import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import {
  buildStyleFormats,
  ensureDateStyle,
  isDateFormat,
  DATE_NUMFMT_ID,
} from "../src/adapters/writers/numberFormats";
import { DONA_MARI_LAYOUT, SheetRow } from "../src/domain/layout";
import { parseDatePtBr, toExcelSerial, toBr } from "../src/domain/dateptbr";

/**
 * "As colunas de data vieram com 46201, 46200, 46199."
 *
 * O valor estava certo — 46201 E 20/08/2026 no calendario do Excel. O que
 * faltava era o FORMATO: quem decide se a celula aparece como data ou como
 * numero cru e o `numFmtId` do estilo (`s="N"`). Herdar o estilo da coluna
 * funciona ate a celula de destino ter estilo proprio sem formato de data.
 *
 * Estes testes cobrem a garantia: ao gravar serial, o writer resolve um estilo
 * que COM CERTEZA exibe data — criando um, se preciso.
 */

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

/** Linha de escrita a partir de uma data pt-BR (serial e texto sempre coerentes). */
const linha = (br = "20/08/2026", over: Partial<SheetRow> = {}): SheetRow => {
  const d = parseDatePtBr(br);
  return {
    dateSerial: toExcelSerial(d),
    dateText: toBr(d),
    description: "ZAIRA FERNANDA | Pix",
    category: null,
    entradaCents: 3720,
    saidaCents: null,
    ...over,
  };
};

/** Serial esperado da data de teste — o "46201" da reclamacao, nesta data. */
const SERIAL = String(toExcelSerial(parseDatePtBr("20/08/2026")));

/* ── leitura de styles.xml ──────────────────────────────────────────────── */

describe("buildStyleFormats — o indice do estilo nao pode escorregar", () => {
  it("conta o <xf> que omite numFmtId (opcional no OOXML) como Geral", () => {
    const styles = `<styleSheet><cellXfs count="3">
<xf numFmtId="0" fontId="0"/>
<xf fontId="1"/>
<xf numFmtId="14" fontId="0" applyNumberFormat="1"/>
</cellXfs></styleSheet>`;
    const fmts = buildStyleFormats(styles);
    expect(fmts.length).toBe(3);
    // sem contar o <xf> sem numFmtId, o estilo de data cairia no indice 1
    expect(fmts[1].numFmtId).toBe(0);
    expect(isDateFormat(fmts[2])).toBe(true);
  });

  it("conta o <xf> com filhos (<alignment/>) como um so estilo", () => {
    const styles = `<styleSheet><cellXfs count="2">
<xf numFmtId="0" fontId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="14" fontId="0" applyNumberFormat="1"/>
</cellXfs></styleSheet>`;
    const fmts = buildStyleFormats(styles);
    expect(fmts.length).toBe(2);
    expect(isDateFormat(fmts[1])).toBe(true);
  });

  it("le numFmt custom com os atributos em ordem invertida", () => {
    const styles = `<styleSheet><numFmts count="1"><numFmt formatCode="dd/mm/yyyy" numFmtId="170"/></numFmts><cellXfs count="1"><xf numFmtId="170"/></cellXfs></styleSheet>`;
    expect(isDateFormat(buildStyleFormats(styles)[0])).toBe(true);
  });
});

/* ── garantia do estilo de data ─────────────────────────────────────────── */

