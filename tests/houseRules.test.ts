import { describe, it, expect } from "vitest";
import {
  applyHouseRules,
  houseRulesPromptBlock,
  optionForRule,
  ruleApplies,
  HOUSE_RULES,
  RECEBIMENTO_DE_VENDA,
  TARIFA_BANCARIA,
} from "../src/domain/houseRules";
import { AiCategorizer } from "../src/adapters/ai/aiCategorizer";
import { AiClient, AiExtractionRequest, AiError } from "../src/application/ports";
import { Money } from "../src/domain/money";
import { Transaction } from "../src/domain/transaction";

/** As 37 categorias reais da planilha Cantina Bom Prato (grafia exata, espaços inclusos). */
const CATEGORIAS = [
  "Recebimento de venda",
  "Aluguel",
  "Vale transporte",
  "Fornecedor",
  "Salário ",
  "Material escritório/limpeza",
  "Gás",
  "Combustível",
  "Manutenção",
  "Impressão",
  "Não Operacional",
  "Motoboys",
  "Investimento",
  "Prolabore",
  "Retirada socios",
  "Ajuda de custo - motoboy",
  "Vale Alimentação",
  "Diárias - free lancer",
  "Farmácia",
  "DAS Simples Nacional",
  "Embalagens",
  "Móveis e Utensílios",
  "Taxa de cartão",
  "Taxa Ifood",
  "DAS - MEI",
  "Energia Elétrica",
  "Internet e Telefone",
  "Contador",
  "Softwares",
  "Empréstimos ",
  "Aporte de capital",
  "Água e esgoto",
  "Marketing",
  "Troco e devolução",
  "Comissões",
  "FGTS",
  "INSS",
];

const venda = (d: string) => applyHouseRules(d, "entrada", CATEGORIAS)?.option ?? null;
const saida = (d: string) => applyHouseRules(d, "saida", CATEGORIAS)?.option ?? null;

/* ────────────────────────────────────────────────────────────────────────
 * Recebimento de venda — descrições reais da planilha do cliente
 * ──────────────────────────────────────────────────────────────────────── */

