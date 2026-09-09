import { StatementParser, RawStatement } from "../../application/ports";
import { Transaction } from "../../domain/transaction";
import { PageTextExtractor, AiReadOptions, AiReadResult } from "../ai/aiStatementParser";
import { arbitrar, LeituraCandidata, ResultadoArbitrado, Cruzamento, NivelConfianca } from "./arbitrate";
import { sniffFileKind, decodeText, StatementFileKind } from "./fileKind";
import { parseCsv } from "./csvTable";
import { readFirstSheet } from "./xlsxTable";
import {
  PAGBANK_PARSER_ID,
  isPagBankStatement,
  isTrustworthy as pagbankConfere,
  parsePagBankPages,
  rejectionReason as pagbankMotivo,
} from "./pagbankPdf";
import {
  TABULAR_PARSER_ID,
  isTabularStatement,
  isTrustworthy as tabularConfere,
  parseTabularStatement,
  rejectionReason as tabularMotivo,
} from "./tabularStatement";
import {
  OFX_PARSER_ID,
  isOfxStatement,
  isTrustworthy as ofxConfere,
  parseOfx,
  rejectionReason as ofxMotivo,
} from "./ofxStatement";

/**
 * ROTEADOR DETERMINISTICO → IA.
 *
 * Dois modos de ler um extrato, e a ordem entre eles importa:
 *
 *  - DETERMINISTICO, quando o layout e conhecido. Nao custa chamada de rede,
 *    responde na hora, e — o que mais importa — devolve exatamente o mesmo
 *    resultado toda vez que roda. Um layout so entra aqui quando da para
 *    CONFERIR o que foi lido: no PagBank, pela cadeia de "Saldo do dia"; no
 *    extrato tabular (CSV/planilha), pela aritmetica de cada linha somada ao
 *    encadeamento dos saldos; no OFX, pela contagem dos registros declarados.
 *
 *  - EMPIRICO (IA), para todo o resto. Le layout que ninguem programou, e o
 *    preco e a variabilidade: duas execucoes podem discordar, e por isso o
 *    pipeline de IA tem suas proprias redes (schema estrito, ancora de linha,
 *    auditoria de saldo).
 *
 * O deterministico so vence quando ele PROVA que leu certo. Recusou a propria
 * leitura — cadeia de saldo que nao fecha, linha que ele nao entendeu — a IA
 * assume o arquivo. Nunca ha meio-termo: o resultado vem inteiro de um dos dois,
 * jamais costurado entre os dois.
 *
 * O TIPO do arquivo e decidido pelos BYTES (`parsers/fileKind.ts`), nunca pela
 * extensao: o extrato que a Stone chama de `.xls` e, por dentro, um .xlsx.
 */

/** Como o arquivo acabou sendo lido — vai para o log e para o relatorio. */
export interface StrategyInfo {
  kind: "deterministic" | "ai";
  /** id do parser ("pagbank-pdf", "tabular-saldo", "ofx") ou "ai". */
  parserId: string;
  /** rotulo curto para a UI. */
  label: string;
  /** por que o deterministico foi recusado (so quando caiu para a IA). */
  reason?: string;
  /**
   * Observacoes da LEITURA que o usuario precisa saber e que nao sao erro —
   * hoje: o OFX que entrega o valor ja liquido de tarifa. Vao para o relatorio.
   */
  avisos?: string[];
  /** o quanto se pode confiar nesta leitura (§3.8). */
  nivel?: NivelConfianca;
  /** o que sustenta a leitura escolhida, em frases prontas. */
  evidencia?: string[];
  /** a segunda leitura, que serviu de conferencia. */
  testemunha?: {
    label: string;
    lancamentos: number | null;
    chamadas: number;
    amostra?: { blocos: number; deTotal: number };
    evidencia: string[];
    recusa?: string;
  } | null;
  /** o resultado do cruzamento entre as duas leituras. */
  cruzamento?: Cruzamento | null;
}

/**
 * O motor empirico, visto pelo roteador.
 *
 * `read` e opcional de proposito: a port `StatementParser` so exige `parse`, e
 * um motor que nao saiba ler por amostra continua servindo — ele apenas le o
 * arquivo inteiro quando chamado como testemunha.
 */
export interface MotorEmpirico extends StatementParser {
  read?(raw: RawStatement, opts?: AiReadOptions): Promise<AiReadResult>;
}

/** Quantos blocos a IA le quando entra apenas como testemunha. */
export const BLOCOS_DE_AMOSTRA = 3;

