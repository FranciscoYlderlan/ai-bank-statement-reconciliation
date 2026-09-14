import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  optionKey,
  matchOption,
  ruleForColumn,
  describeListColumnsForPrompt,
  ListColumnRule,
} from "../src/domain/listColumns";
import {
  detectValidations,
  detectListColumns,
  readRangeOptions,
  extendValidationRange,
} from "../src/adapters/writers/inspectValidations";
import { inspectWorkbook } from "../src/adapters/writers/inspectWorkbook";
import { orientacaoFromUsage } from "../src/adapters/ai/listColumnAnalyzer";
import { AiCategorizer } from "../src/adapters/ai/aiCategorizer";
import { AiClient, AiExtractionRequest } from "../src/application/ports";
import { Money } from "../src/domain/money";
import { Transaction } from "../src/domain/transaction";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

const regra = (over: Partial<ListColumnRule> = {}): ListColumnRule => ({
  letter: "D",
  header: "Categoria",
  options: ["Recebimento de venda", "Salário ", "Empréstimos ", "Fornecedor"],
  source: "validacao-intervalo",
  sourceRef: "Categorias!$A:$A",
  appliesTo: "D13:D254",
  sheets: ["JULHO"],
  examples: [],
  orientacao: "",
  dicaPorOpcao: {},
  ...over,
});

/* ────────────────────────────────────────────────────────────────────────
 * A grafia da planilha e soberana
 * ──────────────────────────────────────────────────────────────────────── */

