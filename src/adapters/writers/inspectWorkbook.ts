import JSZip from "jszip";
import { Money } from "../../domain/money";
import { isSupportSheet } from "../../domain/competence";
import { unescapeXml, readCellRaw, readCellDate } from "./xmlCells";
import {
  DateOrderEvidence,
  combineDateOrder,
  detectDateOrder,
} from "../../domain/dateOrder";
import { buildStyleFormats, formatKind, formatCode, StyleFormat } from "./numberFormats";
import { detectListColumns } from "./inspectValidations";
import { detectFormulaColumns, mergeFormulaRules } from "./inspectFormulas";
import { ListColumnRule, listColumnsToPromptDump } from "../../domain/listColumns";
import { FormulaColumnRule, formulaColumnsToPromptDump } from "../../domain/formulaColumns";

/**
 * INSPECAO DETERMINISTICA de um .xlsx — passo 1 do perfil da planilha.
 *
 * Le a estrutura real do arquivo (abas, linha de cabecalho, o que cada coluna
 * contem, formatos, formulas, categorias validas, como as descricoes ja estao
 * escritas) SEM chamar IA e sem custo. Na maioria das vezes isso ja basta: a
 * planilha e a de sempre e o perfil sai daqui pronto. So quando esta leitura
 * fica inconclusiva e que vale gastar uma chamada de modelo — e ai o que vai no
 * prompt e este dump, nao o arquivo inteiro.
 */

const MESES = [
  "JANEIRO",
  "FEVEREIRO",
  "MARÇO",
  "MARCO",
  "ABRIL",
  "MAIO",
  "JUNHO",
  "JULHO",
  "AGOSTO",
  "SETEMBRO",
  "OUTUBRO",
  "NOVEMBRO",
  "DEZEMBRO",
];

export type CellKind = "date" | "money" | "text" | "number" | "formula" | "empty";

export interface InspectedColumn {
  letter: string;
  header: string;
  hasFormula: boolean;
  kind: CellKind;
  /** conteudo real ja formatado como o usuario ve (ate 5 amostras). */
  samples: string[];
  /** codigo de formato numerico observado (ex.: "dd/mm/yyyy", "R$ #,##0.00"). */
  numFmt: string | null;
  /** quantas linhas de dados tem algum conteudo nesta coluna. */
  filled: number;
}

export interface WorkbookInspection {
  sheetNames: string[];
  monthSheets: string[];
  supportSheets: string[];
  /** aba usada como amostra da estrutura. */
  sampleSheet: string | null;
  headerRow: number | null;
  firstDataRow: number | null;
  columns: InspectedColumn[];
  /** categorias validas (aba `Categorias`, coluna A) — vazio se nao houver. */
  categories: string[];
  /** descricoes ja gravadas, para o sistema copiar o estilo do usuario. */
  descriptionSamples: string[];
  /** linhas de dados com conteudo na aba de amostra. */
  filledRows: number;
  /**
   * Colunas preenchidas por LISTAGEM (dropdown), com as opcoes na grafia exata
   * da planilha e exemplos reais de uso. Vazio quando nao ha nenhuma.
   */
  listColumns: ListColumnRule[];
  /**
   * Colunas preenchidas por FORMULA, com a formula-modelo a ser repetida nas
   * linhas novas. Consolidado de todas as abas de lancamento.
   */
  formulaColumns: FormulaColumnRule[];
  /**
   * ORDEM DAS DATAS praticada pela planilha (todas as abas de lancamento
   * somadas). E o que diz ao writer se a linha nova pertence ao topo, ao meio
   * ou ao fim da aba.
   */
  dateOrder: DateOrderEvidence;
  /** a mesma evidencia, aba a aba — uma aba pode divergir da planilha. */
  dateOrderBySheet: Record<string, DateOrderEvidence>;
  warnings: string[];
}