export interface HybridParserDeps {
  /** motor empirico — testemunha quando ha prova, leitura quando nao ha. */
  ai: MotorEmpirico;
  /** extrator de texto por pagina (o mesmo que alimenta o pipeline de IA). */
  pdfText: PageTextExtractor;
  /** avisa qual estrategia leu o arquivo. */
  onStrategy?: (info: StrategyInfo) => void;
  /**
   * A conferencia por IA em paralelo. Ligada por padrao: o custo e fixo
   * (uma amostra de blocos), e o que ela compra e uma segunda opiniao
   * independente sobre a leitura que ja se provou. Desligar economiza as
   * chamadas e nao muda o resultado — muda so a confianca declarada.
   */
  validacaoIa?: { ativa: boolean; blocosDeAmostra?: number };
  logger?: Pick<Console, "log" | "warn">;
}

/**
 * O ArrayBuffer do arquivo ainda esta valido?
 *
 * Um buffer DESANEXADO (`byteLength` 0 depois de ter conteudo) e o rastro de
 * alguem ter transferido os bytes para um worker — foi o que o pdf.js fazia
 * com o arquivo do usuario ate `pdfText.ts` passar a mandar uma copia. Se
 * acontecer de novo, o erro nativo e ilegivel ("Cannot perform
 * %TypedArray%.prototype.slice on a detached ArrayBuffer"); esta checagem troca
 * isso por uma frase que diz o que fazer.
 */
function assertBytesUsaveis(raw: RawStatement): void {
  if (raw.bytes.byteLength === 0) {
    throw new Error(
      `O conteúdo de "${raw.fileName}" não está mais disponível na memória. ` +
        `Selecione o arquivo novamente e refaça a conciliação.`,
    );
  }
}

/**
 * O .xls ANTIGO (BIFF/OLE2) nao e suportado, e isso e uma escolha: ele exigiria
 * uma biblioteca inteira so para ele, e todo banco que ainda o oferece oferece
 * tambem CSV ou OFX. O que NAO se pode fazer e mandar esses bytes binarios para
 * a IA transcrever — sai lixo com cara de extrato. Entao a leitura para aqui,
 * com a frase que resolve o problema do usuario em um clique.
 */
export class LegacyXlsError extends Error {
  constructor(fileName: string) {
    super(
      `"${fileName}" está no formato Excel antigo (.xls de verdade), que este aplicativo não lê. ` +
        `Abra o arquivo no Excel e salve como .xlsx, ou baixe o extrato em CSV, OFX ou PDF.`,
    );
  }
}

export class HybridStatementParser implements StatementParser {
  readonly id = "hybrid";
  constructor(private readonly deps: HybridParserDeps) {}

  private get log() {
    return this.deps.logger ?? console;
  }

  canParse(): boolean {
    return true; // sempre ha um caminho: no pior caso, a IA
  }

  /** A port pede so as transacoes; quem quiser a arbitragem chama `read`. */
  async parse(raw: RawStatement): Promise<Transaction[]> {
    return (await this.read(raw)).transactions;
  }

  /**
   * Le o extrato pelas DUAS vias e arbitra.
   *
   * Sobre a ordem: o determinístico roda primeiro porque custa milissegundos e
   * nenhuma chamada de rede — e é o veredito dele que DIMENSIONA a leitura por
   * IA. Prova fechada pede da IA apenas uma amostra, o bastante para cruzar;
   * prova recusada pede o arquivo inteiro, porque aí a IA não é testemunha, é a
   * leitura. Inverter isso não adiantaria nada: a segunda via é a cara e a
   * demorada, e o tempo do primeiro desaparece ao lado dela.
   *
   * O que as duas vias NÃO fazem é olhar uma para a outra. Nenhuma recebe o
   * resultado da outra, nenhuma é ajustada para concordar — é isso que torna a
   * coincidência entre elas uma evidência, e não um eco.
   */
  async read(raw: RawStatement): Promise<ResultadoArbitrado> {
    assertBytesUsaveis(raw);
    const kind = sniffFileKind(raw.bytes, raw.fileName);
    if (kind === "xls-legacy") throw new LegacyXlsError(raw.fileName);

    const deterministica = await this.lerDeterministico(raw, kind);
    const provou = deterministica?.transactions != null;

    const empirica = await this.lerComIa(raw, provou);

    const resultado = arbitrar(deterministica, empirica);
    this.deps.onStrategy?.(this.montarStrategy(resultado));
    return resultado;
  }

  /* ── via 1: determinística ─────────────────────────────────────────────── */

