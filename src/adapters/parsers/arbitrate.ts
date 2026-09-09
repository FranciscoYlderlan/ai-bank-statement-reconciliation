import { Transaction } from "../../domain/transaction";
import { Money } from "../../domain/money";
import { toBr } from "../../domain/dateptbr";
import { DESCRICAO_TARIFA } from "./tabularStatement";

/**
 * ARBITRAGEM — duas leituras do mesmo extrato, em paralelo, e uma escolha.
 *
 * O sistema sempre teve dois modos de ler um extrato: o parser determinístico,
 * que só aceita o que consegue PROVAR, e o pipeline de IA, que lê qualquer
 * layout mas não prova nada. Até aqui eles eram alternativos — um rodava
 * quando o outro falhava. Agora rodam JUNTOS, e a segunda leitura vira o que
 * ela sempre poderia ter sido: uma TESTEMUNHA INDEPENDENTE.
 *
 * ─── a regra de decisão, e por que ela não é "o maior ganha" ─────────────
 *
 * "Escolher o melhor resultado" é fácil de dizer e fácil de errar. O critério
 * óbvio — ganha quem trouxer mais lançamentos — premiaria exatamente o defeito
 * que mais custa caro: a IA que INVENTA uma linha. Um lançamento a mais numa
 * planilha de fluxo de caixa não é um detalhe: é dinheiro que nunca existiu.
 *
 * O critério aqui é outro, e é o mesmo do resto do projeto: **vence quem tem
 * prova**. Uma leitura determinística que fechou a própria conferência é
 * verificável — qualquer pessoa pode refazer a aritmética e chegar ao mesmo
 * lugar. Uma leitura por IA não é: ela é plausível, e plausível não se audita.
 * Então:
 *
 *   1. determinístico PROVADO vence — sempre, inclusive quando a IA traz mais
 *      lançamentos. Se a IA viu algo a mais, isso é uma DIVERGÊNCIA a exibir,
 *      não uma correção a aplicar em silêncio;
 *   2. determinístico RECUSADO (ou inexistente para o formato) → a IA assume,
 *      que é exatamente o comportamento que já existia;
 *   3. as duas falharam → não há leitura, e o erro sobe.
 *
 * ─── o que a testemunha acrescenta ──────────────────────────────────────
 *
 * Se a prova já decide, para que ouvir a IA? Porque uma prova responde
 * "a leitura é internamente consistente?", e não "o parser enxergou tudo o que
 * está no arquivo?". As duas perguntas quase sempre têm a mesma resposta, mas
 * "quase sempre" é onde moram os defeitos que chegam do cliente. Duas leituras
 * independentes que enxergam o mesmo conjunto é uma evidência que nenhuma das
 * duas produz sozinha — e quando elas discordam, o relatório mostra a
 * discordância lançamento a lançamento, em vez de escolher por conta própria e
 * calar.
 */

/* ── as duas leituras ───────────────────────────────────────────────────── */

/**
 * O quanto se pode confiar numa leitura — e a palavra é escolhida para ser
 * lida por quem não programa, porque ela aparece no relatório.
 */
export type NivelConfianca =
  /** determinístico cuja conferência fechou E a testemunha confirmou. */
  | "corroborada"
  /** determinístico cuja conferência fechou (sem testemunha, ou com divergência). */
  | "provada"
  /** leitura por IA: plausível, não demonstrável. */
  | "empirica"
  /** tentou e se recusou — não entra na escolha. */
  | "recusada";

