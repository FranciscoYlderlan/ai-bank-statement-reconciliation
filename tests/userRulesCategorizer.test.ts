import { describe, it, expect } from "vitest";
import { AiCategorizer, resumir } from "../src/adapters/ai/aiCategorizer";
import { IdentityAgent } from "../src/adapters/ai/identityAgent";
import { AiClient, AiExtractionRequest } from "../src/application/ports";
import { Money } from "../src/domain/money";
import { Transaction } from "../src/domain/transaction";
import { UserRule } from "../src/domain/userRules";

/**
 * A cadeia inteira do estágio 4, com a IA mockada:
 *
 *   4a regras do usuário → 4b agente de identidade → 4c regras da casa → 4d IA
 *
 * O que estes testes protegem, em uma frase: nenhuma categoria entra na
 * planilha sem que dê para dizer QUEM a decidiu, e o nome em dúvida nunca vira
 * categoria sem alguém ter confirmado que é a pessoa certa.
 */

const CATEGORIAS = [
  "Recebimento de venda",
  "Salário ",
  "Motoboys",
  "Fornecedor",
  "Taxa de cartão",
  "Vale transporte",
  "Troco e devolução",
];

let ordem = 0;
const tx = (
  description: string,
  direction: Transaction["direction"] = "debit",
  reais = 25,
): Transaction => ({
  date: { year: 2026, month: 8, day: 4 },
  description,
  direction,
  amount: Money.fromReais(reais),
  account: { id: "stone-x", label: "Stone" },
  sourceOrder: ordem++,
  rawLine: "",
});

const cfg = () => ({ provider: "openai" as const, model: "gpt-x", supportsDocument: true });
const silent = { log: () => {}, warn: () => {}, error: () => {} };

function ehIdentidade(req: AiExtractionRequest): boolean {
  return req.systemPrompt.includes("confere IDENTIDADE");
}

/** IA roteirizada: responde identidade e categorização de formas separadas. */
class ScriptedAi implements AiClient {
  chamadasIdentidade: AiExtractionRequest[] = [];
  chamadasCategoria: AiExtractionRequest[] = [];
  constructor(
    private readonly opts: {
      identidade?: (indices: number[], req: AiExtractionRequest) => string;
      categoria?: (indices: number[], req: AiExtractionRequest) => string;
    } = {},
  ) {}
  async complete(req: AiExtractionRequest): Promise<string> {
    if (ehIdentidade(req)) {
      this.chamadasIdentidade.push(req);
      const idx = indicesDeConferencia(req.userPrompt);
      if (!this.opts.identidade) throw new Error("identidade não roteirizada");
      return this.opts.identidade(idx, req);
    }
    this.chamadasCategoria.push(req);
    const idx = indicesDeLancamento(req.userPrompt);
    return (
      this.opts.categoria?.(idx, req) ??
      JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) })
    );
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

function indicesDeLancamento(prompt: string): number[] {
  const bloco = prompt.split("--- LANCAMENTOS ---")[1] ?? "";
  return [...bloco.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]));
}
function indicesDeConferencia(prompt: string): number[] {
  const bloco = prompt.split("--- CONFERENCIAS ---")[1] ?? "";
  return [...bloco.matchAll(/^\s+(\d+)\./gm)].map((m) => Number(m[1]));
}

const regra = (over: Partial<UserRule> = {}): UserRule => ({
  id: "r-paulo",
  ativo: true,
  rotulo: "Salário – Paulo",
  direcao: "saida",
  quando: { nome: "Paulo Valente" },
  categoriaChave: "SALARIO",
  origem: "manual",
  ...over,
});