  private ultimaRecusa: string | null = null;
  private ultimosAvisos: string[] = [];
  private ultimaEvidencia: string[] = [];
  private ultimoParser: { id: string; label: string } | null = null;

  /**
   * Tenta o layout conhecido do TIPO de arquivo que chegou. Devolve a leitura
   * so quando o parser CONFERIU a si mesmo; qualquer outra coisa (formato sem
   * parser, texto ilegivel, conferencia que nao fechou) volta como recusa —
   * que e informacao, nao erro: ela aparece no relatorio.
   */
  private async lerDeterministico(
    raw: RawStatement,
    kind: StatementFileKind,
  ): Promise<LeituraCandidata | null> {
    this.ultimaRecusa = null;
    this.ultimosAvisos = [];
    this.ultimaEvidencia = [];
    this.ultimoParser = null;
    let txs: Transaction[] | null = null;
    try {
      if (kind === "pdf") txs = await this.tryPdf(raw);
      else if (kind === "spreadsheet") txs = await this.trySpreadsheet(raw);
      else if (kind === "ofx") txs = this.tryOfx(raw);
      else if (kind === "text") txs = this.tryText(raw);
    } catch (e) {
      // Falha do leitor de arquivo (planilha corrompida, ZIP que nao e xlsx)
      // NAO derruba a conciliacao: e mais um motivo para a IA assumir.
      this.ultimaRecusa = e instanceof Error ? e.message : String(e);
      this.log.warn(`[parser] leitura direta indisponível: ${this.ultimaRecusa}`);
    }

    // Formato sem nenhum parser conhecido: nao ha candidata determinística.
    if (txs == null && this.ultimoParser == null && this.ultimaRecusa == null) return null;

    const parser = this.ultimoParser ?? { id: "deterministico", label: "Leitura direta" };
    return {
      via: "deterministic",
      parserId: parser.id,
      label: parser.label,
      transactions: txs,
      evidencia: this.ultimaEvidencia,
      recusa: txs == null ? (this.ultimaRecusa ?? "leitura direta não confirmada") : undefined,
      chamadas: 0,
      nivel: txs == null ? "recusada" : "provada",
      avisos: this.ultimosAvisos.length ? [...this.ultimosAvisos] : undefined,
    };
  }

  /** PDF: hoje so o PagBank/PagSeguro se autoconfere (§3.4 do README). */
  private async tryPdf(raw: RawStatement): Promise<Transaction[] | null> {
    let pages: string[];
    try {
      pages = await this.deps.pdfText.extractPages(raw.bytes);
    } catch {
      return null; // PDF escaneado ou ilegivel: caso classico de IA
    }
    const texto = pages.join("\n");
    if (texto.trim().length === 0) return null;

    // A extracao de texto nao pode ter consumido os bytes do usuario: quem le o
    // arquivo depois (a IA, em modo documento) precisa deles inteiros.
    assertBytesUsaveis(raw);

    if (!isPagBankStatement(texto)) return null;
    this.ultimoParser = { id: PAGBANK_PARSER_ID, label: "Leitura direta (PagBank · PDF)" };
    const r = parsePagBankPages(pages);
    if (pagbankConfere(r)) {
      this.ultimaEvidencia = [
        `${r.transactions.length} lançamentos lidos linha a linha do texto do PDF.`,
        `A cadeia de "Saldo do dia" fechou em ${r.audit.conferidos} dia(s) conferíveis, sem divergência.`,
        `Nenhuma linha da tabela ficou sem interpretação.`,
      ];
      this.log.log(
        `[parser] PagBank lido de forma determinística: ${r.transactions.length} lançamentos, ` +
          `${r.audit.conferidos} dia(s) conferidos pela cadeia de saldo.`,
      );
      return r.transactions;
    }
    this.ultimaRecusa = pagbankMotivo(r) ?? "leitura direta não confirmada";
    this.log.warn(
      `[parser] leitura direta do PagBank recusada (${this.ultimaRecusa}); passando para a IA.`,
    );
    return null;
  }

  /** Planilha (.xlsx — inclusive o ".xls" que na verdade e xlsx). */
  private async trySpreadsheet(raw: RawStatement): Promise<Transaction[] | null> {
    const table = await readFirstSheet(raw.bytes);
    return this.tryTabular(table.rows, `planilha · aba "${table.sheetName}"`);
  }

