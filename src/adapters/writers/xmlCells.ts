/** Utilitarios de manipulacao cirurgica de XML de planilha (OOXML). */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Extrai o bloco <row r="N" ...>...</row> (ou self-closing) do XML da aba. */
export function findRow(xml: string, rowNum: number): { match: string; start: number; end: number } | null {
  const openRe = new RegExp(`<row r="${rowNum}"[^>]*?/>`);
  const selfClose = xml.match(openRe);
  if (selfClose && selfClose.index !== undefined) {
    return { match: selfClose[0], start: selfClose.index, end: selfClose.index + selfClose[0].length };
  }
  const re = new RegExp(`<row r="${rowNum}"[^>]*?>.*?</row>`, "s");
  const m = xml.match(re);
  if (m && m.index !== undefined) {
    return { match: m[0], start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** Le o atributo de estilo (s="N") de uma celula especifica dentro de um <row>. */
export function cellStyle(rowXml: string, cellRef: string): string | null {
  const re = new RegExp(`<c r="${cellRef}"([^>]*?)(?:/>|>)`);
  const m = rowXml.match(re);
  if (!m) return null;
  const s = m[1].match(/\ss="(\d+)"/);
  return s ? s[1] : null;
}

/** true se a celula esta vazia (self-closing sem <v>/<is>) ou ausente. */
export function cellIsEmpty(rowXml: string, cellRef: string): boolean {
  // self-closing (ex.: <c r="B13" s="74"/>) => vazia. Testar ANTES do <c>...</c>
  // para nao "atravessar" para a celula seguinte (que pode ter <v>/<f>).
  const selfClose = new RegExp(`<c r="${cellRef}"[^>]*?/>`);
  if (selfClose.test(rowXml)) return true;
  const full = new RegExp(`<c r="${cellRef}"[^>]*?>(.*?)</c>`, "s");
  const m = rowXml.match(full);
  if (m) return !/<v>|<is>|<t>/.test(m[1]);
  return true; // ausente => vazia
}

/** Le o conteudo textual/numerico de uma celula (resolve inlineStr, num). */
export function readCellRaw(
  rowXml: string,
  cellRef: string,
): { type: string | null; value: string | null; styleNum: string | null } {
  const styleNum = cellStyle(rowXml, cellRef);
  // self-closing => sem valor (evita atravessar para a celula seguinte)
  const selfClose = new RegExp(`<c r="${cellRef}"[^>]*?/>`);
  if (selfClose.test(rowXml)) return { type: null, value: null, styleNum };
  const full = new RegExp(`<c r="${cellRef}"([^>]*?)>(.*?)</c>`, "s");
  const m = rowXml.match(full);
  if (!m) return { type: null, value: null, styleNum };
  const attrs = m[1];
  const inner = m[2];
  const t = attrs.match(/\st="([^"]+)"/);
  const type = t ? t[1] : null;
  if (type === "inlineStr") {
    const is = inner.match(/<t[^>]*>(.*?)<\/t>/s);
    return { type, value: is ? unescapeXml(is[1]) : "", styleNum };
  }
  const v = inner.match(/<v>(.*?)<\/v>/s);
  return { type, value: v ? v[1] : null, styleNum };
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Constroi o XML de uma celula numerica preservando o estilo. */
export function numberCell(ref: string, styleNum: string | null, value: number | string): string {
  const s = styleNum ? ` s="${styleNum}"` : "";
  return `<c r="${ref}"${s}><v>${value}</v></c>`;
}

/** Constroi o XML de uma celula de texto inline preservando o estilo. */
export function inlineStringCell(ref: string, styleNum: string | null, text: string): string {
  const s = styleNum ? ` s="${styleNum}"` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/**
 * Substitui (ou insere) a celula `ref` dentro do XML de uma unica linha,
 * mantendo a ordem por coluna. Preserva todas as demais celulas intactas.
 */
export function upsertCellInRow(rowXml: string, ref: string, newCellXml: string): string {
  const existing = new RegExp(`<c r="${ref}"[^>]*?/>|<c r="${ref}"[^>]*?>.*?</c>`, "s");
  if (existing.test(rowXml)) {
    return rowXml.replace(existing, newCellXml);
  }
  // inserir mantendo ordem de coluna
  const col = colToNum(ref.replace(/\d+/g, ""));
  const cellRe = /<c r="([A-Z]+)(\d+)"[^>]*?(?:\/>|>.*?<\/c>)/gs;
  let insertPos = -1;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml))) {
    if (colToNum(m[1]) > col) {
      insertPos = m.index;
      break;
    }
  }
  if (insertPos === -1) {
    // antes de </row>
    return rowXml.replace("</row>", `${newCellXml}</row>`);
  }
  return rowXml.slice(0, insertPos) + newCellXml + rowXml.slice(insertPos);
}

/* ────────────────────────────────────────────────────────────────────────
 * DATA DE UMA CELULA
 *
 * Mora aqui, e nao em cada leitor, porque tres modulos precisam da MESMA
 * resposta: o dedup (que compara com a linha ja gravada), a inspecao (que
 * descobre se a aba sobe ou desce) e o writer (que encaixa a linha nova pela
 * data). Duas leituras diferentes da mesma celula produziriam um encaixe que
 * discorda do dedup — e ai a linha nova entra no lugar errado achando que esta
 * certa.
 * ──────────────────────────────────────────────────────────────────────── */

/** Serial do Excel (epoca 1899-12-30) -> ano/mes/dia. */
export function excelSerialToPlainDate(serial: number): {
  year: number;
  month: number;
  day: number;
} {
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + serial * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Data de uma celula tolerando os dois jeitos que aparecem no mundo real:
 * serial numerico do Excel e texto "dd/mm/aaaa" (ou "dd/mm/aa"). Devolve null
 * quando nao da para ler — o chamador ignora a linha em vez de chutar.
 *
 * ATENCAO: numa celula de texto (t="s") o <v> e o INDICE da sharedString, nao
 * um numero. Tratar esse indice como serial produzia datas absurdas (o indice
 * 120 virava 29/04/1900) e o dedup nunca casava com a linha real.
 */
export function plainDateFromCell(
  raw: { type: string | null; value: string | null },
  shared: string[] = [],
): { year: number; month: number; day: number } | null {
  if (raw.value == null || raw.value === "") return null;
  const isText = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
  if (!isText) {
    const n = Number(raw.value);
    if (Number.isFinite(n) && n > 0) {
      const d = excelSerialToPlainDate(n);
      return Number.isFinite(d.year) ? d : null;
    }
  }
  const text = (raw.type === "s" ? (shared[Number(raw.value)] ?? "") : raw.value).trim();
  const m = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Le a data da celula `ref` dentro do XML de uma linha. */
export function readCellDate(
  rowXml: string,
  ref: string,
  shared: string[] = [],
): { year: number; month: number; day: number } | null {
  return plainDateFromCell(readCellRaw(rowXml, ref), shared);
}

/** O XML inteiro de uma celula (`<c .../>` ou `<c ...>…</c>`), ou null. */
export function readCellXml(rowXml: string, cellRef: string): string | null {
  const re = new RegExp(`<c r="${cellRef}"[^>]*?/>|<c r="${cellRef}"[^>]*?>[\\s\\S]*?</c>`);
  const m = rowXml.match(re);
  return m ? m[0] : null;
}

/**
 * A MESMA celula, endereçada noutra linha. E o que permite mover um lancamento
 * ja gravado para baixo sem reinterpretar o que ha dentro dele: o valor, o
 * tipo e o estilo viajam byte a byte, so o `r=` muda. Reconstruir a celula a
 * partir do valor lido perderia justamente o que nao sabemos reproduzir — o
 * indice de sharedString, o formato herdado, o texto com espaco no fim.
 */
export function retargetCell(cellXml: string, newRef: string): string {
  return cellXml.replace(/^<c r="[A-Z]+\d+"/, `<c r="${newRef}"`);
}

/** Celula vazia preservando o estilo — usada para desocupar uma linha. */
export function emptyCell(ref: string, styleNum: string | null): string {
  return `<c r="${ref}"${styleNum ? ` s="${styleNum}"` : ""}/>`;
}
