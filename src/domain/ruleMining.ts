import { FlowDirection, applyHouseRules } from "./houseRules";
import { optionKey } from "./listColumns";
import { UserRule, nomeKey, nomeTokens } from "./userRules";
import { ChaveSugestao, chaveSugestao } from "./ruleSet";

/**
 * MINERACAO DE REGRAS — as regras que o cliente ja escreveu sem saber.
 *
 * A planilha do usuario nao e so o destino: e o registro de tudo o que ele ja
 * decidiu. Na Cantina Bom Prato sao 384 lancamentos ja classificados a mao. Se em seis
 * meses TODA saida para "Wanda Lemos Tavares" foi `Motoboys`, isso nao e
 * palpite nosso — e a propria pratica dele, escrita por ele.
 *
 * Este modulo le esse historico e PROPOE regras. Nao cria nenhuma: sugestao
 * fica colapsada na tela, e so vira regra quando o dono clica. O motivo e o
 * mesmo do §3.3 — regra da casa nasce com evidencia medida, e "medir" aqui e
 * mostrar ao dono o que os dados dizem e deixar ELE confirmar.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O CRITERIO, e ele e severo de proposito. Uma sugestao so aparece quando:
 *
 *  1. o nome tem 2+ tokens. "Wanda" sozinha nao identifica pessoa nenhuma
 *     (mesma trava do `classificarNome`);
 *  2. aparece pelo menos 3 vezes. Duas coincidencias nao sao padrao;
 *  3. CEM POR CENTO das vezes recebeu a MESMA categoria. Uma unica divergencia
 *     mata a sugestao — a pessoa recebe por mais de um motivo, e ai quem tem de
 *     decidir e o classificador, que le contexto;
 *  4. a direcao e sempre a mesma (ela entra na chave);
 *  5. nao ha regra ativa cobrindo aquilo, e a sugestao nao foi dispensada antes.
 *
 * O item 3 e a validacao por replay que o README exige antes de criar regra:
 * a sugestao ja nasce conferida contra o historico inteiro do cliente. Foi essa
 * disciplina que impediu `taxa` de virar regra da casa (§3.3) — e aqui ela e
 * automatica.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE FICA DE FORA E TAMBEM E DECISAO. Quando a REGRA DA CASA ja decide
 * aquele lancamento com a MESMA categoria, nao sugerimos: seria uma regra que
 * nao muda nada e que so faz a lista crescer. Mas quando a casa decidiria
 * DIFERENTE, a sugestao aparece — ali o cliente esta praticando algo que o ramo
 * nao previu, e e exatamente o que ele precisa nos ensinar.
 */

/** Um lancamento ja classificado, lido da planilha do cliente. */
export interface ObservacaoHistorica {
  descricao: string;
  /** categoria como esta gravada na planilha (grafia exata). */
  categoria: string;
  direcao: FlowDirection;
  /** aba de onde veio — so para exibicao. */
  aba?: string;
}

export interface SugestaoDeRegra {
  chave: ChaveSugestao;
  /** o nome normalizado que vira `quando.nome` da regra. */
  nome: string;
  direcao: FlowDirection;
  /** categoria na grafia da planilha. */
  categoria: string;
  /** chave canonica, que e o que a regra guarda. */
  categoriaChave: string;
  ocorrencias: number;
  /** descricoes reais em que apareceu — o dono reconhece por elas. */
  exemplos: string[];
  /** abas onde apareceu. */
  abas: string[];
  /** a regra da casa decidiria diferente? entao esta sugestao ensina algo novo. */
  contrariaCasa?: string;
}

export interface CriteriosMineracao {
  /** minimo de ocorrencias para virar sugestao (default 3). */
  minOcorrencias?: number;
  /** teto de sugestoes devolvidas (default 20). */
  maxSugestoes?: number;
}

export interface ContextoMineracao {
  /** as categorias validas da planilha — a regra da casa precisa delas. */
  categorias: string[];
  /** regras que ja existem: o que elas cobrem nao vira sugestao. */
  regras?: UserRule[];
  /** sugestoes que o usuario ja mandou ignorar. */
  dispensadas?: ChaveSugestao[];
  criterios?: CriteriosMineracao;
}

const MIN_OCORRENCIAS = 3;
const MAX_SUGESTOES = 20;
const MAX_EXEMPLOS = 3;

interface Balde {
  chave: ChaveSugestao;
  nome: string;
  direcao: FlowDirection;
  /** categoria (grafia da planilha) -> quantas vezes. */
  categorias: Map<string, number>;
  exemplos: string[];
  abas: Set<string>;
  total: number;
}

