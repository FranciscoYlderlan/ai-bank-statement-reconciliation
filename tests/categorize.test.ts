import { describe, it, expect } from "vitest";
import { AiCategorizer } from "../src/adapters/ai/aiCategorizer";
import { buildCategorizeUserPrompt } from "../src/adapters/ai/prompts/categorize";
import { AiClient, AiExtractionRequest, AiError } from "../src/application/ports";
import { Money } from "../src/domain/money";
import { Transaction } from "../src/domain/transaction";

const CATEGORIAS = ["Recebimento de venda", "Fornecedor", "Taxa de cartão", "Energia Elétrica"];

const tx = (description: string, direction: Transaction["direction"] = "credit"): Transaction => ({
  date: { year: 2026, month: 8, day: 4 },
  description,
  direction,
  amount: Money.fromReais(25),
  account: { id: "stone-x", label: "Stone" },
  sourceOrder: 0,
  rawLine: "",
});

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

/** Extrai os indices enviados no prompt para responder na mesma ordem. */
function indicesDoPrompt(prompt: string): number[] {
  const bloco = prompt.split("--- LANCAMENTOS ---")[1] ?? "";
  return [...bloco.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]));
}

describe("AiCategorizer — estagio dedicado de categorizacao", () => {
  it("classifica e devolve um array paralelo as transacoes", async () => {
    const ai = new ScriptedAi((req) => {
      const idx = indicesDoPrompt(req.userPrompt);
      return JSON.stringify({
        classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })),
      });
    });
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize([tx("PADARIA"), tx("ACOUGUE")], CATEGORIAS);
    expect(out).toEqual(["Fornecedor", "Fornecedor"]);
  });

  it("agrupa descricoes repetidas: pergunta UMA vez e replica a resposta", async () => {
    let itensEnviados = 0;
    const ai = new ScriptedAi((req) => {
      const idx = indicesDoPrompt(req.userPrompt);
      itensEnviados += idx.length;
      return JSON.stringify({
        classificacoes: idx.map((i) => ({ indice: i, categoria: "Recebimento de venda" })),
      });
    });
    // regras da casa desligadas: aqui o que esta sob teste e o AGRUPAMENTO,
    // e "VENDA PIX" numa entrada seria decidido pela regra antes do modelo
    const c = new AiCategorizer({
      client: ai,
      resolveConfig: cfg,
      logger: silent,
      disableHouseRules: true,
    });
    const txs = [tx("VENDA PIX"), tx("VENDA PIX"), tx("VENDA PIX"), tx("OUTRA COISA")];
    const out = await c.categorize(txs, CATEGORIAS);
    expect(itensEnviados).toBe(2); // 4 transacoes, 2 descricoes distintas
    expect(out.every((x) => x === "Recebimento de venda")).toBe(true);
  });

  it("DESCARTA categoria que nao esta na lista da planilha (dropdown nao pode quebrar)", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: "Alimentação fora do padrão" }] }),
    );
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("ALGO")], CATEGORIAS)).toEqual([null]);
  });

  it("aceita a categoria com diferenca de acento/caixa, normalizando para a grafia da planilha", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: "taxa de cartao" }] }),
    );
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("TARIFA")], CATEGORIAS)).toEqual(["Taxa de cartão"]);
  });

  it("categoria nula do modelo vira coluna vazia (melhor vazio que errado)", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: null }] }),
    );
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("INDECIFRAVEL")], CATEGORIAS)).toEqual([null]);
  });

  it("falha do provedor NAO derruba a conciliacao: fica sem categoria", async () => {
    const ai = new ScriptedAi(() => {
      throw new AiError("rate_limit", "limite atingido");
    });
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("PADARIA")], CATEGORIAS)).toEqual([null]);
  });

  it("sem lista de categorias, nem chama o provedor", async () => {
    const ai = new ScriptedAi(() => "{}");
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    expect(await c.categorize([tx("PADARIA")], [])).toEqual([null]);
    expect(ai.calls.length).toBe(0);
  });

  it("quebra em lotes e reporta progresso", async () => {
    const ai = new ScriptedAi((req) => {
      const idx = indicesDoPrompt(req.userPrompt);
      return JSON.stringify({
        classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })),
      });
    });
    const eventos: Array<[number, number]> = [];
    const c = new AiCategorizer({
      client: ai,
      resolveConfig: cfg,
      batchSize: 2,
      logger: silent,
      onProgress: (done, total) => eventos.push([done, total]),
    });
    const txs = Array.from({ length: 5 }, (_, i) => tx(`LANCAMENTO ${i}`));
    const out = await c.categorize(txs, CATEGORIAS);
    expect(out.every((x) => x === "Fornecedor")).toBe(true);
    expect(ai.calls.length).toBe(3); // 5 descricoes distintas / lote de 2
    expect(eventos[eventos.length - 1]).toEqual([3, 3]);
  });
});

describe("prompt de categorizacao", () => {
  it("leva as categorias validas e a direcao de cada lancamento", () => {
    const p = buildCategorizeUserPrompt(CATEGORIAS, [
      { indice: 0, descricao: "PADARIA CENTRAL", direcao: "saida", valor: "R$ 25,00" },
    ]);
    expect(p).toContain('- "Recebimento de venda"');
    expect(p).toContain("[saida] R$ 25,00 — PADARIA CENTRAL");
    expect(p).toContain('"classificacoes"');
  });

  it("nao mistura a tarefa de extracao: nao pede data, valor nem direcao de volta", () => {
    const p = buildCategorizeUserPrompt(CATEGORIAS, [
      { indice: 0, descricao: "X", direcao: "entrada", valor: "R$ 1,00" },
    ]);
    expect(p).not.toMatch(/"transacoes"/);
    expect(p).toContain("Classifique cada lancamento");
  });
});
