import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  arbitrar,
  cruzar,
  LeituraCandidata,
} from "../src/adapters/parsers/arbitrate";
import {
  HybridStatementParser,
  MemoPageTextExtractor,
  StrategyInfo,
} from "../src/adapters/parsers/hybrid";
import { AiReadOptions, AiReadResult } from "../src/adapters/ai/aiStatementParser";
import { AiError, RawStatement } from "../src/application/ports";
import { Transaction } from "../src/domain/transaction";
import { Money } from "../src/domain/money";
import { parseCsv } from "../src/adapters/parsers/csvTable";
import { parseTabularStatement } from "../src/adapters/parsers/tabularStatement";

/**
 * T-ARBITRAGEM — duas leituras do mesmo extrato, e uma escolha defensável.
 *
 * O que estes testes travam não é "qual das duas é melhor no geral", e sim a
 * regra que decide caso a caso: **prova vence**. O teste que mais importa aqui
 * é o que parece contraintuitivo — a IA trazendo MAIS lançamentos e ainda
 * assim perdendo. É o comportamento certo: um lançamento a mais numa planilha
 * de fluxo de caixa é dinheiro que nunca existiu, e só a prova consegue
 * distinguir "o parser cegou" de "o modelo inventou".
 */

const here = dirname(fileURLToPath(import.meta.url));
const csvTexto = readFileSync(join(here, "fixtures", "stone_extrato.csv"), "utf-8");
const rows = parseCsv(csvTexto);
const csvBytes = new TextEncoder().encode(csvTexto);

/** 16 movimentações + 3 tarifas derivadas da coluna. */
const LANCAMENTOS = 19;
const SEM_TARIFA = 16;

const deterministicas = parseTabularStatement(rows).transactions;

function tx(dia: number, cents: number, direction: "credit" | "debit", description: string): Transaction {
  return {
    date: { year: 2026, month: 8, day: dia },
    description,
    direction,
    amount: Money.fromCents(cents),
    account: { id: "stone-1", label: "Stone" },
    sourceOrder: 0,
    rawLine: "",
  };
}

function candidata(p: Partial<LeituraCandidata>): LeituraCandidata {
  return {
    via: "deterministic",
    parserId: "tabular-saldo",
    label: "Leitura direta",
    transactions: [],
    evidencia: [],
    chamadas: 0,
    nivel: "provada",
    ...p,
  };
}

/* ── a regra de decisão ─────────────────────────────────────────────────── */

