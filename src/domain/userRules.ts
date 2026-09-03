import { optionKey } from "./listColumns";
import { FlowDirection, HouseRule, applyHouseRules } from "./houseRules";

/**
 * REGRAS DO USUARIO — o que o DONO do negocio sabe e nem o modelo nem o ramo
 * tem como saber.
 *
 * As regras da casa (`houseRules.ts`) sao do RAMO: valem para qualquer comercio
 * de balcao, foram medidas contra 384 lancamentos e vivem no codigo. O criterio
 * de la (§3.3 do README) proibe regra de SAIDA cujo gatilho seja nome de pessoa
 * — e continua certo, porque "Pix - NOME" saindo aparece em JUNHO como
 * Motoboys, Troco e devolucao, Retirada socios, Salario e Fornecedor. Cinco
 * categorias, o mesmo texto: o extrato nao carrega a resposta.
 *
 * Mas ele deixa de nao carregar quando ALGUEM INFORMA quem e a pessoa. "Sempre
 * que sair para a Paulo Valente e salario" nao e leitura de contexto, e
 * cadastro. Essa informacao so existe na cabeca do dono, e e exatamente esta
 * camada:
 *
 *   REGRA DA CASA          REGRA DO USUARIO
 *   codigo                 dado
 *   ramo                   este cliente
 *   medida em 384 linhas   enunciada pelo dono
 *   gatilho = nome da      gatilho = nome da pessoa/empresa
 *     despesa                (e e justamente esse o caso de uso)
 *   muda com release       muda com um clique
 *
 * Por que nao juntar as duas: se nome de funcionaria entrar em `houseRules.ts`,
 * aquele arquivo vira cadastro, toda alteracao vira release, e o criterio do
 * §3.3 perde o sentido — passaria a ter excecao dentro de si mesmo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AS TRAVAS. As quatro do §3.3 continuam valendo aqui, e duas se somam:
 *
 *  1. A DIRECAO E PARTE DA REGRA. Nao existe regra "para a Paulo"; existe
 *     regra "SAIDA para a Paulo". O mesmo nome pode ser salario saindo e
 *     recebimento de venda entrando.
 *  2. A CATEGORIA E SEMPRE A DA PLANILHA. A regra guarda a chave CANONICA
 *     (`categoriaChave`) e a grafia e resolvida na hora contra a lista real do
 *     arquivo. Planilha sem categoria equivalente = regra que nao se aplica,
 *     nao regra que inventa opcao. Gravar `"Salário"` no lugar de `"Salário "`
 *     quebra o VLOOKUP da coluna Fluxo de Caixa (§3.1).
 *  3. TODA REGRA PODE TER EXCECAO, E ELA E EXPLICITA (`excecoes`).
 *  4. NAO SE INVENTA GENERALIDADE. Um nome com UM token so nunca decide
 *     sozinho — ver `classificarNome` abaixo.
 *  5. TODA DECISAO POR REGRA E AUDITAVEL. O que decide devolve QUEM decidiu,
 *     para o relatorio poder mostrar e o usuario poder desfazer.
 *  6. REGRA RUIM NUNCA DERRUBA A CONCILIACAO. `problemasDaRegra` reprova e a
 *     regra e ignorada com aviso; nada aqui lanca.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOMES PARECIDOS — o que este arquivo NAO decide.
 *
 * "Paulo Valente" e "PAULO C DA SILVA" sao a mesma pessoa? "Wanda Lemos" e
 * "Aldair Souza"? Heuristica de parecenca erra nos dois sentidos, e errar aqui
 * significa lancar salario na categoria errada em silencio. Entao este modulo
 * so classifica em tres baldes:
 *
 *   EXATO      todos os tokens do nome cadastrado estao na descricao (e o nome
 *              tem 2+ tokens, ou o alias ja foi confirmado antes) → decide aqui
 *   CANDIDATO  ha sobreposicao, mas nao o bastante para afirmar → NAO decide;
 *              vira pergunta para o agente de identidade (estagio 4b), que
 *              responde sim/nao PARA O GRUPO INTEIRO em uma chamada so
 *   NENHUM     nada a ver → segue para as regras da casa e para o classificador
 *
 * A resposta do agente volta para ca como ALIAS (`aliasesSim`/`aliasesNao`).
 * Da segunda conciliacao em diante aquele mesmo nome ja e exato e nao custa
 * chamada nenhuma. E o que faz o custo do estagio 4b tender a zero com o uso.
 */

