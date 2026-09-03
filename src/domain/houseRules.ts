import { optionKey } from "./listColumns";

/**
 * REGRAS DA CASA — o que o dono do negocio sabe e o modelo nao tem como saber.
 *
 * Ha decisoes de categoria que nao dependem de interpretar o lancamento: elas
 * seguem do RAMO. Num comercio que vende no balcao, o dinheiro ENTRA quase
 * sempre pelo mesmo caminho — Pix do cliente, maquininha, antecipacao da
 * adquirente. Isso nao e palpite: das 296 entradas ja lancadas na planilha do
 * cliente, 294 estao como `Recebimento de venda`.
 *
 * Enquanto isso ficava so no julgamento do modelo, saia errado de dois jeitos:
 * lancamento sem categoria nenhuma (em duvida, o modelo devolve `null`, que e a
 * resposta segura) e lancamento na categoria errada. Como a regra e estavel e o
 * dono do negocio a enunciou, ela passou a ser decidida aqui, no dominio, de
 * forma deterministica. O modelo continua decidindo tudo o que sobra.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * QUANDO UMA SAIDA PODE VIRAR REGRA — o criterio, nao o gosto.
 *
 * A entrada de um comercio e monotona: quase todo dinheiro que entra e venda.
 * A saida, no geral, NAO tem padrao — e o proprio arquivo prova. Na aba JUNHO a
 * descricao "Pix - NOME", SAINDO, aparece como Motoboys, Troco e devolucao,
 * Retirada socios, Salario e Fornecedor: cinco categorias, o mesmo texto.
 *
 * Mas o que quebra ali nao e "ser saida" — e a descricao NOMEAR A CONTRAPARTE
 * em vez da despesa. "Pix - Wanda Lemos" diz por onde o dinheiro saiu e para
 * quem, e nao diz nada sobre o que foi pago. Ja "Tarifa bancária" nomeia a
 * PROPRIA DESPESA: nao ha contraparte para interpretar, e o texto ja e a
 * resposta. Por isso ela e regra, e com a mesma solidez das entradas — 24 de 24
 * lancamentos de tarifa na planilha do cliente estao como `Taxa de cartão`.
 *
 * CRITERIO, entao: uma regra de SAIDA so e legitima quando o gatilho e o NOME
 * DA DESPESA. Gatilho que casa com meio de pagamento, nome de pessoa ou de
 * empresa nao vira regra de saida — vai para o classificador, que e quem le
 * contexto bem.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * QUATRO TRAVAS, e as quatro importam:
 *
 *  1. A DIRECAO E PARTE DA REGRA. Cada regra vale para um sentido so, e o
 *     mesmo texto pode ter regra num sentido e nenhuma no outro: "Pix - NOME"
 *     entrando e venda; saindo, nao e nada.
 *  2. A CATEGORIA E SEMPRE DA PLANILHA. O que a regra devolve e uma string que
 *     ja existe na lista do arquivo, com a grafia dele. Se a planilha do usuario
 *     nao tem nada equivalente, a regra simplesmente nao se aplica — o que
 *     tambem e o que a mantem inofensiva em planilhas de outros ramos.
 *  3. TODA REGRA TEM EXCECAO, E ELA E EXPLICITA. Aporte, emprestimo, estorno e
 *     devolucao tambem chegam por Pix; `Taxa Ifood` tambem tem a palavra taxa.
 *     Quando a descricao carrega um desses sinais, a regra se cala.
 *  4. NAO SE INVENTA GENERALIDADE. `tarifa` e regra; `taxa` sozinha nao — na
 *     propria planilha, "taxa são joão vila embratel" e Investimento. A regra
 *     cobre o que os dados sustentam, e nada alem disso.
 */

/** Direcao do lancamento, no vocabulario do prompt de categorizacao. */
export type FlowDirection = "entrada" | "saida";

export interface HouseRule {
  id: string;
  /** rotulo curto, para log e relatorio. */
  label: string;
  /**
   * O sentido em que a regra vale. Numa regra de SAIDA, o gatilho tem de ser o
   * NOME DA DESPESA — ver o criterio no topo do arquivo. Gatilho de saida que
   * casa com meio de pagamento ou com nome de contraparte nao e regra: e
   * trabalho do classificador.
   */
  direction: FlowDirection;
  /** o que dispara a regra (sobre a descricao normalizada). */
  triggers: RegExp[];
  /** o que a desliga, mesmo tendo disparado. */
  exceptions: RegExp[];
  /** nomes que a lista da planilha pode usar para esta categoria, em ordem. */
  optionNames: string[];
  /** casamento tolerante, quando nenhum nome conhecido bate. */
  optionFallback?: (key: string) => boolean;
  /** o texto da regra para o prompt, ja com a categoria real da planilha. */
  promptRule: (categoria: string) => string;
}