export interface LeituraCandidata {
  via: "deterministic" | "ai";
  parserId: string;
  label: string;
  /** null quando a leitura foi recusada ou estourou. */
  transactions: Transaction[] | null;
  /** o que sustenta esta leitura, em frases prontas para a interface. */
  evidencia: string[];
  /** por que foi recusada / o que estourou. */
  recusa?: string;
  /**
   * O erro ORIGINAL, quando a leitura estourou em vez de se recusar.
   *
   * Guardar só a `recusa` em texto parecia suficiente e não era: a interface
   * traduz `AiError` por CATEGORIA — chave ausente, chave recusada, limite de
   * uso, provedor fora do ar — e cada uma dessas vira uma frase que diz o que
   * fazer. Achatar tudo em `string` transformava "Falta configurar a chave da
   * API, abra as Configurações" num genérico "não foi possível concluir".
   */
  erro?: unknown;
  /** chamadas de IA gastas por esta leitura (0 no determinístico). */
  chamadas: number;
  /** quando a leitura cobriu só parte do arquivo. */
  amostra?: { blocos: number; deTotal: number };
  /**
   * Observações da leitura que o usuário precisa saber e que não são erro —
   * hoje: o OFX que entrega o valor já líquido de tarifa.
   */
  avisos?: string[];
  nivel: NivelConfianca;
}

/* ── o cruzamento ───────────────────────────────────────────────────────── */

export interface Divergencia {
  /** `so-na-escolhida`: a leitura vencedora tem, a testemunha não viu. */
  lado: "so-na-escolhida" | "so-na-testemunha";
  data: string;
  valor: string;
  direcao: "entrada" | "saída";
  descricao: string;
}

export interface Cruzamento {
  /** o cruzamento valeu para o arquivo inteiro ou só para a faixa amostrada? */
  cobertura: "integral" | "amostra" | "nenhuma";
  /** lançamentos que as duas leituras enxergaram igual (dentro da cobertura). */
  emComum: number;
  soNaEscolhida: number;
  soNaTestemunha: number;
  /** o detalhe, limitado ao que cabe num painel. */
  divergencias: Divergencia[];
  /** a janela de datas realmente conferida (quando a cobertura é por amostra). */
  janela?: { de: string; ate: string };
  /** o que ficou de fora do cruzamento, e por quê. */
  ressalvas: string[];
}

export interface ResultadoArbitrado {
  transactions: Transaction[];
  escolhida: LeituraCandidata;
  testemunha: LeituraCandidata | null;
  cruzamento: Cruzamento | null;
}

/* ── identidade de um lançamento para o cruzamento ──────────────────────── */

/**
 * A chave do cruzamento é `data + direção + valor ao centavo` — a MESMA
 * identidade que o dedup usa (§Deduplicação), e pela mesma razão: o nome volta
 * escrito diferente de uma leitura para a outra (abreviado, com/sem sufixo
 * societário, reescrito no padrão da planilha) e não serve para decidir se dois
 * lançamentos são o mesmo. Comparar descrição aqui encheria o painel de
 * divergências falsas e esconderia as verdadeiras.
 */
function chave(t: Transaction): string {
  return `${t.date.year}-${t.date.month}-${t.date.day}|${t.direction}|${t.amount.cents}`;
}

function diaIso(t: Transaction): string {
  return `${t.date.year}-${String(t.date.month).padStart(2, "0")}-${String(t.date.day).padStart(2, "0")}`;
}

/**
 * A TARIFA fica fora do cruzamento, e isso precisa estar dito.
 *
 * No CSV e na planilha a tarifa não é uma linha: é uma coluna da linha da
 * venda, que o parser determinístico transforma em lançamento próprio porque é
 * assim que ela chega à categoria `Taxa de cartão` (§3.7). A IA, lendo o mesmo
 * arquivo, transcreve as LINHAS — e não tem por que inventar um lançamento que
 * não existe como linha. Cobrar isso dela produziria uma divergência por
 * tarifa: 175 no extrato de quatro meses. Ruído, não sinal.
 */
function ehTarifaDerivada(t: Transaction): boolean {
  return t.description === DESCRICAO_TARIFA;
}

/** Conta quantas vezes cada chave aparece (dois Pix de R$ 25 no mesmo dia são dois). */
function contar(txs: Transaction[]): Map<string, Transaction[]> {
  const m = new Map<string, Transaction[]>();
  for (const t of txs) {
    const k = chave(t);
    const arr = m.get(k) ?? [];
    arr.push(t);
    m.set(k, arr);
  }
  return m;
}

