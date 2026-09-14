import { describe, it, expect } from "vitest";
import {
  ObservacaoHistorica,
  minerarRegras,
  regraDaSugestao,
  tituloDe,
} from "../src/domain/ruleMining";
import { chaveSugestao } from "../src/domain/ruleSet";
import { UserRule, decidirCategoria, problemasDaRegra } from "../src/domain/userRules";

/**
 * T-REGRA-MINA — as regras que o cliente já escreveu sem saber.
 *
 * A planilha dele é o registro de tudo o que já decidiu. Estes testes garantem
 * que só vira sugestão o que os dados sustentam — e que uma única divergência
 * no histórico é suficiente para a sugestão morrer. É a mesma disciplina que
 * impediu `taxa` de virar regra da casa (§3.3), só que automática.
 */

const CATEGORIAS = [
  "Recebimento de venda",
  "Salário ",
  "Motoboys",
  "Fornecedor",
  "Taxa de cartão",
  "Troco e devolução",
  "Retirada socios",
];

const obs = (
  descricao: string,
  categoria: string,
  direcao: "entrada" | "saida" = "saida",
  aba = "JUNHO",
): ObservacaoHistorica => ({ descricao, categoria, direcao, aba });

/** n lançamentos iguais — o jeito de montar evidência nos testes. */
function repetir(n: number, o: ObservacaoHistorica): ObservacaoHistorica[] {
  return Array.from({ length: n }, () => o);
}

const minerar = (h: ObservacaoHistorica[], extra: Partial<Parameters<typeof minerarRegras>[1]> = {}) =>
  minerarRegras(h, { categorias: CATEGORIAS, ...extra });

/* ────────────────────────────────────────────────────────────────────────
 * O caso que motivou tudo
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-MINA — a evidência vem da planilha do cliente", () => {
  it("seis meses pagando a mesma motoboy viram uma sugestão", () => {
    const s = minerar(repetir(6, obs("Pix - Wanda Lemos Tavares", "Motoboys")));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      nome: "WANDA LEMOS TAVARES",
      direcao: "saida",
      categoria: "Motoboys",
      ocorrencias: 6,
    });
  });

  it("a categoria mantém a grafia da planilha, espaço e tudo", () => {
    const s = minerar(repetir(4, obs("Pix - Paulo Valente Silva", "Salário ")));
    expect(s[0].categoria).toBe("Salário ");
    expect(s[0].categoriaChave).toBe("SALARIO");
  });

  it("descrições escritas de jeitos diferentes contam para a mesma pessoa", () => {
    const s = minerar([
      obs("Pix - Wanda Lemos Tavares", "Motoboys"),
      obs("Pix enviado - WANDA LEMOS TAVARES", "Motoboys"),
      obs("PIX/Wanda Lemos Tavares", "Motoboys"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].ocorrencias).toBe(3);
  });

  it("o dono reconhece a sugestão pelos exemplos e pelas abas", () => {
    const s = minerar([
      obs("Pix - Wanda Lemos Tavares", "Motoboys", "saida", "MAIO"),
      obs("Pix - Wanda Lemos Tavares", "Motoboys", "saida", "JUNHO"),
      obs("Pix enviado - Wanda Lemos Tavares", "Motoboys", "saida", "JULHO"),
    ]);
    expect(s[0].exemplos).toContain("Pix - Wanda Lemos Tavares");
    expect(s[0].abas.sort()).toEqual(["JULHO", "JUNHO", "MAIO"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * O critério — severo de propósito
 * ──────────────────────────────────────────────────────────────────────── */

