import { AiClient, AiError } from "../../application/ports";
import { ListColumnRule, listColumnsToPromptDump, matchOption } from "../../domain/listColumns";
import { AiRuntimeConfig } from "./aiStatementParser";
import {
  LIST_COLUMNS_SYSTEM_PROMPT,
  buildListColumnsUserPrompt,
} from "./prompts/listColumns";
import { parseListColumnsJson, LIST_COLUMNS_JSON_SCHEMA } from "./schema";

/**
 * ESTAGIO -1b do pipeline — REGRAS DAS COLUNAS POR LISTAGEM.
 *
 * Roda logo depois do perfil da planilha e antes de qualquer leitura de
 * extrato. Recebe as colunas de listagem que a inspeccao encontrou (com as
 * opcoes na grafia exata e o uso real ja gravado) e devolve, por opcao, QUANDO
 * ela se aplica.
 *
 * Tres travas que nao saem daqui:
 *
 *  - A LISTA E DA PLANILHA. O modelo so anota dicas; ele nao acrescenta,
 *    remove nem reescreve opcao. Toda opcao devolvida e casada contra a lista
 *    real (`matchOption`) e o que sobra e ignorado.
 *  - A GRAFIA E DA PLANILHA. A chave de `dicaPorOpcao` e sempre a string que
 *    esta no arquivo, com espaco sobrando e tudo. Isso e o que mantem o VLOOKUP
 *    da coluna de fluxo e a validacao da celula funcionando.
 *  - NUNCA DERRUBA A CONCILIACAO. Falhou a chamada, veio schema errado, nao ha
 *    provedor configurado? As regras ficam sem dica e o preenchimento segue com
 *    a lista crua — que ja e o comportamento de hoje, so que agora com os
 *    exemplos reais da planilha no prompt.
 */

export interface ListAnalyzerDeps {
  client?: AiClient;
  resolveConfig?: () => AiRuntimeConfig;
  /** contrato de destino (perfil da planilha) — contexto opcional. */
  destination?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** desliga o passo de IA (usado em teste e no modo offline). */
  disableAi?: boolean;
}

/** Quantas opcoes tornam a analise por IA valer a chamada. */
const MIN_OPTIONS_FOR_AI = 2;

/**
 * Enriquecimento DETERMINISTICO: mesmo sem IA, o uso real ja gravado na
 * planilha e uma regra. Se "Taxa Ifood" so aparece em linhas de saida, isso e
 * um fato observado, nao um palpite — e ja evita metade dos erros de direcao.
 */
export function orientacaoFromUsage(rule: ListColumnRule): ListColumnRule {
  const porOpcao = new Map<string, { entrada: number; saida: number; exemplos: string[] }>();
  for (const ex of rule.examples) {
    const opcao = matchOption(rule, ex.opcao);
    if (!opcao) continue;
    let a = porOpcao.get(opcao);
    if (!a) {
      a = { entrada: 0, saida: 0, exemplos: [] };
      porOpcao.set(opcao, a);
    }
    if (ex.direcao === "entrada") a.entrada++;
    else if (ex.direcao === "saida") a.saida++;
    if (a.exemplos.length < 3 && ex.contexto) a.exemplos.push(ex.contexto);
  }

  const dicaPorOpcao: Record<string, string> = { ...rule.dicaPorOpcao };
  for (const [opcao, a] of porOpcao) {
    if (dicaPorOpcao[opcao]) continue;
    const partes: string[] = [];
    if (a.entrada > 0 && a.saida === 0) partes.push("so aparece em lancamentos de entrada");
    else if (a.saida > 0 && a.entrada === 0) partes.push("so aparece em lancamentos de saida");
    if (a.exemplos.length) partes.push(`ja usada em: ${a.exemplos.join(" ; ")}`);
    if (partes.length) dicaPorOpcao[opcao] = partes.join("; ");
  }

  return {
    ...rule,
    orientacao:
      rule.orientacao ||
      (rule.examples.length
        ? "siga o criterio que a propria planilha ja usa nos exemplos abaixo"
        : ""),
    dicaPorOpcao,
  };
}

/**
 * Produz as regras de uso das colunas de listagem. Determinístico primeiro; a
 * IA so entra para explicar o que os exemplos nao explicam.
 */
export async function analyzeListColumns(
  rules: ListColumnRule[],
  deps: ListAnalyzerDeps = {},
): Promise<{ rules: ListColumnRule[]; warnings: string[] }> {
  const log = deps.logger ?? console;
  const warnings: string[] = [];
  if (rules.length === 0) return { rules, warnings };

  // passo 1 — o que da para saber sem gastar nada
  const base = rules.map(orientacaoFromUsage);

  const candidatas = base.filter((r) => r.options.length >= MIN_OPTIONS_FOR_AI);
  if (
    candidatas.length === 0 ||
    deps.disableAi ||
    !deps.client ||
    !deps.resolveConfig
  ) {
    return { rules: base, warnings };
  }

  // passo 2 — uma chamada, um prompt, so para as regras de uso
  try {
    const cfg = deps.resolveConfig();
    const raw = await deps.client.complete({
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: LIST_COLUMNS_SYSTEM_PROMPT,
      userPrompt: buildListColumnsUserPrompt(
        listColumnsToPromptDump(candidatas),
        deps.destination,
      ),
      responseSchema: LIST_COLUMNS_JSON_SCHEMA,
    });
    const parsed = parseListColumnsJson(raw);
    const porLetra = new Map(parsed.colunas.map((c) => [c.letra, c]));

    const enriquecidas = base.map((r) => {
      const resposta = porLetra.get(r.letter);
      if (!resposta) return r;
      const dicaPorOpcao: Record<string, string> = { ...r.dicaPorOpcao };
      let foraDaLista = 0;
      for (const o of resposta.opcoes) {
        // a opcao volta para a grafia da PLANILHA antes de virar chave
        const exata = matchOption(r, o.opcao);
        if (!exata) {
          foraDaLista++;
          continue;
        }
        const partes = [o.quandoUsar, o.direcao !== "ambas" ? `apenas em ${o.direcao}` : ""]
          .filter(Boolean)
          .join("; ");
        if (partes) dicaPorOpcao[exata] = partes;
      }
      if (foraDaLista > 0) {
        log.warn(
          `[listagem] ${foraDaLista} opcao(oes) fora da lista da coluna ${r.letter} foram ignoradas.`,
        );
      }
      return { ...r, orientacao: resposta.orientacao || r.orientacao, dicaPorOpcao };
    });

    if (parsed.observacoes) warnings.push(parsed.observacoes);
    return { rules: enriquecidas, warnings };
  } catch (e) {
    const msg = e instanceof AiError ? `${e.kind}: ${e.message}` : (e as Error).message;
    log.warn(`[listagem] analise das listas falhou (${msg}); sigo com o uso observado na planilha.`);
    return { rules: base, warnings };
  }
}
