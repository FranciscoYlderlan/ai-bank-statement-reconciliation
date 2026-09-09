import { AiError } from "../../application/ports";

/**
 * Contratos de dados do pipeline de IA. O texto livre do modelo nunca e o
 * resultado final: passa por estes validadores antes de o adapter mapear para
 * o dominio. Desvio => AiError("bad_schema").
 *
 * Alem da validacao client-side, exportamos os JSON Schemas (RECOGNITION_JSON_SCHEMA
 * e EXTRACTION_JSON_SCHEMA) para o backend nativo forcar Structured Outputs "na
 * fonte" (OpenAI response_format json_schema, Gemini response_schema, Anthropic
 * tool) — reduz `bad_schema` antes mesmo de chegar aqui.
 */

/** Etapa 0 — CABECALHO ESTRUTURADO devolvido pelo RECONHECIMENTO. */
export interface RecognitionGuide {
  instituicao: string;
  numero: string;
  rotuloEntrada: string;
  rotuloSaida: string;
  excluir: string[];
  observacoes: string;
  /** Periodo do extrato (ISO AAAA-MM-DD) — informativo, ajuda a validar datas. */
  periodoInicio: string;
  periodoFim: string;
  /** Onde esta o VALOR movimentado x onde esta o SALDO (regra explicita). */
  regraValorSaldo: string;
  /**
   * Onde fica o NOME da contraparte (quem pagou/recebeu) em relacao ao VALOR:
   * mesma linha, linha acima, linha abaixo. Alguns extratos (ex.: Stone) trazem
   * a contraparte na linha ACIMA da linha do valor.
   */
  posicaoContraparte: string;
  /** Estimativa de paginas do documento (informativo). */
  paginasAprox: number | null;
}

/** Etapa 2 — uma transacao transcrita (valor e saldo SEPARADOS). */
export interface AiRawTransaction {
  data: string; // "AAAA-MM-DD"
  descricao: string;
  direcao: "entrada" | "saida";
  valor: number; // valor MOVIMENTADO, positivo (nunca o saldo)
  saldoApos: number | null; // saldo apos a transacao (informativo)
  /**
   * ANCORA DE ORIGEM — numero da linha (do trecho NUMERADO enviado ao modelo)
   * onde o VALOR desta transacao aparece. Serve a dois propositos:
   *  1. obriga o modelo a apontar cada valor para UMA linha concreta, o que
   *     reduz o erro de "emprestar" o nome da contraparte vizinha;
   *  2. deixa o Estagio 3 descartar deterministicamente um lancamento repetido
   *     (duas transacoes ancoradas na MESMA linha = lancamento a mais).
   * null quando o input nao e texto numerado (imagem / documento nativo).
   */
  linha: number | null;
}

function stripCodeFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : t;
}

/**
 * Extrai o primeiro objeto JSON balanceado (tolerante a preambulo) e informa se
 * ele fechou de fato (balanced=false sinaliza TRUNCAMENTO — resposta cortada).
 */
function extractBalancedJson(text: string): { json: string; balanced: boolean } {
  const start = text.indexOf("{");
  if (start === -1) return { json: text, balanced: false };
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), balanced: true };
    }
  }
  // chegou ao fim sem fechar -> truncado
  return { json: text.slice(start), balanced: false };
}

function parseJsonObject(rawText: string): Record<string, unknown> {
  const { json } = extractBalancedJson(stripCodeFences(rawText));
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new AiError(
      "bad_schema",
      "A IA nao retornou um JSON valido (pode ter vindo truncado).",
    );
  }
  if (typeof obj !== "object" || obj === null) {
    throw new AiError("bad_schema", "Resposta da IA nao e um objeto JSON.");
  }
  return obj as Record<string, unknown>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function asIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Valida o cabecalho estruturado da Etapa 0. Tolerante — ausentes viram vazio. */
export function parseRecognitionJson(rawText: string): RecognitionGuide {
  const root = parseJsonObject(rawText);
  const excluir = Array.isArray(root.excluir)
    ? root.excluir.map((x) => asString(x)).filter(Boolean)
    : [];
  return {
    instituicao: asString(root.instituicao),
    numero: asString(root.numero),
    rotuloEntrada: asString(root.rotuloEntrada),
    rotuloSaida: asString(root.rotuloSaida),
    excluir,
    observacoes: asString(root.observacoes),
    periodoInicio: asString(root.periodoInicio),
    periodoFim: asString(root.periodoFim),
    regraValorSaldo: asString(root.regraValorSaldo) || asString(root.observacoes),
    posicaoContraparte: asString(root.posicaoContraparte),
    paginasAprox: asIntOrNull(root.paginasAprox),
  };
}

