import { AiClient, AiError } from "../../application/ports";
import { IdentityAnswer, IdentityQuestion } from "../../domain/userRules";
import { AiRuntimeConfig } from "./aiStatementParser";
import {
  IDENTITY_SYSTEM_PROMPT,
  IdentityItem,
  buildIdentityUserPrompt,
  flattenIdentityQuestions,
} from "./prompts/identity";
import { IDENTITY_JSON_SCHEMA, parseIdentityJson } from "./schema";

/**
 * ESTAGIO 4b — AGENTE DE IDENTIDADE.
 *
 * O unico papel deste agente e responder "esta ocorrencia e a pessoa da regra,
 * sim ou nao?". Ele nao escolhe categoria: a categoria ja esta na regra, e a
 * aplicacao dela e literal e deterministica, no passo seguinte.
 *
 * TRES DECISOES QUE VALEM REGISTRAR:
 *
 *  - EM LOTE, NUNCA UM A UM. A pergunta e por NOME DISTINTO, e todos os nomes
 *    de todas as regras cabem no mesmo lote. Um extrato inteiro costuma ser uma
 *    chamada — e um cliente com as regras ja aprendidas, nenhuma.
 *  - NUNCA DERRUBA A CONCILIACAO. Lote que falhou nao vira "nao": vira AUSENCIA
 *    de veredicto. A diferenca importa — "nao" vira alias negativo e nunca mais
 *    seria perguntado, o que congelaria um erro de rede como se fosse decisao.
 *    Sem veredicto, o lancamento so segue para o classificador, e na proxima
 *    conciliacao a pergunta e feita de novo.
 *  - VEREDICTO SEM PERGUNTA E DESCARTADO. O modelo devolve indice; indice que
 *    nao existe no lote, ou repetido, nao entra. Nada aqui confia na resposta
 *    para saber o que foi perguntado.
 */

export interface IdentityAgentDeps {
  client: AiClient;
  resolveConfig: () => AiRuntimeConfig;
  /** pares (regra, candidato) por chamada (default 60). */
  batchSize?: number;
  /** chamadas simultaneas (default 2). */
  concurrency?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

const DEFAULT_BATCH = 60;
const DEFAULT_CONCURRENCY = 2;

export interface IdentityOutcome {
  respostas: IdentityAnswer[];
  /** quantas chamadas de IA este estagio custou (0 quando nao havia duvida). */
  chamadas: number;
  /** lotes que falharam — viram aviso, nao veredicto. */
  falhas: string[];
}

export class IdentityAgent {
  constructor(private readonly deps: IdentityAgentDeps) {}

  private get log() {
    return this.deps.logger ?? console;
  }

  async confirmar(perguntas: IdentityQuestion[]): Promise<IdentityOutcome> {
    const itens = flattenIdentityQuestions(perguntas);
    if (itens.length === 0) return { respostas: [], chamadas: 0, falhas: [] };

    const tamanho = Math.max(1, this.deps.batchSize ?? DEFAULT_BATCH);
    const lotes: IdentityItem[][] = [];
    for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));

    const respostas: IdentityAnswer[] = [];
    const falhas: string[] = [];
    let chamadas = 0;

    const limite = Math.max(1, Math.min(this.deps.concurrency ?? DEFAULT_CONCURRENCY, lotes.length));
    let proximo = 0;
    await Promise.all(
      Array.from({ length: limite }, async () => {
        for (;;) {
          const i = proximo++;
          if (i >= lotes.length) return;
          const lote = lotes[i];
          chamadas++;
          try {
            respostas.push(...(await this.confirmarLote(lote)));
          } catch (e) {
            const msg = e instanceof AiError ? `${e.kind}: ${e.message}` : (e as Error).message;
            falhas.push(msg);
            this.log.warn(
              `[identidade] lote de ${lote.length} nome(s) falhou (${msg}); ` +
                `estes lancamentos vao para o classificador e a pergunta volta na proxima vez.`,
            );
          }
        }
      }),
    );

    const sim = respostas.filter((r) => r.aplica).length;
    this.log.log(
      `[identidade] ${itens.length} nome(s) conferido(s) em ${chamadas} chamada(s): ` +
        `${sim} confirmado(s), ${respostas.length - sim} recusado(s).`,
    );
    return { respostas, chamadas, falhas };
  }

  private async confirmarLote(lote: IdentityItem[]): Promise<IdentityAnswer[]> {
    const cfg = this.deps.resolveConfig();
    const bruto = await this.deps.client.complete({
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: IDENTITY_SYSTEM_PROMPT,
      userPrompt: buildIdentityUserPrompt(lote),
      responseSchema: IDENTITY_JSON_SCHEMA,
    });
    const veredictos = parseIdentityJson(bruto);

    // O indice manda: e o que amarra a resposta a pergunta. Indice fora do lote
    // ou repetido e descartado — nunca aceitamos o que nao perguntamos.
    const porIndice = new Map(lote.map((i) => [i.indice, i]));
    const vistos = new Set<number>();
    const out: IdentityAnswer[] = [];
    for (const v of veredictos) {
      const item = porIndice.get(v.indice);
      if (!item || vistos.has(v.indice)) continue;
      vistos.add(v.indice);
      out.push({ ruleId: item.ruleId, candidato: item.candidato, aplica: v.mesmaPessoa });
    }
    return out;
  }
}
