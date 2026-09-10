import {
  ListColumnRule,
  ListSource,
  ListUsageExample,
  optionKey,
} from "../../domain/listColumns";
import { unescapeXml, readCellRaw, colToNum, numToCol } from "./xmlCells";

/**
 * INSPECAO DETERMINISTICA DAS COLUNAS POR LISTAGEM — sem IA e sem custo.
 *
 * Le a validacao de dados (`<dataValidation type="list">`, na forma classica e
 * na forma x14 dentro de `<extLst>`, que e a que o Excel moderno grava quando a
 * lista aponta para outra aba) e resolve a lista de opcoes de verdade: seja um
 * intervalo (`Categorias!$A:$A`) seja uma lista escrita na propria formula
 * (`"Sim,Nao"`).
 *
 * Quando NAO ha validacao formal, ainda tentamos: uma coluna de texto em que
 * poucos valores distintos se repetem muito e, na pratica, uma coluna de
 * listagem — so que mantida na mao. Reconhecer isso e o que faz o sistema
 * funcionar em planilhas que nao sao a Cantina Bom Prato.
 *
 * REGRA DE OURO deste modulo: as opcoes saem daqui com a grafia EXATA do
 * arquivo. Nenhum `trim()`. `"Salário "` tem um espaco no fim na planilha real,
 * e e com o espaco que o VLOOKUP da coluna Fluxo de Caixa casa.
 */

export interface SheetSource {
  name: string;
  xml: string;
}

export interface DetectedValidation {
  /** letra da coluna validada. */
  column: string;
  /** primeira e ultima linha cobertas pela validacao. */
  firstRow: number;
  lastRow: number;
  /** referencia crua da origem das opcoes. */
  ref: string | null;
  /** opcoes escritas direto na formula (validacao inline). */
  inlineOptions: string[] | null;
  /** intervalo textual original (ex.: "D13:D254"). */
  sqref: string;
  /** true quando veio do `<extLst>` (x14) em vez do `<dataValidations>` classico. */
  x14: boolean;
}

const MAX_OPTIONS = 400;

/* ────────────────────────────────────────────────────────────────────────
 * Leitura das validacoes de uma aba
 * ──────────────────────────────────────────────────────────────────────── */

function* iterRows(xml: string): Generator<{ r: number; xml: string }> {
  const re = /<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) yield { r: Number(m[1]), xml: m[0] };
}

/** Quebra um `sqref` ("D13:D254 F13:F20") nas colunas/linhas que ele cobre. */
function parseSqref(sqref: string): Array<{ column: string; firstRow: number; lastRow: number }> {
  const out: Array<{ column: string; firstRow: number; lastRow: number }> = [];
  for (const parte of sqref.trim().split(/\s+/)) {
    const m = parte.match(/^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i);
    if (!m) continue;
    const c1 = colToNum(m[1].toUpperCase());
    const c2 = m[3] ? colToNum(m[3].toUpperCase()) : c1;
    const r1 = Number(m[2]);
    const r2 = m[4] ? Number(m[4]) : r1;
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      out.push({ column: numToCol(c), firstRow: Math.min(r1, r2), lastRow: Math.max(r1, r2) });
    }
  }
  return out;
}

/** Lista escrita direto na formula da validacao: `"Sim,Nao,Talvez"`. */
function parseInlineList(formula: string): string[] | null {
  const t = formula.trim();
  const m = t.match(/^"([\s\S]*)"$/);
  if (!m) return null;
  // aspas duplicadas ("") representam uma aspa literal dentro da lista
  return m[1]
    .replace(/""/g, '"')
    .split(",")
    .filter((s) => s.length > 0);
}

/** Todas as validacoes do tipo lista de uma aba (classicas + x14). */
export function detectValidations(sheetXml: string): DetectedValidation[] {
  const out: DetectedValidation[] = [];

  // forma classica: sqref e ATRIBUTO, formula1 e filho
  for (const m of sheetXml.matchAll(
    /<dataValidation\b([^>]*type="list"[^>]*)>([\s\S]*?)<\/dataValidation>/g,
  )) {
    const attrs = m[1];
    const sqref = attrs.match(/\ssqref="([^"]+)"/)?.[1];
    if (!sqref) continue;
    const f1 = m[2].match(/<formula1[^>]*>([\s\S]*?)<\/formula1>/)?.[1] ?? "";
    push(out, sqref, unescapeXml(f1), false);
  }

  // forma x14 (dentro de <extLst>): sqref e ELEMENTO <xm:sqref>
  for (const m of sheetXml.matchAll(
    /<x14:dataValidation\b[^>]*type="list"[^>]*>([\s\S]*?)<\/x14:dataValidation>/g,
  )) {
    const bloco = m[1];
    const sqref = bloco.match(/<xm:sqref>([\s\S]*?)<\/xm:sqref>/)?.[1];
    if (!sqref) continue;
    const f1 = bloco.match(/<xm:f>([\s\S]*?)<\/xm:f>/)?.[1] ?? "";
    push(out, sqref, unescapeXml(f1), true);
  }

  return out;
}