/**
 * ENTRADA por instrumento de venda → recebimento de venda.
 *
 * Os gatilhos sao termos de MEIO DE PAGAMENTO, nao de contraparte: e o "como o
 * dinheiro entrou" que caracteriza a venda, nao quem mandou. Por isso
 * "Pix - Fulano" basta, e por isso a descricao com erro de digitacao que existe
 * na planilha real — "RECEBIBMENTO ANTECIPAÇÃO VENDAS" — continua sendo
 * reconhecida: quem casa e `ANTECIPACAO` e `VENDAS`, nao a palavra errada.
 */
export const RECEBIMENTO_DE_VENDA: HouseRule = {
  id: "recebimento-de-venda",
  label: "recebimento de venda",
  direction: "entrada",
  triggers: [
    /\bPIX\b/,
    /\bMAQUININHA\b/,
    /\bMAQUINETA\b/,
    /\bMAQUINA DE CARTAO\b/,
    /\bCARTAO\b/,
    /\bPOS\b/,
    /\bTEF\b/,
    /\bANTECIPACAO\b/,
    /\bVENDA\b/,
    /\bVENDAS\b/,
  ],
  exceptions: [
    /\bAPORTE\b/,
    /\bEMPRESTIMO\b/,
    /\bEMPRESTIMOS\b/,
    /\bFINANCIAMENTO\b/,
    /\bESTORNO\b/,
    /\bESTORNADO\b/,
    /\bESTORNADA\b/,
    /\bDEVOLUCAO\b/,
    /\bDEVOLVIDO\b/,
    /\bDEVOLVIDA\b/,
    /\bREEMBOLSO\b/,
    /\bRESGATE\b/,
    /\bRENDIMENTO\b/,
    /\bRENDIMENTOS\b/,
    /\bJUROS\b/,
    /\bCASHBACK\b/,
    /\bTROCO\b/,
    /\bENTRE CONTAS\b/,
    /\bCONTA PROPRIA\b/,
    /\bMESMA TITULARIDADE\b/,
    /\bSALDO ANTERIOR\b/,
    /\bSALDO INICIAL\b/,
  ],
  optionNames: [
    "RECEBIMENTO DE VENDA",
    "RECEBIMENTO DE VENDAS",
    "RECEBIMENTOS DE VENDA",
    "RECEBIMENTOS DE VENDAS",
    "RECEBIMENTO VENDA",
    "RECEITA DE VENDA",
    "RECEITA DE VENDAS",
    "VENDA",
    "VENDAS",
    "VENDA DE MERCADORIAS",
    "FATURAMENTO",
  ],
  optionFallback: (k) => /\bVENDAS?\b/.test(k) && /(RECEBIMENTO|RECEITA|FATURAMENTO)/.test(k),
  promptRule: (c) =>
    `Uma ENTRADA que chega por Pix, maquininha, cartao ou antecipacao de vendas e "${c}", ` +
    `mesmo que a descricao traga so o nome de uma pessoa — o negocio vende no balcao e e assim ` +
    `que o dinheiro entra. Nao procure outra explicacao. Excecoes, e so elas: quando a descricao ` +
    `disser aporte, emprestimo, estorno, devolucao, reembolso, resgate, rendimento ou ` +
    `transferencia entre contas proprias. Atencao a DIRECAO: um Pix de SAIDA para uma pessoa nao ` +
    `e venda nenhuma — costuma ser pagamento a motoboy, fornecedor, salario, troco ou retirada.`,
};

/**
 * SAIDA de tarifa bancaria → taxa de cartao.
 *
 * Esta e a unica regra de saida, e ela existe porque passa no criterio do topo
 * do arquivo: o gatilho e o NOME DA DESPESA. "Tarifa bancária" nao tem
 * contraparte para interpretar — o texto ja e a resposta. Na planilha do
 * cliente, 24 de 24 lancamentos de tarifa estao como `Taxa de cartão`.
 *
 * O gatilho e `tarifa`, nao `taxa`. A palavra "taxa" sozinha aparece na
 * planilha real em "taxa são joão vila embratel", que o cliente lancou como
 * Investimento — generalizar dali seria trocar um erro por outro. `taxa` so
 * dispara quando vem grudada no meio de pagamento (taxa de cartao, taxa da
 * maquininha, taxa de antecipacao).
 */
