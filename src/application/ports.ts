import { Transaction } from "../domain/transaction";
import { Competence } from "../domain/competence";
import { SheetRow, SheetRowLayout } from "../domain/layout";
import { RulesFile } from "../domain/ruleSet";

/**
 * Portas (traits) — a fronteira testavel entre os use cases e os detalhes
 * externos (PDF, Excel, Google, IA, SQLite). Nenhum use case importa uma
 * implementacao concreta; recebe estas interfaces por injecao.
 */

/** Uma palavra do PDF com sua posicao (reconstrucao posicional §9.b). */
export interface Word {
  page: number;
  text: string;
  x0: number;
  x1: number;
  top: number;
}

/** Porta de EXTRACAO de palavras posicionadas de um PDF (pdfjs, etc.). */
export interface WordExtractor {
  extract(bytes: Uint8Array): Promise<Word[]>;
}

/** Extrai texto linha-a-linha (para templates simples / OCR). */
export interface TextExtractor {
  extractLines(bytes: Uint8Array): Promise<string[]>;
}

export interface RawStatement {
  fileName: string;
  bytes: Uint8Array;
}

export class ParseError extends Error {}

/** Porta de ENTRADA — converte um arquivo bruto em transacoes normalizadas. */
export interface StatementParser {
  /** identificador da estrategia (ex.: "stone-pdf", "pagseguro-pdf", "ofx"). */
  readonly id: string;
  /** heuristica: este parser reconhece este arquivo? */
  canParse(raw: RawStatement, sniff: string): Promise<boolean> | boolean;
  parse(raw: RawStatement): Promise<Transaction[]>;
}

/** Resultado de uma operacao de escrita. */
export interface AppendOutcome {
  sheet: string;
  appended: number;
  firstRow: number;
  lastRow: number;
  /**
   * Observacoes sobre a ESCRITA que o usuario precisa saber, mas que nao sao
   * erro. Hoje: quando a linha imediatamente acima da que gravamos esta sem
   * saldo, o acumulado da coluna recomeca dali — e um buraco que ja existia na
   * planilha, e ficar calado sobre ele seria pior do que a linha em branco.
   */
  warnings?: string[];
}

/**
 * Porta de SAIDA — implementada pelo XLSX local (cirurgico) e pelo Google
 * Sheets. Anexa linhas SEM tocar em formulas/merges/validacao (§12).
 */
export interface SpreadsheetTarget {
  sheetNames(): Promise<string[]>;
  /** Le transacoes ja lancadas numa aba (dedup contra a fonte de verdade). */
  readExisting(sheet: string, layout: SheetRowLayout): Promise<Transaction[]>;
  /** Anexa linhas novas preenchendo apenas B,C,D,F,G. */
  appendRows(
    sheet: string,
    rows: SheetRow[],
    layout: SheetRowLayout,
  ): Promise<AppendOutcome>;
}

/** Cache/historico local (SQLite no desktop; memoria no demo). */
export interface LedgerRepository {
  knownHashes(comp: Competence): Promise<Set<string>>;
  appendLedger(entries: LedgerEntry[]): Promise<void>;
}

export interface LedgerEntry {
  competenceKey: string;
  hash: string;
  dateIso: string;
  description: string;
  direction: "credit" | "debit";
  amountCents: number;
  category: string | null;
  account: string;
}

/** Backup imutavel antes de qualquer escrita (§13 / T-BACKUP). */
export interface BackupService {
  backup(fileId: string): Promise<string>; // retorna caminho/rotulo do backup
}

export interface Clock {
  now(): Date;
}

/* ────────────────────────────────────────────────────────────────────────
 * Fase 2 — Motor de IA e armazenamento seguro de segredos
 *
 * O motor de extracao deixou de ser deterministico (parsers por banco) e passou
 * a ser um unico caminho via IA (decisao de PRODUTO — ver README §7). Estas
 * ports mantem a arquitetura: a UI e os use cases falam com interfaces; a
 * chamada HTTP real ao provedor e a leitura da API key acontecem no backend
 * nativo (Rust/Tauri), de modo que a chave NUNCA transita pelo WebView em texto.
 * ──────────────────────────────────────────────────────────────────────── */

/** Provedores de IA suportados. Estruturado para adicionar novos facilmente. */
export type AiProviderId = "openai" | "anthropic" | "gemini";