/** Coage o campo `valor` (numero >= 0) tolerando string "1.234,56". */
function coerceValor(v: unknown): number {
  return typeof v === "number"
    ? v
    : typeof v === "string"
      ? Number(v.replace(/\./g, "").replace(",", "."))
      : NaN;
}

/** Valida UMA transacao crua; lanca bad_schema com o indice se desviar. */
function validateTransaction(t: unknown, i: number): AiRawTransaction {
  if (typeof t !== "object" || t === null) {
    throw new AiError("bad_schema", `Transacao #${i + 1} nao e um objeto.`);
  }
  const r = t as Record<string, unknown>;
  if (typeof r.data !== "string" || !DATE_RE.test(r.data)) {
    throw new AiError(
      "bad_schema",
      `Transacao #${i + 1}: data invalida (esperado AAAA-MM-DD), recebido "${String(r.data)}".`,
    );
  }
  if (typeof r.descricao !== "string" || r.descricao.trim() === "") {
    throw new AiError("bad_schema", `Transacao #${i + 1}: descricao ausente.`);
  }
  if (r.direcao !== "entrada" && r.direcao !== "saida") {
    throw new AiError(
      "bad_schema",
      `Transacao #${i + 1}: direcao invalida (esperado "entrada"/"saida"), recebido "${String(r.direcao)}".`,
    );
  }
  const valorNum = coerceValor(r.valor);
  if (!Number.isFinite(valorNum) || valorNum < 0) {
    throw new AiError(
      "bad_schema",
      `Transacao #${i + 1}: valor invalido (esperado numero >= 0), recebido "${String(r.valor)}".`,
    );
  }
  let saldo: number | null = null;
  if (typeof r.saldoApos === "number" && Number.isFinite(r.saldoApos)) saldo = r.saldoApos;
  return {
    data: r.data,
    descricao: r.descricao.replace(/\s+/g, " ").trim(),
    direcao: r.direcao,
    valor: valorNum,
    saldoApos: saldo,
    linha: asIntOrNull(r.linha),
  };
}

/** Valida a lista de transacoes da Etapa 2 (de um trecho/pagina). */
export function parseExtractionTransactions(rawText: string): AiRawTransaction[] {
  const root = parseJsonObject(rawText);
  const arr = root.transacoes;
  if (!Array.isArray(arr)) {
    throw new AiError("bad_schema", 'Resposta da IA sem a lista "transacoes".');
  }
  return arr.map((t, i) => validateTransaction(t, i));
}

/**
 * Variante NAO-lancante da Etapa 2, usada pelo Estagio 2 do pipeline para
 * distinguir TRUNCAMENTO (JSON cortado -> vale subdividir e reprocessar so esta
 * particao) de outros erros de schema (vale retry simples).
 */
export type ExtractionParse =
  | { ok: true; txs: AiRawTransaction[] }
  | { ok: false; truncated: boolean; error: AiError };