const MAX_DIVERGENCIAS = 40;

function descreve(t: Transaction, lado: Divergencia["lado"]): Divergencia {
  return {
    lado,
    data: toBr(t.date),
    valor: Money.fromCents(t.amount.cents).format(),
    direcao: t.direction === "credit" ? "entrada" : "saída",
    descricao: t.description,
  };
}

/**
 * Cruza as duas leituras.
 *
 * Quando a testemunha leu só uma AMOSTRA, o cruzamento não pode valer para o
 * arquivo inteiro: o que ela não leu não é ausência, é silêncio. Então a
 * comparação é restrita à janela de datas que a amostra cobriu — e ainda assim
 * **sem os dias das pontas**, porque um dia que começa numa página amostrada e
 * termina numa página que não foi lida apareceria como lançamento faltando.
 * Encolher a janela custa um pouco de cobertura e evita um alarme falso, que é
 * a troca certa: um painel que grita sem motivo é um painel que ninguém lê.
 */
export function cruzar(
  escolhida: Transaction[],
  testemunha: Transaction[],
  amostra: boolean,
): Cruzamento {
  const ressalvas: string[] = [];

  const tarifas = escolhida.filter(ehTarifaDerivada).length;
  let a = escolhida.filter((t) => !ehTarifaDerivada(t));
  let b = testemunha.filter((t) => !ehTarifaDerivada(t));
  if (tarifas > 0) {
    ressalvas.push(
      `${tarifas} lançamento(s) de tarifa ficaram de fora do cruzamento: no arquivo eles são uma ` +
        `coluna da linha da venda, não uma linha — a leitura por IA não teria por que produzi-los.`,
    );
  }

  let janela: Cruzamento["janela"];
  let cobertura: Cruzamento["cobertura"] = amostra ? "amostra" : "integral";

  if (amostra) {
    if (b.length === 0) {
      return {
        cobertura: "nenhuma",
        emComum: 0,
        soNaEscolhida: 0,
        soNaTestemunha: 0,
        divergencias: [],
        ressalvas: [...ressalvas, "A amostra não trouxe nenhum lançamento para cruzar."],
      };
    }
    const dias = [...new Set(b.map(diaIso))].sort();
    if (dias.length <= 2) {
      return {
        cobertura: "nenhuma",
        emComum: 0,
        soNaEscolhida: 0,
        soNaTestemunha: 0,
        divergencias: [],
        ressalvas: [
          ...ressalvas,
          "A amostra caiu dentro de um intervalo curto demais para cruzar sem alarme falso nas pontas.",
        ],
      };
    }
    const de = dias[1];
    const ate = dias[dias.length - 2];
    const dentro = (t: Transaction) => diaIso(t) >= de && diaIso(t) <= ate;
    a = a.filter(dentro);
    b = b.filter(dentro);
    janela = { de: de.split("-").reverse().join("/"), ate: ate.split("-").reverse().join("/") };
    ressalvas.push(
      `A testemunha leu uma amostra do arquivo, então o cruzamento vale para ${janela.de} a ` +
        `${janela.ate} — os dias das pontas ficam de fora porque poderiam estar partidos entre ` +
        `um bloco lido e outro não lido.`,
    );
  }

  const mapaA = contar(a);
  const mapaB = contar(b);
  let emComum = 0;
  const divergencias: Divergencia[] = [];
  let soNaEscolhida = 0;
  let soNaTestemunha = 0;

  for (const [k, lista] of mapaA) {
    const outros = mapaB.get(k) ?? [];
    const iguais = Math.min(lista.length, outros.length);
    emComum += iguais;
    for (let i = iguais; i < lista.length; i++) {
      soNaEscolhida++;
      if (divergencias.length < MAX_DIVERGENCIAS) divergencias.push(descreve(lista[i], "so-na-escolhida"));
    }
  }
  for (const [k, lista] of mapaB) {
    const outros = mapaA.get(k) ?? [];
    for (let i = outros.length; i < lista.length; i++) {
      soNaTestemunha++;
      if (divergencias.length < MAX_DIVERGENCIAS) divergencias.push(descreve(lista[i], "so-na-testemunha"));
    }
  }

  divergencias.sort((x, y) => x.data.split("/").reverse().join().localeCompare(y.data.split("/").reverse().join()));
  return { cobertura, emComum, soNaEscolhida, soNaTestemunha, divergencias, janela, ressalvas };
}