describe("o critério de sugestão", () => {
  it("duas vezes não é padrão", () => {
    expect(minerar(repetir(2, obs("Pix - Wanda Lemos", "Motoboys")))).toEqual([]);
    expect(minerar(repetir(3, obs("Pix - Wanda Lemos", "Motoboys")))).toHaveLength(1);
  });

  it("UMA divergência mata a sugestão", () => {
    const h = [
      ...repetir(9, obs("Pix - Marcos Vinicius", "Fornecedor")),
      obs("Pix - Marcos Vinicius", "Retirada socios"),
    ];
    // 9 de 10 não basta: a pessoa recebe por mais de um motivo, e quem decide
    // isso é o classificador, que lê contexto
    expect(minerar(h)).toEqual([]);
  });

  it("nome de um token só nunca vira sugestão", () => {
    expect(minerar(repetir(10, obs("Pix - Wanda", "Motoboys")))).toEqual([]);
  });

  it("descrição que vira só ruído é descartada", () => {
    expect(minerar(repetir(10, obs("Pix transferência", "Fornecedor")))).toEqual([]);
  });

  it("lançamento sem categoria não ensina nada", () => {
    expect(minerar(repetir(10, obs("Pix - Wanda Lemos Tavares", "  ")))).toEqual([]);
  });

  it("a direção separa: entrando e saindo são baldes diferentes", () => {
    const h = [
      ...repetir(3, obs("Pix - Marcos Vinicius Souza", "Fornecedor", "saida")),
      ...repetir(3, obs("Pix - Marcos Vinicius Souza", "Troco e devolução", "entrada")),
    ];
    const s = minerar(h);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.direcao).sort()).toEqual(["entrada", "saida"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * O que fica de fora, e por quê
 * ──────────────────────────────────────────────────────────────────────── */

describe("o que a mineração deliberadamente não sugere", () => {
  it("o que a regra da casa já decide igual seria uma regra inútil", () => {
    // ENTRADA por Pix já é "Recebimento de venda" pela regra da casa
    const s = minerar(repetir(50, obs("Pix - Cesar Quadros Tavares", "Recebimento de venda", "entrada")));
    expect(s).toEqual([]);
  });

  it("mas quando a casa decidiria DIFERENTE, a sugestão aparece e diz isso", () => {
    // o cliente lança essa entrada como devolução, não como venda
    const s = minerar(repetir(5, obs("Pix - Marcos Vinicius Souza", "Troco e devolução", "entrada")));
    expect(s).toHaveLength(1);
    expect(s[0].contrariaCasa).toBe("recebimento de venda");
  });

  it("o que já tem regra ativa não volta como sugestão", () => {
    const regra: UserRule = {
      id: "r",
      ativo: true,
      rotulo: "Motoboy – Wanda",
      direcao: "saida",
      quando: { nome: "Wanda Lemos" },
      categoriaChave: "MOTOBOYS",
      origem: "manual",
    };
    const h = repetir(8, obs("Pix - Wanda Lemos Tavares", "Motoboys"));
    expect(minerar(h, { regras: [regra] })).toEqual([]);
    // mas a regra desligada não cobre nada
    expect(minerar(h, { regras: [{ ...regra, ativo: false }] })).toHaveLength(1);
  });

  it("regra da mesma pessoa na OUTRA direção não cobre", () => {
    const regra: UserRule = {
      id: "r",
      ativo: true,
      rotulo: "x",
      direcao: "entrada",
      quando: { nome: "Wanda Lemos" },
      categoriaChave: "MOTOBOYS",
      origem: "manual",
    };
    expect(
      minerar(repetir(5, obs("Pix - Wanda Lemos Tavares", "Motoboys")), { regras: [regra] }),
    ).toHaveLength(1);
  });

  it("sugestão dispensada não volta a incomodar", () => {
    const h = repetir(8, obs("Pix - Wanda Lemos Tavares", "Motoboys"));
    const chave = chaveSugestao("saida", "Pix - Wanda Lemos Tavares");
    expect(minerar(h, { dispensadas: [chave] })).toEqual([]);
    // e "ignorar" vale para a pessoa, não para aquela escrita exata
    const h2 = repetir(8, obs("Pix enviado - WANDA LEMOS TAVARES", "Motoboys"));
    expect(minerar(h2, { dispensadas: [chave] })).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Ordem e teto
 * ──────────────────────────────────────────────────────────────────────── */

describe("ordem e teto", () => {
  const historico = [
    ...repetir(10, obs("Pix - Wanda Lemos Tavares", "Motoboys")),
    ...repetir(6, obs("Pix - Paulo Valente Silva", "Salário ")),
    ...repetir(3, obs("Pix - Distribuidora Norte Alimentos", "Fornecedor")),
  ];

  it("a mais frequente vem primeiro", () => {
    expect(minerar(historico).map((s) => s.ocorrencias)).toEqual([10, 6, 3]);
  });

  it("o teto corta as menos frequentes, não as mais", () => {
    const s = minerar(historico, { criterios: { maxSugestoes: 2 } });
    expect(s.map((x) => x.ocorrencias)).toEqual([10, 6]);
  });

  it("o mínimo de ocorrências é configurável, mas nunca abaixo de 2", () => {
    expect(minerar(historico, { criterios: { minOcorrencias: 1 } })).toHaveLength(3);
    const h2 = repetir(2, obs("Pix - Fulano de Tal Silva", "Fornecedor"));
    expect(minerar(h2, { criterios: { minOcorrencias: 1 } })).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Da sugestão para a regra
 * ──────────────────────────────────────────────────────────────────────── */

describe("aceitar uma sugestão", () => {
  const [sugestao] = minerar(repetir(6, obs("Pix - Wanda Lemos Tavares", "Motoboys")));

  it("gera uma regra válida", () => {
    const r = regraDaSugestao(sugestao, "r-1");
    expect(problemasDaRegra(r)).toEqual([]);
    expect(r.origem).toBe("minerada");
    expect(r.rotulo).toBe("Motoboys – Wanda Lemos Tavares");
  });

  it("e essa regra decide exatamente o que a mineração viu", () => {
    const r = regraDaSugestao(sugestao, "r-1");
    const d = decidirCategoria(
      { descricao: "Pix - Wanda Lemos Tavares", direcao: "saida" },
      CATEGORIAS,
      [r],
    );
    expect(d.option).toBe("Motoboys");
    expect(d.decisor).toBe("regra-do-usuario");
  });

  it("a regra nascida da mineração respeita a direção", () => {
    const r = regraDaSugestao(sugestao, "r-1");
    const d = decidirCategoria(
      { descricao: "Pix - Wanda Lemos Tavares", direcao: "entrada" },
      CATEGORIAS,
      [r],
    );
    // entrando, quem responde é a regra da casa
    expect(d.decisor).toBe("regra-da-casa");
  });

  it("aceitar uma sugestão tira ela da próxima mineração", () => {
    const h = repetir(6, obs("Pix - Wanda Lemos Tavares", "Motoboys"));
    const r = regraDaSugestao(sugestao, "r-1");
    expect(minerar(h, { regras: [r] })).toEqual([]);
  });

  it("tituloDe deixa o rótulo legível", () => {
    expect(tituloDe("WANDA LEMOS TAVARES")).toBe("Wanda Lemos Tavares");
  });
});