  /** OFX 1.x/2.x. */
  private tryOfx(raw: RawStatement): Transaction[] | null {
    const texto = decodeText(raw.bytes);
    if (!isOfxStatement(texto)) return null;
    this.ultimoParser = { id: OFX_PARSER_ID, label: "Leitura direta (OFX)" };
    const r = parseOfx(texto);
    if (ofxConfere(r)) {
      this.ultimosAvisos = r.avisos;
      this.ultimaEvidencia = [
        `Os ${r.audit.declarados} registros <STMTTRN> declarados no arquivo viraram ${r.audit.lidos} lançamentos.`,
        `Nada sobrou dentro da lista de transações que o parser não tenha interpretado.`,
        `Nenhuma data caiu fora do período declarado no próprio arquivo.`,
      ];
      this.log.log(
        `[parser] OFX lido de forma determinística: ${r.transactions.length} de ` +
          `${r.audit.declarados} registro(s) declarados.`,
      );
      return r.transactions;
    }
    this.ultimaRecusa = ofxMotivo(r) ?? "leitura direta não confirmada";
    this.log.warn(`[parser] leitura direta do OFX recusada (${this.ultimaRecusa}); passando para a IA.`);
    return null;
  }

  /** Texto: CSV/TSV com saldo antes e depois. */
  private tryText(raw: RawStatement): Transaction[] | null {
    const texto = decodeText(raw.bytes);
    if (texto.trim().length === 0) return null;
    // um OFX salvo com extensao .txt ainda e um OFX
    if (isOfxStatement(texto)) return this.tryOfx(raw);
    return this.tryTabular(parseCsv(texto), "CSV");
  }

  /** O caminho comum de CSV e planilha: a mesma matriz, a mesma conferencia. */
  private tryTabular(rows: string[][], origem: string): Transaction[] | null {
    if (!isTabularStatement(rows)) {
      this.ultimaRecusa =
        `o ${origem} não traz as colunas de saldo antes/depois que permitem conferir a leitura`;
      return null;
    }
    this.ultimoParser = { id: TABULAR_PARSER_ID, label: "Leitura direta (CSV/planilha com saldo)" };
    const r = parseTabularStatement(rows);
    if (tabularConfere(r)) {
      this.ultimaEvidencia = [
        `${r.audit.linhasConferidas} linha(s) fecharam a própria conta: saldo antes + valor − tarifa = saldo depois.`,
        `Os saldos encadearam em ${r.audit.elosConferidos} ligação(ões) consecutivas, sem buraco — é isto que prova que nenhuma linha foi pulada.`,
        r.tarifas > 0
          ? `${r.tarifas} tarifa(s) cobradas viraram lançamento próprio, como aparecem no PDF do mesmo extrato.`
          : `Nenhuma tarifa cobrada neste período.`,
      ];
      this.log.log(
        `[parser] extrato tabular lido de forma determinística (${origem}): ` +
          `${r.transactions.length} lançamentos (${r.tarifas} tarifa(s) como linha própria), ` +
          `${r.audit.linhasConferidas} linha(s) conferida(s) e ${r.audit.elosConferidos} elo(s) de saldo.`,
      );
      return r.transactions;
    }
    this.ultimaRecusa = tabularMotivo(r) ?? "leitura direta não confirmada";
    this.log.warn(
      `[parser] leitura direta do extrato tabular recusada (${this.ultimaRecusa}); passando para a IA.`,
    );
    return null;
  }

  /* ── via 2: empírica (IA) ──────────────────────────────────────────────── */

