import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { createWorkbook } from "../src/adapters/writers/createWorkbook";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import { DONA_MARI_LAYOUT } from "../src/domain/layout";

describe("createWorkbook — planilha nova no padrao Cantina Bom Prato", () => {
  it("gera as 15 abas (Categorias + dashboard + 12 meses) legiveis pelo writer", async () => {
    const bytes = await createWorkbook();
    // salva para inspecao externa (openpyxl na fase de verificacao)
    writeFileSync("/tmp/nova_planilha.xlsx", bytes);

    const w = await XlsxSurgicalWriter.load(bytes);
    const names = await w.sheetNames();
    expect(names).toContain("Categorias");
    expect(names).toContain("FLUXO DE CAIXA  SIMPLIFICADO");
    expect(names).toContain("JANEIRO");
    expect(names).toContain("DEZEMBRO");
    expect(names.filter((n) => /JANEIRO|FEVEREIRO|MAR|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO/.test(n)).length).toBe(12);
  });

  it("aba de mes nova aceita escrita e reconhece as linhas (round-trip)", async () => {
    const bytes = await createWorkbook();
    const w = await XlsxSurgicalWriter.load(bytes);
    const outcome = await w.appendRows(
      "AGOSTO",
      [
        { dateSerial: 46250, dateText: "16/08/2026", description: "Venda PIX", category: null, entradaCents: 5000, saidaCents: null },
        { dateSerial: 46250, dateText: "16/08/2026", description: "Fornecedor", category: null, entradaCents: null, saidaCents: 1200 },
      ],
      DONA_MARI_LAYOUT,
    );
    expect(outcome.firstRow).toBe(13); // primeira linha de dados
    const existing = await w.readExisting("AGOSTO", DONA_MARI_LAYOUT);
    expect(existing.length).toBe(2);
    expect(existing[0].amount.cents).toBe(5000);
  });

  it("formulas E/H ficam SO nas linhas com dados (finalizeGeneratedTemplate)", async () => {
    const bytes = await createWorkbook();
    const w = await XlsxSurgicalWriter.load(bytes);
    await w.appendRows(
      "AGOSTO",
      [
        { dateSerial: 46250, dateText: "16/08/2026", description: "Venda PIX", category: null, entradaCents: 5000, saidaCents: null },
        { dateSerial: 46251, dateText: "17/08/2026", description: "Fornecedor", category: null, entradaCents: null, saidaCents: 1200 },
      ],
      DONA_MARI_LAYOUT,
    );
    await w.finalizeGeneratedTemplate(DONA_MARI_LAYOUT);

    const zip = await JSZip.loadAsync(await w.toBytes());
    const files = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    let agosto = "";
    let mesVazio = "";
    let dashboard = "";
    for (const f of files) {
      const xml = await zip.file(f)!.async("string");
      if (xml.includes("CONTROLE DE CAIXA — AGOSTO")) agosto = xml;
      if (xml.includes("CONTROLE DE CAIXA — MARÇO")) mesVazio = xml;
      if (xml.includes("FLUXO DE CAIXA — RESUMO MENSAL")) dashboard = xml;
    }
    expect(agosto).not.toBe("");

    const temFormula = (xml: string, ref: string) =>
      new RegExp(`<c r="${ref}"[^>]*?>\\s*<f`).test(xml);

    // 13 e 14 tem dados -> mantem VLOOKUP (E) e saldo corrente (H)
    expect(temFormula(agosto, "E13")).toBe(true);
    expect(temFormula(agosto, "H13")).toBe(true);
    expect(temFormula(agosto, "H14")).toBe(true);
    // dai em diante esta vazio -> nada de formula arrastando o saldo
    expect(temFormula(agosto, "E15")).toBe(false);
    expect(temFormula(agosto, "H15")).toBe(false);
    expect(temFormula(agosto, "H462")).toBe(false);
    // mes sem lancamento nenhum fica limpo do inicio ao fim
    expect(temFormula(mesVazio, "H13")).toBe(false);
    // o dashboard (SUM por mes) NAO e tocado
    expect(dashboard).toContain("<f>");
  });
});