export function tryParseExtraction(rawText: string): ExtractionParse {
  const { json, balanced } = extractBalancedJson(stripCodeFences(rawText));
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    // JSON ilegivel: se nao fechou as chaves, quase certamente foi truncado.
    return {
      ok: false,
      truncated: !balanced,
      error: new AiError(
        "bad_schema",
        balanced
          ? "A IA nao retornou um JSON valido."
          : "A IA retornou um JSON incompleto (resposta truncada).",
      ),
    };
  }
  if (typeof obj !== "object" || obj === null || !Array.isArray((obj as Record<string, unknown>).transacoes)) {
    return {
      ok: false,
      truncated: false,
      error: new AiError("bad_schema", 'Resposta da IA sem a lista "transacoes".'),
    };
  }
  try {
    const txs = ((obj as Record<string, unknown>).transacoes as unknown[]).map((t, i) =>
      validateTransaction(t, i),
    );
    return { ok: true, txs };
  } catch (e) {
    return { ok: false, truncated: false, error: e as AiError };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * PERFIL DA PLANILHA (estagio dedicado — prompts/profileWorkbook.ts)
 * ──────────────────────────────────────────────────────────────────────── */

export type AiColumnRole =
  | "data"
  | "descricao"
  | "categoria"
  | "fluxo"
  | "entrada"
  | "saida"
  | "saldo"
  | "ignorar";

const VALID_ROLES: AiColumnRole[] = [
  "data",
  "descricao",
  "categoria",
  "fluxo",
  "entrada",
  "saida",
  "saldo",
  "ignorar",
];

export interface AiProfiledColumn {
  letra: string;
  cabecalho: string;
  papel: AiColumnRole;
  podeEscrever: boolean;
  recebe: string;
}

export interface AiWorkbookProfile {
  linhaCabecalho: number | null;
  primeiraLinhaDados: number | null;
  colunas: AiProfiledColumn[];
  estiloDescricao: {
    caixa: "maiuscula" | "minuscula" | "mista";
    separador: string | null;
    observacao: string;
  };
  observacoes: string;
}

/** Valida o contrato de colunas devolvido pelo estagio de perfil. */
export function parseWorkbookProfileJson(rawText: string): AiWorkbookProfile {
  const root = parseJsonObject(rawText);
  const arr = root.colunas;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new AiError("bad_schema", 'Perfil da planilha sem a lista "colunas".');
  }
  const colunas: AiProfiledColumn[] = [];
  for (const [i, c] of arr.entries()) {
    if (typeof c !== "object" || c === null) {
      throw new AiError("bad_schema", `Coluna #${i + 1} do perfil nao e um objeto.`);
    }
    const r = c as Record<string, unknown>;
    const letra = asString(r.letra).toUpperCase().replace(/[^A-Z]/g, "");
    if (!letra) continue; // coluna sem letra util — descarta em vez de derrubar o perfil
    const papelRaw = asString(r.papel).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const papel = (VALID_ROLES as string[]).includes(papelRaw)
      ? (papelRaw as AiColumnRole)
      : "ignorar";
    colunas.push({
      letra,
      cabecalho: asString(r.cabecalho),
      papel,
      podeEscrever: r.podeEscrever === true,
      recebe: asString(r.recebe),
    });
  }
  if (colunas.length === 0) {
    throw new AiError("bad_schema", "Perfil da planilha sem nenhuma coluna valida.");
  }
  const estilo = (root.estiloDescricao ?? {}) as Record<string, unknown>;
  const caixaRaw = asString(estilo.caixa);
  return {
    linhaCabecalho: asIntOrNull(root.linhaCabecalho),
    primeiraLinhaDados: asIntOrNull(root.primeiraLinhaDados),
    colunas,
    estiloDescricao: {
      caixa:
        caixaRaw === "maiuscula" || caixaRaw === "minuscula" ? caixaRaw : "mista",
      separador: typeof estilo.separador === "string" && estilo.separador ? estilo.separador : null,
      observacao: asString(estilo.observacao),
    },
    observacoes: asString(root.observacoes),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * REGRAS DAS COLUNAS POR LISTAGEM (estagio dedicado — prompts/listColumns.ts)
 * ──────────────────────────────────────────────────────────────────────── */

export interface AiListOptionRule {
  /** a opcao, na grafia que o modelo devolveu (casada depois com a da planilha). */
  opcao: string;
  quandoUsar: string;
  direcao: "entrada" | "saida" | "ambas";
}

export interface AiListColumnRule {
  letra: string;
  orientacao: string;
  opcoes: AiListOptionRule[];
}

export interface AiListColumnsAnswer {
  colunas: AiListColumnRule[];
  observacoes: string;
}

/**
 * Valida a resposta do estagio de regras de listagem. TOLERANTE de proposito:
 * este estagio produz CONTEXTO, nao decisao. Uma dica malformada vira dica
 * vazia; o preenchimento continua limitado a lista real da planilha de
 * qualquer jeito. So a ausencia total de "colunas" e erro.
 */
export function parseListColumnsJson(rawText: string): AiListColumnsAnswer {
  const root = parseJsonObject(rawText);
  const arr = root.colunas;
  if (!Array.isArray(arr)) {
    throw new AiError("bad_schema", 'Resposta da IA sem a lista "colunas".');
  }
  const colunas: AiListColumnRule[] = [];
  for (const c of arr) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const letra = asString(r.letra).toUpperCase().replace(/[^A-Z]/g, "");
    if (!letra) continue;
    const opcoesRaw = Array.isArray(r.opcoes) ? r.opcoes : [];
    const opcoes: AiListOptionRule[] = [];
    for (const o of opcoesRaw) {
      if (typeof o !== "object" || o === null) continue;
      const ro = o as Record<string, unknown>;
      const opcao = asString(ro.opcao);
      if (!opcao.trim()) continue;
      const dir = asString(ro.direcao).toLowerCase();
      opcoes.push({
        opcao,
        quandoUsar: asString(ro.quandoUsar).trim(),
        direcao: dir === "entrada" || dir === "saida" ? dir : "ambas",
      });
    }
    colunas.push({ letra, orientacao: asString(r.orientacao).trim(), opcoes });
  }
  return { colunas, observacoes: asString(root.observacoes).trim() };
}

/* ────────────────────────────────────────────────────────────────────────
 * COLUNAS CALCULADAS (estagio dedicado — prompts/formulaColumns.ts)
 * ──────────────────────────────────────────────────────────────────────── */

export interface AiFormulaColumnRule {
  letra: string;
  tipo: "linha" | "acumulada" | "outra";
  perpetuar: boolean;
  motivo: string;
}

export interface AiFormulaColumnsAnswer {
  colunas: AiFormulaColumnRule[];
  observacoes: string;
}

/** Valida a resposta do estagio de colunas calculadas. */
export function parseFormulaColumnsJson(rawText: string): AiFormulaColumnsAnswer {
  const root = parseJsonObject(rawText);
  const arr = root.colunas;
  if (!Array.isArray(arr)) {
    throw new AiError("bad_schema", 'Resposta da IA sem a lista "colunas".');
  }
  const colunas: AiFormulaColumnRule[] = [];
  for (const c of arr) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const letra = asString(r.letra).toUpperCase().replace(/[^A-Z]/g, "");
    if (!letra) continue;
    const tipoRaw = asString(r.tipo).toLowerCase();
    colunas.push({
      letra,
      tipo: tipoRaw === "acumulada" || tipoRaw === "linha" ? tipoRaw : "outra",
      perpetuar: r.perpetuar === true,
      motivo: asString(r.motivo).trim(),
    });
  }
  return { colunas, observacoes: asString(root.observacoes).trim() };
}