describe("regra da casa — recebimento de venda", () => {
  it("acerta as descrições que a planilha real usa", () => {
    // exatamente como estão gravadas em JUNHO
    expect(venda("Pix - PATRICIA ANDRADE BARBOSA HORTA")).toBe("Recebimento de venda");
    expect(venda("Pix - Cesar Quadros Tavares Siqueira")).toBe("Recebimento de venda");
    expect(venda("Maquininha - Rafael Dias Duarte")).toBe("Recebimento de venda");
    expect(venda("Maquininha - Tomas Tavares Junqueira Macedo")).toBe("Recebimento de venda");
  });

  it("tolera o erro de digitação que existe na planilha", () => {
    // "RECEBIBMENTO" está escrito assim no arquivo do cliente; quem casa é
    // ANTECIPACAO + VENDAS, não a palavra errada
    expect(venda("RECEBIBMENTO ANTECIPAÇÃO VENDAS")).toBe("Recebimento de venda");
  });

  it("não depende de acento, caixa ou pontuação", () => {
    expect(venda("PIX/JOAO DA SILVA")).toBe("Recebimento de venda");
    expect(venda("pix  maria")).toBe("Recebimento de venda");
    expect(venda("Cartão de crédito - venda")).toBe("Recebimento de venda");
  });

  it("SAÍDA por Pix nunca é venda — é o que separa os dois mundos", () => {
    // todas essas existem em JUNHO como saída, em categorias completamente outras
    expect(saida("Pix - Wanda Lemos Tavares Horta")).toBeNull();
    expect(saida("Pix - Gabriela Neves Klein Oliveira")).toBeNull();
    expect(saida("Pix - Rafael Salgado Vasconcelos Jardim")).toBeNull();
    expect(saida("Maquininha - Fulano")).toBeNull();
  });

  it("entrada que NÃO é venda continua com o classificador", () => {
    expect(venda("Pix - APORTE DE CAPITAL SOCIO")).toBeNull();
    expect(venda("Pix recebido - estorno de compra")).toBeNull();
    expect(venda("Pix - devolucao de pedido")).toBeNull();
    expect(venda("Pix - reembolso")).toBeNull();
    expect(venda("Pix - emprestimo do banco")).toBeNull();
    expect(venda("Transferencia entre contas proprias")).toBeNull();
    expect(venda("Resgate de aplicacao")).toBeNull();
  });

  it("entrada sem instrumento de pagamento não dispara a regra", () => {
    // o iFood entra por outro caminho e o cliente lança como Não Operacional
    expect(venda("TRAMONTANA SERVICOS LTDA")).toBeNull();
    expect(venda("MARCELO JUNQUEIRA MACEDO")).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Tarifa bancária — a única regra de saída, e o critério que a autoriza
 * ──────────────────────────────────────────────────────────────────────── */

describe("regra da casa — tarifa bancária", () => {
  it("acerta as descrições que a planilha real usa", () => {
    expect(saida("Tarifa bancária")).toBe("Taxa de cartão");
    expect(saida("Tarifa")).toBe("Taxa de cartão");
    expect(saida("TARIFA PACOTE DE SERVICOS")).toBe("Taxa de cartão");
  });

  it('"taxa" solta NÃO vira tarifa — a planilha desmente essa generalização', () => {
    // "taxa são joão vila embratel" está lançada como Investimento no arquivo real
    expect(saida("taxa são joão vila embratel")).toBeNull();
    expect(saida("Taxa de lixo")).toBeNull();
    expect(saida("Taxa de iluminacao publica")).toBeNull();
  });

  it("não rouba o que tem categoria própria na planilha", () => {
    expect(saida("Taxa Ifood")).toBeNull();
    expect(saida("TARIFA IFOOD")).toBeNull();
    expect(saida("Taxa DAS Simples Nacional")).toBeNull();
  });

  it('"taxa" grudada no meio de pagamento vale', () => {
    expect(saida("Taxa de cartao")).toBe("Taxa de cartão");
    expect(saida("Taxa da maquininha")).toBe("Taxa de cartão");
    expect(saida("Taxa de antecipacao")).toBe("Taxa de cartão");
  });

  it("entrada com a palavra tarifa não dispara (a regra é de saída)", () => {
    expect(venda("Estorno de tarifa")).toBeNull();
  });
});

describe("o critério que autoriza uma regra de SAÍDA", () => {
  it("saída cujo gatilho nomeia a DESPESA é regra; a que nomeia a CONTRAPARTE não é", () => {
    // "Tarifa bancária" é o nome da despesa: o texto já é a resposta
    expect(saida("Tarifa bancária")).toBe("Taxa de cartão");
    // "Pix - NOME" é meio de pagamento + pessoa. Na planilha real, saindo, isso
    // aparece como Motoboys, Troco e devolução, Retirada socios, Salário e
    // Fornecedor — cinco categorias para o mesmo texto. Não há regra ali.
    expect(saida("Pix - Wanda Lemos Tavares Horta")).toBeNull();
    expect(saida("Pix - Gabriela Neves Klein Oliveira")).toBeNull();
    expect(saida("Maquininha - Fulano")).toBeNull();
  });

  it("nenhuma regra de saída dispara sobre meio de pagamento sozinho", () => {
    const deSaida = HOUSE_RULES.filter((r) => r.direction === "saida");
    expect(deSaida.length).toBeGreaterThan(0);
    for (const nome of ["PIX JOAO DA SILVA", "MAQUININHA MARIA", "CARTAO FULANO"]) {
      for (const r of deSaida) {
        expect(ruleApplies(r, nome, "saida")).toBe(false);
      }
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * A categoria é sempre a da planilha
 * ──────────────────────────────────────────────────────────────────────── */

describe("a regra nunca inventa categoria", () => {
  it("cala quando a planilha não tem a opção correspondente", () => {
    const outraPlanilha = ["Aluguel", "Fornecedor", "Energia"];
    expect(applyHouseRules("Pix - Fulano", "entrada", outraPlanilha)).toBeNull();
    expect(applyHouseRules("Tarifa bancária", "saida", outraPlanilha)).toBeNull();
  });

  it("aceita a mesma categoria escrita de outro jeito, devolvendo a grafia do arquivo", () => {
    expect(optionForRule(RECEBIMENTO_DE_VENDA, ["Receita de Vendas", "Aluguel"])).toBe(
      "Receita de Vendas",
    );
    expect(optionForRule(RECEBIMENTO_DE_VENDA, ["VENDAS "])).toBe("VENDAS ");
    expect(optionForRule(TARIFA_BANCARIA, ["Despesas bancárias"])).toBe("Despesas bancárias");
  });

  it("devolve a grafia exata, com espaço sobrando e tudo", () => {
    const lista = ["Recebimento de venda ", "Aluguel"];
    expect(optionForRule(RECEBIMENTO_DE_VENDA, lista)).toBe("Recebimento de venda ");
  });

  it("ruleApplies respeita a direção declarada na regra", () => {
    expect(ruleApplies(RECEBIMENTO_DE_VENDA, "Pix - X", "entrada")).toBe(true);
    expect(ruleApplies(RECEBIMENTO_DE_VENDA, "Pix - X", "saida")).toBe(false);
    expect(ruleApplies(TARIFA_BANCARIA, "Tarifa", "saida")).toBe(true);
    expect(ruleApplies(TARIFA_BANCARIA, "Tarifa", "entrada")).toBe(false);
  });
});

describe("houseRulesPromptBlock", () => {
  it("leva as regras com a categoria REAL da planilha", () => {
    const bloco = houseRulesPromptBlock(CATEGORIAS);
    expect(bloco).toContain('"Recebimento de venda"');
    expect(bloco).toContain('"Taxa de cartão"');
    expect(bloco).toContain("DIRECAO");
  });

  it("some inteiro quando a planilha não tem nenhuma das categorias", () => {
    expect(houseRulesPromptBlock(["Aluguel", "Energia"])).toBe("");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Integração com o estágio de categorização
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

const tx = (
  description: string,
  direction: Transaction["direction"] = "credit",
): Transaction => ({
  date: { year: 2026, month: 6, day: 17 },
  description,
  direction,
  amount: Money.fromReais(50),
  account: { id: "stone-x", label: "Stone" },
  sourceOrder: 0,
  rawLine: "",
});

describe("AiCategorizer com as regras da casa", () => {
  it("um extrato só de Pix e maquininha não chega a chamar o provedor", async () => {
    const ai = new ScriptedAi(() => "{}");
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize(
      [
        tx("Pix - PATRICIA ANDRADE BARBOSA HORTA"),
        tx("Maquininha - Rafael Dias Duarte"),
        tx("Pix - Alexandre Braga Esteves Teixeira"),
      ],
      CATEGORIAS,
    );
    expect(out).toEqual([
      "Recebimento de venda",
      "Recebimento de venda",
      "Recebimento de venda",
    ]);
    expect(ai.calls.length).toBe(0); // custo zero
  });

  it("a regra vale mesmo quando o provedor falha — era esse o caso do 'não classificou'", async () => {
    const ai = new ScriptedAi(() => {
      throw new AiError("rate_limit", "limite atingido");
    });
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize(
      [tx("Pix - Fulano"), tx("Tarifa bancária", "debit"), tx("ALGO OBSCURO")],
      CATEGORIAS,
    );
    expect(out[0]).toBe("Recebimento de venda");
    expect(out[1]).toBe("Taxa de cartão");
    expect(out[2]).toBeNull(); // esse dependia do modelo, e o modelo caiu
  });

  it("a regra ganha do modelo quando ele discorda — era esse o caso do 'classificou errado'", async () => {
    const ai = new ScriptedAi(() =>
      JSON.stringify({ classificacoes: [{ indice: 0, categoria: "Não Operacional" }] }),
    );
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize([tx("Pix - Fulano")], CATEGORIAS);
    expect(out).toEqual(["Recebimento de venda"]);
  });

  it("o que a regra não decide continua indo para o modelo, com as regras no prompt", async () => {
    const ai = new ScriptedAi((req) => {
      const bloco = req.userPrompt.split("--- LANCAMENTOS ---")[1] ?? "";
      const idx = [...bloco.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]));
      return JSON.stringify({
        classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })),
      });
    });
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize(
      [tx("Pix - Fulano"), tx("MERCADINHO CENTRAL", "debit")],
      CATEGORIAS,
    );
    expect(out).toEqual(["Recebimento de venda", "Fornecedor"]);
    expect(ai.calls.length).toBe(1);
    // só o lançamento indeciso foi perguntado
    expect(ai.calls[0].userPrompt).toContain("MERCADINHO CENTRAL");
    expect(ai.calls[0].userPrompt).not.toContain("Pix - Fulano");
    // e o modelo recebeu o critério da casa, para não contrariá-lo na fronteira
    expect(ai.calls[0].userPrompt).toContain("REGRAS DA CASA");
  });

  it("saída por Pix é perguntada ao modelo, não decidida pela regra", async () => {
    const ai = new ScriptedAi((req) => {
      const bloco = req.userPrompt.split("--- LANCAMENTOS ---")[1] ?? "";
      const idx = [...bloco.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]));
      return JSON.stringify({
        classificacoes: idx.map((i) => ({ indice: i, categoria: "Motoboys" })),
      });
    });
    const c = new AiCategorizer({ client: ai, resolveConfig: cfg, logger: silent });
    const out = await c.categorize([tx("Pix - Wanda Lemos Tavares Horta", "debit")], CATEGORIAS);
    expect(out).toEqual(["Motoboys"]);
    expect(ai.calls.length).toBe(1);
  });
});