export interface AiModelOption {
  id: string; // ex.: "gpt-4o"
  label: string; // ex.: "GPT-4o"
}

/** Configuracao (nao-secreta) de um provedor — persistida em disco em claro. */
export interface AiProviderConfig {
  id: AiProviderId;
  label: string; // ex.: "OpenAI"
  model: string; // modelo selecionado (o motor usa este)
  models: AiModelOption[]; // opcoes para o seletor da tela de Configuracoes
  /** provedor suporta enviar o PDF como documento nativo (base64)? */
  supportsDocument: boolean;
}

/** Estado de conexao exibido como badge por provedor. */
export type ProviderStatus = "connected" | "unconfigured" | "error";

/** Categorias de erro de IA — cada uma vira uma mensagem clara na interface. */
export type AiErrorKind =
  | "invalid_key"
  | "rate_limit"
  | "timeout"
  | "bad_schema"
  | "network"
  | "no_key"
  | "unknown";

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * SecretsStore — armazenamento seguro do SO (Stronghold no desktop). A key e
 * gravada e lida SOMENTE no backend nativo; a UI apenas grava, consulta
 * presenca e apaga. `hasSecret` NUNCA devolve o valor.
 */
export interface SecretsStore {
  setSecret(key: string, value: string): Promise<void>;
  hasSecret(key: string): Promise<boolean>;
  deleteSecret(key: string): Promise<void>;
}

/** Um documento (PDF/imagem) para input nativo do provedor. */
export interface AiDocument {
  base64: string;
  mime: string; // ex.: "application/pdf", "image/png"
  fileName: string;
}

/** Requisicao de extracao enviada ao provedor de IA. */
export interface AiExtractionRequest {
  provider: AiProviderId;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** documento nativo (preferido quando o provedor suporta). */
  document?: AiDocument;
  /** texto extraido do arquivo (fallback p/ provedor sem input de documento). */
  documentText?: string;
  /**
   * JSON Schema estrito para Structured Outputs "na fonte" (o backend nativo
   * traduz para response_format json_schema no OpenAI, response_schema no Gemini
   * e tool no Anthropic). Formato: { name, strict, schema }. Reduz `bad_schema`
   * antes mesmo da validacao client-side. Opcional — sem ele, cai no modo
   * json_object generico.
   */
  responseSchema?: unknown;
}

/**
 * AiClient — porta de saida para o modelo. Implementada no desktop por um
 * comando Rust (a key fica no nativo). Retorna o TEXTO bruto da resposta do
 * modelo (esperado: JSON); a validacao/mapeamento e feita no adapter (TS),
 * onde vive o dominio.
 */
export interface AiClient {
  complete(req: AiExtractionRequest): Promise<string>;
  /** Testa a conexao real com o provedor/modelo usando a key salva no nativo. */
  testConnection(
    provider: AiProviderId,
    model: string,
  ): Promise<{ ok: boolean; message: string }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Fase 2.4 — Regras do usuario
 *
 * As regras do usuario sao DADO, nao codigo (ver `domain/userRules.ts`), e por
 * isso precisam de um lugar para morar entre uma execucao e outra. Nao vao para
 * `localStorage` junto com as preferencias: localStorage e por ORIGEM, e a §3.5
 * ja mostrou o que isso custa — a build instalada nasce limpa. Alem disso o
 * usuario tem de conseguir LEVAR as regras (backup, outro computador, mandar
 * para o contador), o que um arquivo resolve e o storage do WebView nao.
 *
 * Nao ha segredo aqui: nome de funcionaria e categoria nao sao credencial, e o
 * cofre (`SecretsStore`) continua sendo so para API key e token.
 * ──────────────────────────────────────────────────────────────────────── */

export interface RulesRepositoryLoad {
  file: RulesFile;
  /** o que foi descartado na leitura — a tela avisa em vez de perder calado. */
  avisos: string[];
}

/**
 * RulesRepository — porta de persistencia das carteiras de regras.
 *
 * `load` NUNCA lanca: arquivo corrompido, de versao mais nova ou editado a mao
 * volta como arquivo vazio mais avisos. `save` PODE lancar — ali o usuario
 * clicou em salvar e precisa saber se nao deu certo.
 */
export interface RulesRepository {
  load(): Promise<RulesRepositoryLoad>;
  save(file: RulesFile): Promise<void>;
}
