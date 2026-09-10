import { AiClient, AiError } from "../../application/ports";
import { FormulaColumnRule, formulaColumnsToPromptDump } from "../../domain/formulaColumns";
import { AiRuntimeConfig } from "./aiStatementParser";
import {
  FORMULA_COLUMNS_SYSTEM_PROMPT,
  buildFormulaColumnsUserPrompt,
} from "./prompts/formulaColumns";
import { parseFormulaColumnsJson, FORMULA_COLUMNS_JSON_SCHEMA } from "./schema";

/**
 * ESTAGIO -1c do pipeline — COLUNAS CALCULADAS.
 *
 * Decide quais colunas de formula devem ser REPETIDAS em toda linha que o
 * sistema inserir. O texto da formula nunca vem daqui: ele foi lido do arquivo
 * (`inspectFormulas.ts`) e e fato. O que este estagio resolve e a duvida que o
 * arquivo nao resolve — quando uma coluna tem formula em parte das linhas e
 * nao em outras, isso e o padrao da planilha ou e resto de edicao manual?
 *
 * Ordem de esforco, como no resto do projeto:
 *   1. DETERMINISTICO. Coluna com formula em praticamente toda linha de dados e
 *      padrao; coluna acumulada e padrao por definicao (sem ela a corrente do
 *      saldo quebra na primeira linha nova). Isso resolve a planilha de sempre
 *      sem gastar chamada.
 *   2. So o que sobrou ambiguo vai para UM prompt dedicado.
 *   3. Falhou a IA? Vale a decisao deterministica. Nunca derruba a conciliacao.
 */

export interface FormulaAnalyzerDeps {
  client?: AiClient;
  resolveConfig?: () => AiRuntimeConfig;
  destination?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  disableAi?: boolean;
}

/** Uma regra ja decidida: alem do modelo, se ela vale para toda linha nova. */
export interface ResolvedFormulaColumn extends FormulaColumnRule {
  perpetuar: boolean;
  /** de onde veio a decisao. */
  decidedBy: "deterministico" | "ia";
}

/**
 * Decisao deterministica. `porColuna` ja diz que a formula aparece na maioria
 * esmagadora das linhas de dados; `acumulada` diz que a coluna encadeia o
 * resultado. Qualquer um dos dois basta.
 */
export function decideDeterministic(rule: FormulaColumnRule): {
  perpetuar: boolean;
  conclusivo: boolean;
} {
  if (rule.kind === "acumulada") return { perpetuar: true, conclusivo: true };
  if (rule.porColuna && rule.ocorrencias >= 3) return { perpetuar: true, conclusivo: true };
  // pouquissimas ocorrencias: cheira a calculo avulso, mas nao da para jurar
  if (rule.ocorrencias <= 2) return { perpetuar: false, conclusivo: true };
  return { perpetuar: false, conclusivo: false };
}

/** Resolve quais colunas calculadas devem ser perpetuadas nas linhas novas. */
export async function analyzeFormulaColumns(
  rules: FormulaColumnRule[],
  deps: FormulaAnalyzerDeps = {},
): Promise<{ rules: ResolvedFormulaColumn[]; warnings: string[] }> {
  const log = deps.logger ?? console;
  const warnings: string[] = [];
  if (rules.length === 0) return { rules: [], warnings };

  const decididas: ResolvedFormulaColumn[] = [];
  const ambiguas: FormulaColumnRule[] = [];
  for (const r of rules) {
    const d = decideDeterministic(r);
    if (d.conclusivo) {
      decididas.push({ ...r, perpetuar: d.perpetuar, decidedBy: "deterministico" });
    } else {
      ambiguas.push(r);
    }
  }

  if (ambiguas.length === 0 || deps.disableAi || !deps.client || !deps.resolveConfig) {
    for (const r of ambiguas) {
      decididas.push({ ...r, perpetuar: false, decidedBy: "deterministico" });
      warnings.push(
        `A coluna ${r.letter} "${r.header}" tem formula em parte das linhas; nao vou repeti-la nas linhas novas.`,
      );
    }
    return { rules: ordenar(decididas), warnings };
  }

  try {
    const cfg = deps.resolveConfig();
    const raw = await deps.client.complete({
      provider: cfg.provider,
      model: cfg.model,
      systemPrompt: FORMULA_COLUMNS_SYSTEM_PROMPT,
      userPrompt: buildFormulaColumnsUserPrompt(
        formulaColumnsToPromptDump(ambiguas),
        deps.destination,
      ),
      responseSchema: FORMULA_COLUMNS_JSON_SCHEMA,
    });
    const parsed = parseFormulaColumnsJson(raw);
    const porLetra = new Map(parsed.colunas.map((c) => [c.letra, c]));
    for (const r of ambiguas) {
      const resposta = porLetra.get(r.letter);
      decididas.push({
        ...r,
        // o TIPO lido do arquivo continua mandando; o modelo so complementa
        kind: r.kind === "outra" && resposta ? resposta.tipo : r.kind,
        motivo: resposta?.motivo || r.motivo,
        perpetuar: resposta?.perpetuar === true,
        decidedBy: resposta ? "ia" : "deterministico",
      });
    }
    if (parsed.observacoes) warnings.push(parsed.observacoes);
  } catch (e) {
    const msg = e instanceof AiError ? `${e.kind}: ${e.message}` : (e as Error).message;
    log.warn(`[formulas] analise das colunas calculadas falhou (${msg}); sigo pelo observado.`);
    for (const r of ambiguas) {
      decididas.push({ ...r, perpetuar: false, decidedBy: "deterministico" });
    }
  }

  return { rules: ordenar(decididas), warnings };
}

function ordenar(rules: ResolvedFormulaColumn[]): ResolvedFormulaColumn[] {
  return [...rules].sort((a, b) => a.letter.localeCompare(b.letter));
}