/** Vocabulario de cabecalho -> papel provavel (comparacao sem acento/caixa). */
const HEADER_HINTS: Array<{ role: string; words: string[] }> = [
  { role: "data", words: ["DATA", "DT", "DIA", "DATA LANCAMENTO", "DATA DO LANCAMENTO"] },
  {
    role: "descricao",
    words: ["DESCRICAO", "HISTORICO", "LANCAMENTO", "DETALHE", "DISCRIMINACAO", "MEMO"],
  },
  { role: "categoria", words: ["CATEGORIA", "CLASSIFICACAO", "PLANO DE CONTAS", "CONTA"] },
  { role: "fluxo", words: ["FLUXO DE CAIXA", "FLUXO", "GRUPO", "TIPO DE FLUXO"] },
  { role: "entrada", words: ["ENTRADA", "ENTRADAS", "CREDITO", "RECEITA", "RECEBIMENTO"] },
  { role: "saida", words: ["SAIDA", "SAIDAS", "DEBITO", "DESPESA", "PAGAMENTO"] },
  { role: "saldo", words: ["SALDO", "SALDO ACUMULADO", "SALDO CORRENTE"] },
];

export function normalizeHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Papel sugerido por um texto de cabecalho (null quando nao reconhecido). */
export function roleFromHeader(header: string): string | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const hint of HEADER_HINTS) {
    if (hint.words.some((w) => h === w)) return hint.role;
  }
  for (const hint of HEADER_HINTS) {
    if (hint.words.some((w) => h.includes(w))) return hint.role;
  }
  return null;
}

function colLetter(ref: string): string {
  return ref.replace(/\d+/g, "");
}

function* iterRows(xml: string): Generator<{ r: number; xml: string }> {
  const re = /<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) yield { r: Number(m[1]), xml: m[0] };
}

function* iterCells(rowXml: string): Generator<{ ref: string; raw: string }> {
  const re = /<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml))) yield { ref: m[1], raw: m[0] };
}

function displaySample(kind: CellKind, value: string, text: string): string {
  const n = Number(value);
  if (kind === "date" && Number.isFinite(n)) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  }
  if (kind === "money" && Number.isFinite(n)) {
    return Money.fromCents(Math.round(Math.abs(n) * 100)).format();
  }
  return text;
}

interface SheetSource {
  name: string;
  xml: string;
}

async function loadSheets(zip: JSZip): Promise<{ sheets: SheetSource[]; order: string[] }> {
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = relsFile ? await relsFile.async("string") : "";
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*worksheets\/sheet\d+\.xml)"/g)) {
    relMap.set(m[1], "xl/" + m[2].replace(/^\/?xl\//, ""));
  }
  const sheets: SheetSource[] = [];
  const order: string[] = [];
  for (const m of workbook.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)) {
    const name = unescapeXml(m[1]);
    order.push(name);
    const file = relMap.get(m[2]);
    const f = file ? zip.file(file) : null;
    if (f) sheets.push({ name, xml: await f.async("string") });
  }
  return { sheets, order };
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const sst = zip.file("xl/sharedStrings.xml");
  if (!sst) return [];
  const xml = await sst.async("string");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(""),
  );
}

function cellText(rowXml: string, ref: string, shared: string[]): string {
  const raw = readCellRaw(rowXml, ref);
  if (raw.value == null) return "";
  if (raw.type === "s") return shared[Number(raw.value)] ?? "";
  return raw.value;
}

/** Encontra a linha de cabecalho: a que mais casa com o vocabulario conhecido. */
function findHeaderRow(xml: string, shared: string[]): { row: number; score: number } | null {
  let best: { row: number; score: number } | null = null;
  for (const row of iterRows(xml)) {
    if (row.r > 40) break;
    let score = 0;
    let filled = 0;
    const seen = new Set<string>();
    for (const cell of iterCells(row.xml)) {
      const text = cellText(row.xml, cell.ref, shared);
      if (!text.trim()) continue;
      filled++;
      const role = roleFromHeader(text);
      if (role && !seen.has(role)) {
        seen.add(role);
        score++;
      }
    }
    if (filled >= 3 && score >= 3 && (!best || score > best.score)) best = { row: row.r, score };
  }
  return best;
}