describe("ensureDateStyle — garante, em vez de supor", () => {
  const styles = `<styleSheet><cellXfs count="2">` +
    `<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyBorder="1"/>` +
    `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs></styleSheet>`;

  it("estilo que ja exibe data e reaproveitado sem mexer no arquivo", () => {
    const r = ensureDateStyle(styles, 1);
    expect(r.index).toBe(1);
    expect(r.changed).toBe(false);
    expect(r.stylesXml).toBe(styles);
  });

  it("estilo Geral vira um CLONE com formato de data, preservando a aparencia", () => {
    const r = ensureDateStyle(styles, 0);
    expect(r.changed).toBe(true);
    expect(r.index).toBe(2); // acrescentado ao fim
    const fmts = buildStyleFormats(r.stylesXml);
    expect(fmts.length).toBe(3);
    expect(fmts[2].numFmtId).toBe(DATE_NUMFMT_ID);
    // fonte, preenchimento e borda da coluna continuam os mesmos
    const novo = r.stylesXml.match(/<xf[^>]*applyBorder="1"[^>]*\/>/g)!.pop()!;
    expect(novo).toContain('fontId="3"');
    expect(novo).toContain('fillId="2"');
    expect(novo).toContain('borderId="1"');
    // e os estilos que ja existiam ficam intactos (nenhuma outra celula muda)
    expect(fmts[0].numFmtId).toBe(0);
    expect(fmts[1].numFmtId).toBe(DATE_NUMFMT_ID);
  });

  it("nao duplica: pedir duas vezes devolve o mesmo estilo", () => {
    const primeiro = ensureDateStyle(styles, 0);
    const segundo = ensureDateStyle(primeiro.stylesXml, 0);
    expect(segundo.index).toBe(primeiro.index);
    expect(segundo.changed).toBe(false);
  });

  it("sem cellXfs nao inventa estilo (o writer cai para data em texto)", () => {
    const r = ensureDateStyle("<styleSheet/>", null);
    expect(r.changed).toBe(false);
  });
});

/* ── o caso que chegou do cliente ───────────────────────────────────────── */

/** Monta um .xlsx minimo com o styles.xml e o sheet XML dados. */
async function workbookOf(sheetXml: string, stylesXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="AGOSTO" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file("xl/styles.xml", stylesXml);
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  return zip.generateAsync({ type: "uint8array" });
}

/** s=0 Geral | s=1 data dd/mm/yyyy | s=2 moeda */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const HEADER =
  `<row r="12"><c r="B12" t="inlineStr"><is><t>Data</t></is></c><c r="C12" t="inlineStr"><is><t>Descrição</t></is></c><c r="D12" t="inlineStr"><is><t>Categoria</t></is></c><c r="E12" t="inlineStr"><is><t>Fluxo de Caixa</t></is></c><c r="F12" t="inlineStr"><is><t>Entrada</t></is></c><c r="G12" t="inlineStr"><is><t>Saída</t></is></c><c r="H12" t="inlineStr"><is><t>Saldo</t></is></c></row>`;

function sheetOf(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${HEADER}${rows}</sheetData></worksheet>`;
}

/** Estilo (`s`) e valor de uma celula no XML resultante. */
function cellOf(xml: string, ref: string): { s: string | null; xml: string } {
  const m = xml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`));
  if (!m) return { s: null, xml: "" };
  return { s: m[0].match(/\ss="(\d+)"/)?.[1] ?? null, xml: m[0] };
}

