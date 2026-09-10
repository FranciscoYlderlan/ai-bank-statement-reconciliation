import {
  StatementParser,
  RawStatement,
  AiClient,
  AiProviderId,
  AiDocument,
  AiError,
  AiExtractionRequest,
} from "../../application/ports";
import { Transaction, AccountRef } from "../../domain/transaction";
import { accountRefFor } from "../../domain/accountRef";
import { Money } from "../../domain/money";
import { PlainDate } from "../../domain/dateptbr";
import {
  RECOGNIZE_SYSTEM_PROMPT,
  RECOGNIZE_USER_PROMPT,
} from "./prompts/recognize";
import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserPrompt,
  buildExtractImageUserPrompt,
} from "./prompts/extract";
import { sniffFileKind, decodeText } from "../parsers/fileKind";
import { readFirstSheet } from "../parsers/xlsxTable";
import {
  parseRecognitionJson,
  tryParseExtraction,
  RecognitionGuide,
  AiRawTransaction,
  RECOGNITION_JSON_SCHEMA,
  EXTRACTION_JSON_SCHEMA,
} from "./schema";

/** Config de runtime resolvida na hora da extracao (vem das Configuracoes). */
export interface AiRuntimeConfig {
  provider: AiProviderId;
  model: string;
  supportsDocument: boolean;
}

/** Extrator de texto de PDF, PÁGINA a página (para paginar a extração). */
export interface PageTextExtractor {
  extractPages(bytes: Uint8Array): Promise<string[]>;
}

/** Estado de UMA partição (visível na UI em tempo real). */
export interface AiPartitionState {
  index: number; // ordem original (0-based)
  status: "pending" | "running" | "done" | "error";
  label: string; // ex.: "Página 7 de 23"
  txCount?: number; // transações extraídas (quando done)
  error?: string; // mensagem (quando error)
}

/** Progresso reportado a cada evento (fase + partições concluídas). */
export interface AiProgress {
  phase: "recognize" | "partition" | "extract" | "done";
  done: number; // partições concluídas (done + error)
  total: number; // total de partições
  label: string; // rótulo pronto para a UI
  partitions: AiPartitionState[];
}

/** Log da resposta crua por chamada (Estágio 0 e cada partição do Estágio 2). */
export interface AiRawLog {
  stage: "recognize" | "extract";
  partition?: number;
  raw: string;
}

export interface AiParserDeps {
  client: AiClient;
  resolveConfig: () => AiRuntimeConfig;
  /** extrator de texto de PDF (pdf.js empacotado). */
  pdfText?: PageTextExtractor;
  /** callback opcional de progresso (para a UI). */
  onProgress?: (p: AiProgress) => void;
  /** limite de chamadas simultâneas no Estágio 2 (default 5). */
  concurrency?: number;
  /** política de retry por chamada (transientes). Default: 3 tentativas, 400ms base. */
  retry?: { attempts?: number; baseMs?: number };
  /** liga o log da resposta crua por chamada (modo debug). */
  debug?: boolean;
  /** hook opcional para a resposta crua (observabilidade/testes). */
  onRawResponse?: (log: AiRawLog) => void;
  /** injeção de sleep (testes usam no-op para não esperar o backoff real). */
  sleep?: (ms: number) => Promise<void>;
  /** logger (default console). */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * CONTRATO DE DESTINO (perfil da planilha, ja resumido em texto). Quando
   * presente, viaja junto do prompt de extracao para que a descricao saia no
   * mesmo padrao do que ja esta gravado na planilha do usuario.
   */
  destination?: string;
}

/** Opções da leitura por IA (a port `parse` usa sempre o padrão: arquivo inteiro). */
export interface AiReadOptions {
  /**
   * Ler só uma AMOSTRA de N blocos, em vez do arquivo inteiro.
   *
   * Existe para o cruzamento: quando o parser determinístico JÁ PROVOU a
   * própria leitura, mandar a IA reler as 20 páginas é pagar caro por uma
   * segunda opinião sobre algo que já está demonstrado. Uma amostra basta para
   * responder a pergunta que interessa — "as duas leituras enxergam a mesma
   * coisa?" —, e a um custo fixo, que não cresce com o tamanho do extrato.
   */
  amostraDeBlocos?: number;
}