describe("T-ARBITRAGEM — quem ganha, e por quê", () => {
  it("a prova vence MESMO quando a IA traz mais lançamentos", () => {
    const det = candidata({ transactions: [tx(1, 1000, "credit", "Pix - A")] });
    const ia = candidata({
      via: "ai",
      parserId: "ai",
      nivel: "empirica",
      label: "Conferência por IA",
      transactions: [tx(1, 1000, "credit", "Pix - A"), tx(2, 5000, "credit", "Pix - fantasma")],
    });
    const r = arbitrar(det, ia);
    expect(r.escolhida.via).toBe("deterministic");
    expect(r.transactions.length).toBe(1);
  });

  it("…e a discordância não some: ela vai para o cruzamento", () => {
    const det = candidata({ transactions: [tx(1, 1000, "credit", "Pix - A")] });
    const ia = candidata({
      via: "ai",
      nivel: "empirica",
      transactions: [tx(1, 1000, "credit", "Pix - A"), tx(2, 5000, "credit", "Pix - fantasma")],
    });
    const r = arbitrar(det, ia);
    expect(r.cruzamento!.soNaTestemunha).toBe(1);
    expect(r.cruzamento!.divergencias[0].lado).toBe("so-na-testemunha");
    expect(r.cruzamento!.divergencias[0].valor).toBe("R$ 50,00");
    expect(r.escolhida.evidencia.join(" ")).toMatch(/discordou em 1 lançamento/);
  });

  it("sem prova, a IA assume — é o comportamento que sempre existiu", () => {
    const det = candidata({ transactions: null, recusa: "a corrente de saldos se rompe", nivel: "recusada" });
    const ia = candidata({
      via: "ai",
      parserId: "ai",
      nivel: "empirica",
      transactions: [tx(1, 1000, "credit", "Pix - A")],
    });
    const r = arbitrar(det, ia);
    expect(r.escolhida.via).toBe("ai");
    expect(r.transactions.length).toBe(1);
    expect(r.cruzamento).toBeNull(); // não há duas leituras para cruzar
  });

  it("quando as duas enxergam o mesmo conjunto, a leitura sobe para CORROBORADA", () => {
    const iguais = [tx(1, 1000, "credit", "Pix - A"), tx(2, 2500, "debit", "Pix - B")];
    const det = candidata({ transactions: iguais });
    const ia = candidata({
      via: "ai",
      nivel: "empirica",
      // a IA escreve a descrição de outro jeito — e isso NÃO é divergência
      transactions: [tx(1, 1000, "credit", "PIX RECEBIDO A"), tx(2, 2500, "debit", "PIX ENVIADO B")],
    });
    const r = arbitrar(det, ia);
    expect(r.escolhida.nivel).toBe("corroborada");
    expect(r.cruzamento!.emComum).toBe(2);
    expect(r.cruzamento!.soNaEscolhida + r.cruzamento!.soNaTestemunha).toBe(0);
  });

  it("a testemunha que não apareceu não derruba a prova", () => {
    const det = candidata({ transactions: [tx(1, 1000, "credit", "Pix - A")] });
    const ia = candidata({ via: "ai", nivel: "recusada", transactions: null, recusa: "chave inválida" });
    const r = arbitrar(det, ia);
    expect(r.escolhida.via).toBe("deterministic");
    expect(r.escolhida.nivel).toBe("provada"); // provada, não corroborada
    expect(r.cruzamento).toBeNull();
  });

  it("as duas falhando, não há leitura — e o erro diz por quê", () => {
    const det = candidata({ transactions: null, recusa: "linha ilegível", nivel: "recusada" });
    const ia = candidata({ via: "ai", nivel: "recusada", transactions: null, recusa: "sem chave" });
    expect(() => arbitrar(det, ia)).toThrow(/linha ilegível/);
  });

  it("o erro da IA sobe INTACTO quando ela era a leitura — a interface precisa da categoria", () => {
    // Sem isto, "Falta configurar a chave da API — abra as Configurações" vira
    // um generico "Não foi possível concluir a conciliação", e o usuario fica
    // sem o botao que resolve o problema dele.
    const semChave = new AiError("no_key", "Nenhuma chave configurada para o provedor.");
    const det = candidata({ transactions: null, recusa: "sem parser para este formato", nivel: "recusada" });
    const ia = candidata({
      via: "ai",
      nivel: "recusada",
      transactions: null,
      recusa: semChave.message,
      erro: semChave,
    });
    expect(() => arbitrar(det, ia)).toThrow(AiError);
    try {
      arbitrar(det, ia);
    } catch (e) {
      expect((e as AiError).kind).toBe("no_key");
    }
  });

  it("o resultado nunca é a UNIÃO das duas — vem inteiro de uma", () => {
    const det = candidata({ transactions: [tx(1, 1000, "credit", "Pix - A")] });
    const ia = candidata({
      via: "ai",
      nivel: "empirica",
      transactions: [tx(9, 777, "debit", "outra coisa")],
    });
    const r = arbitrar(det, ia);
    expect(r.transactions).toEqual(det.transactions);
    expect(r.transactions.length).toBe(1);
  });
});

/* ── o cruzamento ───────────────────────────────────────────────────────── */