/* ────────────────────────────────────────────────────────────────────────
 * CATEGORIZACAO (estagio dedicado — prompts/categorize.ts)
 * ──────────────────────────────────────────────────────────────────────── */

export interface AiCategoryAssignment {
  /** indice do item enviado no lote. */
  indice: number;
  /** categoria escolhida, exatamente como consta na lista, ou null. */
  categoria: string | null;
}

/** Valida a resposta do estagio de categorizacao. */
export function parseCategorizationJson(rawText: string): AiCategoryAssignment[] {
  const root = parseJsonObject(rawText);
  const arr = root.classificacoes;
  if (!Array.isArray(arr)) {
    throw new AiError("bad_schema", 'Resposta da IA sem a lista "classificacoes".');
  }
  const out: AiCategoryAssignment[] = [];
  for (const [i, item] of arr.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new AiError("bad_schema", `Classificacao #${i + 1} nao e um objeto.`);
    }
    const r = item as Record<string, unknown>;
    const indice = asIntOrNull(r.indice);
    if (indice == null) {
      throw new AiError("bad_schema", `Classificacao #${i + 1}: indice ausente.`);
    }
    const cat = asString(r.categoria).trim();
    out.push({ indice, categoria: cat ? cat : null });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * CONFERENCIA DE IDENTIDADE (estagio 4b — prompts/identity.ts)
 * ──────────────────────────────────────────────────────────────────────── */

export interface AiIdentityVerdict {
  /** indice do par (regra, candidato) enviado no lote. */
  indice: number;
  /** o nome observado e a mesma pessoa do nome cadastrado? */
  mesmaPessoa: boolean;
  /** justificativa curta — vai para o log e para o relatorio. */
  motivo: string;
}

/**
 * Valida a resposta do agente de identidade.
 *
 * `mesmaPessoa` so e verdadeiro quando vem o booleano `true`. String "true",
 * 1, "sim" e qualquer outra criatividade viram FALSE — nao por preguica de
 * coagir, mas porque a assimetria do estagio manda: na duvida (e um tipo
 * inesperado e duvida), o lancamento vai para o classificador em vez de
 * receber a categoria de outra pessoa.
 */
export function parseIdentityJson(rawText: string): AiIdentityVerdict[] {
  const root = parseJsonObject(rawText);
  const arr = root.veredictos;
  if (!Array.isArray(arr)) {
    throw new AiError("bad_schema", 'Resposta da IA sem a lista "veredictos".');
  }
  const out: AiIdentityVerdict[] = [];
  for (const [i, item] of arr.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new AiError("bad_schema", `Veredicto #${i + 1} nao e um objeto.`);
    }
    const r = item as Record<string, unknown>;
    const indice = asIntOrNull(r.indice);
    if (indice == null) {
      throw new AiError("bad_schema", `Veredicto #${i + 1}: indice ausente.`);
    }
    out.push({
      indice,
      mesmaPessoa: r.mesmaPessoa === true,
      motivo: asString(r.motivo).trim(),
    });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * JSON Schemas para Structured Outputs "na fonte" (backend nativo).
 * Espelham exatamente o que os validadores acima aceitam.
 * ──────────────────────────────────────────────────────────────────────── */

/** Schema estrito da conferencia de identidade. */
export const IDENTITY_JSON_SCHEMA = {
  name: "conferencia_identidade",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["veredictos"],
    properties: {
      veredictos: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["indice", "mesmaPessoa", "motivo"],
          properties: {
            indice: { type: "integer" },
            mesmaPessoa: { type: "boolean" },
            motivo: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** Schema estrito do perfil da planilha de destino. */
export const WORKBOOK_PROFILE_JSON_SCHEMA = {
  name: "perfil_planilha",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["linhaCabecalho", "primeiraLinhaDados", "colunas", "estiloDescricao", "observacoes"],
    properties: {
      linhaCabecalho: { type: ["integer", "null"] },
      primeiraLinhaDados: { type: ["integer", "null"] },
      colunas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["letra", "cabecalho", "papel", "podeEscrever", "recebe"],
          properties: {
            letra: { type: "string" },
            cabecalho: { type: "string" },
            papel: { type: "string", enum: VALID_ROLES },
            podeEscrever: { type: "boolean" },
            recebe: { type: "string" },
          },
        },
      },
      estiloDescricao: {
        type: "object",
        additionalProperties: false,
        required: ["caixa", "separador", "observacao"],
        properties: {
          caixa: { type: "string", enum: ["maiuscula", "minuscula", "mista"] },
          separador: { type: ["string", "null"] },
          observacao: { type: "string" },
        },
      },
      observacoes: { type: "string" },
    },
  },
} as const;

/** Schema estrito das regras das colunas por listagem. */
export const LIST_COLUMNS_JSON_SCHEMA = {
  name: "regras_colunas_listagem",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["colunas", "observacoes"],
    properties: {
      colunas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["letra", "orientacao", "opcoes"],
          properties: {
            letra: { type: "string" },
            orientacao: { type: "string" },
            opcoes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["opcao", "quandoUsar", "direcao"],
                properties: {
                  opcao: { type: "string" },
                  quandoUsar: { type: "string" },
                  direcao: { type: "string", enum: ["entrada", "saida", "ambas"] },
                },
              },
            },
          },
        },
      },
      observacoes: { type: "string" },
    },
  },
} as const;