/* ── a decisão ──────────────────────────────────────────────────────────── */

/**
 * Escolhe entre as duas leituras e monta o cruzamento.
 *
 * Note o que esta função NÃO faz: ela nunca mistura os dois resultados. O
 * conjunto entregue vem inteiro de uma das leituras — é o que mantém a
 * conciliação auditável, porque dá para apontar um arquivo, um parser e uma
 * regra para cada linha que foi parar na planilha. Uma união dos dois conjuntos
 * seria maior e seria pior: ninguém conseguiria dizer de onde veio cada linha.
 */
export function arbitrar(
  deterministica: LeituraCandidata | null,
  empirica: LeituraCandidata | null,
): ResultadoArbitrado {
  const detOk = deterministica?.transactions != null;
  const iaOk = empirica?.transactions != null;

  if (!detOk && !iaOk) {
    // Quando a IA era a LEITURA (e não a testemunha) e ela estourou, quem sobe
    // é o erro dela, intacto: é ele que carrega a categoria que a interface
    // traduz em "falta configurar a chave" ou "o provedor não respondeu". Um
    // `new Error(mensagem)` aqui apagaria essa categoria e devolveria ao
    // usuário um beco sem saída no lugar de um botão para clicar.
    if (empirica?.erro !== undefined) throw empirica.erro;
    const motivo =
      deterministica?.recusa ??
      empirica?.recusa ??
      "nenhuma das duas leituras conseguiu interpretar o arquivo";
    throw new Error(`Não foi possível ler o extrato: ${motivo}`);
  }

  // A PROVA vence. Sempre — inclusive quando a testemunha trouxe mais linhas.
  const escolhida = (detOk ? deterministica : empirica) as LeituraCandidata;
  const testemunha = detOk ? (iaOk ? empirica : empirica ?? null) : null;

  let cruzamento: Cruzamento | null = null;
  if (detOk && iaOk && empirica) {
    cruzamento = cruzar(
      deterministica!.transactions!,
      empirica.transactions!,
      empirica.amostra != null,
    );
    // Confirmada pela testemunha? Então a leitura sobe de "provada" para
    // "corroborada" — duas vias independentes que enxergam o mesmo conjunto.
    if (
      cruzamento.cobertura !== "nenhuma" &&
      cruzamento.soNaEscolhida === 0 &&
      cruzamento.soNaTestemunha === 0
    ) {
      escolhida.nivel = "corroborada";
      escolhida.evidencia.push(
        cruzamento.cobertura === "integral"
          ? `A leitura por IA, feita em paralelo, chegou ao mesmo conjunto de ${cruzamento.emComum} lançamentos.`
          : `A leitura por IA conferiu ${cruzamento.emComum} lançamentos por amostragem e não discordou de nenhum.`,
      );
    } else if (cruzamento.soNaEscolhida > 0 || cruzamento.soNaTestemunha > 0) {
      escolhida.evidencia.push(
        `A leitura por IA discordou em ${cruzamento.soNaEscolhida + cruzamento.soNaTestemunha} ` +
          `lançamento(s) — a prova prevaleceu, e a divergência está listada abaixo para conferência.`,
      );
    }
  }

  return {
    transactions: escolhida.transactions!,
    escolhida,
    testemunha: detOk ? testemunha : null,
    cruzamento,
  };
}