describe("T-ARBITRAGEM — o cruzamento compara o que dá para comparar", () => {
  it("a descrição NÃO entra na chave: o mesmo lançamento escrito diferente é o mesmo", () => {
    const c = cruzar(
      [tx(1, 1000, "credit", "Pix - MARIA DA SILVA LTDA")],
      [tx(1, 1000, "credit", "PIX RECEB MARIA")],
      false,
    );
    expect(c.emComum).toBe(1);
    expect(c.soNaEscolhida + c.soNaTestemunha).toBe(0);
  });

  it("a contagem importa: dois Pix iguais no mesmo dia são dois lançamentos", () => {
    const c = cruzar(
      [tx(1, 2500, "credit", "Pix - A"), tx(1, 2500, "credit", "Pix - B")],
      [tx(1, 2500, "credit", "Pix - A")],
      false,
    );
    expect(c.emComum).toBe(1);
    expect(c.soNaEscolhida).toBe(1);
  });

  it("as TARIFAS derivadas da coluna ficam de fora — e o relatório diz isso", () => {
    const c = cruzar(
      [tx(1, 2500, "credit", "Maquininha - A"), tx(1, 24, "debit", "Tarifa")],
      [tx(1, 2500, "credit", "Maquininha - A")],
      false,
    );
    expect(c.emComum).toBe(1);
    expect(c.soNaEscolhida).toBe(0);
    expect(c.ressalvas.join(" ")).toMatch(/tarifa ficaram de fora/);
  });

  it("com AMOSTRA, o cruzamento vale só para a janela — e sem os dias das pontas", () => {
    const escolhida = [1, 2, 3, 4, 5].map((d) => tx(d, 1000, "credit", `Pix - dia ${d}`));
    // a testemunha só leu os dias 2 a 4; o dia 1 e o 5 dela nem existem
    const testemunha = [2, 3, 4].map((d) => tx(d, 1000, "credit", `Pix - dia ${d}`));
    const c = cruzar(escolhida, testemunha, true);
    expect(c.cobertura).toBe("amostra");
    expect(c.janela).toEqual({ de: "03/08/2026", ate: "03/08/2026" });
    // só o dia 3 entrou: os dias 2 e 4 são as pontas da amostra
    expect(c.emComum).toBe(1);
    expect(c.soNaEscolhida).toBe(0);
    expect(c.ressalvas.join(" ")).toMatch(/amostra/);
  });

  it("amostra curta demais não cruza nada — melhor calar que dar alarme falso", () => {
    const c = cruzar([tx(1, 1000, "credit", "a")], [tx(1, 1000, "credit", "a")], true);
    expect(c.cobertura).toBe("nenhuma");
    expect(c.divergencias).toEqual([]);
  });

  it("uma divergência DENTRO da janela amostrada é detectada", () => {
    const escolhida = [1, 2, 3, 4, 5].map((d) => tx(d, 1000, "credit", `Pix - dia ${d}`));
    const testemunha = [
      ...[2, 4].map((d) => tx(d, 1000, "credit", `Pix - dia ${d}`)),
      tx(3, 9999, "credit", "Pix - que a direta não viu"),
    ];
    const c = cruzar(escolhida, testemunha, true);
    expect(c.soNaTestemunha).toBe(1);
    expect(c.soNaEscolhida).toBe(1); // o dia 3 de R$ 10,00 ficou sem par
  });
});

/* ── o caminho completo, pelo roteador ──────────────────────────────────── */

/** Motor de IA falso que registra COMO foi chamado (amostra ou arquivo inteiro). */
function motorFalso(
  transactions: Transaction[],
  opts: { falha?: string; blocosNoArquivo?: number } = {},
) {
  const registro = { chamadoComo: null as null | "amostra" | "inteiro", blocos: 0 };
  return {
    registro,
    motor: {
      id: "ai",
      canParse: () => true,
      parse: async () => {
        registro.chamadoComo = "inteiro";
        if (opts.falha) throw new Error(opts.falha);
        return transactions;
      },
      read: async (_raw: RawStatement, o?: AiReadOptions): Promise<AiReadResult> => {
        registro.chamadoComo = o?.amostraDeBlocos ? "amostra" : "inteiro";
        registro.blocos = o?.amostraDeBlocos ?? 0;
        if (opts.falha) throw new Error(opts.falha);
        const total = opts.blocosNoArquivo ?? 9;
        // espelha o motor real: pedir mais blocos do que o arquivo tem não é
        // amostra nenhuma — é o arquivo inteiro, e aí o cruzamento vale inteiro
        const lidos = Math.min(o?.amostraDeBlocos ?? total, total);
        return {
          transactions,
          particoes: { total: lidos, lidas: lidos, comErro: 0, noArquivo: total },
          chamadas: lidos + 1,
          amostra: lidos < total ? { blocos: lidos, deTotal: total, indices: [0, 4, 8] } : null,
          quebrasDeSaldo: 0,
          fantasmasDescartados: 0,
        };
      },
    },
  };
}

const semPdf = new MemoPageTextExtractor({ extractPages: async () => [] });

