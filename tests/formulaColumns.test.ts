import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import {
  translateFormula,
  formulaRuleFor,
  FormulaColumnRule,
} from "../src/domain/formulaColumns";
import {
  detectFormulaColumns,
  mergeFormulaRules,
  readSheetFormulas,
  sharedFormulaMasters,
} from "../src/adapters/writers/inspectFormulas";
import {
  XlsxSurgicalWriter,
  perpetuateFormulas,
  resolveFormulaRules,
} from "../src/adapters/writers/xlsxSurgical";
import { inspectWorkbook } from "../src/adapters/writers/inspectWorkbook";
import { decideDeterministic } from "../src/adapters/ai/formulaColumnAnalyzer";
import { DONA_MARI_LAYOUT, SheetRow, SheetRowLayout } from "../src/domain/layout";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

/* ────────────────────────────────────────────────────────────────────────
 * Transposicao de formula — a mesma semantica de arrastar para baixo
 * ──────────────────────────────────────────────────────────────────────── */

describe("translateFormula", () => {
  it("desloca a referencia relativa junto com a linha", () => {
    expect(translateFormula("H13+F14-G14", 14, 300)).toBe("H299+F300-G300");
    expect(translateFormula("D13*2", 13, 14)).toBe("D14*2");
  });

  it("nao desloca o que esta travado com $", () => {
    expect(translateFormula("$B$5+C13", 13, 20)).toBe("$B$5+C20");
    expect(translateFormula("B$5+$C13", 13, 20)).toBe("B$5+$C20");
  });

  it("preserva referencia a outra aba e intervalo sem linha", () => {
    const f = 'IF(ISERROR(VLOOKUP(D13,Categorias!A:B,2,0)),"",VLOOKUP(D13,Categorias!A:B,2,0))';
    expect(translateFormula(f, 13, 250)).toBe(
      'IF(ISERROR(VLOOKUP(D250,Categorias!A:B,2,0)),"",VLOOKUP(D250,Categorias!A:B,2,0))',
    );
  });

  it("nao mexe no que esta dentro de aspas", () => {
    expect(translateFormula('IF(A1="B12","B12",A1)', 1, 5)).toBe('IF(A5="B12","B12",A5)');
  });

  it("nao confunde nome de funcao com referencia de celula", () => {
    expect(translateFormula("LOG10(A1)", 1, 9)).toBe("LOG10(A9)");
    expect(translateFormula("SUM(A1:A3)", 1, 5)).toBe("SUM(A5:A7)");
  });

  it("devolve null quando a transposicao levaria a linha para antes da 1", () => {
    expect(translateFormula("H13+F14-G14", 14, 1)).toBeNull();
  });

  it("linha igual devolve a formula intacta", () => {
    expect(translateFormula("H13+F14-G14", 14, 14)).toBe("H13+F14-G14");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Formula compartilhada — o ponteiro `si` precisa ser resolvido
 * ──────────────────────────────────────────────────────────────────────── */

const ABA_COMPARTILHADA = `<worksheet><sheetData>
<row r="12"><c r="B12" t="inlineStr"><is><t>Data</t></is></c><c r="H12" t="inlineStr"><is><t>Saldo</t></is></c></row>
<row r="13"><c r="B13"><v>46000</v></c><c r="H13" s="9"><f>G7+F13-G13</f><v>10</v></c></row>
<row r="14"><c r="B14"><v>46001</v></c><c r="H14" s="9"><f t="shared" ref="H14:H16" si="0">H13+F14-G14</f><v>20</v></c></row>
<row r="15"><c r="B15"><v>46002</v></c><c r="H15" s="9"><f t="shared" si="0"/><v>30</v></c></row>
<row r="16"><c r="B16"/><c r="H16" s="9"/></row>
</sheetData></worksheet>`;

describe("formula compartilhada", () => {
  it("mapeia o si para a formula-mestra", () => {
    const m = sharedFormulaMasters(ABA_COMPARTILHADA);
    expect(m.get("0")).toEqual({ text: "H13+F14-G14", row: 14 });
  });

  it("a linha que so tem o ponteiro conta como linha COM formula", () => {
    const fs = readSheetFormulas(ABA_COMPARTILHADA, 13);
    const h15 = fs.find((f) => f.row === 15 && f.column === "H")!;
    expect(h15.text).toBe("H13+F14-G14");
    expect(h15.originRow).toBe(14); // deslocamento parte da mestra
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Deteccao sobre o arquivo real
 * ──────────────────────────────────────────────────────────────────────── */

describe("detectFormulaColumns na planilha real", () => {
  it("reconhece Fluxo de Caixa (por linha) e Saldo (acumulada)", async () => {
    const ins = await inspectWorkbook(templateBytes());
    const e = formulaRuleFor(ins.formulaColumns, "E")!;
    const h = formulaRuleFor(ins.formulaColumns, "H")!;
    expect(e.kind).toBe("linha");
    expect(e.template).toContain("VLOOKUP");
    expect(h.kind).toBe("acumulada");
    expect(h.template).toMatch(/^H\d+\+F\d+-G\d+$/);
    // a primeira linha de dados e diferente: aponta para o saldo inicial
    expect(h.templateFirstRow).toBe("G7+F13-G13");
  });

  it("nao trata coluna gravavel como calculada", async () => {
    const ins = await inspectWorkbook(templateBytes());
    const letras = ins.formulaColumns.map((f) => f.letter);
    for (const gravavel of DONA_MARI_LAYOUT.writableColumns) {
      expect(letras).not.toContain(gravavel);
    }
  });
});

describe("mergeFormulaRules", () => {
  const r = (letter: string, sheet: string, ocorrencias: number): FormulaColumnRule => ({
    letter,
    header: "",
    template: `${letter}1`,
    templateRow: 1,
    kind: "linha",
    cellType: null,
    styleNum: null,
    porColuna: true,
    ocorrencias,
    sheet,
    motivo: "",
  });

  it("a aba com mais ocorrencias ensina a aba que nunca foi usada", () => {
    const out = mergeFormulaRules([[r("H", "JANEIRO", 0)], [r("H", "MAIO", 250)]]);
    expect(out).toHaveLength(1);
    expect(out[0].sheet).toBe("MAIO");
  });
});

describe("decideDeterministic", () => {
  const base: FormulaColumnRule = {
    letter: "H",
    header: "Saldo",
    template: "H12+F13-G13",
    templateRow: 13,
    kind: "acumulada",
    cellType: null,
    styleNum: null,
    porColuna: true,
    ocorrencias: 100,
    sheet: "MAIO",
    motivo: "",
  };

  it("coluna acumulada e sempre padrao", () => {
    expect(decideDeterministic({ ...base, porColuna: false, ocorrencias: 4 })).toEqual({
      perpetuar: true,
      conclusivo: true,
    });
  });

  it("formula em praticamente toda linha e padrao", () => {
    expect(decideDeterministic({ ...base, kind: "linha" }).perpetuar).toBe(true);
  });

  it("uma ou duas ocorrencias = calculo avulso, nao repete", () => {
    const d = decideDeterministic({ ...base, kind: "linha", porColuna: false, ocorrencias: 2 });
    expect(d).toEqual({ perpetuar: false, conclusivo: true });
  });

  it("o meio-termo fica pendente para o estagio dedicado", () => {
    const d = decideDeterministic({ ...base, kind: "linha", porColuna: false, ocorrencias: 7 });
    expect(d.conclusivo).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Perpetuacao na escrita — o bug do cliente
 * ──────────────────────────────────────────────────────────────────────── */

const REGRA_E: FormulaColumnRule = {
  letter: "E",
  header: "Fluxo de Caixa",
  template: 'IF(ISERROR(VLOOKUP(D13,Categorias!A:B,2,0)),"",VLOOKUP(D13,Categorias!A:B,2,0))',
  templateRow: 13,
  kind: "linha",
  cellType: "str",
  styleNum: "38",
  porColuna: true,
  ocorrencias: 100,
  sheet: "JULHO",
  motivo: "",
};

const REGRA_H: FormulaColumnRule = {
  letter: "H",
  header: "Saldo",
  template: "H13+F14-G14",
  templateRow: 14,
  kind: "acumulada",
  cellType: null,
  styleNum: "79",
  porColuna: true,
  ocorrencias: 100,
  sheet: "JULHO",
  motivo: "",
  templateFirstRow: "G7+F13-G13",
  templateFirstRowOrigin: 13,
};

describe("perpetuateFormulas", () => {
  const xml = `<worksheet><sheetData><row r="200"><c r="B200" s="1"><v>46000</v></c><c r="E200" s="38"/><c r="H200" s="79"/></row></sheetData></worksheet>`;

  it("escreve a formula transposta na linha nova (o que faltava)", () => {
    const out = perpetuateFormulas(xml, 200, [REGRA_E, REGRA_H], 13);
    expect(out).toContain("VLOOKUP(D200,Categorias!A:B,2,0)");
    expect(out).toContain("<f>H199+F200-G200</f>");
  });

  it("grava a formula sem valor em cache — quem calcula e o Excel", () => {
    const out = perpetuateFormulas(xml, 200, [REGRA_H], 13);
    expect(out).toMatch(/<c r="H200"[^>]*><f>H199\+F200-G200<\/f><\/c>/);
    expect(out).not.toMatch(/<c r="H200"[^>]*>.*?<v>/);
  });

  it("mantem o estilo que a celula ja tinha", () => {
    const out = perpetuateFormulas(xml, 200, [REGRA_E], 13);
    expect(out).toContain('<c r="E200" s="38">');
  });

  it("herda o estilo da regra quando a celula nem existe na linha", () => {
    const magra = `<worksheet><sheetData><row r="200"><c r="B200" s="1"><v>46000</v></c></row></sheetData></worksheet>`;
    const out = perpetuateFormulas(magra, 200, [REGRA_H], 13);
    expect(out).toContain('<c r="H200" s="79">');
  });

  it("NUNCA sobrescreve formula existente — a da planilha e soberana", () => {
    const comFormula = `<worksheet><sheetData><row r="200"><c r="H200" s="79"><f>MINHA_FORMULA()</f><v>1</v></c></row></sheetData></worksheet>`;
    expect(perpetuateFormulas(comFormula, 200, [REGRA_H], 13)).toBe(comFormula);
  });

  it("usa o modelo da PRIMEIRA linha quando escreve na primeira linha de dados", () => {
    const primeira = `<worksheet><sheetData><row r="13"><c r="H13" s="79"/></row></sheetData></worksheet>`;
    const out = perpetuateFormulas(primeira, 13, [REGRA_H], 13);
    expect(out).toContain("<f>G7+F13-G13</f>");
  });

  it("escapa a formula para XML valido", () => {
    const regra: FormulaColumnRule = { ...REGRA_E, template: 'IF(D13>0,"a","b")', templateRow: 13 };
    const out = perpetuateFormulas(xml, 200, [regra], 13);
    expect(out).toContain("IF(D200&gt;0,&quot;a&quot;,&quot;b&quot;)");
  });
});

describe("resolveFormulaRules — a aba de destino tem a ultima palavra", () => {
  const layout: SheetRowLayout = { ...DONA_MARI_LAYOUT, formulaColumns: [REGRA_H] };

  it("prefere o padrao praticado na propria aba", () => {
    const out = resolveFormulaRules(ABA_COMPARTILHADA, "MAIO", {
      ...layout,
      firstDataRow: 13,
    });
    const h = formulaRuleFor(out, "H")!;
    expect(h.sheet).toBe("MAIO");
    expect(h.template).toBe("H13+F14-G14");
  });

  it("uma aba sem formula nenhuma herda o modelo consolidado do perfil", () => {
    const vazia = `<worksheet><sheetData><row r="13"><c r="B13"/><c r="H13"/></row></sheetData></worksheet>`;
    const out = resolveFormulaRules(vazia, "JANEIRO", layout);
    expect(formulaRuleFor(out, "H")!.template).toBe("H13+F14-G14");
  });

  it("formula avulsa numa coluna que o perfil nao reconheceu nao vira regra", () => {
    const avulsa = `<worksheet><sheetData><row r="13"><c r="J13"><f>SUM(F13:G13)</f></c></row></sheetData></worksheet>`;
    const out = resolveFormulaRules(avulsa, "MAIO", layout);
    expect(formulaRuleFor(out, "J")).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Fim a fim, no arquivo real
 * ──────────────────────────────────────────────────────────────────────── */

const SHEET_FILE = "xl/worksheets/sheet10.xml"; // JULHO

const linhas: SheetRow[] = [
  {
    dateSerial: 46210,
    dateText: "07/07/2026",
    description: "NOME01 | Pix",
    category: "Salário ",
    entradaCents: null,
    saidaCents: 3200,
  },
];

async function sheetXmlOf(bytes: Uint8Array, file: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(file)!.async("string");
}

describe("escrita fim a fim (planilha real)", () => {
  it("pede recalculo na abertura, para o Fluxo/Saldo aparecerem preenchidos", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows("JULHO", linhas, DONA_MARI_LAYOUT);
    const wb = await sheetXmlOf(await w.toBytes(), "xl/workbook.xml");
    expect(wb).toContain('fullCalcOnLoad="1"');
  });

  it("a categoria vai para a celula com a grafia exata da lista", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows("JULHO", linhas, DONA_MARI_LAYOUT);
    const after = await sheetXmlOf(await w.toBytes(), SHEET_FILE);
    expect(after).toContain(
      `<c r="D${outcome.firstRow}" s="1" t="inlineStr"><is><t xml:space="preserve">Salário </t></is></c>`,
    );
  });

  it("linha nova em aba cujas linhas livres nao tinham formula sai COM formula", async () => {
    // reproduz o caso real: a aba tem dados ate a linha 14 e as linhas livres
    // seguintes existem sem <f> nenhum — era ali que Fluxo e Saldo ficavam vazios
    const semFormula = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="12"><c r="B12" t="inlineStr"><is><t>Data</t></is></c><c r="C12" t="inlineStr"><is><t>Descrição</t></is></c><c r="D12" t="inlineStr"><is><t>Categoria</t></is></c><c r="E12" t="inlineStr"><is><t>Fluxo de Caixa</t></is></c><c r="F12" t="inlineStr"><is><t>Entrada</t></is></c><c r="G12" t="inlineStr"><is><t>Saída</t></is></c><c r="H12" t="inlineStr"><is><t>Saldo</t></is></c></row>
<row r="13"><c r="B13" t="inlineStr"><is><t>01/07/2026</t></is></c><c r="C13" t="inlineStr"><is><t>Anterior</t></is></c><c r="D13" s="1"/><c r="E13" s="38"><f>IF(ISERROR(VLOOKUP(D13,Categorias!A:B,2,0)),"",VLOOKUP(D13,Categorias!A:B,2,0))</f></c><c r="F13" s="39"><v>100</v></c><c r="G13" s="40"/><c r="H13" s="79"><f>G7+F13-G13</f><v>100</v></c></row>
<row r="14"><c r="B14" t="inlineStr"><is><t>02/07/2026</t></is></c><c r="C14" t="inlineStr"><is><t>Outro</t></is></c><c r="D14" s="1"/><c r="E14" s="38"><f>IF(ISERROR(VLOOKUP(D14,Categorias!A:B,2,0)),"",VLOOKUP(D14,Categorias!A:B,2,0))</f></c><c r="F14" s="39"><v>50</v></c><c r="G14" s="40"/><c r="H14" s="79"><f>H13+F14-G14</f><v>150</v></c></row>
<row r="15"><c r="B15"/><c r="C15"/><c r="D15" s="1"/><c r="E15" s="38"/><c r="F15" s="39"/><c r="G15" s="40"/><c r="H15" s="79"/></row>
</sheetData></worksheet>`;
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
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="JULHO" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>`,
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file("xl/worksheets/sheet1.xml", semFormula);
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const ins = await inspectWorkbook(bytes);
    const layout: SheetRowLayout = { ...DONA_MARI_LAYOUT, formulaColumns: ins.formulaColumns };

    const w = await XlsxSurgicalWriter.load(bytes);
    const outcome = await w.appendRows("JULHO", linhas, layout);
    expect(outcome.firstRow).toBe(15);
    const after = await sheetXmlOf(await w.toBytes(), "xl/worksheets/sheet1.xml");
    expect(after).toContain("VLOOKUP(D15,Categorias!A:B,2,0)");
    expect(after).toContain("<f>H14+F15-G15</f>");
  });
});

describe("aviso de corrente interrompida", () => {
  it("avisa quando a linha de cima esta sem saldo (o acumulado recomeca ali)", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    // JULHO esta vazia: a primeira gravacao cai na primeira linha de dados, que
    // nao tem linha anterior — nada a avisar
    const primeiro = await w.appendRows("JULHO", linhas, DONA_MARI_LAYOUT);
    expect(primeiro.firstRow).toBe(DONA_MARI_LAYOUT.firstDataRow);
    expect(primeiro.warnings).toEqual([]);
  });

  it("a observacao nomeia a aba e a linha do buraco", async () => {
    const xml = `<worksheet><sheetData>
<row r="13"><c r="B13" t="inlineStr"><is><t>01/07/2026</t></is></c><c r="H13" s="79"/></row>
<row r="14"><c r="B14"/><c r="H14" s="79"/></row>
</sheetData></worksheet>`;
    // a linha 13 nao tem saldo nem formula; escrever na 14 quebra a corrente
    const rules = [REGRA_H];
    const w = perpetuateFormulas(xml, 14, rules, 13);
    expect(w).toContain("<f>H13+F14-G14</f>"); // a formula sai correta
  });
});

describe("prudencia: modelo que nao se generaliza nao e arrastado", () => {
  it("coluna com apenas a formula do saldo INICIAL nao ganha modelo geral", () => {
    // `G7+F13-G13` alcanca o cabecalho; copiada para a linha 300 daria
    // `G294+F300-G300`. Melhor a celula vazia do que um numero inventado.
    const xml = `<worksheet><sheetData>
<row r="12"><c r="H12" t="inlineStr"><is><t>Saldo</t></is></c></row>
<row r="13"><c r="H13" s="79"><f>G7+F13-G13</f><v>100</v></c></row>
</sheetData></worksheet>`;
    const [regra] = detectFormulaColumns({
      sheetName: "JULHO",
      sheetXml: xml,
      firstDataRow: 13,
      headers: new Map([["H", "Saldo"]]),
    });
    expect(regra.template).toBe("");
    expect(regra.templateFirstRow).toBe("G7+F13-G13");

    // na linha 200 nao escreve nada; na primeira linha, escreve o modelo certo
    const alvo = `<worksheet><sheetData><row r="200"><c r="H200" s="79"/></row><row r="13"><c r="H13" s="79"/></row></sheetData></worksheet>`;
    expect(perpetuateFormulas(alvo, 200, [regra], 13)).toBe(alvo);
    expect(perpetuateFormulas(alvo, 13, [regra], 13)).toContain("<f>G7+F13-G13</f>");
  });
});