function push(out: DetectedValidation[], sqref: string, formula1: string, x14: boolean): void {
  const inline = parseInlineList(formula1);
  for (const faixa of parseSqref(sqref)) {
    out.push({
      column: faixa.column,
      firstRow: faixa.firstRow,
      lastRow: faixa.lastRow,
      ref: inline ? null : formula1.trim() || null,
      inlineOptions: inline,
      sqref,
      x14,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Resolucao das opcoes a partir da referencia
 * ──────────────────────────────────────────────────────────────────────── */

function cellText(rowXml: string, ref: string, shared: string[]): string {
  const raw = readCellRaw(rowXml, ref);
  if (raw.value == null) return "";
  if (raw.type === "s") return shared[Number(raw.value)] ?? "";
  return raw.value; // inlineStr ja vem resolvido por readCellRaw
}

/**
 * Le os valores de um intervalo de UMA coluna (`Categorias!$A:$A`,
 * `$A$2:$A$38`, `Plan1!A1:A20`). Devolve os textos NA ORDEM e SEM tocar na
 * grafia. `null` quando a referencia nao e um intervalo de coluna unica.
 */
export function readRangeOptions(
  ref: string,
  sheets: SheetSource[],
  shared: string[],
  currentSheet: string,
): { values: string[]; sheetName: string } | null {
  const limpo = ref.replace(/^=/, "").trim();
  const m = limpo.match(
    /^(?:'([^']+)'|([A-Za-z0-9_À-ÿ .]+))?!?\$?([A-Z]{1,3})(?:\$?(\d+))?(?::\$?([A-Z]{1,3})(?:\$?(\d+))?)?$/,
  );
  if (!m) return null;
  const nomeAba = (m[1] ?? m[2] ?? "").trim() || currentSheet;
  const col1 = m[3].toUpperCase();
  const col2 = (m[5] ?? m[3]).toUpperCase();
  if (col1 !== col2) return null; // so intervalos de coluna unica
  const de = m[4] ? Number(m[4]) : 1;
  const ate = m[6] ? Number(m[6]) : Number.MAX_SAFE_INTEGER;

  const aba = sheets.find((s) => s.name === nomeAba) ?? sheets.find((s) => s.name.trim() === nomeAba);
  if (!aba) return null;

  const values: string[] = [];
  for (const row of iterRows(aba.xml)) {
    if (row.r < de || row.r > ate) continue;
    const texto = cellText(row.xml, `${col1}${row.r}`, shared);
    if (texto === "" || !texto.trim()) continue;
    values.push(texto); // <- grafia EXATA, sem trim
    if (values.length >= MAX_OPTIONS) break;
  }
  return { values, sheetName: aba.name };
}

/**
 * Remove o cabecalho do intervalo quando ele foi incluido por preguica de
 * referencia (`Categorias!$A:$A` pega a linha 1, que diz "CATEGORIA").
 * So descarta o PRIMEIRO valor, e so quando ele e claramente um rotulo.
 */
function dropHeaderOption(values: string[], columnHeader: string): string[] {
  if (values.length === 0) return values;
  const primeiro = optionKey(values[0]);
  const rotulos = new Set([
    optionKey(columnHeader),
    optionKey(columnHeader + "s"),
    "CATEGORIA",
    "CATEGORIAS",
    "OPCAO",
    "OPCOES",
    "ITEM",
    "ITENS",
    "TIPO",
    "TIPOS",
    "LISTA",
  ]);
  return rotulos.has(primeiro) ? values.slice(1) : values;
}

/* ────────────────────────────────────────────────────────────────────────
 * Listagem inferida do conteudo (planilhas sem validacao formal)
 * ──────────────────────────────────────────────────────────────────────── */

/** Uma coluna e "de listagem de fato" quando poucos valores cobrem quase tudo. */
function inferListFromContent(
  valores: string[],
): { options: string[]; confiante: boolean } {
  if (valores.length < 8) return { options: [], confiante: false };
  const contagem = new Map<string, { exato: string; n: number }>();
  for (const v of valores) {
    const k = optionKey(v);
    if (!k) continue;
    const atual = contagem.get(k);
    if (atual) atual.n++;
    else contagem.set(k, { exato: v, n: 1 });
  }
  const distintos = contagem.size;
  if (distintos === 0 || distintos > 60) return { options: [], confiante: false };
  const repetidos = [...contagem.values()].filter((c) => c.n > 1);
  const coberturaRepetida = repetidos.reduce((a, c) => a + c.n, 0) / valores.length;
  // poucos valores distintos, e a maioria das linhas usa um valor repetido
  const confiante = distintos <= valores.length / 3 && coberturaRepetida >= 0.6;
  const options = [...contagem.values()].sort((a, b) => b.n - a.n).map((c) => c.exato);
  return { options, confiante };
}

/* ────────────────────────────────────────────────────────────────────────
 * Montagem das regras
 * ──────────────────────────────────────────────────────────────────────── */

export interface ListDetectionInput {
  sheets: SheetSource[];
  shared: string[];
  /** abas de lancamento a considerar (as demais so servem de origem de lista). */
  dataSheets: string[];
  /** letra -> cabecalho, lidos da aba de amostra. */
  headers: Map<string, string>;
  firstDataRow: number;
  /** coluna de descricao, usada para montar os exemplos de uso. */
  descriptionColumn: string | null;
  /** colunas de entrada/saida, usadas para saber a direcao dos exemplos. */
  entradaColumn?: string | null;
  saidaColumn?: string | null;
  /** colunas que sabidamente sao calculadas (nunca sao "de listagem"). */
  formulaColumns?: string[];
  /**
   * Colunas cujo papel ja e conhecido e NAO e de listagem (data, valor,
   * descricao…). Elas continuam valendo se tiverem validacao formal, mas nunca
   * entram por inferencia de conteudo — senao uma coluna de data guardada como
   * texto vira "lista de 31 opcoes", que foi exatamente o que aconteceu.
   */
  excludeFromInference?: string[];
}

/**
 * Descobre as colunas preenchidas por listagem e devolve a regra de cada uma,
 * ja com exemplos reais de uso lidos da propria planilha. Nao chama IA.
 */
export function detectListColumns(input: ListDetectionInput): ListColumnRule[] {
  const {
    sheets,
    shared,
    dataSheets,
    headers,
    firstDataRow,
    descriptionColumn,
    entradaColumn,
    saidaColumn,
  } = input;
  const calculadas = new Set(input.formulaColumns ?? []);
  const semInferencia = new Set(input.excludeFromInference ?? []);

  interface Acc {
    letter: string;
    options: string[];
    source: ListSource;
    sourceRef: string | null;
    appliesTo: string | null;
    sheets: Set<string>;
    valores: string[]; // conteudo real observado (para inferencia e exemplos)
    examples: ListUsageExample[];
  }
  const porColuna = new Map<string, Acc>();
  const ensure = (letter: string): Acc => {
    let a = porColuna.get(letter);
    if (!a) {
      a = {
        letter,
        options: [],
        source: "conteudo",
        sourceRef: null,
        appliesTo: null,
        sheets: new Set(),
        valores: [],
        examples: [],
      };
      porColuna.set(letter, a);
    }
    return a;
  };

  // 1) validacoes formais, aba por aba
  for (const aba of sheets) {
    if (!dataSheets.includes(aba.name)) continue;
    for (const v of detectValidations(aba.xml)) {
      if (v.lastRow < firstDataRow) continue; // validacao de area de cabecalho
      if (calculadas.has(v.column)) continue;
      const a = ensure(v.column);
      a.sheets.add(aba.name);
      a.appliesTo = a.appliesTo ?? v.sqref;
      if (a.options.length > 0) continue; // ja resolvida por outra aba
      if (v.inlineOptions) {
        a.options = v.inlineOptions;
        a.source = "validacao-inline";
        a.sourceRef = null;
      } else if (v.ref) {
        const lidas = readRangeOptions(v.ref, sheets, shared, aba.name);
        if (lidas && lidas.values.length) {
          a.options = dropHeaderOption(lidas.values, headers.get(v.column) ?? "");
          a.source = "validacao-intervalo";
          a.sourceRef = v.ref;
        }
      }
    }
  }

  // 2) conteudo real das abas de lancamento (exemplos + inferencia)
  for (const aba of sheets) {
    if (!dataSheets.includes(aba.name)) continue;
    for (const row of iterRows(aba.xml)) {
      if (row.r < firstDataRow) continue;
      const contexto = descriptionColumn
        ? cellText(row.xml, `${descriptionColumn}${row.r}`, shared).trim()
        : "";
      const entrada = entradaColumn
        ? cellText(row.xml, `${entradaColumn}${row.r}`, shared).trim()
        : "";
      const saida = saidaColumn ? cellText(row.xml, `${saidaColumn}${row.r}`, shared).trim() : "";
      const direcao: ListUsageExample["direcao"] = saida ? "saida" : entrada ? "entrada" : null;

      for (const [letter, header] of headers) {
        if (calculadas.has(letter)) continue;
        const raw = readCellRaw(row.xml, `${letter}${row.r}`);
        if (raw.value == null || raw.value === "") continue;
        const ehTexto = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
        if (!ehTexto) continue;
        const texto = raw.type === "s" ? (shared[Number(raw.value)] ?? "") : raw.value;
        if (!texto.trim()) continue;
        // colunas candidatas: as que ja tem validacao formal, ou uma coluna de
        // texto de papel desconhecido (a descricao e sempre unica por linha, e
        // data/valor tem papel conhecido — nenhuma das duas e listagem)
        if (!porColuna.has(letter) && (letter === descriptionColumn || semInferencia.has(letter))) {
          continue;
        }
        const a = ensure(letter);
        void header;
        a.sheets.add(aba.name);
        a.valores.push(texto);
        if (a.examples.length < 60 && contexto) {
          a.examples.push({ contexto, opcao: texto, direcao });
        }
      }
    }
  }

  const regras: ListColumnRule[] = [];
  for (const a of porColuna.values()) {
    let options = a.options;
    let source = a.source;
    if (options.length === 0) {
      const inferida = inferListFromContent(a.valores);
      if (!inferida.confiante) continue; // coluna de texto livre — nao e listagem
      options = inferida.options;
      source = "conteudo";
    }
    if (options.length === 0) continue;
    // exemplos so valem se a opcao usada existir na lista
    const validos = new Set(options.map(optionKey));
    const examples = a.examples.filter((e) => validos.has(optionKey(e.opcao)));
    regras.push({
      letter: a.letter,
      header: headers.get(a.letter) ?? "",
      options,
      source,
      sourceRef: a.sourceRef,
      appliesTo: a.appliesTo,
      sheets: [...a.sheets],
      examples: dedupeExamples(examples),
      orientacao: "",
      dicaPorOpcao: {},
    });
  }
  return regras.sort((x, y) => x.letter.localeCompare(y.letter));
}

/** Um exemplo por par (contexto, opcao) — o prompt nao ganha nada com repeticao. */
function dedupeExamples(examples: ListUsageExample[]): ListUsageExample[] {
  const vistos = new Set<string>();
  const out: ListUsageExample[] = [];
  for (const e of examples) {
    const k = `${optionKey(e.contexto)}|${optionKey(e.opcao)}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(e);
    if (out.length >= 30) break;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Manutencao da validacao ao escrever abaixo do intervalo original
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Amplia o intervalo da validacao de lista da coluna `column` ate `lastRow`.
 *
 * Sem isso, gravar na linha 260 de uma aba cuja validacao vai so ate a 254
 * produz uma celula com o texto certo mas SEM a lista suspensa — o usuario abre
 * a planilha e a linha nova nao se comporta como as outras. Mexe apenas no
 * atributo `sqref` (ou no `<xm:sqref>`, na forma x14): nenhuma celula, formula
 * ou merge e tocado.
 */
export function extendValidationRange(xml: string, column: string, lastRow: number): string {
  const estender = (sqref: string): string =>
    sqref
      .trim()
      .split(/\s+/)
      .map((parte) => {
        const m = parte.match(/^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i);
        if (!m) return parte;
        const c1 = m[1].toUpperCase();
        const c2 = (m[3] ?? m[1]).toUpperCase();
        if (c1 !== column || c2 !== column) return parte;
        const r1 = Number(m[2]);
        const r2 = m[4] ? Number(m[4]) : r1;
        if (Math.max(r1, r2) >= lastRow) return parte;
        return `${c1}${Math.min(r1, r2)}:${c2}${lastRow}`;
      })
      .join(" ");

  // forma classica: `sqref` e atributo da propria tag
  let out = xml.replace(/<dataValidation\b[^>]*type="list"[^>]*>/g, (tag) =>
    tag.replace(/\ssqref="([^"]+)"/, (_a, sq: string) => ` sqref="${estender(sq)}"`),
  );

  // forma x14: `sqref` e um elemento dentro do bloco
  out = out.replace(
    /(<x14:dataValidation\b[^>]*type="list"[^>]*>[\s\S]*?<xm:sqref>)([\s\S]*?)(<\/xm:sqref>)/g,
    (_todo, abre: string, sq: string, fecha: string) => `${abre}${estender(sq)}${fecha}`,
  );

  return out;
}
