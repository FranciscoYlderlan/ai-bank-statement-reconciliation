import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { inspectWorkbook } from "../src/adapters/writers/inspectWorkbook";
import { profileWorkbook } from "../src/adapters/ai/workbookProfiler";
import { describeProfileForPrompt } from "../src/domain/workbookProfile";

/**
 * O padrao de escrita que os proximos estagios imitam sai daqui. Duas coisas
 * estavam erradas e as duas custavam caro na pratica:
 *
 *  - a coluna de exemplos era escolhida por "quantidade de texto", e nesta
 *    planilha a coluna DATA guarda "31/05/2026" como texto e ganha da descricao;
 *  - a amostra vinha da aba com MAIS linhas, e nao da aba mais recente — ou
 *    seja, do padrao antigo em vez do que o cliente escreve hoje.
 */

const linha = (r: number, data: string, desc: string, valor: string) =>
  `<row r="${r}">` +
  `<c r="B${r}" t="inlineStr"><is><t>${data}</t></is></c>` +
  `<c r="C${r}" t="inlineStr"><is><t>${desc}</t></is></c>` +
  `<c r="D${r}" t="inlineStr"><is><t>Recebimento de venda</t></is></c>` +
  `<c r="F${r}"><v>${valor}</v></c>` +
  `</row>`;

const cabecalho =
  `<row r="12">` +
  `<c r="B12" t="inlineStr"><is><t>Data</t></is></c>` +
  `<c r="C12" t="inlineStr"><is><t>Descrição</t></is></c>` +
  `<c r="D12" t="inlineStr"><is><t>Categoria</t></is></c>` +
  `<c r="E12" t="inlineStr"><is><t>Fluxo de Caixa</t></is></c>` +
  `<c r="F12" t="inlineStr"><is><t>Entrada</t></is></c>` +
  `<c r="G12" t="inlineStr"><is><t>Saída</t></is></c>` +
  `<c r="H12" t="inlineStr"><is><t>Saldo</t></is></c>` +
  `</row>`;

const aba = (linhas: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  cabecalho +
  linhas +
  `</sheetData></worksheet>`;

/** JANEIRO com o padrao ANTIGO (só o nome) e FEVEREIRO com o padrao ATUAL. */
async function planilhaComDoisPadroes(): Promise<Uint8Array> {
  // JANEIRO tem MAIS linhas de proposito: é a aba que a heurística antiga escolheria
  const janeiro = aba(
    Array.from({ length: 20 }, (_, i) =>
      linha(13 + i, `0${(i % 9) + 1}/01/2026`, `CLIENTE NUMERO ${i} DA SILVA`, "50"),
    ).join(""),
  );
  const fevereiro = aba(
    [
      linha(13, "03/02/2026", "Pix - RAMON DOS SANTOS", "50"),
      linha(14, "04/02/2026", "Maquininha - Orlando Cutrim", "30"),
      linha(15, "05/02/2026", "Pix - Cesar Quadros", "25"),
    ].join(""),
  );

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="JANEIRO" sheetId="1" r:id="rId1"/><sheet name="FEVEREIRO" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  );
  zip.file("xl/worksheets/sheet1.xml", janeiro);
  zip.file("xl/worksheets/sheet2.xml", fevereiro);
  return zip.generateAsync({ type: "uint8array" });
}

describe("estilo de descrição — de onde saem os exemplos", () => {
  it("os exemplos vêm da coluna DESCRIÇÃO, não da coluna de data guardada como texto", async () => {
    const ins = await inspectWorkbook(await planilhaComDoisPadroes());
    for (const s of ins.descriptionSamples) {
      expect(s).not.toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
    expect(ins.descriptionSamples.length).toBeGreaterThan(0);
  });

  it("os exemplos vêm da aba mais RECENTE com dados, não da com mais linhas", async () => {
    const ins = await inspectWorkbook(await planilhaComDoisPadroes());
    expect(ins.descriptionSamples).toEqual([
      "Pix - RAMON DOS SANTOS",
      "Maquininha - Orlando Cutrim",
      "Pix - Cesar Quadros",
    ]);
    // a aba antiga, com mais linhas, não contamina o padrão
    expect(ins.descriptionSamples.join(" ")).not.toContain("CLIENTE NUMERO");
  });

  it("o contrato de destino leva o padrão atual para os próximos estágios", async () => {
    const perfil = await profileWorkbook(await planilhaComDoisPadroes(), { disableAi: true });
    const contrato = describeProfileForPrompt(perfil);
    expect(contrato).toContain("Pix - RAMON DOS SANTOS");
    expect(perfil.descriptionStyle.separador).toBe(" - ");
  });
});
