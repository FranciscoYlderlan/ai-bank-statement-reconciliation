import { AiClient, AiError } from "../../application/ports";
import { Transaction } from "../../domain/transaction";
import { comparisonKey } from "../../domain/normalize";
import { ListColumnRule, describeListColumnsForPrompt } from "../../domain/listColumns";
import { houseRulesPromptBlock, FlowDirection } from "../../domain/houseRules";
import {
  UserRule,
  UserRuleMatch,
  applyIdentityAnswers,
  buildIdentityQuestions,
  decidirCategoria,
} from "../../domain/userRules";
import { AiRuntimeConfig } from "./aiStatementParser";
import { IdentityAgent } from "./identityAgent";
import {
  CATEGORIZE_SYSTEM_PROMPT,
  buildCategorizeUserPrompt,
  CategorizeItem,
} from "./prompts/categorize";
import { parseCategorizationJson, CATEGORIZATION_JSON_SCHEMA } from "./schema";

/**
 * ESTAGIO DEDICADO — CATEGORIZACAO.
 *
 * Recebe transacoes JA transcritas e a lista de categorias reais da planilha do
 * usuario, e devolve a categoria de cada uma. A cadeia, na ordem:
 *
 *   4a. REGRAS DO USUARIO      o dono do negocio sabe; ninguem adivinha
 *   4b. AGENTE DE IDENTIDADE   so quando o nome ficou em duvida (em lote)
 *   4c. REGRAS DA CASA         o que o ramo ja decide (dominio, sem IA)
 *   4d. CLASSIFICADOR (IA)     o que sobrou, agrupado por descricao
 *
 * Tres decisoes antigas continuam valendo:
 *
 *  - AGRUPA POR DESCRICAO — mas so o que chega no 4d. Um extrato de 358 linhas
 *    costuma ter algumas dezenas de descricoes distintas; classificamos cada uma
 *    UMA vez e replicamos.
 *  - VALIDA CONTRA A LISTA. Categoria fora da lista da planilha e descartada. A
 *    coluna tem dropdown; valor invalido quebra a validacao da celula.
 *  - NUNCA DERRUBA A CONCILIACAO. Lote que falha deixa aqueles lancamentos sem
 *    categoria e a importacao segue — categorizar e melhoria, nao requisito.
 *
 * E uma decisao nova, que e a razao de este arquivo ter mudado:
 *
 *  - AS REGRAS RODAM POR TRANSACAO, NAO POR GRUPO. Regras podem depender de
 *    valor e de conta, que variam DENTRO de um grupo de mesma descricao. Rodar
 *    funcao pura em 358 linhas nao custa nada; agrupar antes custaria correcao.
 *
 * O que este estagio devolve e SEMPRE a string que esta na planilha, nunca a
 * que o modelo digitou (§3.1: `"Salário "` com o espaco, senao o VLOOKUP da
 * coluna Fluxo de Caixa nao encontra nada).
 */

/** Quem decidiu a categoria de um lancamento. */
export type Decisor = "regra-do-usuario" | "regra-da-casa" | "ia" | null;

/** O rastro de UMA decisao — e o que o relatorio mostra (trava 5). */
export interface DecisaoAuditada {
  indice: number;
  descricao: string;
  direcao: FlowDirection;
  categoria: string | null;
  decisor: Decisor;
  /** rotulo da regra do usuario ou da regra da casa que decidiu. */
  porQuem: string | null;
  /** a identidade desta ocorrencia foi confirmada pelo agente (estagio 4b). */
  viaAgente?: boolean;
  /** rotulo da regra da casa que teria decidido diferente. */
  contrariouCasa?: string;
  /** rotulos de outras regras do usuario que apontavam para categoria diferente. */
  conflitos?: string[];
}

export interface ResumoCategorizacao {
  porRegraDoUsuario: number;
  /** subconjunto de `porRegraDoUsuario`: identidade confirmada pelo agente. */
  porAgente: number;
  porRegraDaCasa: number;
  porIa: number;
  semCategoria: number;
  /** chamadas gastas no estagio 4b. */
  chamadasIdentidade: number;
  /** nomes que o agente recusou — nao viraram categoria. */
  identidadesRecusadas: number;
}