/** A leitura por IA com a evidência de COMO ela foi obtida. */
export interface AiReadResult {
  transactions: Transaction[];
  particoes: { total: number; lidas: number; comErro: number; noArquivo: number };
  /** chamadas feitas ao provedor (reconhecimento + extrações + retries). */
  chamadas: number;
  /** quando a leitura foi por amostra, quais blocos entraram. */
  amostra: { blocos: number; deTotal: number; indices: number[] } | null;
  /** divergências da cadeia de saldo que a rede de segurança MANTEVE para conferência. */
  quebrasDeSaldo: number;
  /** lançamentos fantasma que a rede de segurança descartou. */
  fantasmasDescartados: number;
}

/**
 * Escolhe N blocos ESPALHADOS pelo arquivo — começo, meio e fim —, e não os N
 * primeiros. O começo de um extrato é a parte mais fácil e mais parecida com o
 * exemplo do prompt; amostrar só ali daria uma conferência otimista. A escolha
 * é determinística de propósito: a mesma amostra em toda execução, senão duas
 * conciliações do mesmo arquivo poderiam discordar por sorteio.
 */
function amostrar<T>(itens: T[], n: number): T[] {
  if (n >= itens.length || n <= 0) return itens;
  if (n === 1) return [itens[Math.floor((itens.length - 1) / 2)]];
  const passo = (itens.length - 1) / (n - 1);
  const escolhidos = new Set<number>();
  for (let i = 0; i < n; i++) escolhidos.add(Math.round(i * passo));
  return [...escolhidos].sort((a, b) => a - b).map((i) => itens[i]);
}

/** Uma partição do documento: texto (paginado) OU documento nativo (imagem/PDF). */
interface Partition {
  index: number;
  unit: string; // "Página" | "Trecho"
  text?: string;
  document?: AiDocument;
}

type FileKind = "pdf" | "image" | "spreadsheet" | "text";

/** Categorias de erro TRANSIENTES — vale retry com backoff. */
const TRANSIENT: ReadonlyArray<AiError["kind"]> = ["rate_limit", "timeout", "network", "unknown"];
/** Categorias FATAIS — abortam o run inteiro (não adianta seguir). */
const FATAL: ReadonlyArray<AiError["kind"]> = ["invalid_key", "no_key"];

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 400;
const MAX_SPLIT_DEPTH = 2; // truncamento: até 2 níveis de subdivisão por partição

/**
 * De que tipo e o arquivo — pelos BYTES, nunca pela extensao.
 *
 * A deteccao mora em `parsers/fileKind.ts` e e a MESMA que o roteador usa, de
 * proposito: se os dois discordassem, o roteador poderia recusar a leitura
 * direta de uma planilha e o pipeline de IA receberia esses bytes achando que
 * sao texto. Foi exatamente o que acontecia com o extrato que a Stone entrega
 * como `.xls`: um ZIP decodificado como UTF-8 vira lixo binario, e o modelo
 * recebia paginas de simbolos para "transcrever".
 */