export type { FlowDirection };

/** De onde a regra veio — muda so a forma como a UI a apresenta. */
export type UserRuleOrigin = "manual" | "aprendida" | "minerada";

export interface UserRule {
  id: string;
  ativo: boolean;
  /** rotulo curto para a tela e para o relatorio (ex.: "Salario - Paulo"). */
  rotulo: string;
  /** trava 1: a regra vale para UM sentido. */
  direcao: FlowDirection;
  quando: {
    /** nome da contraparte, como o dono a chama. Casado por TOKEN, nao por texto. */
    nome?: string;
    /** termos que tem de aparecer na descricao (todos). */
    contem?: string[];
    /** faixa de valor, em centavos inteiros (nunca float). */
    valorCents?: { min?: number; max?: number };
  };
  /** desliga a regra mesmo tendo disparado. */
  excecoes?: string[];
  /** chave CANONICA da categoria (optionKey), nao a grafia. Ver trava 2. */
  categoriaChave: string;
  /** limita a regra a uma conta do extrato (`AccountRef.id`). */
  contaId?: string | null;
  /** nomes ja CONFIRMADOS pelo agente de identidade (chave de nome). */
  aliasesSim?: string[];
  /** nomes ja RECUSADOS pelo agente — nunca mais viram pergunta. */
  aliasesNao?: string[];
  /** desempate quando duas regras igualmente especificas casam. Maior ganha. */
  prioridade?: number;
  origem: UserRuleOrigin;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Chave de NOME
 *
 * `counterpartyKey` (normalize.ts) NAO serve aqui: ela assume a contraparte na
 * FRENTE ("FULANO | Pix") e corta no separador. A planilha da Cantina Bom Prato escreve
 * ao contrario — "Pix - NOME" —, entao ali ela devolveria "PIX" para todo mundo.
 * Aqui a limpeza e por RUIDO: cai fora o que e meio de pagamento, tipo de
 * lancamento, preposicao e sufixo societario; fica o nome.
 * ────────────────────────────────────────────────────────────────────────── */

const RUIDO = new Set([
  // meio de pagamento / tipo do lancamento
  "PIX", "TED", "DOC", "TEV", "TEF", "POS",
  "TRANSFERENCIA", "TRANSFERENCIAS", "TRANSF",
  "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA",
  "PAGAMENTO", "PAGTO", "PGTO", "DEBITO", "CREDITO",
  "MAQUININHA", "MAQUINETA", "CARTAO", "COMPRA", "SAQUE",
  // conectivos
  "DE", "DA", "DO", "DAS", "DOS", "E",
  // sufixos societarios (mesma lista de normalize.ts, por token)
  "LTDA", "ME", "MEI", "EPP", "EIRELI", "SA", "CIA", "EI", "SS",
]);

/** Tokens uteis de um texto: sem acento, sem caixa, sem pontuacao, sem ruido. */
export function nomeTokens(texto: string): string[] {
  return optionKey(texto)
    .split(" ")
    .filter((t) => t.length > 0 && !RUIDO.has(t));
}

/**
 * A chave de NOME de uma descricao — e ela que vira alias.
 * "Pix - Wanda Lemos Tavares" e "Pix enviado - WANDA LEMOS TAVARES" dao a
 * mesma chave, entao um alias confirmado sobrevive a mudanca de prefixo (o
 * parser direto e a IA escrevem a descricao de jeitos diferentes, §3.4).
 */
export function nomeKey(texto: string): string {
  return nomeTokens(texto).join(" ");
}

export type NomeMatch = "exato" | "candidato" | "nenhum";

/**
 * O nome cadastrado descreve esta descricao?
 *
 * EXATO exige DUAS coisas: todos os tokens do nome presentes na descricao E o
 * nome ter 2+ tokens. Um nome de um token so ("Wanda") nao identifica pessoa
 * nenhuma — casaria com Wanda Lemos e com Wanda Souza igual — entao ele nunca
 * decide sozinho: vira CANDIDATO e quem resolve e o agente (trava 4).
 */
export function classificarNome(nomeCadastrado: string, descricao: string): NomeMatch {
  const alvo = nomeTokens(nomeCadastrado);
  const obs = nomeTokens(descricao);
  if (alvo.length === 0 || obs.length === 0) return "nenhum";

  const conjunto = new Set(obs);
  const presentes = alvo.filter((t) => conjunto.has(t));

  if (presentes.length === alvo.length) {
    // nome de um token so nao basta para afirmar identidade
    return alvo.length >= 2 ? "exato" : "candidato";
  }
  // sobreposicao parcial: so vira candidato se o que casou for DISTINTIVO
  // (token de 3+ letras). "DA"/"E" ja sairam no ruido, mas iniciais ("C") nao.
  const distintivo = presentes.some((t) => t.length >= 3);
  return distintivo ? "candidato" : "nenhum";
}

/* ──────────────────────────────────────────────────────────────────────────
 * Aplicacao
 * ────────────────────────────────────────────────────────────────────────── */

export interface RuleContext {
  descricao: string;
  direcao: FlowDirection;
  /** valor absoluto em centavos. */
  valorCents?: number;
  /** conta de origem do lancamento (`AccountRef.id`). */
  contaId?: string | null;
}

export interface UserRuleMatch {
  rule: UserRule;
  kind: "exato" | "candidato";
  /** chave do nome observado — e ela que vira alias depois do veredicto. */
  aliasKey: string;
  /** quanto a regra e ESPECIFICA. Maior decide primeiro. */
  peso: number;
}

function contemTodos(descricao: string, termos: string[]): boolean {
  const k = optionKey(descricao);
  return termos.every((t) => {
    const alvo = optionKey(t);
    return alvo.length > 0 && k.includes(alvo);
  });
}

function valorBate(valorCents: number | undefined, faixa?: { min?: number; max?: number }): boolean {
  if (!faixa) return true;
  if (valorCents == null) return false;
  if (faixa.min != null && valorCents < faixa.min) return false;
  if (faixa.max != null && valorCents > faixa.max) return false;
  return true;
}

/**
 * A regra casa com este lancamento? Devolve `null` quando nao, e o tipo do
 * casamento quando sim. NAO resolve a categoria — isso e o passo seguinte, e
 * depende da lista da planilha.
 */
export function matchUserRule(rule: UserRule, ctx: RuleContext): UserRuleMatch | null {
  if (!rule.ativo) return null;
  if (rule.direcao !== ctx.direcao) return null; // trava 1
  if (rule.contaId && ctx.contaId && rule.contaId !== ctx.contaId) return null;
  if (problemasDaRegra(rule).length > 0) return null; // trava 6
  if (!valorBate(ctx.valorCents, rule.quando.valorCents)) return null;

  const k = optionKey(ctx.descricao);
  if (rule.excecoes?.some((e) => optionKey(e).length > 0 && k.includes(optionKey(e)))) return null;

  const termos = rule.quando.contem ?? [];
  if (termos.length > 0 && !contemTodos(ctx.descricao, termos)) return null;

  const alias = nomeKey(ctx.descricao);
  let kind: "exato" | "candidato";

  if (rule.quando.nome) {
    // memoria do agente: veredicto ja dado nao vira pergunta de novo
    if (rule.aliasesNao?.includes(alias)) return null;
    if (rule.aliasesSim?.includes(alias)) kind = "exato";
    else {
      const m = classificarNome(rule.quando.nome, ctx.descricao);
      if (m === "nenhum") return null;
      kind = m;
    }
  } else {
    // regra sem nome (so termos e/ou valor) e sempre afirmativa
    if (termos.length === 0 && !rule.quando.valorCents) return null;
    kind = "exato";
  }

  const peso =
    (rule.quando.nome ? nomeTokens(rule.quando.nome).length * 10 : 0) +
    termos.length * 5 +
    (rule.quando.valorCents ? 3 : 0) +
    (rule.contaId ? 1 : 0) +
    (rule.prioridade ?? 0) * 100;

  return { rule, kind, aliasKey: alias, peso };
}

/**
 * A opcao da planilha correspondente a categoria da regra, na grafia EXATA.
 * `null` quando a planilha nao tem essa categoria — e ai a regra nao se aplica
 * (trava 2). Nunca devolve o texto guardado na regra.
 */
export function optionForUserRule(rule: UserRule, options: string[]): string | null {
  const alvo = optionKey(rule.categoriaChave);
  if (!alvo) return null;
  return options.find((o) => optionKey(o) === alvo) ?? null;
}

/** Regras cuja categoria NAO existe nesta planilha — viram aviso no relatorio. */
export function regrasSemCategoria(regras: UserRule[], options: string[]): UserRule[] {
  return regras.filter((r) => r.ativo && optionForUserRule(r, options) === null);
}

export type Decisor = "regra-do-usuario" | "regra-da-casa";

export interface Decisao {
  /** categoria na grafia da planilha, ou null quando ninguem decidiu aqui. */
  option: string | null;
  decisor: Decisor | null;
  /** rotulo de quem decidiu — o relatorio mostra isto (trava 5). */
  porQuem: string | null;
  userRule?: UserRule;
  houseRule?: HouseRule;
  /**
   * Regras que casaram como CANDIDATO e nao decidiram. Viram pergunta para o
   * agente de identidade. Quando ha pendencia, `option` fica null de proposito:
   * decidir sem confirmar seria chutar identidade.
   */
  pendentes: UserRuleMatch[];
  /**
   * Outras regras EXATAS que apontavam para categoria diferente da escolhida.
   * A mais especifica ganhou, mas o conflito nao pode ser silencioso.
   */
  conflitos: UserRule[];
  /**
   * A regra da casa que teria decidido DIFERENTE se o usuario nao tivesse
   * regra. O usuario ganha — ele conhece o negocio —, mas o relatorio mostra:
   * e o mesmo principio do `duplicadosNomeDivergente` (§ Deduplicacao), a
   * regra decide sozinha e nao decide as escondidas.
   */
  contrariaCasa?: HouseRule;
}

/**
 * A cadeia inteira de decisao deterministica, na ordem:
 *
 *   1. REGRAS DO USUARIO  (o dono sabe; ninguem adivinha)
 *   2. REGRAS DA CASA     (o ramo decide)
 *   3. — sobra para o classificador (IA), fora daqui
 *
 * O usuario ganha da casa porque e mais especifico: a casa diz "toda ENTRADA
 * por Pix e recebimento de venda"; o dono diz "menos a da Paulo, que e
 * devolucao". Quando isso acontece o conflito volta em `conflitos` para o
 * relatorio — a regra decide sozinha, mas nao as escondidas.
 */
export function decidirCategoria(
  ctx: RuleContext,
  options: string[],
  regras: UserRule[],
  /** `semRegrasDaCasa` existe so para o teste do caminho puro, como no categorizador. */
  opcoes?: { semRegrasDaCasa?: boolean },
): Decisao {
  const casaLigada = !opcoes?.semRegrasDaCasa;
  const pendentes: UserRuleMatch[] = [];
  const exatos: UserRuleMatch[] = [];

  for (const rule of regras) {
    const m = matchUserRule(rule, ctx);
    if (!m) continue;
    if (optionForUserRule(rule, options) === null) continue; // trava 2
    (m.kind === "exato" ? exatos : pendentes).push(m);
  }

  if (exatos.length > 0) {
    exatos.sort((a, b) => b.peso - a.peso);
    const escolhido = exatos[0];
    const option = optionForUserRule(escolhido.rule, options)!;
    const conflitos = exatos
      .slice(1)
      .filter((m) => optionForUserRule(m.rule, options) !== option)
      .map((m) => m.rule);
    const casa = casaLigada ? applyHouseRules(ctx.descricao, ctx.direcao, options) : null;
    return {
      option,
      decisor: "regra-do-usuario",
      porQuem: escolhido.rule.rotulo,
      userRule: escolhido.rule,
      pendentes,
      conflitos,
      ...(casa && casa.option !== option ? { contrariaCasa: casa.rule } : {}),
    };
  }

  // Ha candidato por confirmar: NAO deixamos a regra da casa decidir por baixo.
  // Se o agente confirmar que e a Paulo, a categoria e a da regra; deixar a
  // casa responder agora seria gravar "Recebimento de venda" e so depois
  // descobrir que era devolucao.
  if (pendentes.length > 0) {
    return {
      option: null,
      decisor: null,
      porQuem: null,
      pendentes,
      conflitos: [],
    };
  }

  const casa = casaLigada ? applyHouseRules(ctx.descricao, ctx.direcao, options) : null;
  if (casa) {
    return {
      option: casa.option,
      decisor: "regra-da-casa",
      porQuem: casa.rule.label,
      houseRule: casa.rule,
      pendentes: [],
      conflitos: [],
    };
  }

  return { option: null, decisor: null, porQuem: null, pendentes: [], conflitos: [] };
}

/* ──────────────────────────────────────────────────────────────────────────
 * ESTAGIO 4b — o agente de identidade, do lado do dominio
 *
 * O dominio nao chama ninguem. Ele so (a) monta a pergunta agrupada e (b)
 * aplica o veredicto. A chamada em si e o prompt vivem no adapter, como todo o
 * resto da IA.
 *
 * O agrupamento e o ponto: a pergunta e por NOME DISTINTO, nunca por
 * lancamento. Um extrato com 40 Pix para a Paulo e UMA pergunta.
 * ────────────────────────────────────────────────────────────────────────── */

export interface IdentityQuestion {
  ruleId: string;
  /** o nome como o dono cadastrou. */
  nomeCadastrado: string;
  /** os nomes distintos observados no extrato que ficaram em duvida. */
  candidatos: string[];
}

/** Monta as perguntas do agente a partir das pendencias de um extrato inteiro. */
export function buildIdentityQuestions(pendentes: UserRuleMatch[]): IdentityQuestion[] {
  const porRegra = new Map<string, { rule: UserRule; alias: Set<string> }>();
  for (const p of pendentes) {
    if (!p.rule.quando.nome) continue;
    const atual = porRegra.get(p.rule.id);
    if (atual) atual.alias.add(p.aliasKey);
    else porRegra.set(p.rule.id, { rule: p.rule, alias: new Set([p.aliasKey]) });
  }
  return [...porRegra.values()]
    .map(({ rule, alias }) => ({
      ruleId: rule.id,
      nomeCadastrado: rule.quando.nome!,
      candidatos: [...alias].sort(),
    }))
    .filter((q) => q.candidatos.length > 0);
}

export interface IdentityAnswer {
  ruleId: string;
  candidato: string;
  aplica: boolean;
}

/**
 * Grava o veredicto do agente nas regras. Devolve uma copia — regra e dado, e
 * dado se substitui, nao se muta no lugar.
 *
 * Isto e o que faz o custo do estagio 4b cair com o uso: o que foi confirmado
 * uma vez vira `exato` e nunca mais e perguntado.
 */
export function applyIdentityAnswers(regras: UserRule[], respostas: IdentityAnswer[]): UserRule[] {
  if (respostas.length === 0) return regras;
  const porRegra = new Map<string, IdentityAnswer[]>();
  for (const r of respostas) {
    const lista = porRegra.get(r.ruleId);
    if (lista) lista.push(r);
    else porRegra.set(r.ruleId, [r]);
  }
  return regras.map((rule) => {
    const rs = porRegra.get(rule.id);
    if (!rs) return rule;
    const sim = new Set(rule.aliasesSim ?? []);
    const nao = new Set(rule.aliasesNao ?? []);
    for (const r of rs) {
      const k = nomeKey(r.candidato);
      if (!k) continue;
      if (r.aplica) {
        sim.add(k);
        nao.delete(k);
      } else {
        nao.add(k);
        sim.delete(k);
      }
    }
    return { ...rule, aliasesSim: [...sim], aliasesNao: [...nao] };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Validacao (trava 6) — reprovar sem lancar
 * ────────────────────────────────────────────────────────────────────────── */

/** Problemas que tornam a regra inaplicavel. Vazio = regra utilizavel. */
export function problemasDaRegra(rule: UserRule): string[] {
  const p: string[] = [];
  if (!rule.id) p.push("regra sem identificador");
  if (rule.direcao !== "entrada" && rule.direcao !== "saida") {
    p.push("a direcao tem de ser entrada ou saida");
  }
  if (!optionKey(rule.categoriaChave)) p.push("regra sem categoria");

  const nome = rule.quando.nome ? nomeKey(rule.quando.nome) : "";
  const termos = (rule.quando.contem ?? []).filter((t) => optionKey(t).length > 0);
  const faixa = rule.quando.valorCents;

  if (!nome && termos.length === 0 && !faixa) {
    p.push("regra sem condicao: casaria com todo lancamento da direcao");
  }
  if (rule.quando.nome && !nome) {
    p.push("o nome so tem palavras genericas (Pix, transferencia, LTDA…)");
  }
  if (nome && nome.replace(/ /g, "").length < 3) {
    p.push("nome curto demais para identificar alguem");
  }
  if (faixa && faixa.min != null && faixa.max != null && faixa.min > faixa.max) {
    p.push("faixa de valor invertida");
  }
  if (faixa && !nome && termos.length === 0) {
    p.push("valor sozinho nao identifica lancamento — combine com nome ou termo");
  }
  return p;
}
