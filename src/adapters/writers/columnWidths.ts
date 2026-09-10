/**
 * Larguras de coluna (OOXML `<cols>`) — o layout do .xlsx so fica legivel se a
 * coluna couber o conteudo. Este modulo faz duas coisas, e so estas duas:
 *
 *  1. MEDE  — estima a largura (em "caracteres" do Excel) de um texto ja
 *     formatado como o usuario o ve (data em dd/mm/aaaa, dinheiro em R$ ...).
 *  2. APLICA — reescreve o elemento `<cols>` de uma aba mantendo TODO o resto
 *     do XML intacto. No modo `onlyExpand` uma coluna nunca encolhe: se o
 *     usuario ja alargou a coluna dele, respeitamos a escolha dele.
 *
 * Por que nao usar `bestFit`: `bestFit` e apenas uma *dica* — o Excel so
 * recalcula a largura quando o usuario mexe na coluna. Gravamos `width` +
 * `customWidth="1"`, que e o que de fato abre o arquivo com a coluna certa.
 */

/** Largura minima util (cabecalhos curtos ainda respiram). */
export const MIN_WIDTH = 9;
/** Teto — descricoes gigantes nao podem empurrar a planilha para fora da tela. */
export const MAX_WIDTH = 58;
/** Folga a direita do texto (borda + respiro). */
export const PADDING = 2.6;

/** Uma entrada do `<cols>` ja normalizada para UMA faixa de colunas. */
interface ColEntry {
  min: number;
  max: number;
  width: number | null;
  /** demais atributos preservados (style, hidden, outlineLevel…). */
  rest: string;
}

/**
 * Estima a largura de um texto em "caracteres" na fonte padrao. Nao e metrica
 * exata (isso exigiria as metricas da fonte), mas pondera glifos largos e
 * estreitos — o suficiente para a coluna caber sem sobrar deserto branco.
 */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/[MWmw@%＿]/.test(ch)) w += 1.4;
    else if (/[ABCDEFGHKNOPQRSUVXYZÁÂÃÀÉÊÍÓÔÕÚÇ]/.test(ch)) w += 1.15;
    else if (/[iljtIf.,:;'`|!\[\]() ]/.test(ch)) w += 0.55;
    else w += 1;
  }
  return w;
}

/** Clamp para larguras DERIVADAS DE CONTEUDO (piso legivel + teto de tela). */
export function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w * 100) / 100));
}

/**
 * Clamp para larguras EXPLICITAS (as que ja estao no arquivo ou que nos
 * especificamos a mao). Aqui nao existe piso de legibilidade: uma calha
 * estreita de propria escolha — a coluna A do contrato, por exemplo — deve
 * continuar estreita.
 */
function clampExplicit(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(0.5, Math.round(w * 100) / 100));
}

/** Largura necessaria para caber `text` (ja com a folga). */
export function widthForText(text: string): number {
  return clampWidth(textWidth(text) + PADDING);
}

/** Largura necessaria para caber o MAIOR texto de uma coluna. */
export function widthForTexts(texts: Iterable<string>): number {
  let max = 0;
  for (const t of texts) max = Math.max(max, textWidth(t));
  return clampWidth(max + PADDING);
}

/** Numero da coluna ("B" -> 2). */
export function colNumber(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Serializa um mapa {letra: largura} para {numero: largura}. */
export function byColumnNumber(widths: Record<string, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [letter, w] of Object.entries(widths)) out[colNumber(letter)] = w;
  return out;
}

/** Monta um bloco `<cols>` do zero (usado pela planilha gerada por nos). */
export function buildColsXml(widths: Record<string, number>): string {
  const entries = Object.entries(widths)
    .map(([letter, w]) => ({ n: colNumber(letter), w: clampExplicit(w) }))
    .sort((a, b) => a.n - b.n);
  if (entries.length === 0) return "";
  const cols = entries
    .map((e) => `<col min="${e.n}" max="${e.n}" width="${e.w}" customWidth="1"/>`)
    .join("");
  return `<cols>${cols}</cols>`;
}