function detectKind(raw: RawStatement): { kind: FileKind; mime: string } {
  switch (sniffFileKind(raw.bytes, raw.fileName)) {
    case "pdf":
      return { kind: "pdf", mime: "application/pdf" };
    case "image":
      return {
        kind: "image",
        mime: raw.bytes[0] === 0x89 ? "image/png" : "image/jpeg",
      };
    case "spreadsheet":
      return {
        kind: "spreadsheet",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    default:
      return { kind: "text", mime: "text/plain" };
  }
}

/**
 * Planilha → TEXTO tabular, uma linha por linha da aba, colunas separadas por
 * ` | `. E o formato que o prompt de extracao ja sabe ler (ele numera linhas e
 * usa a ancora de linha como rede de seguranca) e mantem visivel o alinhamento
 * entre cabecalho e celula.
 */
function tabelaParaTexto(rows: string[][]): string {
  return rows.map((linha) => linha.map((c) => c.replace(/\s+/g, " ").trim()).join(" | ")).join("\n");
}

function toBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/**
 * A identidade da conta e compartilhada com os parsers deterministicos
 * (src/domain/accountRef.ts): o `id` entra no hash de dedup, entao os dois
 * caminhos de leitura precisam chegar exatamente na mesma conta.
 */
function accountFromGuide(guide: RecognitionGuide): AccountRef {
  return accountRefFor(guide.instituicao || "", guide.numero || "");
}

function isoToPlainDate(iso: string): PlainDate {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}

/** Divide texto em blocos de no maximo `maxLines` linhas. */
function chunkByLines(content: string, maxLines: number): string[] {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    const block = lines.slice(i, i + maxLines).join("\n").trim();
    if (block) chunks.push(block);
  }
  return chunks.length ? chunks : [content];
}

/** Divide um trecho de texto em DOIS (por linhas) — usado no reprocesso por truncamento. */
function splitTextInHalf(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [text];
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
}

const DEFAULT_GUIDE: RecognitionGuide = {
  instituicao: "",
  numero: "",
  rotuloEntrada: "",
  rotuloSaida: "",
  excluir: ["Saldo do dia", "Saldo anterior", "Saldo inicial", "Saldo final"],
  observacoes: "",
  periodoInicio: "",
  periodoFim: "",
  regraValorSaldo: "",
  posicaoContraparte: "",
  paginasAprox: null,
};

/** Rede de seguranca: descarta linhas de saldo mesmo se o modelo escorregar. */
function isNonTransaction(descricao: string, excluir: string[]): boolean {
  const d = descricao.toLowerCase();
  if (/saldo\s+(do dia|anterior|inicial|final|em conta|atual)/.test(d)) return true;
  for (const pat of excluir) {
    const p = pat.trim().toLowerCase();
    if (p.length >= 4 && d.includes(p)) return true;
  }
  return false;
}

function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

/** Chave de identidade de um lancamento (para comparar repeticoes). */
function txKey(t: AiRawTransaction): string {
  return `${t.data}|${t.direcao}|${Math.round(t.valor * 100)}`;
}

/**
 * REDE 1 contra "lancamento a mais" — ancora de linha.
 * Duas transacoes da MESMA chamada que apontam para a MESMA linha de origem
 * (`linha`) descrevem o mesmo valor do documento: a segunda e um lancamento
 * duplicado. So descarta quando data/direcao/valor tambem batem — assim uma
 * linha que legitimamente contenha dois valores distintos e preservada.
 * Roda por CHAMADA (nao por particao), porque a numeracao de linhas reinicia
 * a cada sub-bloco criado pelo reprocesso de truncamento.
 */
function dedupeBySourceLine(
  txs: AiRawTransaction[],
): { txs: AiRawTransaction[]; dropped: number } {
  const seen = new Map<number, Set<string>>();
  const out: AiRawTransaction[] = [];
  let dropped = 0;
  for (const t of txs) {
    if (t.linha == null) {
      out.push(t);
      continue;
    }
    const keys = seen.get(t.linha) ?? new Set<string>();
    const key = txKey(t);
    if (keys.has(key)) {
      dropped++;
      continue;
    }
    keys.add(key);
    seen.set(t.linha, keys);
    out.push(t);
  }
  return { txs: out, dropped };
}

/**
 * REDE 2 contra "lancamento a mais" — cadeia de saldo.
 * Quando o extrato traz o SALDO apos cada transacao, a diferenca entre dois
 * saldos consecutivos tem de ser exatamente o valor movimentado do segundo
 * lancamento. Um lancamento fantasma (repetido pelo modelo) aparece com
 * delta ZERO: o saldo nao andou. So descartamos nesse caso especifico — e so
 * quando o item repete o anterior — porque ai a remocao RESTAURA a cadeia.
 * Qualquer outra inconsistencia e apenas contabilizada (`breaks`) e logada:
 * preferimos avisar a apagar um lancamento real.
 */