function montar(ai: ScriptedAi, regras: UserRule[], comAgente = true) {
  return new AiCategorizer({
    client: ai,
    resolveConfig: cfg,
    logger: silent,
    regras,
    identity: comAgente
      ? new IdentityAgent({ client: ai, resolveConfig: cfg, logger: silent })
      : null,
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * 4a — a regra do usuário decide antes de qualquer chamada
 * ──────────────────────────────────────────────────────────────────────── */

describe("4a — regra do usuário", () => {
  it("decide sem gastar chamada nenhuma", async () => {
    const ai = new ScriptedAi();
    const r = await montar(ai, [regra()]).classificar(
      [tx("Pix - Paulo Valente"), tx("Pix - Paulo Valente", "debit", 900)],
      CATEGORIAS,
    );
    expect(r.categorias).toEqual(["Salário ", "Salário "]);
    expect(ai.chamadasCategoria).toHaveLength(0);
    expect(ai.chamadasIdentidade).toHaveLength(0);
  });

  it("o rastro diz quem decidiu cada lançamento", async () => {
    const ai = new ScriptedAi();
    const r = await montar(ai, [regra()]).classificar(
      [
        tx("Pix - Paulo Valente"), // regra do usuário
        tx("Tarifa bancária"), // regra da casa
        tx("Compra material limpeza"), // sobra para a IA
      ],
      CATEGORIAS,
    );
    expect(r.auditoria.map((a) => a.decisor)).toEqual(["regra-do-usuario", "regra-da-casa", "ia"]);
    expect(r.auditoria[0].porQuem).toBe("Salário – Paulo");
    expect(r.auditoria[1].porQuem).toBe("tarifa bancária");
    expect(r.resumo).toMatchObject({ porRegraDoUsuario: 1, porRegraDaCasa: 1, porIa: 1 });
  });

  it("só o que sobra vai para o classificador", async () => {
    const ai = new ScriptedAi();
    await montar(ai, [regra()]).classificar(
      [tx("Pix - Paulo Valente"), tx("Tarifa bancária"), tx("Compra material limpeza")],
      CATEGORIAS,
    );
    expect(ai.chamadasCategoria).toHaveLength(1);
    expect(indicesDeLancamento(ai.chamadasCategoria[0].userPrompt)).toHaveLength(1);
  });

  it("regra por VALOR funciona dentro do mesmo grupo de descrição", async () => {
    // é por isto que as regras rodam por transação e não por grupo: as duas
    // linhas têm a MESMA descrição e valores diferentes
    const porValor = regra({
      id: "r-vale",
      rotulo: "Vale – Paulo",
      quando: { nome: "Paulo Valente", valorCents: { max: 20000 } },
      categoriaChave: "VALE TRANSPORTE",
    });
    const ai = new ScriptedAi();
    const r = await montar(ai, [regra(), porValor]).classificar(
      [tx("Pix - Paulo Valente", "debit", 150), tx("Pix - Paulo Valente", "debit", 1800)],
      CATEGORIAS,
    );
    expect(r.categorias).toEqual(["Vale transporte", "Salário "]);
  });

  it("quando a regra contraria a casa, o relatório fica sabendo", async () => {
    const devolucao = regra({
      id: "r-dev",
      rotulo: "Devolução – Paulo",
      direcao: "entrada",
      categoriaChave: "TROCO E DEVOLUCAO",
    });
    const ai = new ScriptedAi();
    const r = await montar(ai, [devolucao]).classificar(
      [tx("Pix - Paulo Valente", "credit")],
      CATEGORIAS,
    );
    expect(r.categorias).toEqual(["Troco e devolução"]);
    expect(r.auditoria[0].contrariouCasa).toBe("recebimento de venda");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4b — o agente de identidade
 * ──────────────────────────────────────────────────────────────────────── */

describe("4b — agente de identidade", () => {
  const wanda = regra({
    id: "r-wanda",
    rotulo: "Motoboy – Wanda",
    quando: { nome: "Wanda" }, // um token só: nunca decide sozinho
    categoriaChave: "MOTOBOYS",
  });

  const simParaTodos = (idx: number[]) =>
    JSON.stringify({
      veredictos: idx.map((i) => ({ indice: i, mesmaPessoa: true, motivo: "mesma pessoa" })),
    });

  it("40 ocorrências da mesma pessoa custam UMA chamada", async () => {
    const ai = new ScriptedAi({ identidade: simParaTodos });
    const txs = Array.from({ length: 40 }, () => tx("Pix - Wanda Lemos Tavares"));
    const r = await montar(ai, [wanda]).classificar(txs, CATEGORIAS);

    expect(ai.chamadasIdentidade).toHaveLength(1);
    expect(indicesDeConferencia(ai.chamadasIdentidade[0].userPrompt)).toHaveLength(1);
    expect(new Set(r.categorias)).toEqual(new Set(["Motoboys"]));
    expect(ai.chamadasCategoria).toHaveLength(0);
  });

  it("confirmado vira categoria literal da planilha, marcado como via agente", async () => {
    const ai = new ScriptedAi({ identidade: simParaTodos });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);
    expect(r.categorias).toEqual(["Motoboys"]);
    expect(r.auditoria[0]).toMatchObject({
      decisor: "regra-do-usuario",
      porQuem: "Motoboy – Wanda",
      viaAgente: true,
    });
    expect(r.resumo.porAgente).toBe(1);
  });

  it("recusado NÃO vira categoria — vai para o classificador", async () => {
    const ai = new ScriptedAi({
      identidade: (idx) =>
        JSON.stringify({
          veredictos: idx.map((i) => ({ indice: i, mesmaPessoa: false, motivo: "outra família" })),
        }),
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Souza Nascimento")], CATEGORIAS);
    expect(r.categorias).toEqual(["Fornecedor"]);
    expect(r.auditoria[0].decisor).toBe("ia");
    expect(r.resumo.identidadesRecusadas).toBe(1);
  });

  it("cada pessoa recebe seu veredicto — sim para uma, não para outra", async () => {
    const ai = new ScriptedAi({
      identidade: (idx, req) => {
        const prompt = req.userPrompt;
        return JSON.stringify({
          veredictos: idx.map((i) => {
            const linha = prompt.split("\n").find((l) => l.trim().startsWith(`${i}.`)) ?? "";
            return {
              indice: i,
              mesmaPessoa: linha.includes("LEMOS"),
              motivo: "",
            };
          }),
        });
      },
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda]).classificar(
      [tx("Pix - Wanda Lemos Tavares"), tx("Pix - Wanda Souza Nascimento")],
      CATEGORIAS,
    );
    expect(r.categorias).toEqual(["Motoboys", "Fornecedor"]);
  });

  it("o alias aprendido volta nas regras, para a próxima vez não custar nada", async () => {
    const ai = new ScriptedAi({ identidade: simParaTodos });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);
    expect(r.regras[0].aliasesSim).toEqual(["WANDA LEMOS TAVARES"]);

    // segunda conciliação, agora com a regra aprendida: zero chamadas
    const ai2 = new ScriptedAi();
    const r2 = await montar(ai2, r.regras).classificar(
      [tx("Pix - Wanda Lemos Tavares")],
      CATEGORIAS,
    );
    expect(r2.categorias).toEqual(["Motoboys"]);
    expect(ai2.chamadasIdentidade).toHaveLength(0);
    expect(r2.auditoria[0].viaAgente).toBeUndefined();
  });

  it("as regras de entrada NÃO são mutadas — o resultado é uma cópia", async () => {
    const original = wanda;
    const ai = new ScriptedAi({ identidade: simParaTodos });
    await montar(ai, [original]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);
    expect(original.aliasesSim).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4b — o que acontece quando o agente falha ou responde besteira
 * ──────────────────────────────────────────────────────────────────────── */

describe("4b — o agente nunca derruba a conciliação", () => {
  const wanda = regra({
    id: "r-wanda",
    rotulo: "Motoboy – Wanda",
    quando: { nome: "Wanda" },
    categoriaChave: "MOTOBOYS",
  });

  it("falha do lote não vira 'não': vira ausência de veredicto", async () => {
    const ai = new ScriptedAi({
      identidade: () => {
        throw new Error("timeout do provedor");
      },
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);

    expect(r.categorias).toEqual(["Fornecedor"]); // seguiu para o classificador
    // e MUITO importante: não gravou alias negativo. Congelar um erro de rede
    // como decisão faria a pergunta nunca mais ser feita.
    expect(r.regras[0].aliasesNao).toBeUndefined();
    expect(r.avisos.join(" ")).toMatch(/identidade/);
  });

  it("veredicto com índice que não foi perguntado é descartado", async () => {
    const ai = new ScriptedAi({
      identidade: () =>
        JSON.stringify({
          veredictos: [{ indice: 99, mesmaPessoa: true, motivo: "inventado" }],
        }),
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);
    expect(r.categorias).toEqual(["Fornecedor"]);
    expect(r.regras[0].aliasesSim).toBeUndefined();
  });

  it("'sim' que não é booleano é tratado como não — a dúvida tem lado", async () => {
    const ai = new ScriptedAi({
      identidade: (idx) =>
        JSON.stringify({
          veredictos: idx.map((i) => ({ indice: i, mesmaPessoa: "sim", motivo: "" })),
        }),
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda]).classificar([tx("Pix - Wanda Lemos Tavares")], CATEGORIAS);
    expect(r.categorias).toEqual(["Fornecedor"]);
  });

  it("sem agente ligado, a dúvida vai direto para o classificador", async () => {
    const ai = new ScriptedAi({
      categoria: (idx) =>
        JSON.stringify({ classificacoes: idx.map((i) => ({ indice: i, categoria: "Fornecedor" })) }),
    });
    const r = await montar(ai, [wanda], false).classificar(
      [tx("Pix - Wanda Lemos Tavares")],
      CATEGORIAS,
    );
    expect(ai.chamadasIdentidade).toHaveLength(0);
    expect(r.categorias).toEqual(["Fornecedor"]);
    expect(r.resumo.chamadasIdentidade).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Compatibilidade e resumo
 * ──────────────────────────────────────────────────────────────────────── */

describe("compatibilidade e resumo", () => {
  it("sem regras do usuário, o comportamento é exatamente o de antes", async () => {
    const ai = new ScriptedAi();
    const r = await montar(ai, []).classificar(
      [tx("Pix - Fulano", "credit"), tx("Tarifa bancária"), tx("Compra qualquer")],
      CATEGORIAS,
    );
    expect(r.categorias).toEqual(["Recebimento de venda", "Taxa de cartão", "Fornecedor"]);
    expect(r.resumo.porRegraDoUsuario).toBe(0);
  });

  it("categorize() continua devolvendo só o array", async () => {
    const ai = new ScriptedAi();
    const out = await montar(ai, [regra()]).categorize([tx("Pix - Paulo Valente")], CATEGORIAS);
    expect(out).toEqual(["Salário "]);
  });

  it("resumir conta cada decisor uma vez só", () => {
    const resumo = resumir(
      [
        { indice: 0, descricao: "a", direcao: "saida", categoria: "X", decisor: "regra-do-usuario", porQuem: "R", viaAgente: true },
        { indice: 1, descricao: "b", direcao: "saida", categoria: "Y", decisor: "regra-da-casa", porQuem: "C" },
        { indice: 2, descricao: "c", direcao: "saida", categoria: "Z", decisor: "ia", porQuem: null },
        { indice: 3, descricao: "d", direcao: "saida", categoria: null, decisor: null, porQuem: null },
      ],
      2,
      1,
    );
    expect(resumo).toEqual({
      porRegraDoUsuario: 1,
      porAgente: 1,
      porRegraDaCasa: 1,
      porIa: 1,
      semCategoria: 1,
      chamadasIdentidade: 2,
      identidadesRecusadas: 1,
    });
  });

  it("lista de categorias vazia não chama nada", async () => {
    const ai = new ScriptedAi();
    const r = await montar(ai, [regra()]).classificar([tx("Pix - Paulo Valente")], []);
    expect(r.categorias).toEqual([null]);
    expect(ai.chamadasCategoria).toHaveLength(0);
    expect(ai.chamadasIdentidade).toHaveLength(0);
  });

  it("o nome da funcionária não viaja para o provedor no prompt de categoria", async () => {
    const ai = new ScriptedAi();
    await montar(ai, [regra()]).classificar(
      [tx("Pix - Paulo Valente"), tx("Compra material")],
      CATEGORIAS,
    );
    // o cadastro de nomes não entra no prompt: já decidiu deterministicamente
    expect(ai.chamadasCategoria[0].userPrompt).not.toContain("Paulo");
  });
});
