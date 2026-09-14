import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import {
  applyColumnWidths,
  buildColsXml,
  readColumnWidth,
  widthForTexts,
} from "../src/adapters/writers/columnWidths";
import { createWorkbook } from "../src/adapters/writers/createWorkbook";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import { DONA_MARI_LAYOUT, SheetRow } from "../src/domain/layout";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

async function sheetXmlOf(bytes: Uint8Array, file: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(file)!.async("string");
}

const SHEET = "JULHO";
const SHEET_FILE = "xl/worksheets/sheet10.xml";

describe("columnWidths — medida e aplicacao", () => {
  it("uma descricao longa exige mais largura que uma curta", () => {
    const curta = widthForTexts(["Tarifa"]);
    const longa = widthForTexts(["SUPERMERCADO ATACADISTA DA REGIAO NORTE LTDA | Pix"]);
    expect(longa).toBeGreaterThan(curta);
  });

  it("insere <cols> imediatamente antes de <sheetData> quando nao existe", () => {
    const xml = `<worksheet><dimension ref="A1:H20"/><sheetData><row r="1"/></sheetData></worksheet>`;
    const out = applyColumnWidths(xml, { 3: 40 });
    expect(out).toContain('<cols><col min="3" max="3" width="40" customWidth="1"/></cols><sheetData>');
    expect(out.indexOf("<cols>")).toBeLessThan(out.indexOf("<sheetData>"));
  });

  it("onlyExpand NUNCA encolhe uma coluna que o usuario ja alargou", () => {
    const xml = `<worksheet><cols><col min="3" max="3" width="52" customWidth="1"/></cols><sheetData/></worksheet>`;
    const out = applyColumnWidths(xml, { 3: 20 }, { onlyExpand: true });
    expect(readColumnWidth(out, 3)).toBe(52);
  });

  it("onlyExpand alarga quando o conteudo nao cabe", () => {
    const xml = `<worksheet><cols><col min="3" max="3" width="9" customWidth="1"/></cols><sheetData/></worksheet>`;
    const out = applyColumnWidths(xml, { 3: 44 }, { onlyExpand: true });
    expect(readColumnWidth(out, 3)).toBe(44);
  });

  it("fatia uma faixa larga preservando os atributos das colunas vizinhas", () => {
    const xml = `<worksheet><cols><col min="1" max="16384" width="8.43" style="7"/></cols><sheetData/></worksheet>`;
    const out = applyColumnWidths(xml, { 3: 40 }, { onlyExpand: true });
    expect(readColumnWidth(out, 2)).toBe(8.43);
    expect(readColumnWidth(out, 3)).toBe(40);
    expect(readColumnWidth(out, 4)).toBe(8.43);
    expect(out).toContain('style="7"');
  });

  it("buildColsXml ordena por numero de coluna", () => {
    expect(buildColsXml({ C: 30, A: 4 })).toBe(
      '<cols><col min="1" max="1" width="4" customWidth="1"/><col min="3" max="3" width="30" customWidth="1"/></cols>',
    );
  });
});

describe("planilha nova — colunas ja nascem no tamanho do conteudo", () => {
  it("cada aba de mes traz <cols> com a Descricao mais larga que a Data", async () => {
    const bytes = await createWorkbook();
    const zip = await JSZip.loadAsync(bytes);
    const files = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    let checked = 0;
    for (const f of files) {
      const xml = await zip.file(f)!.async("string");
      if (!xml.includes("CONTROLE DE CAIXA")) continue;
      expect(xml).toContain("<cols>");
      const data = readColumnWidth(xml, 2)!; // B
      const descricao = readColumnWidth(xml, 3)!; // C
      expect(descricao).toBeGreaterThan(data);
      expect(data).toBeGreaterThanOrEqual(10);
      checked++;
    }
    expect(checked).toBe(12);
  });
});

describe("auto-ajuste na planilha do usuario (T-PRES continua valendo)", () => {
  const longa = "SUPERMERCADO ATACADISTA DA REGIAO NORTE LTDA ME | Transferência Pix recebida";
  const rows: SheetRow[] = [
    { dateSerial: 46210, dateText: "07/07/2026", description: longa, category: null, entradaCents: 3200, saidaCents: null },
  ];

  it("alarga a coluna de Descricao para caber o texto gravado", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows(SHEET, rows, DONA_MARI_LAYOUT);
    const antes = readColumnWidth(await sheetXmlOf(await w.toBytes(), SHEET_FILE), 3);
    await w.autofitColumns(SHEET, DONA_MARI_LAYOUT, { onlyExpand: true });
    const depois = readColumnWidth(await sheetXmlOf(await w.toBytes(), SHEET_FILE), 3)!;
    expect(depois).toBeGreaterThan(antes ?? 0);
    expect(depois).toBeGreaterThanOrEqual(40);
  });

  it("nao toca em formulas, merges nem no dropdown de validacao", async () => {
    const before = await sheetXmlOf(templateBytes(), SHEET_FILE);
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows(SHEET, rows, DONA_MARI_LAYOUT);
    await w.autofitColumns(SHEET, DONA_MARI_LAYOUT, { onlyExpand: true });
    const after = await sheetXmlOf(await w.toBytes(), SHEET_FILE);

    const countF = (s: string) => (s.match(/<f/g) || []).length;
    expect(countF(after)).toBe(countF(before));
    expect(after).toContain("x14:dataValidation");
    expect(after).toContain('<mergeCells count="12">');
    expect(after).toContain("VLOOKUP(D13,Categorias!A:B,2,0)");
  });

  it("autofitAllSheets pula as abas de apoio", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const categoriasAntes = await sheetXmlOf(await w.toBytes(), "xl/worksheets/sheet1.xml");
    await w.autofitAllSheets(DONA_MARI_LAYOUT, { onlyExpand: true });
    const categoriasDepois = await sheetXmlOf(await w.toBytes(), "xl/worksheets/sheet1.xml");
    expect(categoriasDepois).toBe(categoriasAntes);
  });
});