/**
 * Uma regra ativa ja cobre este nome nesta direcao? Comparamos por conjunto de
 * tokens: "Wanda Lemos" cadastrada cobre o balde "WANDA LEMOS TAVARES", e nao
 * faz sentido sugerir de novo o que ja esta la.
 */
function jaCoberto(nome: string, direcao: FlowDirection, regras: UserRule[]): boolean {
  const obs = new Set(nomeTokens(nome));
  return regras.some((r) => {
    if (!r.ativo || r.direcao !== direcao || !r.quando.nome) return false;
    const alvo = nomeTokens(r.quando.nome);
    return alvo.length > 0 && alvo.every((t) => obs.has(t));
  });
}

/**
 * Le o historico e devolve as sugestoes, da mais frequente para a menos.
 * Funcao pura: nao le arquivo, nao chama IA, nao cria regra nenhuma.
 */
export function minerarRegras(
  historico: ObservacaoHistorica[],
  ctx: ContextoMineracao,
): SugestaoDeRegra[] {
  const min = Math.max(2, ctx.criterios?.minOcorrencias ?? MIN_OCORRENCIAS);
  const max = Math.max(1, ctx.criterios?.maxSugestoes ?? MAX_SUGESTOES);
  const regras = ctx.regras ?? [];
  const dispensadas = new Set(ctx.dispensadas ?? []);

  const baldes = new Map<ChaveSugestao, Balde>();
  for (const o of historico) {
    if (!o.categoria || !o.categoria.trim()) continue;
    const nome = nomeKey(o.descricao);
    // trava 4 do userRules: nome de um token so nunca identifica alguem, e
    // portanto nunca vira regra — nem por mineracao.
    if (nomeTokens(nome).length < 2) continue;

    const chave = chaveSugestao(o.direcao, o.descricao);
    let b = baldes.get(chave);
    if (!b) {
      b = {
        chave,
        nome,
        direcao: o.direcao,
        categorias: new Map(),
        exemplos: [],
        abas: new Set(),
        total: 0,
      };
      baldes.set(chave, b);
    }
    b.total++;
    b.categorias.set(o.categoria, (b.categorias.get(o.categoria) ?? 0) + 1);
    if (o.aba) b.abas.add(o.aba);
    if (b.exemplos.length < MAX_EXEMPLOS && !b.exemplos.includes(o.descricao)) {
      b.exemplos.push(o.descricao);
    }
  }

  const sugestoes: SugestaoDeRegra[] = [];
  for (const b of baldes.values()) {
    if (b.total < min) continue;
    // CEM POR CENTO da mesma categoria. Uma divergencia e o bastante para a
    // sugestao morrer: a pessoa recebe por mais de um motivo, e quem decide
    // isso e o classificador, que le contexto.
    if (b.categorias.size !== 1) continue;
    if (dispensadas.has(b.chave)) continue;
    if (jaCoberto(b.nome, b.direcao, regras)) continue;

    const categoria = [...b.categorias.keys()][0];

    // O que a casa ja decide igual nao precisa virar regra do usuario.
    const casa = applyHouseRules(b.exemplos[0] ?? b.nome, b.direcao, ctx.categorias);
    if (casa && casa.option === categoria) continue;

    sugestoes.push({
      chave: b.chave,
      nome: b.nome,
      direcao: b.direcao,
      categoria,
      categoriaChave: optionKey(categoria),
      ocorrencias: b.total,
      exemplos: b.exemplos,
      abas: [...b.abas],
      ...(casa ? { contrariaCasa: casa.rule.label } : {}),
    });
  }

  return sugestoes
    .sort((a, b) => b.ocorrencias - a.ocorrencias || a.nome.localeCompare(b.nome))
    .slice(0, max);
}

/**
 * Converte uma sugestao aceita em regra. `origem: "minerada"` fica registrado —
 * a tela mostra de onde a regra veio, e "veio do seu proprio historico" e uma
 * informacao diferente de "voce digitou".
 */
export function regraDaSugestao(s: SugestaoDeRegra, id: string): UserRule {
  return {
    id,
    ativo: true,
    rotulo: `${s.categoria.trim()} – ${tituloDe(s.nome)}`,
    direcao: s.direcao,
    quando: { nome: s.nome },
    categoriaChave: s.categoriaChave,
    origem: "minerada",
  };
}

/** "WANDA LEMOS TAVARES" -> "Wanda Lemos Tavares", so para o rotulo. */
export function tituloDe(nome: string): string {
  return nome
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