function auditSaldoChain(txs: AiRawTransaction[]): {
  txs: AiRawTransaction[];
  dropped: number;
  breaks: number;
} {
  const out: AiRawTransaction[] = [];
  let dropped = 0;
  let breaks = 0;
  let prev: AiRawTransaction | null = null;
  for (const t of txs) {
    if (prev && prev.saldoApos != null && t.saldoApos != null) {
      const delta = Math.round(t.saldoApos * 100) - Math.round(prev.saldoApos * 100);
      const esperado = Math.round(t.valor * 100) * (t.direcao === "entrada" ? 1 : -1);
      if (delta !== esperado) {
        if (delta === 0 && txKey(t) === txKey(prev)) {
          dropped++; // fantasma: saldo nao andou e o lancamento repete o anterior
          continue;
        }
        breaks++;
      }
    }
    out.push(t);
    prev = t;
  }
  return { txs: out, dropped, breaks };
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Executa `worker` sobre `items` com no máximo `limit` chamadas simultâneas,
 * preservando a ORDEM de saída igual à de entrada. Se um worker lançar, a
 * promise rejeita (usado para erros FATAIS que abortam o run).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const runners: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    runners.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await worker(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * AiStatementParser — motor de extração em PIPELINE de 3 estágios (Fase 2,
 * refatorado). Divide para conquistar:
 *   Estágio 0 — reconhece o layout UMA vez e produz um CABEÇALHO ESTRUTURADO;
 *   Estágio 1 — particiona o documento localmente (sem IA);
 *   Estágio 2 — extrai as partições EM PARALELO (limite de concorrência), com
 *               retry/backoff por partição, detecção de truncamento e falha
 *               isolada (uma partição ruim não derruba as demais);
 *   Estágio 3 — agrega na ordem original + rede de segurança.
 * Implementa a mesma port StatementParser (arquivo -> Transaction[]).
 */
export class AiStatementParser implements StatementParser {
  readonly id = "ai";
  constructor(private readonly deps: AiParserDeps) {}

  private get sleep() {
    return this.deps.sleep ?? sleepDefault;
  }
  private get log() {
    return this.deps.logger ?? console;
  }

  canParse(): boolean {
    return true;
  }

  async parse(raw: RawStatement): Promise<Transaction[]> {
    return (await this.read(raw)).transactions;
  }

  /**
   * A leitura por IA com a EVIDENCIA junto.
   *
   * `parse` devolve so as transacoes porque e o que a port exige. Mas quem
   * arbitra entre as duas vias de leitura (`parsers/arbitrate.ts`) precisa
   * saber COMO esta leitura foi obtida — quantas particoes vingaram, quantas
   * falharam, quantos lancamentos fantasma as redes de seguranca descartaram e
   * se o arquivo foi lido inteiro ou por amostra. Sem isso, "escolher o melhor
   * resultado" viraria escolher o maior, que e outra coisa.
   */
  async read(raw: RawStatement, opts: AiReadOptions = {}): Promise<AiReadResult> {
    const cfg = this.deps.resolveConfig();

    // Estágio 1 — particionamento local (sem IA).
    const todas = await this.buildPartitions(raw, cfg);
    if (todas.length === 0) {
      throw new AiError("unknown", "Nao foi possivel ler nenhum conteudo do arquivo.");
    }
    const partitions = opts.amostraDeBlocos ? amostrar(todas, opts.amostraDeBlocos) : todas;
    const amostra =
      partitions.length < todas.length
        ? { blocos: partitions.length, deTotal: todas.length, indices: partitions.map((p) => p.index) }
        : null;
    const total = partitions.length;
    let chamadas = 0;
    const contarChamada = () => chamadas++;

    const states: AiPartitionState[] = partitions.map((p) => ({
      index: p.index,
      status: "pending",
      label: `${p.unit} ${p.index + 1} de ${todas.length}`,
    }));
    const porIndice = new Map(states.map((s) => [s.index, s]));
    const emit = (phase: AiProgress["phase"], label: string) => {
      const done = states.filter((s) => s.status === "done" || s.status === "error").length;
      this.deps.onProgress?.({ phase, done, total, label, partitions: states.map((s) => ({ ...s })) });
    };

    // Estágio 0 — reconhecimento (uma chamada; aborta cedo se a chamada falhar).
    emit("recognize", "Reconhecendo o layout do extrato…");
    const guide = await this.recognize(partitions[0], cfg, contarChamada);
    const account = accountFromGuide(guide);
    emit(
      "partition",
      amostra
        ? `Conferindo ${total} de ${todas.length} partes (amostra)…`
        : `Dividido em ${total} ${total === 1 ? "parte" : "partes"}…`,
    );

    // Estágio 2 — extração paralela por partição (concorrência controlada).
    const limit = this.deps.concurrency ?? DEFAULT_CONCURRENCY;
    let firstError: unknown;
    const perPartition = await mapWithConcurrency(partitions, limit, async (part) => {
      const state = porIndice.get(part.index)!;
      state.status = "running";
      try {
        const txs = await this.extractPartition(part, guide, cfg, 0, contarChamada);
        state.status = "done";
        state.txCount = txs.length;
        emit("extract", `${part.unit} ${part.index + 1} de ${todas.length} concluída`);
        return txs;
      } catch (e) {
        if (isAiError(e) && FATAL.includes(e.kind)) throw e; // aborta o run inteiro
        if (firstError === undefined) firstError = e;
        const msg = e instanceof Error ? e.message : String(e);
        state.status = "error";
        state.error = msg;
        this.log.warn(`[ai] ${part.unit} ${part.index + 1} falhou após retries: ${msg}`);
        emit("extract", `${part.unit} ${part.index + 1} de ${todas.length} com erro`);
        return [] as AiRawTransaction[]; // falha isolada — segue com as demais
      }
    });

    // Se TODAS as partições falharam, não há resultado parcial útil: propaga o
    // erro (a falha isolada só faz sentido quando ao menos uma partição vinga).
    if (states.every((s) => s.status === "error")) {
      throw firstError ?? new AiError("unknown", "Todas as partições falharam na extração.");
    }

    // Estágio 3 — agregação na ordem original + redes de segurança.
    const rawTxs: AiRawTransaction[] = ([] as AiRawTransaction[]).concat(...perPartition);
    const audited = auditSaldoChain(rawTxs);
    if (audited.dropped > 0 || audited.breaks > 0) {
      this.log.warn(
        `[ai] auditoria da cadeia de saldo: ${audited.dropped} lancamento(s) fantasma descartado(s), ` +
          `${audited.breaks} divergencia(s) mantida(s) para conferencia manual.`,
      );
    }
    const txs = this.toTransactions(account, audited.txs, guide.excluir);
    emit("done", amostra ? "Amostra conferida" : "Extração concluída");
    const comErro = states.filter((s) => s.status === "error").length;
    if (comErro > 0) {
      this.log.warn(`[ai] ${comErro} de ${total} partições falharam; resultado parcial (${txs.length} transações).`);
    }
    return {
      transactions: txs,
      particoes: { total, lidas: total - comErro, comErro, noArquivo: todas.length },
      chamadas,
      amostra,
      quebrasDeSaldo: audited.breaks,
      fantasmasDescartados: audited.dropped,
    };
  }

  /** ── Estágio 1 — particionamento local (sem IA). ─────────────────────── */
  private async buildPartitions(raw: RawStatement, cfg: AiRuntimeConfig): Promise<Partition[]> {
    const { kind, mime } = detectKind(raw);
    if (kind === "pdf") {
      if (this.deps.pdfText) {
        const pages = await this.deps.pdfText.extractPages(raw.bytes);
        const textPages = pages.filter((p) => p.trim().length > 0);
        if (textPages.length > 0) {
          return textPages.map((text, index) => ({ index, unit: "Página", text }));
        }
      }
      // PDF sem texto extraível (escaneado): tenta como documento nativo (1 partição).
      if (cfg.supportsDocument) {
        return [{ index: 0, unit: "Página", document: { base64: toBase64(raw.bytes), mime, fileName: raw.fileName } }];
      }
      throw new AiError(
        "unknown",
        "PDF sem texto extraivel e o provedor selecionado nao aceita documento. Troque de provedor/modelo.",
      );
    }
    if (kind === "image") {
      if (!cfg.supportsDocument) {
        throw new AiError("unknown", "Imagem exige um provedor/modelo com suporte a documento.");
      }
      return [{ index: 0, unit: "Página", document: { base64: toBase64(raw.bytes), mime, fileName: raw.fileName } }];
    }
    if (kind === "spreadsheet") {
      // A planilha NUNCA vai como binario: viraria lixo no prompt. Ela e lida
      // aqui e entregue como texto tabular, do mesmo jeito que um CSV.
      const table = await readFirstSheet(raw.bytes);
      return chunkByLines(tabelaParaTexto(table.rows), 150).map((text, index) => ({
        index,
        unit: "Trecho",
        text,
      }));
    }
    // OFX / CSV / texto — blocos de ~150 linhas. A codificacao e detectada pelo
    // conteudo: o OFX da Stone declara CHARSET:1252 e vem em UTF-8, e obedecer
    // ao cabecalho trocaria todo acento por lixo na descricao gravada.
    const content = decodeText(raw.bytes);
    return chunkByLines(content, 150).map((text, index) => ({ index, unit: "Trecho", text }));
  }

  /** ── Estágio 0 — reconhecimento (cabeçalho estruturado). ─────────────── */
  private async recognize(
    first: Partition,
    cfg: AiRuntimeConfig,
    contar?: () => void,
  ): Promise<RecognitionGuide> {
    const userPrompt = first.text
      ? `${RECOGNIZE_USER_PROMPT}\n\n--- INICIO DO EXTRATO ---\n${first.text.slice(0, 4000)}`
      : RECOGNIZE_USER_PROMPT;
    // A CHAMADA em si pode abortar o run (rede/chave). O CONTEÚDO (JSON) é
    // tolerante: se vier ilegível, seguimos com o guia padrão.
    const raw = await this.completeWithRetry(
      {
        provider: cfg.provider,
        model: cfg.model,
        systemPrompt: RECOGNIZE_SYSTEM_PROMPT,
        userPrompt,
        document: first.document,
        responseSchema: RECOGNITION_JSON_SCHEMA,
      },
      { stage: "recognize" },
      contar,
    );
    try {
      const guide = parseRecognitionJson(raw);
      if (guide.excluir.length === 0) guide.excluir = [...DEFAULT_GUIDE.excluir];
      return guide;
    } catch {
      this.log.warn("[ai] reconhecimento ilegível — usando cabeçalho padrão.");
      return { ...DEFAULT_GUIDE };
    }
  }

  /** ── Estágio 2 — extração de UMA partição (com truncamento → subdivisão). */
  private async extractPartition(
    part: Partition,
    guide: RecognitionGuide,
    cfg: AiRuntimeConfig,
    depth: number,
    contar?: () => void,
  ): Promise<AiRawTransaction[]> {
    const userPrompt = part.text
      ? buildExtractUserPrompt(guide, part.text, this.deps.destination)
      : buildExtractImageUserPrompt(guide, this.deps.destination);
    const raw = await this.completeWithRetry(
      {
        provider: cfg.provider,
        model: cfg.model,
        systemPrompt: EXTRACT_SYSTEM_PROMPT,
        userPrompt,
        document: part.document,
        responseSchema: EXTRACTION_JSON_SCHEMA,
      },
      { stage: "extract", partition: part.index },
      contar,
    );

    const parsed = tryParseExtraction(raw);
    if (parsed.ok) {
      // Rede 1 — por CHAMADA: dois itens ancorados na mesma linha de origem.
      const { txs, dropped } = dedupeBySourceLine(parsed.txs);
      if (dropped > 0) {
        this.log.warn(
          `[ai] ${part.unit} ${part.index + 1}: ${dropped} lancamento(s) descartado(s) por repetir a mesma linha de origem.`,
        );
      }
      return txs;
    }

    // Truncamento: só faz sentido subdividir partição de TEXTO (documento nativo
    // não é fatiável aqui). Reprocessa apenas ESTA partição em sub-blocos.
    if (parsed.truncated && part.text && depth < MAX_SPLIT_DEPTH) {
      const halves = splitTextInHalf(part.text);
      if (halves.length > 1) {
        this.log.warn(
          `[ai] ${part.unit} ${part.index + 1} truncada — subdividindo em ${halves.length} (nível ${depth + 1}).`,
        );
        const out: AiRawTransaction[] = [];
        for (const half of halves) {
          const sub = await this.extractPartition(
            { ...part, text: half },
            guide,
            cfg,
            depth + 1,
            contar,
          );
          out.push(...sub);
        }
        return out;
      }
    }
    throw parsed.error; // schema ruim não-truncado → vira falha isolada da partição
  }

  /**
   * Chama o modelo com RETRY/BACKOFF para erros transientes. Erros fatais
   * (chave inválida/ausente) e não-transientes propagam imediatamente. Registra
   * a resposta crua (debug/hook) para diagnóstico.
   */
  private async completeWithRetry(
    req: AiExtractionRequest,
    meta: { stage: "recognize" | "extract"; partition?: number },
    contar?: () => void,
  ): Promise<string> {
    const attempts = Math.max(1, this.deps.retry?.attempts ?? DEFAULT_ATTEMPTS);
    const baseMs = this.deps.retry?.baseMs ?? DEFAULT_BACKOFF_MS;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        contar?.();
        const raw = await this.deps.client.complete(req);
        if (this.deps.debug) {
          this.log.log(
            `[ai:raw] ${meta.stage}${meta.partition !== undefined ? ` p${meta.partition + 1}` : ""}: ${raw}`,
          );
        }
        this.deps.onRawResponse?.({ stage: meta.stage, partition: meta.partition, raw });
        return raw;
      } catch (e) {
        lastErr = e;
        const kind = isAiError(e) ? e.kind : "unknown";
        const retriable = TRANSIENT.includes(kind) && attempt < attempts;
        if (!retriable) throw e;
        const wait = baseMs * 2 ** (attempt - 1);
        this.log.warn(
          `[ai] ${meta.stage}${meta.partition !== undefined ? ` p${meta.partition + 1}` : ""} tentativa ${attempt}/${attempts} falhou (${kind}); repetindo em ${wait}ms.`,
        );
        await this.sleep(wait);
      }
    }
    throw lastErr;
  }

  /** ── Estágio 3 — montagem determinística + filtro de segurança. ──────── */
  private toTransactions(
    account: AccountRef,
    rawTxs: AiRawTransaction[],
    excluir: string[],
  ): Transaction[] {
    const out: Transaction[] = [];
    for (const t of rawTxs) {
      if (isNonTransaction(t.descricao, excluir)) continue; // rede de seguranca
      const tx: Transaction = {
        date: isoToPlainDate(t.data),
        description: t.descricao,
        direction: t.direcao === "entrada" ? "credit" : "debit",
        amount: Money.fromReais(t.valor),
        account,
        sourceOrder: out.length, // ordem contínua através das partições
        rawLine: `${t.data} ${t.direcao} ${t.valor} ${t.descricao}`,
      };
      if (t.saldoApos !== null) tx.balanceAfter = Money.fromReais(t.saldoApos);
      out.push(tx);
    }
    return out;
  }
}