function parseColsBlock(xml: string): { entries: ColEntry[]; start: number; end: number } | null {
  const m = xml.match(/<cols>[\s\S]*?<\/cols>/);
  if (!m || m.index === undefined) return null;
  const entries: ColEntry[] = [];
  for (const c of m[0].matchAll(/<col\b([^>]*?)\/?>/g)) {
    const attrs = c[1];
    const min = Number(attrs.match(/\bmin="(\d+)"/)?.[1] ?? 0);
    const max = Number(attrs.match(/\bmax="(\d+)"/)?.[1] ?? min);
    if (!min) continue;
    const widthAttr = attrs.match(/\bwidth="([\d.]+)"/)?.[1];
    const rest = attrs
      .replace(/\bmin="\d+"/, "")
      .replace(/\bmax="\d+"/, "")
      .replace(/\bwidth="[\d.]+"/, "")
      .replace(/\bcustomWidth="[^"]*"/, "")
      .replace(/\bbestFit="[^"]*"/, "")
      .replace(/\s+/g, " ")
      .trim();
    entries.push({ min, max, width: widthAttr ? Number(widthAttr) : null, rest });
  }
  return { entries, start: m.index, end: m.index + m[0].length };
}

function serializeEntries(entries: ColEntry[]): string {
  const parts = entries
    .filter((e) => e.min <= e.max)
    .sort((a, b) => a.min - b.min || a.max - b.max)
    .map((e) => {
      const w = e.width != null ? ` width="${clampExplicit(e.width)}" customWidth="1"` : "";
      const rest = e.rest ? ` ${e.rest}` : "";
      return `<col min="${e.min}" max="${e.max}"${w}${rest}/>`;
    })
    .join("");
  return parts ? `<cols>${parts}</cols>` : "";
}

/**
 * Aplica larguras a UMA aba. `desired` e indexado pelo NUMERO da coluna.
 *
 * - `onlyExpand` (default true): so aumenta. Uma coluna que o usuario ja
 *   deixou larga permanece larga; uma que ele apertou de proposito tambem —
 *   so mexemos quando o conteudo NAO CABE.
 * - Faixas existentes (`<col min="1" max="16384">`) sao FATIADAS apenas nas
 *   colunas afetadas, preservando o resto da faixa com seus atributos.
 * - Tudo fora de `<cols>` fica byte-a-byte igual.
 */
export function applyColumnWidths(
  xml: string,
  desired: Record<number, number>,
  opts: { onlyExpand?: boolean } = {},
): string {
  const onlyExpand = opts.onlyExpand !== false;
  const wanted = Object.entries(desired)
    .map(([n, w]) => ({ n: Number(n), w: clampWidth(w) }))
    .filter((x) => Number.isFinite(x.n) && x.n > 0)
    .sort((a, b) => a.n - b.n);
  if (wanted.length === 0) return xml;

  const parsed = parseColsBlock(xml);
  let entries: ColEntry[] = parsed ? parsed.entries : [];

  for (const { n, w } of wanted) {
    const idx = entries.findIndex((e) => e.min <= n && n <= e.max);
    if (idx === -1) {
      entries.push({ min: n, max: n, width: w, rest: "" });
      continue;
    }
    const e = entries[idx];
    const current = e.width ?? 0;
    const target = onlyExpand ? Math.max(current, w) : w;
    if (Math.abs(target - current) < 0.05) continue; // ja cabe — nao mexe
    const replacement: ColEntry[] = [];
    if (e.min < n) replacement.push({ ...e, max: n - 1 });
    replacement.push({ ...e, min: n, max: n, width: target });
    if (n < e.max) replacement.push({ ...e, min: n + 1 });
    entries.splice(idx, 1, ...replacement);
  }

  const colsXml = serializeEntries(entries);
  if (parsed) {
    return xml.slice(0, parsed.start) + colsXml + xml.slice(parsed.end);
  }
  if (!colsXml) return xml;
  // `<cols>` precisa vir IMEDIATAMENTE antes de `<sheetData>` (ordem do schema).
  const at = xml.search(/<sheetData[\s/>]/);
  if (at === -1) return xml.replace("</worksheet>", `${colsXml}</worksheet>`);
  return xml.slice(0, at) + colsXml + xml.slice(at);
}

/** Le a largura efetiva de uma coluna (util em teste/diagnostico). */
export function readColumnWidth(xml: string, col: number): number | null {
  const parsed = parseColsBlock(xml);
  if (!parsed) return null;
  const e = parsed.entries.find((x) => x.min <= col && col <= x.max);
  return e?.width ?? null;
}
