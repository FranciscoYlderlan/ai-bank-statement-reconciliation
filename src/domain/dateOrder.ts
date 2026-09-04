import { PlainDate, toIso } from "./dateptbr";

/**
 * ORDEM DAS DATAS DE UMA ABA — e a INSERCAO POR ENCAIXE que sai dela.
 *
 * Ate aqui o writer so sabia fazer uma coisa: achar a primeira linha vazia e
 * gravar ali. Enquanto a planilha estava em ordem CRESCENTE isso passava por
 * certo, porque o fim da lista era mesmo o lugar da data mais nova. Numa aba
 * DECRESCENTE (a de 19 a 1 de setembro, do caso real) o mesmo gesto produz o
 * erro que o cliente viu: os lancamentos de 15 a 31 foram parar DEPOIS do dia 1,
 * ainda por cima em ordem decrescente entre si — a ordem foi reconhecida e
 * ignorada na hora de escrever.
 *
 * Este modulo e DOMINIO puro: nao le XML, nao chama IA, nao conhece planilha.
 * Faz duas contas, e as duas sao verificaveis linha a linha num teste:
 *
 *  1. `detectDateOrder` — olha os pares consecutivos de datas JA gravadas e diz
 *     se a aba sobe, desce, ou nao tem padrao. Devolve a evidencia junto (quantos
 *     pares concordaram) porque "decrescente" com dois pares e um chute, e
 *     "decrescente" com oitenta pares e um fato; quem chama precisa distinguir.
 *  2. `planInsertion` — dada a sequencia existente e a lista de novos, devolve a
 *     sequencia final: cada novo entra ONDE a data dele pede — no comeco, no
 *     meio ou no fim.
 *
 * Duas invariantes que valem para os dois casos:
 *  - a ordem RELATIVA das linhas que ja estavam la nunca muda. O usuario digitou
 *    aquilo; nao e nosso papel reordenar o que ele fez;
 *  - empate de data resolve a favor de quem ja estava: o lancamento novo entra
 *    DEPOIS do bloco daquela data.
 */

export type DateOrder = "crescente" | "decrescente" | "indefinida";

/**
 * Minimo de pares consecutivos comparaveis para chamar a ordem de conclusiva.
 * Com um par so ("29/09 depois de 30/09") qualquer aba pareceria decrescente.
 */
export const MIN_PARES_CONCLUSIVOS = 3;

/**
 * Fracao dos pares que precisa concordar. Planilha viva tem lancamento fora de
 * ordem (o dono lembrou de um recibo antigo e digitou no fim) — exigir 100%
 * transformaria uma aba claramente decrescente em "indefinida". Exigir pouco
 * faria uma aba baguncada virar ordem.
 */
export const LIMIAR_CONFIANCA = 0.75;

export interface DateOrderEvidence {
  /** o veredito. "indefinida" quando a evidencia nao autoriza decidir. */
  ordem: DateOrder;
  /** a maioria bruta, mesmo quando ela nao foi suficiente para decidir. */
  tendencia: "crescente" | "decrescente" | null;
  /** datas legiveis analisadas. */
  amostra: number;
  /** pares consecutivos com datas DIFERENTES (empate nao vota). */
  comparados: number;
  crescentes: number;
  decrescentes: number;
  empates: number;
  /** 0..1 — fracao dos pares comparados que concorda com a tendencia. */
  confianca: number;
  /** true quando `ordem` !== "indefinida". */
  conclusiva: boolean;
}

const SEM_EVIDENCIA: DateOrderEvidence = {
  ordem: "indefinida",
  tendencia: null,
  amostra: 0,
  comparados: 0,
  crescentes: 0,
  decrescentes: 0,
  empates: 0,
  confianca: 0,
  conclusiva: false,
};

/**
 * A ordem praticada por uma sequencia de datas, na ordem em que aparecem nas
 * linhas. Datas ilegiveis (null) sao PULADAS, nao interrompem a corrente: uma
 * linha de observacao no meio da aba nao muda o padrao das que estao em volta.
 */
export function detectDateOrder(datas: Array<PlainDate | null>): DateOrderEvidence {
  const isos = datas.filter((d): d is PlainDate => d != null).map(toIso);
  if (isos.length < 2) return { ...SEM_EVIDENCIA, amostra: isos.length };

  let crescentes = 0;
  let decrescentes = 0;
  let empates = 0;
  for (let i = 1; i < isos.length; i++) {
    if (isos[i] > isos[i - 1]) crescentes++;
    else if (isos[i] < isos[i - 1]) decrescentes++;
    else empates++;
  }
  return evidenciaDeContagens({ crescentes, decrescentes, empates, amostra: isos.length });
}

/**
 * Junta a evidencia de VARIAS abas numa so. E assim que a planilha inteira
 * responde a pergunta: cada aba de mes vota com o peso dos pares que ela tem,
 * entao a aba de setembro (cheia) pesa mais que a de janeiro (com duas linhas),
 * que e exatamente o que se quer — e a pratica atual do cliente que manda.
 */
export function combineDateOrder(evidencias: DateOrderEvidence[]): DateOrderEvidence {
  const soma = { crescentes: 0, decrescentes: 0, empates: 0, amostra: 0 };
  for (const e of evidencias) {
    soma.crescentes += e.crescentes;
    soma.decrescentes += e.decrescentes;
    soma.empates += e.empates;
    soma.amostra += e.amostra;
  }
  if (soma.amostra === 0) return { ...SEM_EVIDENCIA };
  return evidenciaDeContagens(soma);
}

