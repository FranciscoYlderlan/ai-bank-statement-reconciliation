import JSZip from "jszip";
import { DEFAULT_CATEGORIES, CategoryDef } from "../../domain/category";
import { monthSheetName } from "../../domain/competence";
import { escapeXml } from "./xmlCells";
import { buildColsXml } from "./columnWidths";

/**
 * Gera uma planilha .xlsx NOVA do zero, seguindo o MESMO padrao da planilha
 * Cantina Bom Prato (§3): 12 abas de mes (JANEIRO..DEZEMBRO) + aba `Categorias` +
 * dashboard `FLUXO DE CAIXA  SIMPLIFICADO`.
 *
 * Cada aba de mes replica o contrato de layout:
 *  - cabecalho na linha 12 (B..H)
 *  - primeira linha de dados 13
 *  - coluna E = VLOOKUP da categoria (Fluxo de Caixa)
 *  - coluna H = saldo corrente
 *  - dropdown de validacao em D referenciando Categorias!$A:$A
 */

const HEADER = ["Data", "Descrição", "Categoria", "Fluxo de Caixa", "Entrada", "Saída", "Saldo"];
const DATA_ROWS = 450; // linhas pre-preenchidas com formulas E/H

/**
 * Larguras iniciais das abas de mes. Sao um PISO calibrado no conteudo real
 * (data dd/mm/aaaa, descricao "CONTRAPARTE | TIPO", categorias da aba
 * Categorias, dinheiro em R$): a planilha ja nasce legivel. Depois de gravar,
 * o writer roda o auto-ajuste por conteudo e alarga o que ficou apertado.
 */
const MONTH_COL_WIDTHS: Record<string, number> = {
  A: 3.5, // calha lateral (vazia por contrato)
  B: 12, // Data — dd/mm/aaaa
  C: 46, // Descricao — o campo mais longo
  D: 26, // Categoria — dropdown
  E: 20, // Fluxo de Caixa (formula) — "GASTOS VARIÁVEIS"
  F: 15, // Entrada — R$ 1.234.567,89
  G: 15, // Saida
  H: 16, // Saldo acumulado
};
const CATEGORIAS_COL_WIDTHS: Record<string, number> = { A: 34, B: 22 };
const DASHBOARD_COL_WIDTHS: Record<string, number> = { A: 3.5, B: 16, C: 16, D: 16, E: 16 };

// ---- estilos ----
// s=0 geral | s=1 data | s=2 moeda | s=3 header (negrito) | s=4 titulo
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function inlineStr(ref: string, text: string, s = 0): string {
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}
function formulaCell(ref: string, f: string, s = 0): string {
  return `<c r="${ref}" s="${s}"><f>${escapeXml(f)}</f></c>`;
}

function categoriasSheet(cats: CategoryDef[]): string {
  let rows = `<row r="1"><c r="A1" s="3" t="inlineStr"><is><t>CATEGORIA</t></is></c><c r="B1" s="3" t="inlineStr"><is><t>FLUXO DE CAIXA</t></is></c></row>`;
  cats.forEach((c, i) => {
    const r = i + 2;
    rows += `<row r="${r}">${inlineStr(`A${r}`, c.name)}${inlineStr(`B${r}`, c.flow)}</row>`;
  });
  return sheetWrap(
    `<dimension ref="A1:B${cats.length + 1}"/>${buildColsXml(CATEGORIAS_COL_WIDTHS)}<sheetData>${rows}</sheetData>`,
  );
}

