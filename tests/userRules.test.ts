import { describe, it, expect } from "vitest";
import {
  UserRule,
  RuleContext,
  applyIdentityAnswers,
  buildIdentityQuestions,
  classificarNome,
  decidirCategoria,
  matchUserRule,
  nomeKey,
  optionForUserRule,
  problemasDaRegra,
  regrasSemCategoria,
} from "../src/domain/userRules";

/**
 * T-REGRA — as regras do USUARIO.
 *
 * A pergunta que este arquivo responde e sempre a mesma: o sistema aprendeu o
 * que o dono do negocio ensinou, sem inventar nada por conta propria?
 *
 * Os nomes e as categorias abaixo sao os do caso real: "sempre quando for pra
 * elas e salario — Paulo Valente, Wanda (motoboy)".
 */

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

function regra(over: Partial<UserRule> = {}): UserRule {
  return {
    id: "r1",
    ativo: true,
    rotulo: "Salário – Paulo",
    direcao: "saida",
    quando: { nome: "Paulo Valente" },
    categoriaChave: "SALARIO",
    origem: "manual",
    ...over,
  };
}

const ctx = (descricao: string, over: Partial<RuleContext> = {}): RuleContext => ({
  descricao,
  direcao: "saida",
  ...over,
});

const decide = (c: RuleContext, regras: UserRule[]) => decidirCategoria(c, CATEGORIAS, regras);

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA — o que o dono ensinou vale
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA — a regra do usuário decide o que o extrato não diz", () => {
  it("classifica o Pix de saída para a funcionária como salário", () => {
    const d = decide(ctx("Pix - Paulo Valente"), [regra()]);
    expect(d.option).toBe("Salário ");
    expect(d.decisor).toBe("regra-do-usuario");
    expect(d.porQuem).toBe("Salário – Paulo");
  });

  it("T-REGRA-GRAFIA: grava a string LITERAL da planilha, com o espaço no fim", () => {
    const d = decide(ctx("Pix - Paulo Valente"), [regra()]);
    // "Salário" (aparado) quebraria o VLOOKUP da coluna Fluxo de Caixa (§3.1)
    expect(d.option).toBe("Salário ");
    expect(d.option).not.toBe("Salário");
  });

  it("atravessa a diferença de escrita entre o parser direto e a IA (§3.4)", () => {
    // o parser direto transcreve o banco; a IA reescreve no padrão da planilha
    for (const desc of [
      "Pix - Paulo Valente",
      "Pix enviado - PAULO VALENTE",
      "PIX/Paulo Valente",
      "Transferência Pix Paulo Valente LTDA",
    ]) {
      expect(decide(ctx(desc), [regra()]).option).toBe("Salário ");
    }
  });

  it("a motoboy da casa cai em Motoboys", () => {
    const wanda = regra({
      id: "r2",
      rotulo: "Motoboy – Wanda",
      quando: { nome: "Wanda Lemos" },
      categoriaChave: "MOTOBOYS",
    });
    expect(decide(ctx("Pix - Wanda Lemos Tavares Horta"), [wanda]).option).toBe("Motoboys");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA-DIR — a direção é parte da regra (trava 1)
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-DIR — a direção é parte da regra", () => {
  it("regra de saída não toca no mesmo nome entrando", () => {
    const d = decide(ctx("Pix - Paulo Valente", { direcao: "entrada" }), [regra()]);
    // quem responde aqui é a regra da CASA: entrada por Pix é venda
    expect(d.option).toBe("Recebimento de venda");
    expect(d.decisor).toBe("regra-da-casa");
  });

  it("a mesma pessoa pode ter regra nos dois sentidos, com categorias diferentes", () => {
    const saida = regra();
    const entrada = regra({
      id: "r1b",
      rotulo: "Devolução – Paulo",
      direcao: "entrada",
      categoriaChave: "TROCO E DEVOLUCAO",
    });
    expect(decide(ctx("Pix - Paulo Valente"), [saida, entrada]).option).toBe("Salário ");
    expect(
      decide(ctx("Pix - Paulo Valente", { direcao: "entrada" }), [saida, entrada]).option,
    ).toBe("Troco e devolução");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA-CASA — o usuário ganha do ramo, mas o conflito aparece
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-CASA — precedência sobre a regra da casa", () => {
  const devolucao = regra({
    id: "r3",
    rotulo: "Devolução – Paulo",
    direcao: "entrada",
    categoriaChave: "TROCO E DEVOLUCAO",
  });

  it("a regra do usuário ganha da regra da casa", () => {
    const d = decide(ctx("Pix - Paulo Valente", { direcao: "entrada" }), [devolucao]);
    expect(d.option).toBe("Troco e devolução");
    expect(d.decisor).toBe("regra-do-usuario");
  });

  it("mas o relatório fica sabendo que ela contrariou a casa", () => {
    const d = decide(ctx("Pix - Paulo Valente", { direcao: "entrada" }), [devolucao]);
    expect(d.contrariaCasa?.id).toBe("recebimento-de-venda");
  });

  it("sem contradição, nada é reportado", () => {
    const d = decide(ctx("Pix - Paulo Valente"), [regra()]);
    expect(d.contrariaCasa).toBeUndefined();
  });

  it("sem regra do usuário, a casa continua decidindo como sempre", () => {
    expect(decide(ctx("Tarifa bancária"), []).option).toBe("Taxa de cartão");
    expect(decide(ctx("Pix - Fulano de Tal", { direcao: "entrada" }), []).option).toBe(
      "Recebimento de venda",
    );
    // saída para pessoa continua sem resposta determinística — é do classificador
    expect(decide(ctx("Pix - Gabriela Neves Klein Oliveira"), []).option).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA-CANDIDATO — nome parecido NÃO decide sozinho (trava 4)
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-CANDIDATO — identidade duvidosa vira pergunta, não decisão", () => {
  it("nome completo bate: é exato", () => {
    expect(classificarNome("Paulo Valente", "Pix - Paulo Valente")).toBe("exato");
  });

  it("nome abreviado não decide sozinho: vira candidato", () => {
    expect(classificarNome("Paulo Valente", "Pix - PAULO C DA SILVA")).toBe("candidato");
  });

  it("nome de UM token só nunca é exato — 'Wanda' não identifica ninguém", () => {
    expect(classificarNome("Wanda", "Pix - Wanda Lemos Tavares")).toBe("candidato");
    expect(classificarNome("Wanda", "Pix - Wanda Souza Nascimento")).toBe("candidato");
  });

  it("outra pessoa não vira nem candidato", () => {
    expect(classificarNome("Paulo Valente", "Pix - Rafael Santos")).toBe("nenhum");
    expect(classificarNome("Wanda Lemos", "Pix - Aldair Mendes")).toBe("nenhum");
  });

  it("com pendência, ninguém decide — nem a regra da casa por baixo", () => {
    const d = decide(ctx("Pix - PAULO C DA SILVA", { direcao: "entrada" }), [
      regra({ direcao: "entrada", categoriaChave: "TROCO E DEVOLUCAO" }),
    ]);
    // a casa diria "Recebimento de venda"; gravar isso agora seria decidir
    // antes de saber se é a Paulo
    expect(d.option).toBeNull();
    expect(d.decisor).toBeNull();
    expect(d.pendentes).toHaveLength(1);
    expect(d.pendentes[0].kind).toBe("candidato");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * ESTÁGIO 4b — o agente de identidade: em lote, e com memória
 * ──────────────────────────────────────────────────────────────────────── */

describe("agente de identidade — pergunta em grupo, responde sim/não", () => {
  const wanda = regra({
    id: "r2",
    rotulo: "Motoboy – Wanda",
    quando: { nome: "Wanda" },
    categoriaChave: "MOTOBOYS",
  });

  it("40 lançamentos da mesma pessoa viram UMA pergunta", () => {
    const pendentes = Array.from({ length: 40 }, () =>
      matchUserRule(wanda, ctx("Pix - Wanda Lemos Tavares")),
    ).filter((m): m is NonNullable<typeof m> => m !== null);
    expect(pendentes).toHaveLength(40);

    const perguntas = buildIdentityQuestions(pendentes);
    expect(perguntas).toHaveLength(1);
    expect(perguntas[0].candidatos).toEqual(["WANDA LEMOS TAVARES"]);
  });

  it("nomes distintos da mesma regra ficam na mesma pergunta", () => {
    const pendentes = [
      matchUserRule(wanda, ctx("Pix - Wanda Lemos Tavares"))!,
      matchUserRule(wanda, ctx("Pix - Wanda Souza Nascimento"))!,
    ];
    const [q] = buildIdentityQuestions(pendentes);
    expect(q.ruleId).toBe("r2");
    expect(q.nomeCadastrado).toBe("Wanda");
    expect(q.candidatos).toEqual(["WANDA LEMOS TAVARES", "WANDA SOUZA NASCIMENTO"]);
  });

  it("o 'sim' vira alias e a próxima conciliação decide sem perguntar", () => {
    const [depois] = applyIdentityAnswers(
      [wanda],
      [{ ruleId: "r2", candidato: "WANDA LEMOS TAVARES", aplica: true }],
    );
    const d = decide(ctx("Pix - Wanda Lemos Tavares"), [depois]);
    expect(d.option).toBe("Motoboys");
    expect(d.pendentes).toHaveLength(0);
  });

  it("o 'não' também é lembrado — aquele nome nunca mais vira pergunta", () => {
    const [depois] = applyIdentityAnswers(
      [wanda],
      [{ ruleId: "r2", candidato: "WANDA SOUZA NASCIMENTO", aplica: false }],
    );
    const d = decide(ctx("Pix - Wanda Souza Nascimento"), [depois]);
    expect(d.option).toBeNull();
    expect(d.pendentes).toHaveLength(0);
    expect(buildIdentityQuestions(d.pendentes)).toHaveLength(0);
  });

  it("um veredicto novo corrige o anterior, sem duplicar alias", () => {
    let regras = applyIdentityAnswers(
      [wanda],
      [{ ruleId: "r2", candidato: "WANDA SOUZA NASCIMENTO", aplica: false }],
    );
    regras = applyIdentityAnswers(regras, [
      { ruleId: "r2", candidato: "WANDA SOUZA NASCIMENTO", aplica: true },
    ]);
    expect(regras[0].aliasesSim).toEqual(["WANDA SOUZA NASCIMENTO"]);
    expect(regras[0].aliasesNao).toEqual([]);
  });

  it("o alias sobrevive à mudança de prefixo da descrição", () => {
    const [depois] = applyIdentityAnswers(
      [wanda],
      [{ ruleId: "r2", candidato: "Pix - Wanda Lemos Tavares", aplica: true }],
    );
    expect(depois.aliasesSim).toEqual(["WANDA LEMOS TAVARES"]);
    expect(decide(ctx("Pix enviado - WANDA LEMOS TAVARES"), [depois]).option).toBe("Motoboys");
  });

  it("não muta as regras originais", () => {
    applyIdentityAnswers([wanda], [{ ruleId: "r2", candidato: "X Y", aplica: true }]);
    expect(wanda.aliasesSim).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * A categoria é sempre a da planilha (trava 2)
 * ──────────────────────────────────────────────────────────────────────── */

describe("a planilha manda — regra sem categoria equivalente não se aplica", () => {
  it("categoria fora da lista: a regra se cala em vez de inventar opção", () => {
    const inexistente = regra({ categoriaChave: "PROLABORE DOS SOCIOS FUNDADORES" });
    const d = decide(ctx("Pix - Paulo Valente"), [inexistente]);
    expect(d.option).toBeNull();
    expect(d.decisor).toBeNull();
  });

  it("e isso vira aviso no relatório, não silêncio", () => {
    const inexistente = regra({ categoriaChave: "PROLABORE DOS SOCIOS FUNDADORES" });
    expect(regrasSemCategoria([regra(), inexistente], CATEGORIAS)).toEqual([inexistente]);
  });

  it("a chave canônica casa com a grafia real, acento e espaço inclusos", () => {
    expect(optionForUserRule(regra({ categoriaChave: "SALARIO" }), CATEGORIAS)).toBe("Salário ");
    expect(optionForUserRule(regra({ categoriaChave: "salário" }), CATEGORIAS)).toBe("Salário ");
    expect(optionForUserRule(regra({ categoriaChave: "AGUA E ESGOTO" }), CATEGORIAS)).toBe(
      "Água e esgoto",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Condições auxiliares e escopo
 * ──────────────────────────────────────────────────────────────────────── */

describe("condições auxiliares", () => {
  it("termos livres exigem TODOS presentes", () => {
    const r = regra({
      rotulo: "Aluguel",
      quando: { contem: ["aluguel", "imobiliaria"] },
      categoriaChave: "ALUGUEL",
    });
    expect(decide(ctx("Pagamento aluguel Imobiliária Central"), [r]).option).toBe("Aluguel");
    expect(decide(ctx("Pagamento aluguel do galpão"), [r]).option).toBeNull();
  });

  it("a exceção desliga a regra mesmo tendo disparado (trava 3)", () => {
    const r = regra({ excecoes: ["adiantamento"] });
    expect(decide(ctx("Pix - Paulo Valente"), [r]).option).toBe("Salário ");
    expect(decide(ctx("Pix - Paulo Valente adiantamento"), [r]).option).toBeNull();
  });

  it("faixa de valor em centavos inteiros", () => {
    const r = regra({ quando: { nome: "Paulo Valente", valorCents: { min: 100000 } } });
    expect(decide(ctx("Pix - Paulo Valente", { valorCents: 150000 }), [r]).option).toBe(
      "Salário ",
    );
    expect(decide(ctx("Pix - Paulo Valente", { valorCents: 5000 }), [r]).option).toBeNull();
    // sem valor informado, a regra com faixa não arrisca
    expect(decide(ctx("Pix - Paulo Valente"), [r]).option).toBeNull();
  });

  it("o escopo por conta limita a regra àquele extrato", () => {
    const r = regra({ contaId: "stone-892952680" });
    expect(decide(ctx("Pix - Paulo Valente", { contaId: "stone-892952680" }), [r]).option).toBe(
      "Salário ",
    );
    expect(decide(ctx("Pix - Paulo Valente", { contaId: "pagbank-123" }), [r]).option).toBeNull();
  });

  it("regra desligada não decide nada", () => {
    expect(decide(ctx("Pix - Paulo Valente"), [regra({ ativo: false })]).option).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA-CONFLITO — duas regras, a mais específica ganha e o conflito aparece
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-CONFLITO — especificidade decide, o conflito é reportado", () => {
  const generica = regra({
    id: "g",
    rotulo: "Salário – Paulo",
    quando: { nome: "Paulo Valente" },
    categoriaChave: "SALARIO",
  });
  const especifica = regra({
    id: "e",
    rotulo: "Vale – Paulo",
    quando: { nome: "Paulo Valente", contem: ["vale"] },
    categoriaChave: "VALE TRANSPORTE",
  });

  it("a regra com mais condições ganha", () => {
    const d = decide(ctx("Pix - Paulo Valente vale transporte"), [generica, especifica]);
    expect(d.option).toBe("Vale transporte");
    expect(d.porQuem).toBe("Vale – Paulo");
  });

  it("a que perdeu, com categoria diferente, volta como conflito", () => {
    const d = decide(ctx("Pix - Paulo Valente vale transporte"), [generica, especifica]);
    expect(d.conflitos.map((r) => r.id)).toEqual(["g"]);
  });

  it("a ordem em que foram cadastradas não muda o resultado", () => {
    const a = decide(ctx("Pix - Paulo Valente vale transporte"), [generica, especifica]);
    const b = decide(ctx("Pix - Paulo Valente vale transporte"), [especifica, generica]);
    expect(b.option).toBe(a.option);
    expect(b.porQuem).toBe(a.porQuem);
  });

  it("duas regras concordando não geram conflito", () => {
    const outra = regra({ id: "x", rotulo: "Outra", quando: { nome: "Paulo Valente Silva" } });
    const d = decide(ctx("Pix - Paulo Valente Silva"), [generica, outra]);
    expect(d.option).toBe("Salário ");
    expect(d.conflitos).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Trava 6 — regra ruim é reprovada, e não derruba nada
 * ──────────────────────────────────────────────────────────────────────── */

describe("regra ruim é reprovada, nunca lançada", () => {
  it("regra sem condição casaria com o extrato inteiro", () => {
    const r = regra({ quando: {} });
    expect(problemasDaRegra(r)).toContain("regra sem condicao: casaria com todo lancamento da direcao");
    expect(decide(ctx("Pix - Qualquer Um"), [r]).option).toBeNull();
  });

  it("nome só de palavras genéricas é reprovado", () => {
    const r = regra({ quando: { nome: "Pix transferência LTDA" } });
    expect(problemasDaRegra(r).length).toBeGreaterThan(0);
    expect(decide(ctx("Pix - Paulo Valente"), [r]).option).toBeNull();
  });

  it("nome curto demais é reprovado", () => {
    expect(problemasDaRegra(regra({ quando: { nome: "Jo" } })).length).toBeGreaterThan(0);
  });

  it("faixa invertida e valor solto são reprovados", () => {
    expect(
      problemasDaRegra(regra({ quando: { nome: "Paulo Valente", valorCents: { min: 500, max: 100 } } })),
    ).toContain("faixa de valor invertida");
    expect(problemasDaRegra(regra({ quando: { valorCents: { min: 100 } } })).length).toBeGreaterThan(0);
  });

  it("regra sem categoria é reprovada", () => {
    expect(problemasDaRegra(regra({ categoriaChave: "" }))).toContain("regra sem categoria");
  });

  it("regra válida não tem problema nenhum", () => {
    expect(problemasDaRegra(regra())).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Chave de nome — por que counterpartyKey não serve aqui
 * ──────────────────────────────────────────────────────────────────────── */

describe("chave de nome", () => {
  it("descarta o meio de pagamento, que vem NA FRENTE nesta planilha", () => {
    // counterpartyKey corta no " - " e devolveria "PIX" para todas estas
    expect(nomeKey("Pix - Wanda Lemos Tavares")).toBe("WANDA LEMOS TAVARES");
    expect(nomeKey("Maquininha - Rafael Dias Duarte")).toBe("RAFAEL DIAS DUARTE");
  });

  it("descarta sufixo societário e conectivo", () => {
    expect(nomeKey("Pix - Fulano de Tal Comercio LTDA")).toBe("FULANO TAL COMERCIO");
    expect(nomeKey("FULANO COMERCIO ME")).toBe("FULANO COMERCIO");
  });

  it("é estável entre acento, caixa e pontuação", () => {
    expect(nomeKey("Pix/José  Antônio")).toBe(nomeKey("PIX - jose antonio"));
  });

  it("descrição só de ruído não vira chave", () => {
    expect(nomeKey("Pix transferência")).toBe("");
  });
});