/** Schema estrito da analise das colunas calculadas. */
export const FORMULA_COLUMNS_JSON_SCHEMA = {
  name: "colunas_calculadas",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["colunas", "observacoes"],
    properties: {
      colunas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["letra", "tipo", "perpetuar", "motivo"],
          properties: {
            letra: { type: "string" },
            tipo: { type: "string", enum: ["linha", "acumulada", "outra"] },
            perpetuar: { type: "boolean" },
            motivo: { type: "string" },
          },
        },
      },
      observacoes: { type: "string" },
    },
  },
} as const;

/** Schema estrito do lote de categorizacao. */
export const CATEGORIZATION_JSON_SCHEMA = {
  name: "classificacao_lancamentos",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["classificacoes"],
    properties: {
      classificacoes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["indice", "categoria"],
          properties: {
            indice: { type: "integer" },
            categoria: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

/** Schema estrito do cabecalho estruturado (Etapa 0). */
export const RECOGNITION_JSON_SCHEMA = {
  name: "cabecalho_extrato",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "instituicao",
      "numero",
      "rotuloEntrada",
      "rotuloSaida",
      "excluir",
      "observacoes",
      "periodoInicio",
      "periodoFim",
      "regraValorSaldo",
      "posicaoContraparte",
      "paginasAprox",
    ],
    properties: {
      instituicao: { type: "string" },
      numero: { type: "string" },
      rotuloEntrada: { type: "string" },
      rotuloSaida: { type: "string" },
      excluir: { type: "array", items: { type: "string" } },
      observacoes: { type: "string" },
      periodoInicio: { type: "string" },
      periodoFim: { type: "string" },
      regraValorSaldo: { type: "string" },
      posicaoContraparte: { type: "string" },
      paginasAprox: { type: ["integer", "null"] },
    },
  },
} as const;

/** Schema estrito da lista de transacoes de UMA particao (Etapa 2). */
export const EXTRACTION_JSON_SCHEMA = {
  name: "transacoes_particao",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["transacoes"],
    properties: {
      transacoes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["data", "descricao", "direcao", "valor", "saldoApos", "linha"],
          properties: {
            data: { type: "string" },
            descricao: { type: "string" },
            direcao: { type: "string", enum: ["entrada", "saida"] },
            valor: { type: "number" },
            saldoApos: { type: ["number", "null"] },
            linha: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
} as const;
