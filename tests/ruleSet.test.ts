import { describe, it, expect } from "vitest";
import {
  RulesFile,
  arquivoVazio,
  carteiraPorId,
  carteiraVazia,
  chaveSugestao,
  dispensarSugestao,
  escolherCarteira,
  foiDispensada,
  impressaoDaPlanilha,
  regrasAtivas,
  removerRegra,
  salvarRegra,
  sanitizeRulesFile,
  serializeRulesFile,
  usarCarteira,
} from "../src/domain/ruleSet";
import { UserRule } from "../src/domain/userRules";
import {
  FileRulesRepository,
  MemoryTextStore,
  RULES_FILE_NAME,
} from "../src/adapters/repo/rulesRepository";

/**
 * T-REGRA-CARTEIRA / T-REGRA-PERSIST — de quem sao as regras, e como elas
 * sobrevivem ao fechamento do app.
 *
 * O erro que estes testes existem para impedir e um so, e ele e caro: a regra
 * de um cliente decidir o lancamento de outro. Acontece calado, e o resultado e
 * salario lancado na categoria errada na planilha de quem nunca cadastrou nada.
 */

const AGORA = "2026-08-22T12:00:00.000Z";
const DEPOIS = "2026-08-23T09:30:00.000Z";

const bomPrato = {
  sheetNames: ["JANEIRO", "JULHO", "AGOSTO", "Categorias"],
  columns: [
    { letter: "B", header: "Data" },
    { letter: "C", header: "Descrição" },
    { letter: "D", header: "Categoria" },
  ],
  categories: ["Salário ", "Motoboys", "Recebimento de venda"],
};

const outroCliente = {
  sheetNames: ["JANEIRO", "JULHO", "AGOSTO", "Categorias"],
  columns: [
    { letter: "B", header: "Data" },
    { letter: "C", header: "Histórico" },
    { letter: "D", header: "Classificação" },
  ],
  categories: ["Folha", "Frete", "Venda"],
};

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

/* ────────────────────────────────────────────────────────────────────────
 * Impressão da planilha — identidade estável, não frágil
 * ──────────────────────────────────────────────────────────────────────── */