export const TARIFA_BANCARIA: HouseRule = {
  id: "tarifa-bancaria",
  label: "tarifa bancária",
  direction: "saida",
  triggers: [
    /\bTARIFA\b/,
    /\bTARIFAS\b/,
    /\bTAXA D[AEO] CARTAO\b/,
    /\bTAXA CARTAO\b/,
    /\bTAXA D[AEO] MAQUININHA\b/,
    /\bTAXA D[AEO] ANTECIPACAO\b/,
  ],
  exceptions: [
    // o que tem categoria propria na planilha, ou e taxa de outro servico
    /\bIFOOD\b/,
    /\bI FOOD\b/,
    /\bRAPPI\b/,
    /\bUBER\b/,
    /\bDAS\b/,
    /\bSIMPLES NACIONAL\b/,
    /\bINSS\b/,
    /\bFGTS\b/,
    /\bENERGIA\b/,
    /\bAGUA\b/,
    /\bESGOTO\b/,
    /\bINTERNET\b/,
    /\bALUGUEL\b/,
    /\bCONDOMINIO\b/,
    /\bLIXO\b/,
    /\bILUMINACAO\b/,
    /\bBOMBEIRO\b/,
    /\bALVARA\b/,
    /\bCARTORIO\b/,
  ],
  optionNames: [
    "TAXA DE CARTAO",
    "TAXA CARTAO",
    "TAXAS DE CARTAO",
    "TARIFA BANCARIA",
    "TARIFAS BANCARIAS",
    "DESPESAS BANCARIAS",
    "TAXA BANCARIA",
  ],
  optionFallback: (k) => /\bTAXAS?\b/.test(k) && /(CARTAO|BANCARIA|BANCARIAS|BANCO)/.test(k),
  promptRule: (c) =>
    `Uma SAIDA de tarifa bancaria — "Tarifa", "Tarifa bancária", "Tarifa pacote de serviços" — ` +
    `e "${c}". Nao vale para a palavra "taxa" solta: "taxa" seguida do nome de um servico ou de ` +
    `um lugar (taxa de lixo, taxa de iluminacao, Taxa Ifood) e outra coisa e deve ser ` +
    `classificada pelo que a descricao diz.`,
};

/**
 * As regras da casa, na ordem em que sao avaliadas.
 *
 * Uma de entrada e uma de saida — e a assimetria e proposital. A entrada de um
 * comercio e monotona; a saida so vira regra quando a descricao nomeia a
 * propria despesa, como em "Tarifa bancária". Saida cuja descricao nomeia uma
 * contraparte ("Pix - NOME") continua inteira com o classificador.
 */
export const HOUSE_RULES: HouseRule[] = [RECEBIMENTO_DE_VENDA, TARIFA_BANCARIA];

/**
 * A opcao da lista que corresponde a uma regra, na grafia EXATA da planilha.
 * `null` quando a planilha nao tem nada equivalente — e ai a regra nao se
 * aplica, porque inventar categoria fora da lista quebra o dropdown e o VLOOKUP
 * da coluna de fluxo.
 */
export function optionForRule(rule: HouseRule, options: string[]): string | null {
  for (const nome of rule.optionNames) {
    const achado = options.find((o) => optionKey(o) === nome);
    if (achado) return achado;
  }
  if (rule.optionFallback) {
    const achado = options.find((o) => rule.optionFallback!(optionKey(o)));
    if (achado) return achado;
  }
  return null;
}

/**
 * A regra dispara para esta descricao e esta direcao? Trabalha sobre a chave
 * normalizada (sem acento, sem caixa, pontuacao virando espaco), entao
 * `"Maquininha - Orlando"`, `"MAQUININHA/ORLANDO"` e `"maquininha  orlando"`
 * sao a mesma coisa.
 */
export function ruleApplies(
  rule: HouseRule,
  description: string,
  direction: FlowDirection,
): boolean {
  if (rule.direction !== direction) return false;
  const k = optionKey(description);
  if (!k) return false;
  if (rule.exceptions.some((re) => re.test(k))) return false;
  return rule.triggers.some((re) => re.test(k));
}

export interface HouseRuleHit {
  /** a categoria, na grafia da planilha. */
  option: string;
  rule: HouseRule;
}

/**
 * Aplica as regras da casa a um lancamento. Devolve a categoria da planilha
 * quando alguma vale, e `null` quando quem decide e o classificador.
 */
export function applyHouseRules(
  description: string,
  direction: FlowDirection,
  options: string[],
): HouseRuleHit | null {
  for (const rule of HOUSE_RULES) {
    if (!ruleApplies(rule, description, direction)) continue;
    const option = optionForRule(rule, options);
    if (option) return { option, rule };
  }
  return null;
}

/**
 * O bloco das regras da casa para o prompt de categorizacao. So entram as
 * regras cuja categoria existe de fato na planilha. Vai junto para o modelo
 * decidir o que sobrou com o mesmo criterio da casa, em vez de um criterio
 * proprio.
 */
export function houseRulesPromptBlock(options: string[]): string {
  const linhas: string[] = [];
  for (const rule of HOUSE_RULES) {
    const option = optionForRule(rule, options);
    if (option) linhas.push(`- ${rule.promptRule(option)}`);
  }
  if (linhas.length === 0) return "";
  return ["REGRAS DA CASA (valem sobre qualquer outra leitura):", ...linhas].join("\n");
}