describe("T-ARBITRAGEM — as duas vias pelo roteador", () => {
  it("prova fechada: a IA é chamada como TESTEMUNHA, por amostra", async () => {
    const { motor, registro } = motorFalso(deterministicas.filter((t) => t.description !== "Tarifa"));
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await h.parse({ fileName: "e.csv", bytes: csvBytes });
    expect(txs.length).toBe(LANCAMENTOS);
    expect(registro.chamadoComo).toBe("amostra");
    expect(info!.kind).toBe("deterministic");
    expect(info!.testemunha?.chamadas).toBeGreaterThan(0);
  });

  it("sem parser e sem chave de IA, o erro que chega à tela é o da chave", async () => {
    const semChave = new AiError("no_key", "Nenhuma chave configurada.");
    const motor = {
      id: "ai",
      canParse: () => true,
      parse: async () => {
        throw semChave;
      },
    };
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const semSaldo = new TextEncoder().encode("Data,Descrição,Valor\n01/08/2026,Pix,10\n");
    await expect(h.parse({ fileName: "x.csv", bytes: semSaldo })).rejects.toBeInstanceOf(AiError);
  });

  it("prova recusada: a IA é chamada como LEITURA, arquivo inteiro", async () => {
    const daIa = [tx(1, 1000, "credit", "Pix - A")];
    const { motor, registro } = motorFalso(daIa);
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const semSaldo = "Data,Descrição,Valor\n01/08/2026,Pix,10\n";
    const txs = await h.parse({ fileName: "e.csv", bytes: new TextEncoder().encode(semSaldo) });
    expect(registro.chamadoComo).toBe("inteiro");
    expect(txs.length).toBe(1);
    expect(info!.kind).toBe("ai");
    expect(info!.nivel).toBe("empirica");
  });

  it("a IA que estoura NÃO derruba a leitura provada", async () => {
    const { motor } = motorFalso([], { falha: "provedor fora do ar" });
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await h.parse({ fileName: "e.csv", bytes: csvBytes });
    expect(txs.length).toBe(LANCAMENTOS);
    expect(info!.nivel).toBe("provada");
    expect(info!.testemunha?.recusa).toMatch(/fora do ar/);
  });

  it("desligada nas Configurações, a conferência não gasta chamada nenhuma", async () => {
    const { motor, registro } = motorFalso([]);
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      validacaoIa: { ativa: false },
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await h.parse({ fileName: "e.csv", bytes: csvBytes });
    expect(txs.length).toBe(LANCAMENTOS);
    expect(registro.chamadoComo).toBeNull();
    expect(info!.testemunha).toBeNull();
    expect(info!.nivel).toBe("provada");
  });

  it("a leitura provada que a IA confirma sai como CORROBORADA", async () => {
    // a testemunha enxerga as mesmas 16 movimentações (sem as tarifas, que são
    // coluna e não linha) — leitura integral, para o cruzamento valer inteiro
    const { motor } = motorFalso(deterministicas.filter((t) => t.description !== "Tarifa"), {
      blocosNoArquivo: 1,
    });
    let info: StrategyInfo | undefined;
    const h = new HybridStatementParser({
      ai: motor,
      pdfText: semPdf,
      // 1 bloco de amostra num arquivo de 1 bloco = leitura integral
      validacaoIa: { ativa: true, blocosDeAmostra: 1 },
      onStrategy: (i) => (info = i),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    await h.parse({ fileName: "e.csv", bytes: csvBytes });
    expect(info!.cruzamento!.emComum).toBe(SEM_TARIFA);
    expect(info!.cruzamento!.soNaEscolhida).toBe(0);
    expect(info!.cruzamento!.soNaTestemunha).toBe(0);
    expect(info!.nivel).toBe("corroborada");
  });

  it("motor antigo, sem `read`, continua servindo — lê o arquivo inteiro", async () => {
    const daIa = deterministicas.filter((t) => t.description !== "Tarifa");
    const simples = {
      id: "ai",
      canParse: () => true,
      chamado: false,
      parse: async () => {
        simples.chamado = true;
        return daIa;
      },
    };
    const h = new HybridStatementParser({
      ai: simples,
      pdfText: semPdf,
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await h.parse({ fileName: "e.csv", bytes: csvBytes });
    expect(simples.chamado).toBe(true);
    expect(txs.length).toBe(LANCAMENTOS); // a prova continua vencendo
  });
});