describe("grafia exata das opcoes (a origem do Fluxo de Caixa vazio)", () => {
  it("casa ignorando acento, caixa e espaco — mas devolve a string DA PLANILHA", () => {
    const r = regra();
    expect(matchOption(r, "salario")).toBe("Salário ");
    expect(matchOption(r, "Salário")).toBe("Salário ");
    expect(matchOption(r, "EMPRESTIMOS")).toBe("Empréstimos ");
    // o espaco no fim sobrevive: e ele que faz o VLOOKUP da coluna E casar
    expect(matchOption(r, "salario")!.endsWith(" ")).toBe(true);
  });

  it("opcao que nao existe na lista continua sendo descartada", () => {
    expect(matchOption(regra(), "Alimentação fora do padrão")).toBeNull();
    expect(matchOption(regra(), "")).toBeNull();
    expect(matchOption(regra(), null)).toBeNull();
  });

  it("optionKey normaliza so para comparar", () => {
    expect(optionKey("Salário ")).toBe(optionKey("salario"));
    expect(optionKey("DAS - MEI")).toBe(optionKey("das mei"));
    expect(optionKey("Água e esgoto")).not.toBe(optionKey("Aguas e esgoto"));
  });

  it("inspectWorkbook NAO apara a grafia das categorias (regressao do trim)", async () => {
    const ins = await inspectWorkbook(templateBytes());
    expect(ins.categories).toContain("Salário ");
    expect(ins.categories).toContain("Empréstimos ");
    expect(ins.categories).not.toContain("Salário");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Deteccao da validacao de dados
 * ──────────────────────────────────────────────────────────────────────── */

const SHEET_X14 = `<worksheet><sheetData/><extLst><ext><x14:dataValidations count="1"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>Categorias!$A:$A</xm:f></x14:formula1><xm:sqref>D13:D254</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>`;

const SHEET_CLASSICO = `<worksheet><sheetData/><dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="D13:D261"><formula1>Categorias!$A:$A</formula1></dataValidation></dataValidations></worksheet>`;

const SHEET_INLINE = `<worksheet><sheetData/><dataValidations count="1"><dataValidation type="list" sqref="F13:F20"><formula1>"Sim,Nao,Talvez"</formula1></dataValidation></dataValidations></worksheet>`;

describe("detectValidations — as duas formas que o Excel grava", () => {
  it("le a forma x14 (dentro de extLst), que e a usada quando a lista mora em outra aba", () => {
    const [v] = detectValidations(SHEET_X14);
    expect(v.column).toBe("D");
    expect(v.firstRow).toBe(13);
    expect(v.lastRow).toBe(254);
    expect(v.ref).toBe("Categorias!$A:$A");
    expect(v.x14).toBe(true);
  });

  it("le a forma classica, com sqref no atributo", () => {
    const [v] = detectValidations(SHEET_CLASSICO);
    expect(v.column).toBe("D");
    expect(v.lastRow).toBe(261);
    expect(v.x14).toBe(false);
  });

  it("le a lista escrita na propria formula", () => {
    const [v] = detectValidations(SHEET_INLINE);
    expect(v.column).toBe("F");
    expect(v.inlineOptions).toEqual(["Sim", "Nao", "Talvez"]);
  });

  it("ignora validacao que nao e do tipo lista", () => {
    const xml = `<worksheet><dataValidations><dataValidation type="decimal" sqref="F13:F20"><formula1>0</formula1></dataValidation></dataValidations></worksheet>`;
    expect(detectValidations(xml)).toEqual([]);
  });
});

describe("readRangeOptions — resolve a origem das opcoes", () => {
  const categorias = `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>CATEGORIA</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">Salário </t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Fornecedor</t></is></c></row>
</sheetData></worksheet>`;
  const sheets = [{ name: "Categorias", xml: categorias }];

  it("le a coluna inteira preservando o espaco no fim", () => {
    const r = readRangeOptions("Categorias!$A:$A", sheets, [], "JULHO");
    expect(r!.values).toEqual(["CATEGORIA", "Salário ", "Fornecedor"]);
  });

  it("respeita o intervalo com linhas explicitas", () => {
    const r = readRangeOptions("Categorias!$A$2:$A$3", sheets, [], "JULHO");
    expect(r!.values).toEqual(["Salário ", "Fornecedor"]);
  });

  it("recusa intervalo de mais de uma coluna", () => {
    expect(readRangeOptions("Categorias!A:B", sheets, [], "JULHO")).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Deteccao completa sobre o arquivo real
 * ──────────────────────────────────────────────────────────────────────── */

describe("detectListColumns na planilha real", () => {
  it("reconhece a coluna Categoria como coluna de listagem, com as 37 opcoes", async () => {
    const ins = await inspectWorkbook(templateBytes());
    const d = ruleForColumn(ins.listColumns, "D");
    expect(d).toBeTruthy();
    expect(d!.header).toBe("Categoria");
    expect(d!.source).toBe("validacao-intervalo");
    expect(d!.sourceRef).toBe("Categorias!$A:$A");
    expect(d!.options).toHaveLength(37);
    expect(d!.options).toContain("Salário ");
    // o cabecalho "CATEGORIA" do intervalo nao entra como opcao
    expect(d!.options).not.toContain("CATEGORIA");
  });

  it("nao confunde coluna de data ou de valor com coluna de listagem", async () => {
    const ins = await inspectWorkbook(templateBytes());
    const letras = ins.listColumns.map((c) => c.letter);
    expect(letras).not.toContain("B"); // Data
    expect(letras).not.toContain("C"); // Descricao
    expect(letras).not.toContain("F"); // Entrada
    expect(letras).not.toContain("G"); // Saida
  });
});

describe("detectListColumns sem validacao formal (inferencia por conteudo)", () => {
  const aba = (valores: string[]) => `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Rubrica</t></is></c><c r="B1" t="inlineStr"><is><t>Historico</t></is></c></row>
${valores
  .map(
    (v, i) =>
      `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${v}</t></is></c><c r="B${i + 2}" t="inlineStr"><is><t>lancamento ${i}</t></is></c></row>`,
  )
  .join("")}
</sheetData></worksheet>`;

  const rodar = (valores: string[]) =>
    detectListColumns({
      sheets: [{ name: "Caixa", xml: aba(valores) }],
      shared: [],
      dataSheets: ["Caixa"],
      headers: new Map([
        ["A", "Rubrica"],
        ["B", "Historico"],
      ]),
      firstDataRow: 2,
      descriptionColumn: "B",
    });

  it("poucos valores muito repetidos = coluna de listagem mantida na mao", () => {
    const rules = rodar(["Fornecedor", "Fornecedor", "Aluguel", "Aluguel", "Fornecedor", "Salario", "Aluguel", "Fornecedor", "Salario", "Aluguel"]);
    const a = ruleForColumn(rules, "A");
    expect(a).toBeTruthy();
    expect(a!.source).toBe("conteudo");
    expect(a!.options).toContain("Fornecedor");
  });

  it("texto livre NAO vira listagem", () => {
    const rules = rodar(
      Array.from({ length: 12 }, (_, i) => `Pagamento avulso numero ${i} para alguem`),
    );
    expect(ruleForColumn(rules, "A")).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Regra deduzida do uso, sem gastar chamada
 * ──────────────────────────────────────────────────────────────────────── */

describe("orientacaoFromUsage — o uso ja gravado e uma regra", () => {
  it("marca a direcao quando a opcao so aparece num sentido", () => {
    const r = orientacaoFromUsage(
      regra({
        examples: [
          { contexto: "Pix recebido", opcao: "Recebimento de venda", direcao: "entrada" },
          { contexto: "Maquininha", opcao: "Recebimento de venda", direcao: "entrada" },
          { contexto: "Folha julho", opcao: "Salário ", direcao: "saida" },
        ],
      }),
    );
    expect(r.dicaPorOpcao["Recebimento de venda"]).toContain("entrada");
    expect(r.dicaPorOpcao["Salário "]).toContain("saida");
    // a chave e a grafia da planilha, com espaco
    expect(Object.keys(r.dicaPorOpcao)).toContain("Salário ");
  });

  it("ignora exemplo cuja opcao nao esta na lista", () => {
    const r = orientacaoFromUsage(
      regra({ examples: [{ contexto: "X", opcao: "Categoria inexistente", direcao: "saida" }] }),
    );
    expect(r.dicaPorOpcao["Categoria inexistente"]).toBeUndefined();
  });
});

describe("describeListColumnsForPrompt", () => {
  it("mostra a opcao entre aspas, para o espaco no fim ficar visivel ao modelo", () => {
    const texto = describeListColumnsForPrompt([regra()]);
    expect(texto).toContain('- "Salário "');
    expect(texto).toContain("Coluna D");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Do modelo ate a celula
 * ──────────────────────────────────────────────────────────────────────── */

class ScriptedAi implements AiClient {
  calls: AiExtractionRequest[] = [];
  constructor(private readonly reply: (req: AiExtractionRequest) => string) {}
  async complete(req: AiExtractionRequest): Promise<string> {
    this.calls.push(req);
    return this.reply(req);
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

const cfg = () => ({ provider: "openai" as const, model: "gpt-x", supportsDocument: true });
const silent = { log: () => {}, warn: () => {}, error: () => {} };

const tx = (description: string): Transaction => ({
  date: { year: 2026, month: 8, day: 4 },
  description,
  direction: "debit",
  amount: Money.fromReais(25),
  account: { id: "stone-x", label: "Stone" },
  sourceOrder: 0,
  rawLine: "",
});

describe("AiCategorizer com a regra da coluna", () => {
  it("grava a grafia da PLANILHA mesmo quando o modelo devolve a versao aparada", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: "Salario" }] }),
    );
    const c = new AiCategorizer({
      client: ai,
      resolveConfig: cfg,
      logger: silent,
      rule: regra(),
    });
    const out = await c.categorize([tx("FOLHA DE PAGAMENTO")], []);
    expect(out).toEqual(["Salário "]);
  });

  it("a lista da regra dispensa a lista solta — e vai no prompt com aspas", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: "Fornecedor" }] }),
    );
    const c = new AiCategorizer({
      client: ai,
      resolveConfig: cfg,
      logger: silent,
      rule: regra({ orientacao: "siga o uso da planilha" }),
    });
    await c.categorize([tx("PADARIA")], []);
    expect(ai.calls[0].userPrompt).toContain('"Salário "');
    expect(ai.calls[0].userPrompt).toContain("siga o uso da planilha");
  });

  it("sem regra e sem lista, nem chama o provedor", async () => {
    const ai = new ScriptedAi(() => "{}");
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("X")], [])).toEqual([null]);
    expect(ai.calls.length).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * O dropdown tem de alcancar a linha nova
 * ──────────────────────────────────────────────────────────────────────── */

describe("extendValidationRange", () => {
  it("amplia o intervalo da forma classica", () => {
    const out = extendValidationRange(SHEET_CLASSICO, "D", 300);
    expect(out).toContain('sqref="D13:D300"');
  });

  it("amplia o intervalo da forma x14", () => {
    const out = extendValidationRange(SHEET_X14, "D", 300);
    expect(out).toContain("<xm:sqref>D13:D300</xm:sqref>");
  });

  it("nao encolhe o intervalo quando ja alcanca a linha", () => {
    expect(extendValidationRange(SHEET_CLASSICO, "D", 100)).toBe(SHEET_CLASSICO);
  });

  it("nao mexe na validacao de outra coluna", () => {
    expect(extendValidationRange(SHEET_INLINE, "D", 300)).toBe(SHEET_INLINE);
  });
});