describe("impressão da planilha", () => {
  it("a mesma planilha dá sempre a mesma impressão", () => {
    expect(impressaoDaPlanilha(bomPrato)).toBe(impressaoDaPlanilha(bomPrato));
  });

  it("planilhas de clientes diferentes têm impressões diferentes", () => {
    expect(impressaoDaPlanilha(bomPrato)).not.toBe(impressaoDaPlanilha(outroCliente));
  });

  it("reordenar aba, trocar acento ou caixa não cria planilha nova", () => {
    const remexida = {
      sheetNames: ["Categorias", "AGOSTO", "julho", "JANEIRO"],
      columns: [
        { letter: "D", header: "CATEGORIA" },
        { letter: "b", header: "data" },
        { letter: "C", header: "Descricao" },
      ],
      categories: ["MOTOBOYS", "recebimento de venda", "Salario"],
    };
    expect(impressaoDaPlanilha(remexida)).toBe(impressaoDaPlanilha(bomPrato));
  });

  it("acrescentar categoria MUDA a impressão — é para isso que existe a lista", () => {
    const comNova = { ...bomPrato, categories: [...bomPrato.categories, "Farmácia"] };
    expect(impressaoDaPlanilha(comNova)).not.toBe(impressaoDaPlanilha(bomPrato));
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Escolha da carteira — nunca adivinhar
 * ──────────────────────────────────────────────────────────────────────── */

describe("escolha da carteira", () => {
  const impDM = impressaoDaPlanilha(bomPrato);

  function arquivoComBomPrato(): RulesFile {
    const c = carteiraVazia("c-dm", "Cantina Bom Prato", AGORA);
    return usarCarteira({ ...arquivoVazio(), carteiras: [c] }, c, impDM, AGORA);
  }

  it("impressão conhecida: reconhece sem perguntar nada", () => {
    const e = escolherCarteira(arquivoComBomPrato(), impDM);
    expect(e.motivo).toBe("impressao");
    expect(e.carteira?.nome).toBe("Cantina Bom Prato");
  });

  it("primeira vez de tudo: carteira nova, nenhuma regra herdada", () => {
    const e = escolherCarteira(arquivoVazio(), impDM);
    expect(e.motivo).toBe("nova");
    expect(e.carteira).toBeNull();
    expect(regrasAtivas(e.carteira)).toEqual([]);
  });

  it("planilha desconhecida NÃO herda silenciosamente: o motivo diz que é palpite", () => {
    const e = escolherCarteira(arquivoComBomPrato(), impressaoDaPlanilha(outroCliente));
    // devolve a última usada para a tela oferecer — mas marcada como palpite,
    // porque aplicar a carteira da Cantina Bom Prato calado seria o pior desfecho
    expect(e.motivo).toBe("ultima");
    expect(e.carteira?.id).toBe("c-dm");
  });

  it("a planilha do cliente que muda de estrutura é reaprendida, não perdida", () => {
    let file = arquivoComBomPrato();
    const impNova = impressaoDaPlanilha({
      ...bomPrato,
      categories: [...bomPrato.categories, "Farmácia"],
    });

    // antes de confirmar: não bate
    expect(escolherCarteira(file, impNova).motivo).toBe("ultima");

    // o usuário confirma que é a mesma carteira → a impressão nova entra
    file = usarCarteira(file, carteiraPorId(file, "c-dm")!, impNova, DEPOIS);
    expect(escolherCarteira(file, impNova).motivo).toBe("impressao");
    // e a antiga continua valendo
    expect(escolherCarteira(file, impDM).motivo).toBe("impressao");
  });

  it("usar a carteira não duplica a impressão nem perde as regras", () => {
    let file = arquivoComBomPrato();
    file = usarCarteira(file, salvarRegra(carteiraPorId(file, "c-dm")!, regra(), AGORA), impDM, DEPOIS);
    file = usarCarteira(file, carteiraPorId(file, "c-dm")!, impDM, DEPOIS);
    const c = carteiraPorId(file, "c-dm")!;
    expect(c.impressoes).toEqual([impDM]);
    expect(c.regras).toHaveLength(1);
    expect(file.carteiras).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Isolamento entre clientes — a razão de tudo isto existir
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-CARTEIRA — a regra de um cliente não vaza para o outro", () => {
  it("cada planilha enxerga só as suas regras", () => {
    const dm = salvarRegra(carteiraVazia("c-dm", "Cantina Bom Prato", AGORA), regra(), AGORA);
    const outro = salvarRegra(
      carteiraVazia("c-2", "Padaria do Zé", AGORA),
      regra({ id: "r9", rotulo: "Frete", quando: { nome: "Transportadora Norte" } }),
      AGORA,
    );
    let file: RulesFile = { ...arquivoVazio(), carteiras: [dm, outro] };
    file = usarCarteira(file, dm, impressaoDaPlanilha(bomPrato), AGORA);
    file = usarCarteira(file, outro, impressaoDaPlanilha(outroCliente), AGORA);

    const naBomPrato = escolherCarteira(file, impressaoDaPlanilha(bomPrato));
    const noOutro = escolherCarteira(file, impressaoDaPlanilha(outroCliente));

    expect(regrasAtivas(naBomPrato.carteira).map((r) => r.id)).toEqual(["r1"]);
    expect(regrasAtivas(noOutro.carteira).map((r) => r.id)).toEqual(["r9"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Edição da carteira
 * ──────────────────────────────────────────────────────────────────────── */

describe("edição da carteira", () => {
  const base = carteiraVazia("c", "Cantina Bom Prato", AGORA);

  it("salvar acrescenta; salvar de novo substitui, sem duplicar", () => {
    let c = salvarRegra(base, regra(), AGORA);
    c = salvarRegra(c, regra({ rotulo: "Salário – Paulo (revisto)" }), DEPOIS);
    expect(c.regras).toHaveLength(1);
    expect(c.regras[0].rotulo).toBe("Salário – Paulo (revisto)");
    expect(c.atualizadoEm).toBe(DEPOIS);
  });

  it("salvar preserva a ordem das outras regras", () => {
    let c = salvarRegra(base, regra({ id: "a", rotulo: "A" }), AGORA);
    c = salvarRegra(c, regra({ id: "b", rotulo: "B" }), AGORA);
    c = salvarRegra(c, regra({ id: "a", rotulo: "A2" }), DEPOIS);
    expect(c.regras.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("remover tira só a regra pedida", () => {
    let c = salvarRegra(base, regra({ id: "a" }), AGORA);
    c = salvarRegra(c, regra({ id: "b" }), AGORA);
    expect(removerRegra(c, "a", DEPOIS).regras.map((r) => r.id)).toEqual(["b"]);
  });

  it("não muta a carteira original", () => {
    salvarRegra(base, regra(), AGORA);
    expect(base.regras).toEqual([]);
  });

  it("regra desligada ou inválida não entra em regrasAtivas", () => {
    let c = salvarRegra(base, regra({ id: "ok" }), AGORA);
    c = salvarRegra(c, regra({ id: "off", ativo: false }), AGORA);
    c = salvarRegra(c, regra({ id: "ruim", quando: {} }), AGORA);
    expect(regrasAtivas(c).map((r) => r.id)).toEqual(["ok"]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Sugestões dispensadas — "ignorar" tem de valer para sempre
 * ──────────────────────────────────────────────────────────────────────── */

describe("sugestões dispensadas", () => {
  it("ignorar uma sugestão vale para a pessoa, não para aquela descrição exata", () => {
    const chave = chaveSugestao("saida", "Pix - Marcos Vinícius Souza");
    const c = dispensarSugestao(carteiraVazia("c", "Cantina Bom Prato", AGORA), chave, AGORA);
    // outra escrita da mesma pessoa dá a mesma chave
    expect(foiDispensada(c, chaveSugestao("saida", "Pix enviado - MARCOS VINICIUS SOUZA"))).toBe(
      true,
    );
  });

  it("a direção faz parte da chave", () => {
    const c = dispensarSugestao(
      carteiraVazia("c", "Cantina Bom Prato", AGORA),
      chaveSugestao("saida", "Pix - Marcos Vinícius"),
      AGORA,
    );
    expect(foiDispensada(c, chaveSugestao("entrada", "Pix - Marcos Vinícius"))).toBe(false);
  });

  it("dispensar duas vezes não duplica", () => {
    const chave = chaveSugestao("saida", "Pix - Marcos");
    let c = dispensarSugestao(carteiraVazia("c", "Cantina Bom Prato", AGORA), chave, AGORA);
    c = dispensarSugestao(c, chave, DEPOIS);
    expect(c.dispensadas).toEqual([chave]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * T-REGRA-PERSIST — o disco é desconfiado por profissão
 * ──────────────────────────────────────────────────────────────────────── */

describe("T-REGRA-PERSIST — leitura do disco nunca derruba o app", () => {
  const cheio = (): RulesFile => {
    const c = salvarRegra(carteiraVazia("c-dm", "Cantina Bom Prato", AGORA), regra(), AGORA);
    return usarCarteira({ ...arquivoVazio(), carteiras: [c] }, c, impressaoDaPlanilha(bomPrato), AGORA);
  };

  it("round-trip: o que foi salvo volta igual", async () => {
    const store = new MemoryTextStore();
    const repo = new FileRulesRepository(store);
    await repo.save(cheio());
    const { file, avisos } = await repo.load();
    expect(avisos).toEqual([]);
    expect(file).toEqual(cheio());
  });

  it("primeira execução: arquivo não existe e isso não é erro", async () => {
    const { file, avisos } = await new FileRulesRepository(new MemoryTextStore()).load();
    expect(file).toEqual(arquivoVazio());
    expect(avisos).toEqual([]);
  });

  it("JSON corrompido: começa vazio e avisa, sem lançar", async () => {
    const store = new MemoryTextStore({ [RULES_FILE_NAME]: "{ isto não é json" });
    const { file, avisos } = await new FileRulesRepository(store, RULES_FILE_NAME, {
      warn: () => {},
    }).load();
    expect(file.carteiras).toEqual([]);
    expect(avisos.join(" ")).toMatch(/ilegivel/);
  });

  it("armazenamento que falha não derruba a leitura", async () => {
    const quebrado = {
      read: async () => {
        throw new Error("disco fora do ar");
      },
      write: async () => {},
    };
    const { file, avisos } = await new FileRulesRepository(quebrado, RULES_FILE_NAME, {
      warn: () => {},
    }).load();
    expect(file).toEqual(arquivoVazio());
    expect(avisos.join(" ")).toMatch(/disco fora do ar/);
  });

  it("mas salvar PODE falhar em voz alta — o usuário clicou em salvar", async () => {
    const quebrado = {
      read: async () => null,
      write: async () => {
        throw new Error("sem permissão de escrita");
      },
    };
    await expect(new FileRulesRepository(quebrado).save(arquivoVazio())).rejects.toThrow(
      /sem permissão/,
    );
  });

  it("regra inválida vinda do disco é descartada com aviso, e o resto sobrevive", () => {
    const { file, avisos } = sanitizeRulesFile({
      versao: 1,
      carteiras: [
        {
          id: "c",
          nome: "Cantina Bom Prato",
          impressoes: ["abc"],
          regras: [
            regra({ id: "boa" }),
            { id: "ruim", ativo: true, rotulo: "Sem condição", direcao: "saida", quando: {}, categoriaChave: "SALARIO", origem: "manual" },
            "isto nem é objeto",
          ],
          dispensadas: [],
          atualizadoEm: AGORA,
        },
      ],
      ultimaCarteiraId: "c",
    });
    expect(file.carteiras[0].regras.map((r) => r.id)).toEqual(["boa"]);
    expect(avisos).toHaveLength(2);
  });

  it("regra e carteira duplicadas são descartadas, não sobrescrevem", () => {
    const { file, avisos } = sanitizeRulesFile({
      versao: 1,
      carteiras: [
        { id: "c", nome: "A", regras: [regra({ id: "x", rotulo: "primeira" }), regra({ id: "x", rotulo: "segunda" })] },
        { id: "c", nome: "B", regras: [] },
      ],
      ultimaCarteiraId: "c",
    });
    expect(file.carteiras).toHaveLength(1);
    expect(file.carteiras[0].nome).toBe("A");
    expect(file.carteiras[0].regras).toHaveLength(1);
    expect(file.carteiras[0].regras[0].rotulo).toBe("primeira");
    expect(avisos.join(" ")).toMatch(/duplicad/);
  });

  it("arquivo de versão mais nova avisa em vez de fingir que entendeu", () => {
    const { avisos } = sanitizeRulesFile({ versao: 99, carteiras: [], ultimaCarteiraId: null });
    expect(avisos.join(" ")).toMatch(/versao mais nova/);
  });

  it("ultimaCarteiraId apontando para carteira que não existe é limpo", () => {
    const { file } = sanitizeRulesFile({ versao: 1, carteiras: [], ultimaCarteiraId: "fantasma" });
    expect(file.ultimaCarteiraId).toBeNull();
  });

  it("campos ausentes viram padrão em vez de undefined solto", () => {
    const { file } = sanitizeRulesFile({ carteiras: [{ id: "c" }] });
    const c = file.carteiras[0];
    expect(c.nome).toBe("c");
    expect(c.impressoes).toEqual([]);
    expect(c.regras).toEqual([]);
    expect(c.dispensadas).toEqual([]);
  });

  it("lixo total vira arquivo vazio, com aviso", () => {
    for (const lixo of [null, 42, "texto", [1, 2]]) {
      const { file } = sanitizeRulesFile(lixo);
      expect(file.carteiras).toEqual([]);
    }
  });

  it("o arquivo gravado é legível por gente — é para ser copiado e conferido", async () => {
    const store = new MemoryTextStore();
    await new FileRulesRepository(store).save(cheio());
    const bruto = store.bruto(RULES_FILE_NAME)!;
    expect(bruto).toContain("\n  ");
    expect(bruto).toContain("Paulo Valente");
    expect(JSON.parse(bruto).versao).toBe(1);
  });

  it("serializar sempre grava a versão atual, mesmo se a memória tinha outra", () => {
    const antigo = { ...arquivoVazio(), versao: 0 };
    expect(JSON.parse(serializeRulesFile(antigo)).versao).toBe(1);
  });

  it("os aliases confirmados pelo agente sobrevivem ao disco", async () => {
    const store = new MemoryTextStore();
    const repo = new FileRulesRepository(store);
    const c = salvarRegra(
      carteiraVazia("c", "Cantina Bom Prato", AGORA),
      regra({ aliasesSim: ["PAULO VALENTE SILVA"], aliasesNao: ["RAFAEL SANTOS"] }),
      AGORA,
    );
    await repo.save({ ...arquivoVazio(), carteiras: [c] });
    const { file } = await repo.load();
    expect(file.carteiras[0].regras[0].aliasesSim).toEqual(["PAULO VALENTE SILVA"]);
    expect(file.carteiras[0].regras[0].aliasesNao).toEqual(["RAFAEL SANTOS"]);
  });
});