/** Inspeciona o .xlsx e devolve tudo o que da para saber SEM IA. */
export async function inspectWorkbook(bytes: Uint8Array): Promise<WorkbookInspection> {
  const zip = await JSZip.loadAsync(bytes);
  const { sheets, order } = await loadSheets(zip);
  const shared = await loadSharedStrings(zip);
  const stylesFile = zip.file("xl/styles.xml");
  const styleFormats: StyleFormat[] = stylesFile
    ? buildStyleFormats(await stylesFile.async("string"))
    : [];

  const warnings: string[] = [];
  const monthSheets = order.filter((n) => MESES.includes(normalizeHeader(n)));
  const supportSheets = order.filter((n) => isSupportSheet(n));

  // aba de amostra: a primeira aba de mes COM dados; senao a primeira de mes;
  // senao a primeira aba que nao seja de apoio.
  const candidates = [
    ...sheets.filter((s) => monthSheets.includes(s.name)),
    ...sheets.filter((s) => !isSupportSheet(s.name) && !monthSheets.includes(s.name)),
  ];
  // Preferimos a aba com MAIS lancamentos ja gravados: e dela que saem as
  // amostras de conteudo e o estilo das descricoes que o sistema vai imitar.
  // Uma aba vazia identifica o cabecalho mas nao ensina nada sobre o padrao.
  let sample: SheetSource | null = null;
  let header: { row: number; score: number } | null = null;
  let bestRows = -1;
  for (const s of candidates) {
    const h = findHeaderRow(s.xml, shared);
    if (!h) continue;
    let rows = 0;
    for (const r of iterRows(s.xml)) {
      if (r.r <= h.row) continue;
      for (const c of iterCells(r.xml)) {
        if (!/<f[\s>]/.test(c.raw) && /<v>|<is>/.test(c.raw)) {
          rows++;
          break;
        }
      }
      if (rows > 200) break; // ja e amostra mais que suficiente
    }
    if (rows > bestRows) {
      bestRows = rows;
      sample = s;
      header = h;
    }
  }

  if (!sample || !header) {
    warnings.push(
      "Nao foi possivel localizar a linha de cabecalho por conta propria nesta planilha.",
    );
    return {
      sheetNames: order,
      monthSheets,
      supportSheets,
      sampleSheet: sample?.name ?? null,
      headerRow: null,
      firstDataRow: null,
      columns: [],
      categories: await readCategories(sheets, shared),
      descriptionSamples: [],
      filledRows: 0,
      listColumns: [],
      formulaColumns: [],
      dateOrder: combineDateOrder([]),
      dateOrderBySheet: {},
      warnings,
    };
  }

  const headerRow = header.row;
  const firstDataRow = headerRow + 1;

  // cabecalhos por coluna
  const headers = new Map<string, string>();
  const headerRowXml = [...iterRows(sample.xml)].find((r) => r.r === headerRow)?.xml ?? "";
  for (const cell of iterCells(headerRowXml)) {
    const text = cellText(headerRowXml, cell.ref, shared).trim();
    if (text) headers.set(colLetter(cell.ref), text);
  }

  // conteudo das linhas de dados
  interface Acc {
    formulas: number;
    dates: number;
    moneys: number;
    numbers: number;
    texts: number;
    samples: string[];
    numFmt: string | null;
    filled: number;
  }
  const acc = new Map<string, Acc>();
  const ensure = (c: string): Acc => {
    let a = acc.get(c);
    if (!a) {
      a = { formulas: 0, dates: 0, moneys: 0, numbers: 0, texts: 0, samples: [], numFmt: null, filled: 0 };
      acc.set(c, a);
    }
    return a;
  };
  for (const c of headers.keys()) ensure(c);

  let filledRows = 0;
  let scanned = 0;
  for (const row of iterRows(sample.xml)) {
    if (row.r < firstDataRow) continue;
    if (scanned >= 400) break;
    scanned++;
    let rowHasData = false;
    for (const cell of iterCells(row.xml)) {
      const letter = colLetter(cell.ref);
      const a = ensure(letter);
      const isFormula = /<f[\s>]/.test(cell.raw);
      if (isFormula) a.formulas++;
      const raw = readCellRaw(row.xml, cell.ref);
      const styleNum = raw.styleNum ? Number(raw.styleNum) : null;
      const fmt = styleNum != null ? styleFormats[styleNum] : undefined;
      if (fmt && !a.numFmt) a.numFmt = formatCode(fmt) || null;
      if (raw.value == null || raw.value === "") continue;
      // t="s"/"inlineStr"/"str" => o <v> e INDICE de sharedString, nao um numero.
      // Confundir isso faz uma data virar 29/04/1900 e um valor virar centavos
      // aleatorios — o mesmo engano que quebrava o dedup na leitura das abas.
      const isText = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
      const text = raw.type === "s" ? (shared[Number(raw.value)] ?? "") : raw.value;
      if (!text.trim()) continue;
      a.filled++;
      if (!isFormula) rowHasData = true;
      const fmtKind = isText ? null : formatKind(fmt);
      let kind: CellKind;
      if (isFormula) kind = "formula";
      else if (fmtKind) kind = fmtKind;
      else if (!isText && Number.isFinite(Number(raw.value))) kind = "number";
      else kind = "text";
      if (kind === "date") a.dates++;
      else if (kind === "money") a.moneys++;
      else if (kind === "number") a.numbers++;
      else if (kind === "text") a.texts++;
      if (a.samples.length < 5 && !isFormula) {
        const s = displaySample(kind === "formula" ? "text" : kind, raw.value, text);
        if (s.trim()) a.samples.push(s.trim());
      }
    }
    if (rowHasData) filledRows++;
  }

  const columns: InspectedColumn[] = [...headers.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, headerText]) => {
      const a = ensure(letter);
      const kind: CellKind = a.formulas > 0 && a.filled === 0
        ? "formula"
        : a.dates > 0
          ? "date"
          : a.moneys > 0
            ? "money"
            : a.texts > 0
              ? "text"
              : a.numbers > 0
                ? "number"
                : a.formulas > 0
                  ? "formula"
                  : "empty";
      return {
        letter,
        header: headerText,
        hasFormula: a.formulas > 0,
        kind,
        samples: a.samples,
        numFmt: a.numFmt,
        filled: a.filled,
      };
    });

  // DESCRICOES JA GRAVADAS — o modelo de escrita que os proximos estagios imitam.
  //
  // Duas correcoes que valeram muito mais do que parecem:
  //
  //  (a) A COLUNA VEM DO PAPEL, nao do palpite. Antes pegavamos "a coluna de
  //      texto mais preenchida", e nesta planilha isso e a coluna DATA — que
  //      guarda "31/05/2026" como texto e tem mais celulas preenchidas que a
  //      descricao. O resultado era o prompt de extracao recebendo cinco datas
  //      como "exemplos de descricao" e nao aprendendo padrao nenhum.
  //  (b) A AMOSTRA VEM DA ABA MAIS RECENTE com dados, nao da com mais linhas.
  //      Quem dita o padrao e o que o cliente escreve HOJE. Nesta planilha as
  //      abas antigas trazem so o nome da pessoa e a ultima traz
  //      "Pix - NOME" / "Maquininha - NOME" — e e essa a convencao que o
  //      lancamento novo tem de seguir.
  const descCol =
    columns.find((c) => roleFromHeader(c.header) === "descricao" && !c.hasFormula) ??
    columns.filter((c) => c.kind === "text" && !c.hasFormula).sort((a, b) => b.filled - a.filled)[0];
  let descriptionSamples = descCol ? descCol.samples.slice(0, 8) : [];
  if (descCol) {
    const recentes = latestSheetSamples(sheets, monthSheets, descCol.letter, firstDataRow, shared);
    if (recentes.length) descriptionSamples = recentes;
  }

  if (filledRows === 0) {
    warnings.push("A planilha ainda nao tem lancamentos — o estilo de descricao sera o padrao.");
  }

  // ── colunas CALCULADAS e colunas por LISTAGEM ─────────────────────────────
  // As duas classes de coluna que o writer nao enxergava. A ordem importa: a
  // deteccao de formula vem primeiro porque uma coluna calculada jamais deve
  // ser tratada como coluna de listagem (o resultado do VLOOKUP se repete e
  // pareceria uma lista).
  const roleByLetter = new Map<string, string | null>(
    columns.map((c) => [c.letter, roleFromHeader(c.header)]),
  );
  const letterWithRole = (role: string): string | null =>
    [...roleByLetter.entries()].find(([, r]) => r === role)?.[0] ?? null;
  const writableLetters = columns
    .filter((c) => {
      const r = roleByLetter.get(c.letter);
      return r === "data" || r === "descricao" || r === "categoria" || r === "entrada" || r === "saida";
    })
    .map((c) => c.letter);

  const dataSheets = monthSheets.length ? monthSheets : [sample.name];
  const headersByLetter = new Map(columns.map((c) => [c.letter, c.header]));

  let formulaColumns: FormulaColumnRule[] = [];
  let listColumns: ListColumnRule[] = [];
  try {
    formulaColumns = mergeFormulaRules(
      sheets
        .filter((s) => dataSheets.includes(s.name))
        .map((s) =>
          detectFormulaColumns({
            sheetName: s.name,
            sheetXml: s.xml,
            firstDataRow,
            headers: headersByLetter,
            writableColumns: writableLetters,
          }),
        ),
    );
  } catch (e) {
    warnings.push(`Nao consegui mapear as colunas de formula: ${(e as Error).message}`);
  }

  try {
    listColumns = detectListColumns({
      sheets,
      shared,
      dataSheets,
      headers: headersByLetter,
      firstDataRow,
      descriptionColumn: letterWithRole("descricao"),
      entradaColumn: letterWithRole("entrada"),
      saidaColumn: letterWithRole("saida"),
      formulaColumns: formulaColumns.map((f) => f.letter),
      excludeFromInference: columns
        .filter((c) => {
          const r = roleByLetter.get(c.letter);
          return r === "data" || r === "descricao" || r === "entrada" || r === "saida" || r === "saldo";
        })
        .map((c) => c.letter),
    });
  } catch (e) {
    warnings.push(`Nao consegui mapear as colunas de listagem: ${(e as Error).message}`);
  }

  // ── ORDEM DAS DATAS ───────────────────────────────────────────────────────
  // A pergunta que faltava fazer: esta planilha cresce para baixo ou para cima?
  // Sem ela o writer so sabia empilhar no fim — e no fim de uma aba decrescente
  // fica a data MAIS ANTIGA, entao todo lancamento novo nascia fora de ordem.
  const dateColumn = letterWithRole("data");
  const dateOrderBySheet: Record<string, DateOrderEvidence> = {};
  if (dateColumn) {
    for (const s of sheets) {
      if (!dataSheets.includes(s.name)) continue;
      const datas = readColumnDates(s.xml, dateColumn, firstDataRow, shared);
      const ev = detectDateOrder(datas);
      if (ev.amostra > 0) dateOrderBySheet[s.name] = ev;
    }
  } else {
    warnings.push(
      "Nao identifiquei a coluna de data — nao da para saber se a planilha esta em ordem crescente ou decrescente.",
    );
  }
  const dateOrder = combineDateOrder(Object.values(dateOrderBySheet));

  return {
    sheetNames: order,
    monthSheets,
    supportSheets,
    sampleSheet: sample.name,
    headerRow,
    firstDataRow,
    columns,
    categories: await readCategories(sheets, shared),
    descriptionSamples,
    filledRows,
    listColumns,
    formulaColumns,
    dateOrder,
    dateOrderBySheet,
    warnings,
  };
}