describe("data gravada aparece como DATA, nunca como o serial cru", () => {
  it("linha de destino com estilo Geral: o serial ganha um estilo de data", async () => {
    // a coluna tem data com formato (linha 13) mas a proxima linha livre ficou
    // com estilo Geral — foi assim que "46201" chegou na tela do cliente
    const bytes = await workbookOf(
      sheetOf(
        `<row r="13"><c r="B13" s="1"><v>46200</v></c><c r="C13" t="inlineStr"><is><t>Anterior</t></is></c><c r="F13" s="2"><v>10</v></c></row>` +
          `<row r="14"><c r="B14" s="0"/><c r="C14" s="0"/><c r="F14" s="2"/><c r="G14" s="2"/></row>`,
      ),
      STYLES,
    );
    const w = await XlsxSurgicalWriter.load(bytes);
    const outcome = await w.appendRows("AGOSTO", [linha()], DONA_MARI_LAYOUT);
    expect(outcome.firstRow).toBe(14);

    const out = await w.toBytes();
    const zip = await JSZip.loadAsync(out);
    const after = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const styles = await zip.file("xl/styles.xml")!.async("string");

    const b = cellOf(after, "B14");
    expect(b.xml).toContain(`<v>${SERIAL}</v>`); // valor continua sendo data de verdade
    const fmt = buildStyleFormats(styles)[Number(b.s)];
    expect(isDateFormat(fmt)).toBe(true); // e agora ela EXIBE data
  });

  it("coluna de data vazia e sem estilo de data: o writer cria o formato", async () => {
    const bytes = await workbookOf(
      sheetOf(`<row r="13"><c r="B13" s="0"/><c r="C13" s="0"/><c r="F13" s="2"/></row>`),
      STYLES,
    );
    const w = await XlsxSurgicalWriter.load(bytes);
    await w.appendRows("AGOSTO", [linha()], DONA_MARI_LAYOUT);
    const zip = await JSZip.loadAsync(await w.toBytes());
    const after = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const styles = await zip.file("xl/styles.xml")!.async("string");

    const b = cellOf(after, "B13");
    expect(b.xml).toContain(`<v>${SERIAL}</v>`);
    expect(isDateFormat(buildStyleFormats(styles)[Number(b.s)])).toBe(true);
  });

  it("aba que guarda data como TEXTO continua em texto (nao muda a convencao)", async () => {
    const bytes = await workbookOf(
      sheetOf(
        `<row r="13"><c r="B13" t="inlineStr"><is><t>19/08/2026</t></is></c><c r="C13" t="inlineStr"><is><t>Anterior</t></is></c><c r="F13" s="2"><v>10</v></c></row>` +
          `<row r="14"><c r="B14" s="0"/><c r="C14" s="0"/></row>`,
      ),
      STYLES,
    );
    const w = await XlsxSurgicalWriter.load(bytes);
    await w.appendRows("AGOSTO", [linha()], DONA_MARI_LAYOUT);
    const zip = await JSZip.loadAsync(await w.toBytes());
    const after = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(cellOf(after, "B14").xml).toContain("20/08/2026");
    expect(cellOf(after, "B14").xml).not.toContain(SERIAL);
  });

  it("o que foi gravado volta como a MESMA data na releitura", async () => {
    const bytes = await workbookOf(
      sheetOf(`<row r="13"><c r="B13" s="0"/><c r="C13" s="0"/></row>`),
      STYLES,
    );
    const w = await XlsxSurgicalWriter.load(bytes);
    await w.appendRows("AGOSTO", [linha()], DONA_MARI_LAYOUT);
    const relido = await XlsxSurgicalWriter.load(await w.toBytes());
    const txs = await relido.readExisting("AGOSTO", DONA_MARI_LAYOUT);
    expect(txs.length).toBe(1);
    expect(txs[0].date).toEqual({ year: 2026, month: 8, day: 20 });
  });

  it("planilha real: a data gravada sai com formato de data", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows("JULHO", [linha()], DONA_MARI_LAYOUT);
    const zip = await JSZip.loadAsync(await w.toBytes());
    const after = await zip.file("xl/worksheets/sheet10.xml")!.async("string");
    const styles = await zip.file("xl/styles.xml")!.async("string");
    const b = cellOf(after, `B${outcome.firstRow}`);
    expect(isDateFormat(buildStyleFormats(styles)[Number(b.s)])).toBe(true);
  });

  it("gravar varias vezes nao incha o styles.xml com estilos repetidos", async () => {
    const bytes = await workbookOf(
      sheetOf(`<row r="13"><c r="B13" s="0"/><c r="C13" s="0"/></row>`),
      STYLES,
    );
    const w = await XlsxSurgicalWriter.load(bytes);
    await w.appendRows("AGOSTO", [linha(), linha("21/08/2026")], DONA_MARI_LAYOUT);
    await w.appendRows("AGOSTO", [linha("22/08/2026")], DONA_MARI_LAYOUT);
    const zip = await JSZip.loadAsync(await w.toBytes());
    const styles = await zip.file("xl/styles.xml")!.async("string");
    // o clone de "Geral com formato de data" e identico ao estilo 1 que ja
    // existia: reaproveita em vez de duplicar, quantas vezes rodar
    expect(buildStyleFormats(styles).length).toBe(3);
  });
});