export interface ResultadoCategorizacao {
  /** array paralelo a `txs` — a categoria de cada transacao. */
  categorias: (string | null)[];
  auditoria: DecisaoAuditada[];
  resumo: ResumoCategorizacao;
  /**
   * As regras com os aliases que o agente confirmou nesta execucao. A UI grava
   * isto na carteira — e o que faz a proxima conciliacao nao gastar a chamada.
   * Identico a `deps.regras` quando nada foi aprendido.
   */
  regras: UserRule[];
  /** avisos para o relatorio (lote de identidade que falhou, etc.). */
  avisos: string[];
}

export interface CategorizerDeps {
  client: AiClient;
  resolveConfig: () => AiRuntimeConfig;
  /** quantas descricoes por chamada (default 40). */
  batchSize?: number;
  /** chamadas simultaneas (default 3). */
  concurrency?: number;
  /** contrato de destino (perfil da planilha) — contexto opcional. */
  destination?: string;
  /**
   * Regra da coluna de categoria (estagio -1b). Quando presente, as opcoes DELA
   * sao a lista valida — inclusive a grafia — e as dicas por opcao vao no
   * prompt.
   */
  rule?: ListColumnRule | null;
  /** as regras do usuario (carteira da planilha). Vazio = comportamento antigo. */
  regras?: UserRule[];
  /**
   * O agente de identidade. `null` desliga o estagio 4b: os nomes em duvida
   * seguem direto para o classificador, sem chamada nenhuma. E o que acontece
   * quando a carteira nao tem regra por nome.
   */
  identity?: IdentityAgent | null;
  /** desliga as regras da casa (só para teste do caminho puro do modelo). */
  disableHouseRules?: boolean;
  onProgress?: (done: number, total: number) => void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

const DEFAULT_BATCH = 40;
const DEFAULT_CONCURRENCY = 3;

/** Chave canonica de uma categoria, para casar respostas com pequenas variacoes. */
function canonKey(s: string): string {
  return comparisonKey(s).replace(/[^A-Z0-9]+/g, " ").trim();
}

function formatValor(tx: Transaction): string {
  return tx.amount.format();
}

function direcaoDe(tx: Transaction): FlowDirection {
  return tx.direction === "credit" ? "entrada" : "saida";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

export class AiCategorizer {
  constructor(private readonly deps: CategorizerDeps) {}

  private get log() {
    return this.deps.logger ?? console;
  }

  /**
   * Compatibilidade: devolve so o array de categorias, como antes. Quem quiser
   * o rastro da decisao (o relatorio) chama `classificar`.
   */
  async categorize(txs: Transaction[], categorias: string[]): Promise<(string | null)[]> {
    return (await this.classificar(txs, categorias)).categorias;
  }

  async classificar(txs: Transaction[], categorias: string[]): Promise<ResultadoCategorizacao> {
    // A regra da coluna, quando existe, e a fonte da lista: ela veio do proprio
    // dropdown da planilha, com a grafia intacta. `categorias` continua sendo o
    // caminho de compatibilidade (planilha sem validacao formal).
    const lista = this.deps.rule?.options.length ? this.deps.rule.options : categorias;
    const out: (string | null)[] = txs.map(() => null);
    const auditoria: DecisaoAuditada[] = txs.map((tx, i) => ({
      indice: i,
      descricao: tx.description,
      direcao: direcaoDe(tx),
      categoria: null,
      decisor: null,
      porQuem: null,
    }));
    const vazio: ResultadoCategorizacao = {
      categorias: out,
      auditoria,
      resumo: resumir(auditoria, 0, 0),
      regras: this.deps.regras ?? [],
      avisos: [],
    };
    if (txs.length === 0 || lista.length === 0) return vazio;

    const opcoes = { semRegrasDaCasa: this.deps.disableHouseRules === true };
    let regras = this.deps.regras ?? [];
    const avisos: string[] = [];

    // ── 4a: regras do usuario e da casa, POR TRANSACAO ────────────────────
    // Por transacao e nao por grupo porque uma regra pode depender de valor e
    // de conta, que variam dentro de um mesmo grupo de descricao.
    const decisoes = txs.map((tx) =>
      decidirCategoria(this.contexto(tx), lista, regras, opcoes),
    );
    // guardamos as pendencias ANTES do agente: depois do veredicto elas viram
    // decisao e somem, e sem isto nao daria para dizer no relatorio quais foram
    // confirmadas por ele.
    const pendenciaDe: UserRuleMatch[][] = decisoes.map((d) => d.pendentes);
    const pendentes = pendenciaDe.flat();

    // ── 4b: agente de identidade, so para o que ficou em duvida ───────────
    let chamadasIdentidade = 0;
    let recusadas = 0;
    let confirmados = new Set<string>();
    if (pendentes.length > 0 && this.deps.identity) {
      const perguntas = buildIdentityQuestions(pendentes);
      const { respostas, chamadas, falhas } = await this.deps.identity.confirmar(perguntas);
      chamadasIdentidade = chamadas;
      recusadas = respostas.filter((r) => !r.aplica).length;
      for (const f of falhas) {
        avisos.push(`a conferencia de identidade falhou num lote (${f}); ` +
          `esses lancamentos foram para o classificador`);
      }
      if (respostas.length > 0) {
        regras = applyIdentityAnswers(regras, respostas);
        confirmados = new Set(
          respostas.filter((r) => r.aplica).map((r) => chaveConfirmacao(r.ruleId, r.candidato)),
        );
        // re-decide SO o que estava pendente: as regras mudaram (ganharam alias)
        for (let i = 0; i < txs.length; i++) {
          if (pendenciaDe[i].length === 0) continue;
          decisoes[i] = decidirCategoria(this.contexto(txs[i]), lista, regras, opcoes);
        }
      }
    } else if (pendentes.length > 0) {
      this.log.log(
        `[categoria] ${pendentes.length} ocorrencia(s) com nome em duvida seguiram para o ` +
          `classificador: o agente de identidade nao esta ligado.`,
      );
    }

    // ── grava o que foi decidido sem IA ───────────────────────────────────
    let porRegra = 0;
    for (let i = 0; i < txs.length; i++) {
      const d = decisoes[i];
      if (!d.option) continue;
      out[i] = d.option;
      porRegra++;
      auditoria[i] = {
        ...auditoria[i],
        categoria: d.option,
        decisor: d.decisor,
        porQuem: d.porQuem,
        ...(d.decisor === "regra-do-usuario" &&
        d.userRule &&
        pendenciaDe[i].some(
          (m) =>
            m.rule.id === d.userRule!.id &&
            confirmados.has(chaveConfirmacao(m.rule.id, m.aliasKey)),
        )
          ? { viaAgente: true }
          : {}),
        ...(d.contrariaCasa ? { contrariouCasa: d.contrariaCasa.label } : {}),
        ...(d.conflitos.length ? { conflitos: d.conflitos.map((r) => r.rotulo) } : {}),
      };
    }
    if (porRegra > 0) {
      this.log.log(
        `[categoria] ${porRegra} lançamento(s) decididos por regra (usuário + casa); ` +
          `${txs.length - porRegra} vão para o classificador.`,
      );
    }

    // ── 4d: o que sobrou vai para a IA, agrupado por descricao ────────────
    const groups = new Map<string, { item: CategorizeItem; indices: number[] }>();
    txs.forEach((tx, i) => {
      if (out[i]) return;
      const key = `${tx.direction}|${comparisonKey(tx.description)}`;
      const g = groups.get(key);
      if (g) {
        g.indices.push(i);
        return;
      }
      groups.set(key, {
        item: {
          indice: groups.size,
          descricao: tx.description,
          direcao: direcaoDe(tx),
          valor: formatValor(tx),
        },
        indices: [i],
      });
    });

    const unique = [...groups.values()];
    if (unique.length === 0) {
      this.deps.onProgress?.(1, 1);
      return {
        categorias: out,
        auditoria,
        resumo: resumir(auditoria, chamadasIdentidade, recusadas),
        regras,
        avisos,
      };
    }

    const batchSize = Math.max(1, this.deps.batchSize ?? DEFAULT_BATCH);
    const batches: (typeof unique)[] = [];
    for (let i = 0; i < unique.length; i += batchSize) batches.push(unique.slice(i, i + batchSize));

    // Indice canonico das categorias validas. A CHAVE e normalizada (sem
    // acento, sem caixa, sem espaco sobrando) so para casar; o VALOR e a
    // string literal da planilha, e e ela que sera gravada.
    const canon = new Map<string, string>();
    for (const c of lista) canon.set(canonKey(c), c);

    let done = 0;
    const total = batches.length;
    this.deps.onProgress?.(0, total);

    await mapWithConcurrency(batches, this.deps.concurrency ?? DEFAULT_CONCURRENCY, async (batch) => {
      try {
        const assignments = await this.classifyBatch(batch.map((b) => b.item), lista);
        const byIndice = new Map(assignments.map((a) => [a.indice, a.categoria]));
        for (const g of batch) {
          const answer = byIndice.get(g.item.indice);
          if (!answer) continue;
          const match = canon.get(canonKey(answer));
          if (!match) {
            this.log.warn(`[categoria] resposta fora da lista descartada: "${answer}".`);
            continue;
          }
          for (const i of g.indices) {
            out[i] = match;
            auditoria[i] = { ...auditoria[i], categoria: match, decisor: "ia", porQuem: null };
          }
        }
      } catch (e) {
        const msg = e instanceof AiError ? `${e.kind}: ${e.message}` : (e as Error).message;
        this.log.warn(`[categoria] lote falhou (${msg}); estes lancamentos ficam sem categoria.`);
      } finally {
        done++;
        this.deps.onProgress?.(done, total);
      }
    });

    return {
      categorias: out,
      auditoria,
      resumo: resumir(auditoria, chamadasIdentidade, recusadas),
      regras,
      avisos,
    };
  }

  private contexto(tx: Transaction) {
    return {
      descricao: tx.description,
      direcao: direcaoDe(tx),
      valorCents: tx.amount.cents,
      contaId: tx.account.id,
    };
  }

  private async classifyBatch(itens: CategorizeItem[], categorias: string[]) {
    const cfg = this.deps.resolveConfig();
    const raw = await this.deps.client.complete({
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: CATEGORIZE_SYSTEM_PROMPT,
      userPrompt: buildCategorizeUserPrompt(
        categorias,
        itens,
        this.deps.destination,
        [
          this.deps.rule ? describeListColumnsForPrompt([this.deps.rule]) : "",
          // as regras da casa vao mesmo tendo sido aplicadas antes: o que chega
          // aqui e o que elas NAO decidiram, e o modelo precisa do mesmo
          // criterio para nao contrariar a casa nos casos de fronteira.
          //
          // As regras do USUARIO nao vao. Elas ja decidiram deterministicamente
          // o que era delas, e um cadastro de dezenas de nomes proprios so
          // encheria o prompt — sem contar que nome de funcionaria do cliente
          // nao precisa viajar para o provedor.
          this.deps.disableHouseRules ? "" : houseRulesPromptBlock(categorias),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      responseSchema: CATEGORIZATION_JSON_SCHEMA,
    });
    return parseCategorizationJson(raw);
  }
}

/** Chave (regra, nome) usada para marcar o que o agente confirmou nesta rodada. */
function chaveConfirmacao(ruleId: string, candidato: string): string {
  return `${ruleId}|${candidato}`;
}

/** Resumo do estagio, para o painel do relatorio. Funcao pura, testavel. */
export function resumir(
  auditoria: DecisaoAuditada[],
  chamadasIdentidade: number,
  identidadesRecusadas: number,
): ResumoCategorizacao {
  return {
    porRegraDoUsuario: auditoria.filter((a) => a.decisor === "regra-do-usuario").length,
    porAgente: auditoria.filter((a) => a.viaAgente).length,
    porRegraDaCasa: auditoria.filter((a) => a.decisor === "regra-da-casa").length,
    porIa: auditoria.filter((a) => a.decisor === "ia").length,
    semCategoria: auditoria.filter((a) => a.categoria == null).length,
    chamadasIdentidade,
    identidadesRecusadas,
  };
}