function monthSheet(name: string): string {
  const parts: string[] = [];
  // titulo
  parts.push(`<row r="2">${inlineStr("B2", `CONTROLE DE CAIXA — ${name}`, 4)}</row>`);
  // saldo inicial
  parts.push(`<row r="7">${inlineStr("B7", "SALDO INICIAL:", 3)}<c r="G7" s="2"><f>0</f></c></row>`);
  // cabecalho linha 12
  let head = `<row r="12">`;
  ["B", "C", "D", "E", "F", "G", "H"].forEach((col, i) => {
    head += inlineStr(`${col}12`, HEADER[i], 3);
  });
  head += `</row>`;
  parts.push(head);
  // linhas de dados 13..(12+DATA_ROWS) com formulas E e H
  for (let i = 0; i < DATA_ROWS; i++) {
    const r = 13 + i;
    const eF = `IF(ISERROR(VLOOKUP(D${r},Categorias!A:B,2,0)),"",VLOOKUP(D${r},Categorias!A:B,2,0))`;
    const hF = i === 0 ? `G7+F13-G13` : `H${r - 1}+F${r}-G${r}`;
    parts.push(
      `<row r="${r}"><c r="B${r}" s="1"/><c r="C${r}"/><c r="D${r}"/>${formulaCell(
        `E${r}`,
        eF,
      )}<c r="F${r}" s="2"/><c r="G${r}" s="2"/>${formulaCell(`H${r}`, hF, 2)}</row>`,
    );
  }
  const lastRow = 12 + DATA_ROWS;
  const merges = `<mergeCells count="1"><mergeCell ref="B2:H5"/></mergeCells>`;
  // dropdown de validacao em D via extLst (padrao x14, como o arquivo real)
  const validation =
    `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">` +
    `<x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">` +
    `<x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1">` +
    `<x14:formula1><xm:f>Categorias!$A:$A</xm:f></x14:formula1><xm:sqref>D13:D${lastRow}</xm:sqref>` +
    `</x14:dataValidation></x14:dataValidations></ext></extLst>`;
  return sheetWrap(
    `<dimension ref="A1:H${lastRow}"/>${buildColsXml(MONTH_COL_WIDTHS)}` +
      `<sheetData>${parts.join("")}</sheetData>${merges}${validation}`,
  );
}

function dashboardSheet(): string {
  const months = Array.from({ length: 12 }, (_, i) => monthSheetName({ year: 2026, month: i + 1 }));
  let rows = `<row r="2">${inlineStr("B2", "FLUXO DE CAIXA — RESUMO MENSAL", 4)}</row>`;
  rows += `<row r="4">${inlineStr("B4", "Mês", 3)}${inlineStr("C4", "Entradas", 3)}${inlineStr("D4", "Saídas", 3)}${inlineStr("E4", "Saldo", 3)}</row>`;
  months.forEach((m, i) => {
    const r = 5 + i;
    rows +=
      `<row r="${r}">${inlineStr(`B${r}`, m)}` +
      `${formulaCell(`C${r}`, `SUM('${m}'!F13:F462)`, 2)}` +
      `${formulaCell(`D${r}`, `SUM('${m}'!G13:G462)`, 2)}` +
      `${formulaCell(`E${r}`, `C${r}-D${r}`, 2)}</row>`;
  });
  const tot = 17;
  rows +=
    `<row r="${tot}">${inlineStr(`B${tot}`, "TOTAL", 3)}` +
    `${formulaCell(`C${tot}`, `SUM(C5:C16)`, 2)}${formulaCell(`D${tot}`, `SUM(D5:D16)`, 2)}${formulaCell(`E${tot}`, `C${tot}-D${tot}`, 2)}</row>`;
  return sheetWrap(
    `<dimension ref="A1:E${tot}"/>${buildColsXml(DASHBOARD_COL_WIDTHS)}<sheetData>${rows}</sheetData>`,
  );
}

function sheetWrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">${inner}</worksheet>`;
}

export async function createWorkbook(
  cats: CategoryDef[] = DEFAULT_CATEGORIES,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  const zip = new JSZip();
  const months = Array.from({ length: 12 }, (_, i) => monthSheetName({ year: 2026, month: i + 1 }));
  // ordem das abas: Categorias, dashboard, depois os 12 meses
  const sheetDefs = [
    { name: "Categorias", xml: categoriasSheet(cats) },
    { name: "FLUXO DE CAIXA  SIMPLIFICADO", xml: dashboardSheet() },
    ...months.map((m) => ({ name: m, xml: monthSheet(m) })),
  ];

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetDefs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );

  const sheetTags = sheetDefs
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets></workbook>`,
  );

  const rels =
    sheetDefs
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheetDefs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );

  zip.file("xl/styles.xml", STYLES_XML);
  sheetDefs.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.xml));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }, (meta) =>
    onProgress?.(Math.max(0, Math.min(1, meta.percent / 100))),
  );
}