  /**
   * A leitura por IA — como TESTEMUNHA quando a prova já fechou, como LEITURA
   * quando não fechou.
   *
   * A distinção não é cosmética, é de custo: no papel de testemunha ela lê uma
   * amostra de blocos e gasta um punhado de chamadas, não importa se o extrato
   * tem uma página ou vinte; no papel de leitura, lê tudo. E ela NUNCA derruba
   * a conciliação: se o provedor estiver fora do ar, a chave errada ou o
   * modelo devolver lixo, isso vira uma candidata recusada e a leitura provada
   * segue seu caminho. Uma testemunha que não apareceu não invalida a prova.
   */
  private async lerComIa(raw: RawStatement, comoTestemunha: boolean): Promise<LeituraCandidata | null> {
    const validacao = this.deps.validacaoIa;
    if (comoTestemunha && validacao?.ativa === false) return null;
    const blocos = validacao?.blocosDeAmostra ?? BLOCOS_DE_AMOSTRA;

    const motor = this.deps.ai;
    try {
      const r =
        comoTestemunha && typeof motor.read === "function"
          ? await motor.read(raw, { amostraDeBlocos: blocos })
          : {
              transactions: await motor.parse(raw),
              particoes: null,
              chamadas: 0,
              amostra: null,
              quebrasDeSaldo: 0,
              fantasmasDescartados: 0,
            };

      const evidencia: string[] = [];
      if (r.amostra) {
        evidencia.push(
          `Conferência por amostragem: ${r.amostra.blocos} de ${r.amostra.deTotal} blocos do arquivo, ` +
            `escolhidos do começo, do meio e do fim.`,
        );
      }
      if (r.particoes) {
        evidencia.push(
          `${r.particoes.lidas} de ${r.particoes.total} partes foram extraídas com sucesso` +
            (r.particoes.comErro > 0 ? `; ${r.particoes.comErro} falharam após as tentativas.` : "."),
        );
      }
      if (r.fantasmasDescartados > 0) {
        evidencia.push(
          `${r.fantasmasDescartados} lançamento(s) repetidos pelo modelo foram descartados pelas redes de segurança.`,
        );
      }
      if (r.quebrasDeSaldo > 0) {
        evidencia.push(
          `${r.quebrasDeSaldo} divergência(s) na cadeia de saldo foram mantidas para conferência manual.`,
        );
      }
      evidencia.push(
        `${r.transactions.length} lançamentos transcritos em ${r.chamadas} chamada(s) ao provedor.`,
      );

      return {
        via: "ai",
        parserId: "ai",
        label: comoTestemunha ? "Conferência por IA" : "Leitura por IA",
        transactions: r.transactions,
        evidencia,
        chamadas: r.chamadas,
        amostra: r.amostra ? { blocos: r.amostra.blocos, deTotal: r.amostra.deTotal } : undefined,
        nivel: "empirica",
      };
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      this.log.warn(`[parser] a leitura por IA não pôde ser feita: ${motivo}`);
      return {
        via: "ai",
        parserId: "ai",
        label: comoTestemunha ? "Conferência por IA" : "Leitura por IA",
        transactions: null,
        evidencia: [],
        recusa: motivo,
        // o erro original viaja junto: como TESTEMUNHA ele só vira texto no
        // relatorio, mas como LEITURA e ele que a interface precisa traduzir
        erro: e,
        chamadas: 0,
        nivel: "recusada",
      };
    }
  }

  /** Traduz a arbitragem para o formato que o relatorio ja consome. */
  private montarStrategy(r: ResultadoArbitrado): StrategyInfo {
    const e = r.escolhida;
    if (e.via === "deterministic") {
      this.deps.onStrategy &&
        this.log.log(
          `[parser] leitura escolhida: ${e.label} (${e.nivel})` +
            (r.cruzamento
              ? ` — cruzamento ${r.cruzamento.cobertura}: ${r.cruzamento.emComum} em comum, ` +
                `${r.cruzamento.soNaEscolhida + r.cruzamento.soNaTestemunha} divergência(s).`
              : ""),
        );
    }
    return {
      kind: e.via,
      parserId: e.parserId,
      label: e.label,
      reason: e.via === "ai" ? r.testemunha?.recusa ?? this.ultimaRecusa ?? undefined : undefined,
      avisos: e.avisos,
      nivel: e.nivel,
      evidencia: e.evidencia,
      testemunha: r.testemunha
        ? {
            label: r.testemunha.label,
            lancamentos: r.testemunha.transactions?.length ?? null,
            chamadas: r.testemunha.chamadas,
            amostra: r.testemunha.amostra,
            evidencia: r.testemunha.evidencia,
            recusa: r.testemunha.recusa,
          }
        : null,
      cruzamento: r.cruzamento,
    };
  }
}

/**
 * Extrator de texto MEMORIZADO. O roteador precisa do texto para reconhecer o
 * layout, e o pipeline de IA precisa do mesmo texto para paginar a extracao:
 * sem isso, o mesmo PDF seria renderizado duas vezes a cada conciliacao.
 */
export class MemoPageTextExtractor implements PageTextExtractor {
  private cache = new WeakMap<Uint8Array, Promise<string[]>>();
  constructor(private readonly inner: PageTextExtractor) {}
  extractPages(bytes: Uint8Array): Promise<string[]> {
    // A chave e o PROPRIO array, nao o `buffer`: dois recortes distintos do
    // mesmo buffer sao arquivos distintos e nao podem dividir o cache.
    const hit = this.cache.get(bytes);
    if (hit) return hit;
    const p = this.inner.extractPages(bytes);
    this.cache.set(bytes, p);
    return p;
  }
}