/**
 * As datas de uma coluna, NA ORDEM DAS LINHAS — que e a unica ordem que
 * interessa aqui. Linha sem data legivel nao entra: um cabecalho de secao ou
 * uma observacao no meio da aba nao pode contar como quebra de padrao.
 */
function readColumnDates(
  xml: string,
  letter: string,
  firstDataRow: number,
  shared: string[],
): Array<{ year: number; month: number; day: number } | null> {
  const out: Array<{ year: number; month: number; day: number } | null> = [];
  for (const row of iterRows(xml)) {
    if (row.r < firstDataRow) continue;
    const d = readCellDate(row.xml, `${letter}${row.r}`, shared);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Le as categorias validas da aba `Categorias` (coluna A, pulando o titulo).
 *
 * ATENCAO — a grafia sai daqui INTACTA, de proposito. Aqui existia um
 * `.trim()` que parecia inofensivo e custava caro: na planilha real duas
 * categorias tem um espaco sobrando no fim (`"Salário "` e `"Empréstimos "`).
 * Aparadas, elas deixam de ser o texto que esta na aba `Categorias` — e ai o
 * `VLOOKUP` da coluna Fluxo de Caixa nao encontra nada e a validacao da celula
 * passa a recusar o valor. O espaco e feio, mas e o que a planilha usa.
 */
async function readCategories(sheets: SheetSource[], shared: string[]): Promise<string[]> {
  const cat = sheets.find((s) => normalizeHeader(s.name) === "CATEGORIAS");
  if (!cat) return [];
  const out: string[] = [];
  for (const row of iterRows(cat.xml)) {
    const text = cellText(row.xml, `A${row.r}`, shared);
    if (!text.trim()) continue;
    const n = normalizeHeader(text);
    if (n === "CATEGORIA" || n === "CATEGORIAS") continue; // cabecalho
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * Amostras da coluna de descricao na aba de mes MAIS RECENTE que tem dados.
 *
 * "Mais recente" e a ultima aba de mes, na ordem do proprio arquivo, com algo
 * escrito nessa coluna. A convencao de escrita de uma planilha viva muda com o
 * tempo — nesta, as abas antigas trazem so o nome da pessoa e a ultima traz
 * `Pix - NOME`. Copiar a aba antiga faria os lancamentos novos nascerem fora do
 * padrao que o cliente adotou desde entao.
 */
function latestSheetSamples(
  sheets: SheetSource[],
  monthSheets: string[],
  letter: string,
  firstDataRow: number,
  shared: string[],
): string[] {
  for (let i = monthSheets.length - 1; i >= 0; i--) {
    const aba = sheets.find((s) => s.name === monthSheets[i]);
    if (!aba) continue;
    const out: string[] = [];
    for (const row of iterRows(aba.xml)) {
      if (row.r < firstDataRow) continue;
      const raw = readCellRaw(row.xml, `${letter}${row.r}`);
      if (raw.value == null || raw.value === "") continue;
      const ehTexto = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
      if (!ehTexto) continue;
      const texto = raw.type === "s" ? (shared[Number(raw.value)] ?? "") : raw.value;
      if (!texto.trim()) continue;
      out.push(texto.trim());
      if (out.length >= 8) return out;
    }
    if (out.length) return out;
  }
  return [];
}

/** Dump textual compacto da inspecao — e o que vai no prompt quando precisamos de IA. */
export function inspectionToPromptDump(ins: WorkbookInspection): string {
  const linhas: string[] = [];
  linhas.push(`Abas: ${ins.sheetNames.join(" ; ") || "(nenhuma)"}`);
  linhas.push(`Abas de mes detectadas: ${ins.monthSheets.join(" ; ") || "(nenhuma)"}`);
  linhas.push(`Aba analisada: ${ins.sampleSheet ?? "(nenhuma)"}`);
  linhas.push(`Linha de cabecalho detectada: ${ins.headerRow ?? "nao identificada"}`);
  linhas.push(`Linhas de dados com conteudo: ${ins.filledRows}`);
  linhas.push(
    `Ordem das datas ja gravadas: ${ins.dateOrder.ordem} ` +
      `(${ins.dateOrder.crescentes} pares subindo, ${ins.dateOrder.decrescentes} descendo)`,
  );
  linhas.push("Colunas (letra | cabecalho | formato | tem formula | amostras do conteudo real):");
  for (const c of ins.columns) {
    linhas.push(
      `  ${c.letter} | "${c.header}" | fmt=${c.numFmt || "-"} | formula=${c.hasFormula ? "sim" : "nao"} | ${
        c.samples.length ? c.samples.join(" ; ") : "(vazia)"
      }`,
    );
  }
  if (ins.categories.length) {
    linhas.push(`Categorias validas (aba Categorias): ${ins.categories.join(" ; ")}`);
  }
  if (ins.listColumns.length) {
    linhas.push("Colunas preenchidas por LISTAGEM (dropdown):");
    linhas.push(listColumnsToPromptDump(ins.listColumns));
  }
  if (ins.formulaColumns.length) {
    linhas.push("Colunas preenchidas por FORMULA:");
    linhas.push(formulaColumnsToPromptDump(ins.formulaColumns));
  }
  return linhas.join("\n");
}
