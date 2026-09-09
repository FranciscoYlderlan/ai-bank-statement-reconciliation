import JSZip from "jszip";
import { colToNum, unescapeXml, excelSerialToPlainDate } from "../writers/xmlCells";

/**
 * PLANILHA OOXML → MATRIZ DE TEXTO. O par do `csvTable.ts`: le a PRIMEIRA aba
 * de um .xlsx e devolve linhas de strings, para que o leitor de extrato
 * (`parsers/stoneTabular.ts`) enxergue exatamente a mesma coisa que veria num
 * CSV. Um extrato nao muda de conteudo por ter sido baixado em outro botao.
 *
 * Tres cuidados que o arquivo real cobra:
 *
 *  - **A extensao mente.** O extrato que a Stone entrega como `.xls` e um
 *    .xlsx. Aqui isso nem se discute: quem chama ja identificou o ZIP pelos
 *    bytes (`parsers/fileKind.ts`), e este leitor so trata de OOXML.
 *  - **Celula ausente nao e celula vazia deslocada.** O exportador omite a
 *    celula sem conteudo, entao a matriz tem de ser posicionada pela REFERENCIA
 *    (`r="G12"`), nunca pela ordem em que as celulas aparecem — senao a coluna
 *    Data de uma linha vai parar embaixo da Situacao da outra.
 *  - **Data pode chegar como numero.** Um exportador grava `31/08/2026` como
 *    texto e outro como serial do Excel. Uma celula numerica com estilo de data
 *    volta ja formatada em dd/mm/aaaa, para que o leitor de extrato receba a
 *    mesma string nos dois casos.
 */

export interface SheetTable {
  /** nome da aba lida. */
  sheetName: string;
  /** linhas x colunas, ja com os buracos preenchidos com "". */
  rows: string[][];
}

/** Erro de leitura da planilha, com mensagem pronta para a interface. */
export class SpreadsheetReadError extends Error {}

function* iterRows(xml: string): Generator<{ r: number; xml: string }> {
  const re = /<row[^>]*\sr="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) yield { r: Number(m[1]), xml: m[0] };
}

function* iterCells(rowXml: string): Generator<{ ref: string; xml: string }> {
  const re = /<c[^>]*\sr="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml))) yield { ref: m[1], xml: m[0] };
}

/** Formatos numericos que EXIBEM data — o bastante para decidir se um serial e data. */
function isDateFormat(code: string): boolean {
  if (!code) return false;
  const semLiteral = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
  return /[dmyDMY]/.test(semLiteral) && /[/-]|mmm/i.test(semLiteral);
}

/** numFmtId embutidos que sao data (14..22, 45..47 na tabela do OOXML). */
function isBuiltinDateFmt(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
}

async function loadStyleIsDate(zip: JSZip): Promise<(styleIndex: number) => boolean> {
  const f = zip.file("xl/styles.xml");
  if (!f) return () => false;
  const xml = await f.async("string");
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g)) {
    custom.set(Number(m[1]), unescapeXml(m[2]));
  }
  const bloco = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  const ids: number[] = [];
  if (bloco) {
    for (const m of bloco[1].matchAll(/<xf[^>]*\/>|<xf[^>]*>[\s\S]*?<\/xf>/g)) {
      const n = m[0].match(/numFmtId="(\d+)"/);
      ids.push(n ? Number(n[1]) : 0);
    }
  }
  return (styleIndex: number) => {
    const id = ids[styleIndex];
    if (id == null) return false;
    if (isBuiltinDateFmt(id)) return true;
    return isDateFormat(custom.get(id) ?? "");
  };
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const sst = zip.file("xl/sharedStrings.xml");
  if (!sst) return [];
  const xml = await sst.async("string");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(""),
  );
}

/** Nome + XML da primeira aba, seguindo workbook.xml → rels → worksheets/. */
async function firstSheet(zip: JSZip): Promise<{ name: string; xml: string }> {
  const wbFile = zip.file("xl/workbook.xml");
  if (!wbFile) {
    throw new SpreadsheetReadError(
      "O arquivo é um ZIP, mas não tem a estrutura de uma planilha do Excel.",
    );
  }
  const workbook = await wbFile.async("string");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = relsFile ? await relsFile.async("string") : "";
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*worksheets\/sheet\d+\.xml)"/g)) {
    relMap.set(m[1], "xl/" + m[2].replace(/^\/?xl\//, ""));
  }
  const primeira = workbook.match(/<sheet\b[^>]*\/>/);
  if (!primeira) throw new SpreadsheetReadError("A planilha não declara nenhuma aba.");
  const nome = primeira[0].match(/name="([^"]+)"/);
  const rid = primeira[0].match(/r:id="(rId\d+)"/);
  const caminho = (rid && relMap.get(rid[1])) ?? "xl/worksheets/sheet1.xml";
  const f = zip.file(caminho);
  if (!f) throw new SpreadsheetReadError(`A aba "${nome?.[1] ?? "?"}" não foi encontrada no arquivo.`);
  return { name: nome ? unescapeXml(nome[1]) : "Planilha1", xml: await f.async("string") };
}

function brDate(serial: number): string {
  const d = excelSerialToPlainDate(serial);
  return `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
}

/**
 * Le a primeira aba de uma planilha OOXML como matriz de texto. Lanca
 * `SpreadsheetReadError` com mensagem em portugues quando o arquivo nao e uma
 * planilha legivel — quem chama transforma isso em recusa da leitura direta,
 * nao em tela de erro.
 */
export async function readFirstSheet(bytes: Uint8Array): Promise<SheetTable> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new SpreadsheetReadError("Não foi possível abrir a planilha (arquivo corrompido?).");
  }
  const { name, xml } = await firstSheet(zip);
  const shared = await loadSharedStrings(zip);
  const styleIsDate = await loadStyleIsDate(zip);

  const rows: string[][] = [];
  for (const row of iterRows(xml)) {
    const linha: string[] = [];
    for (const cell of iterCells(row.xml)) {
      const col = colToNum(cell.ref.replace(/\d+/g, "")) - 1;
      const attrs = cell.xml.slice(0, cell.xml.indexOf(">") + 1);
      const t = attrs.match(/\st="([^"]+)"/)?.[1] ?? null;
      const s = attrs.match(/\ss="(\d+)"/)?.[1] ?? null;
      let texto = "";
      if (t === "inlineStr") {
        texto = [...cell.xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((m) => unescapeXml(m[1]))
          .join("");
      } else {
        const v = cell.xml.match(/<v>([\s\S]*?)<\/v>/);
        const bruto = v ? unescapeXml(v[1]) : "";
        if (t === "s") texto = shared[Number(bruto)] ?? "";
        else if (t === "b") texto = bruto === "1" ? "VERDADEIRO" : "FALSO";
        else if (bruto !== "" && s != null && styleIsDate(Number(s)) && Number.isFinite(Number(bruto))) {
          texto = brDate(Number(bruto));
        } else texto = bruto;
      }
      while (linha.length < col) linha.push("");
      linha[col] = texto;
    }
    if (linha.some((c) => c.trim().length > 0)) rows.push(linha);
  }
  const largura = rows.reduce((n, r) => Math.max(n, r.length), 0);
  for (const r of rows) while (r.length < largura) r.push("");
  return { sheetName: name, rows };
}
