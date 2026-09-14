import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { inspectWorkbook, inspectionToPromptDump } from "../src/adapters/writers/inspectWorkbook";
import { profileWorkbook, profileFromInspection } from "../src/adapters/ai/workbookProfiler";
import {
  layoutFromProfile,
  describeProfileForPrompt,
  defaultProfile,
} from "../src/domain/workbookProfile";
import { DONA_MARI_LAYOUT } from "../src/domain/layout";
import { AiClient, AiExtractionRequest } from "../src/application/ports";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

/** Cliente de IA de mentira: devolve a resposta programada e guarda o prompt. */
class FakeAi implements AiClient {
  calls: AiExtractionRequest[] = [];
  constructor(private readonly answer: string) {}
  async complete(req: AiExtractionRequest): Promise<string> {
    this.calls.push(req);
    return this.answer;
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

const cfg = () => ({ provider: "openai" as const, model: "gpt-x", supportsDocument: true });

/** Planilha minima com cabecalhos FORA do padrao, para forcar o caminho de IA. */
async function planilhaForaDoPadrao(): Promise<Uint8Array> {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Dia</t></is></c><c r="B1" t="inlineStr"><is><t>Movimento</t></is></c><c r="C1" t="inlineStr"><is><t>Rubrica</t></is></c><c r="D1" t="inlineStr"><is><t>Cred</t></is></c><c r="E1" t="inlineStr"><is><t>Deb</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>01/05/2026</t></is></c><c r="B2" t="inlineStr"><is><t>PADARIA CENTRAL</t></is></c><c r="C2" t="inlineStr"><is><t>Fornecedor</t></is></c><c r="D2"/><c r="E2"><v>120.5</v></c></row>
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
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Caixa" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file("xl/worksheets/sheet1.xml", sheet);
  return zip.generateAsync({ type: "uint8array" });
}

describe("inspectWorkbook — leitura da estrutura sem IA", () => {
  it("acha o cabecalho, as 12 abas de mes e as categorias reais", async () => {
    const ins = await inspectWorkbook(templateBytes());
    expect(ins.headerRow).toBe(12);
    expect(ins.firstDataRow).toBe(13);
    expect(ins.monthSheets.length).toBe(12);
    expect(ins.categories.length).toBe(37);
    expect(ins.categories).toContain("Recebimento de venda");
    expect(ins.columns.map((c) => c.letter)).toEqual(["B", "C", "D", "E", "F", "G", "H"]);
  });

  it("prefere a aba com mais lancamentos, para ter amostras do conteudo real", async () => {
    const ins = await inspectWorkbook(templateBytes());
    expect(ins.filledRows).toBeGreaterThan(50);
    expect(ins.descriptionSamples.length).toBeGreaterThan(0);
    const descricao = ins.columns.find((c) => c.letter === "C")!;
    expect(descricao.samples.length).toBeGreaterThan(0);
  });

  it("marca como formula as colunas que o writer nao pode tocar", async () => {
    const ins = await inspectWorkbook(templateBytes());
    expect(ins.columns.find((c) => c.letter === "E")!.hasFormula).toBe(true);
    expect(ins.columns.find((c) => c.letter === "H")!.hasFormula).toBe(true);
    expect(ins.columns.find((c) => c.letter === "C")!.hasFormula).toBe(false);
  });
});

describe("profileWorkbook — deterministico primeiro, IA so se divergir", () => {
  it("na planilha conhecida resolve sozinho e NAO chama a IA", async () => {
    const ai = new FakeAi("{}");
    const p = await profileWorkbook(templateBytes(), { client: ai, resolveConfig: cfg });
    expect(p.source).toBe("deterministico");
    expect(ai.calls.length).toBe(0);
    // o contrato estrutural continua o mesmo; o que vem a mais e o que foi LIDO
    // do arquivo real — o dropdown da coluna D e as formulas de E/H —, que o
    // literal DONA_MARI_LAYOUT nao carrega de proposito
    const layout = layoutFromProfile(p);
    const { listColumns, formulaColumns, dateOrder, dateOrderBySheet, ...estrutura } = layout;
    const {
      listColumns: _l,
      formulaColumns: _f,
      dateOrder: _o,
      dateOrderBySheet: _os,
      ...esperado
    } = DONA_MARI_LAYOUT;
    expect(estrutura).toEqual(esperado);
    expect(listColumns!.map((c) => c.letter)).toEqual(["D"]);
    expect(formulaColumns!.map((c) => c.letter)).toEqual(["E", "H"]);
    // A ORDEM DAS DATAS tambem sai da inspecao local, e aba a aba. Nesta
    // planilha real MAIO desce (31 -> 09) e JUNHO sobe: a planilha inteira nao
    // tem uma ordem so, e dizer que tem seria inventar. E por isso que o writer
    // pergunta primeiro a ABA de destino e so depois o costume da planilha.
    expect(dateOrderBySheet!.MAIO.ordem).toBe("decrescente");
    expect(dateOrderBySheet!.JUNHO.ordem).toBe("crescente");
    expect(dateOrder).toBe("indefinida");
  });

  it("o perfil reproduz o contrato: A/E/H proibidas, B,C,D,F,G gravaveis", async () => {
    const ins = await inspectWorkbook(templateBytes());
    const p = profileFromInspection(ins)!;
    const layout = layoutFromProfile(p);
    expect(layout.forbiddenColumns).toEqual(["A", "E", "H"]);
    expect(layout.writableColumns).toEqual(["B", "C", "D", "F", "G"]);
  });

  it("planilha fora do padrao cai no prompt dedicado e mapeia os papeis", async () => {
    const ai = new FakeAi(
      JSON.stringify({
        linhaCabecalho: 1,
        primeiraLinhaDados: 2,
        colunas: [
          { letra: "A", cabecalho: "Dia", papel: "data", podeEscrever: true, recebe: "data" },
          { letra: "B", cabecalho: "Movimento", papel: "descricao", podeEscrever: true, recebe: "quem" },
          { letra: "C", cabecalho: "Rubrica", papel: "categoria", podeEscrever: true, recebe: "categoria" },
          { letra: "D", cabecalho: "Cred", papel: "entrada", podeEscrever: true, recebe: "entrada" },
          { letra: "E", cabecalho: "Deb", papel: "saida", podeEscrever: true, recebe: "saida" },
        ],
        estiloDescricao: { caixa: "maiuscula", separador: null, observacao: "nome em caixa alta" },
        observacoes: "",
      }),
    );
    const p = await profileWorkbook(await planilhaForaDoPadrao(), {
      client: ai,
      resolveConfig: cfg,
    });
    expect(p.source).toBe("ia");
    expect(ai.calls.length).toBe(1);
    const layout = layoutFromProfile(p);
    expect(layout.headerRow).toBe(1);
    expect(layout.firstDataRow).toBe(2);
    expect(layout.columns.date).toBe("A");
    expect(layout.columns.description).toBe("B");
    expect(layout.columns.entrada).toBe("D");
    expect(layout.columns.saida).toBe("E");
  });

  it("sem IA disponivel, planilha estranha nao derruba a conciliacao", async () => {
    const p = await profileWorkbook(await planilhaForaDoPadrao(), { disableAi: true });
    expect(p.source).toBe("padrao");
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(layoutFromProfile(p).columns.date).toBe("B"); // volta ao padrao
  });

  it("arquivo ilegivel vira perfil padrao com aviso, nunca excecao", async () => {
    const p = await profileWorkbook(new Uint8Array([1, 2, 3, 4]), { disableAi: true });
    expect(p.source).toBe("padrao");
    expect(p.warnings.join(" ")).toMatch(/inspecionar/i);
  });
});

describe("contrato de destino repassado aos proximos agentes", () => {
  it("descreve colunas, formulas e as categorias validas", async () => {
    const p = await profileWorkbook(templateBytes(), { disableAi: true });
    const bloco = describeProfileForPrompt(p);
    expect(bloco).toContain("PLANILHA DE DESTINO");
    expect(bloco).toContain("(descricao)");
    expect(bloco).toContain("[FORMULA — nao preencher]");
    expect(bloco).toContain("Recebimento de venda");
  });

  it("o dump da inspecao mostra o que cada coluna recebe", async () => {
    const dump = inspectionToPromptDump(await inspectWorkbook(templateBytes()));
    expect(dump).toContain("Linha de cabecalho detectada: 12");
    expect(dump).toContain('"Descrição"');
    expect(dump).toContain("formula=sim");
  });

  it("perfil padrao (planilha nova) ja traz o contrato completo", () => {
    const p = defaultProfile(["Fornecedor"]);
    expect(layoutFromProfile(p)).toEqual(DONA_MARI_LAYOUT);
    expect(describeProfileForPrompt(p)).toContain("Fornecedor");
  });
});