function evidenciaDeContagens(c: {
  crescentes: number;
  decrescentes: number;
  empates: number;
  amostra: number;
}): DateOrderEvidence {
  const comparados = c.crescentes + c.decrescentes;
  const tendencia: DateOrderEvidence["tendencia"] =
    comparados === 0 ? null : c.crescentes >= c.decrescentes ? "crescente" : "decrescente";
  const confianca =
    comparados === 0 ? 0 : Math.max(c.crescentes, c.decrescentes) / comparados;
  const conclusiva =
    tendencia != null && comparados >= MIN_PARES_CONCLUSIVOS && confianca >= LIMIAR_CONFIANCA;
  return {
    ordem: conclusiva ? tendencia! : "indefinida",
    tendencia,
    amostra: c.amostra,
    comparados,
    crescentes: c.crescentes,
    decrescentes: c.decrescentes,
    empates: c.empates,
    confianca,
    conclusiva,
  };
}

/** Frase curta para o relatorio, os avisos e o contrato de destino do prompt. */
export function describeDateOrder(ordem: DateOrder): string {
  if (ordem === "crescente") return "datas em ordem crescente (da mais antiga para a mais recente)";
  if (ordem === "decrescente")
    return "datas em ordem decrescente (da mais recente para a mais antiga)";
  return "sem ordem de datas identificada";
}

/* ────────────────────────────────────────────────────────────────────────
 * ENCAIXE
 * ──────────────────────────────────────────────────────────────────────── */

export interface ItemDatado<T> {
  item: T;
  date: PlainDate | null;
}

export type Encaixado<E, N> =
  | { tipo: "existente"; item: E }
  | { tipo: "novo"; item: N };

export interface PlanoDeEncaixe<E, N> {
  /** a sequencia final, de cima para baixo. */
  sequencia: Array<Encaixado<E, N>>;
  /**
   * indice (0-based na sequencia) da primeira posicao que deixou de ser o que
   * era. Tudo acima disso pode ficar intocado no arquivo — e o que mantem a
   * escrita cirurgica quando os lancamentos novos sao todos mais recentes.
   * -1 quando nada muda de lugar.
   */
  primeiraMudanca: number;
  /** true quando todos os novos foram para o fim (o comportamento antigo). */
  apenasNoFim: boolean;
}

/**
 * Ordena os novos e os encaixa na sequencia existente.
 *
 * Com `ordem === "indefinida"` o resultado e deliberadamente o comportamento de
 * sempre: tudo no fim, na ordem em que veio. Sem padrao para seguir, inventar um
 * seria pior — reorganizaria uma aba que o usuario mantem numa ordem que nos nao
 * entendemos.
 */
export function planInsertion<E, N>(
  existentes: Array<ItemDatado<E>>,
  novos: Array<ItemDatado<N>>,
  ordem: DateOrder,
): PlanoDeEncaixe<E, N> {
  const fila = ordenarNovos(novos, ordem);
  const sequencia: Array<Encaixado<E, N>> = [];
  let i = 0;

  for (const e of existentes) {
    if (e.date) {
      while (i < fila.length && vemAntes(fila[i].date, e.date, ordem)) {
        sequencia.push({ tipo: "novo", item: fila[i].item });
        i++;
      }
    }
    sequencia.push({ tipo: "existente", item: e.item });
  }
  for (; i < fila.length; i++) sequencia.push({ tipo: "novo", item: fila[i].item });

  const primeiraMudanca = sequencia.findIndex((s) => s.tipo === "novo");
  const apenasNoFim = primeiraMudanca === -1 || primeiraMudanca >= existentes.length;
  return { sequencia, primeiraMudanca, apenasNoFim };
}

/**
 * Os novos entre si seguem a MESMA ordem da aba. Foi a metade que faltou no
 * erro relatado: o sistema percebeu que a aba era decrescente, ordenou os
 * lancancamentos novos de 31 para 15 — e depois grudou esse bloco embaixo do
 * dia 1. Ordenar sem encaixar nao conserta nada.
 *
 * Data ilegivel vai para o fim, na ordem em que chegou: sem data nao ha encaixe
 * possivel, e o fim e o unico lugar que nao mente sobre a posicao.
 */
function ordenarNovos<N>(novos: Array<ItemDatado<N>>, ordem: DateOrder): Array<ItemDatado<N>> {
  if (ordem === "indefinida") return [...novos];
  const comData = novos.filter((n) => n.date != null);
  const semData = novos.filter((n) => n.date == null);
  const sinal = ordem === "crescente" ? 1 : -1;
  // Array.prototype.sort e estavel: lancamentos da mesma data preservam a ordem
  // em que apareceram no extrato.
  comData.sort((a, b) => sinal * toIso(a.date!).localeCompare(toIso(b.date!)));
  return [...comData, ...semData];
}

/** O novo `nova` tem de entrar ANTES da linha existente de data `existente`? */
function vemAntes(nova: PlainDate | null, existente: PlainDate, ordem: DateOrder): boolean {
  if (!nova || ordem === "indefinida") return false;
  const a = toIso(nova);
  const b = toIso(existente);
  // Empate (a === b) devolve false de proposito: o lancamento novo entra DEPOIS
  // do bloco da mesma data, nunca no meio do que o usuario ja digitou.
  return ordem === "crescente" ? a < b : a > b;
}
