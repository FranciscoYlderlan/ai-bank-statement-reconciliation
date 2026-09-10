import { AiClient, AiError } from "../../application/ports";
import {
  WorkbookProfile,
  ProfiledColumn,
  ColumnRole,
  DescriptionStyle,
  defaultProfile,
} from "../../domain/workbookProfile";
import {
  inspectWorkbook,
  inspectionToPromptDump,
  WorkbookInspection,
  InspectedColumn,
  roleFromHeader,
} from "../writers/inspectWorkbook";
import { PROFILE_SYSTEM_PROMPT, buildProfileUserPrompt } from "./prompts/profileWorkbook";
import { parseWorkbookProfileJson, WORKBOOK_PROFILE_JSON_SCHEMA } from "./schema";
import { AiRuntimeConfig } from "./aiStatementParser";
import { analyzeListColumns, orientacaoFromUsage } from "./listColumnAnalyzer";
import { analyzeFormulaColumns, decideDeterministic } from "./formulaColumnAnalyzer";
import { ListColumnRule, ruleForColumn } from "../../domain/listColumns";
import { FormulaColumnRule } from "../../domain/formulaColumns";

/**
 * ESTAGIO -1 do pipeline — PERFIL DA PLANILHA DE DESTINO.
 *
 * Roda ANTES de qualquer leitura de extrato, e existe por um motivo concreto:
 * quando o usuario fornece uma planilha como base, os agentes seguintes
 * precisam saber para onde estao escrevendo. Sem isso, o sistema assumia um
 * layout fixo e o resultado era campo em branco, dado na coluna errada e
 * descricao fora do padrao do que ja estava gravado — que por sua vez estraga
 * o dedup (descricao diferente nao casa com a linha existente).
 *
 * Ordem de esforco, do mais barato para o mais caro:
 *   1. INSPECAO LOCAL (sem IA, sem custo) — resolve o caso comum.
 *   2. Se a inspecao nao conclui, UM prompt dedicado so para ler a estrutura.
 *   3. Se nem isso, o perfil padrao, com o aviso correspondente.
 */

export interface ProfileDeps {
  client?: AiClient;
  resolveConfig?: () => AiRuntimeConfig;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** desliga o passo de IA (usado em teste e no modo offline). */
  disableAi?: boolean;
}

/** Papeis que precisamos ter identificado para dispensar a IA. */
const REQUIRED_ROLES: ColumnRole[] = ["data", "descricao", "entrada", "saida"];

function styleFromSamples(samples: string[]): DescriptionStyle {
  if (samples.length === 0) {
    return { exemplos: [], caixa: "mista", separador: null, tamanhoMedio: 0 };
  }
  const letras = samples.join("");
  const upper = (letras.match(/[A-ZÁÂÃÀÉÊÍÓÔÕÚÇ]/g) || []).length;
  const lower = (letras.match(/[a-záâãàéêíóôõúç]/g) || []).length;
  const caixa: DescriptionStyle["caixa"] =
    upper > lower * 3 ? "maiuscula" : lower > upper * 3 ? "minuscula" : "mista";
  const separadores = ["|", " - ", "/", "•"];
  const separador =
    separadores.find((s) => samples.filter((x) => x.includes(s)).length >= samples.length / 2) ??
    null;
  const tamanhoMedio = samples.reduce((a, s) => a + s.length, 0) / samples.length;
  return { exemplos: samples.slice(0, 6), caixa, separador, tamanhoMedio };
}

function recebeFor(role: ColumnRole, col: InspectedColumn, style: DescriptionStyle): string {
  switch (role) {
    case "data":
      return "a data do lancamento (dd/mm/aaaa)";
    case "descricao":
      return style.separador
        ? `quem pagou/recebeu, seguido de "${style.separador.trim()}" e do tipo do lancamento`
        : "quem pagou/recebeu e o tipo do lancamento";
    case "categoria":
      return "uma categoria da lista valida da planilha (deixe vazio se nao houver certeza)";
    case "fluxo":
      return "FORMULA derivada da categoria — nunca escrever";
    case "entrada":
      return "o valor, em reais, quando o dinheiro ENTRA";
    case "saida":
      return "o valor, em reais, quando o dinheiro SAI";
    case "saldo":
      return "FORMULA de saldo acumulado — nunca escrever";
    default:
      return col.header ? `conteudo proprio da planilha ("${col.header}")` : "nao preencher";
  }
}

/** Passo 1 — tenta montar o perfil so com a inspecao local. */
export function profileFromInspection(ins: WorkbookInspection): WorkbookProfile | null {
  if (ins.headerRow == null || ins.firstDataRow == null || ins.columns.length === 0) return null;

  const style = styleFromSamples(ins.descriptionSamples);
  const used = new Set<ColumnRole>();
  const columns: ProfiledColumn[] = ins.columns.map((c) => {
    let role = (roleFromHeader(c.header) as ColumnRole | null) ?? "ignorar";
    // um mesmo papel nao pode ser reivindicado por duas colunas
    if (role !== "ignorar" && used.has(role)) role = "ignorar";
    if (role !== "ignorar") used.add(role);
    return {
      letter: c.letter,
      header: c.header,
      role,
      hasFormula: c.hasFormula,
      kind: c.kind,
      samples: c.samples,
      recebe: recebeFor(role, c, style),
    };
  });

  const faltando = REQUIRED_ROLES.filter((r) => !used.has(r));
  if (faltando.length > 0) return null; // inconclusivo -> vale gastar uma chamada de IA

  return {
    source: "deterministico",
    sheetNames: ins.sheetNames,
    monthSheets: ins.monthSheets,
    supportSheets: ins.supportSheets,
    headerRow: ins.headerRow,
    firstDataRow: ins.firstDataRow,
    columns,
    categories: ins.categories,
    listColumns: ins.listColumns,
    formulaColumns: ins.formulaColumns,
    formulaColumnsPendentes: [],
    // A ordem das datas e FATO OBSERVADO no arquivo, nunca opiniao: sai da
    // inspecao local tanto neste caminho quanto no da IA.
    dateOrder: ins.dateOrder.ordem,
    dateOrderEvidence: ins.dateOrder,
    dateOrderBySheet: ins.dateOrderBySheet,
    descriptionStyle: style,
    warnings: [...ins.warnings],
  };
}

/** Passo 2 — perfil pela IA, a partir do dump da inspecao (nunca do arquivo cru). */
async function profileWithAi(
  ins: WorkbookInspection,
  deps: ProfileDeps,
): Promise<WorkbookProfile | null> {
  if (deps.disableAi || !deps.client || !deps.resolveConfig) return null;
  const cfg = deps.resolveConfig();
  const raw = await deps.client.complete({
    provider: cfg.provider,
    model: cfg.model,
    systemPrompt: PROFILE_SYSTEM_PROMPT,
    userPrompt: buildProfileUserPrompt(inspectionToPromptDump(ins)),
    responseSchema: WORKBOOK_PROFILE_JSON_SCHEMA,
  });
  const parsed = parseWorkbookProfileJson(raw);

  const style = styleFromSamples(ins.descriptionSamples);
  if (parsed.estiloDescricao.separador) style.separador = parsed.estiloDescricao.separador;
  style.caixa = parsed.estiloDescricao.caixa;

  const byLetter = new Map(ins.columns.map((c) => [c.letter, c]));
  const used = new Set<ColumnRole>();
  const columns: ProfiledColumn[] = parsed.colunas.map((c) => {
    const insCol = byLetter.get(c.letra);
    let role = c.papel as ColumnRole;
    if (role !== "ignorar" && used.has(role)) role = "ignorar";
    if (role !== "ignorar") used.add(role);
    // A inspecao local tem a ultima palavra sobre FORMULA: e fato observado no
    // arquivo, nao opiniao do modelo. Coluna com formula nunca vira gravavel.
    const hasFormula = insCol?.hasFormula || !c.podeEscrever;
    return {
      letter: c.letra,
      header: c.cabecalho || insCol?.header || "",
      role,
      hasFormula,
      kind: insCol?.kind ?? "empty",
      samples: insCol?.samples ?? [],
      recebe: c.recebe || recebeFor(role, insCol ?? emptyCol(c.letra), style),
    };
  });

  const warnings = [...ins.warnings];
  if (parsed.observacoes) warnings.push(parsed.observacoes);

  return {
    source: "ia",
    sheetNames: ins.sheetNames,
    monthSheets: ins.monthSheets,
    supportSheets: ins.supportSheets,
    listColumns: ins.listColumns,
    formulaColumns: ins.formulaColumns,
    formulaColumnsPendentes: [],
    dateOrder: ins.dateOrder.ordem,
    dateOrderEvidence: ins.dateOrder,
    dateOrderBySheet: ins.dateOrderBySheet,
    headerRow: parsed.linhaCabecalho ?? ins.headerRow ?? 12,
    firstDataRow:
      parsed.primeiraLinhaDados ?? (parsed.linhaCabecalho != null ? parsed.linhaCabecalho + 1 : ins.firstDataRow ?? 13),
    columns,
    categories: ins.categories,
    descriptionStyle: style,
    warnings,
  };
}

function emptyCol(letter: string): InspectedColumn {
  return { letter, header: "", hasFormula: false, kind: "empty", samples: [], numFmt: null, filled: 0 };
}

/**
 * Perfila a planilha de destino. Nunca lanca por causa do perfil: se tudo
 * falhar, devolve o perfil padrao com o aviso — uma planilha estranha nao pode
 * impedir a conciliacao, so precisa ser sinalizada.
 */
export async function profileWorkbook(
  bytes: Uint8Array | null,
  deps: ProfileDeps = {},
): Promise<WorkbookProfile> {
  const log = deps.logger ?? console;
  if (!bytes) return defaultProfile();

  let ins: WorkbookInspection;
  try {
    ins = await inspectWorkbook(bytes);
  } catch (e) {
    log.warn(`[perfil] inspecao local falhou: ${(e as Error).message}`);
    const p = defaultProfile();
    p.warnings.push("Nao foi possivel inspecionar a planilha; usando o layout padrao.");
    return p;
  }

  const local = profileFromInspection(ins);
  if (local) return finishProfile(local);

  try {
    const viaAi = await profileWithAi(ins, deps);
    if (viaAi) return finishProfile(viaAi);
  } catch (e) {
    const msg = e instanceof AiError ? `${e.kind}: ${e.message}` : (e as Error).message;
    log.warn(`[perfil] leitura da estrutura por IA falhou (${msg}); usando o layout padrao.`);
  }

  const p = defaultProfile(ins.categories);
  p.sheetNames = ins.sheetNames;
  p.monthSheets = ins.monthSheets;
  p.supportSheets = ins.supportSheets;
  p.listColumns = ins.listColumns;
  p.formulaColumns = ins.formulaColumns;
  p.dateOrder = ins.dateOrder.ordem;
  p.dateOrderEvidence = ins.dateOrder;
  p.dateOrderBySheet = ins.dateOrderBySheet;
  if (ins.headerRow != null) p.headerRow = ins.headerRow;
  if (ins.firstDataRow != null) p.firstDataRow = ins.firstDataRow;
  p.descriptionStyle = styleFromSamples(ins.descriptionSamples);
  p.warnings.push(
    "Nao consegui identificar todas as colunas desta planilha; segui com o layout padrao (Data · Descrição · Categoria · Fluxo · Entrada · Saída · Saldo).",
  );
  p.warnings.push(...ins.warnings);
  return finishProfile(p);
}

/**
 * Fechamento DETERMINISTICO do perfil — sem nenhuma chamada de modelo.
 *
 * Na planilha de sempre, tudo o que importa ja esta no arquivo: o dropdown diz
 * quais opcoes a coluna aceita, as linhas ja gravadas dizem quando cada opcao e
 * usada, e a presenca da formula diz quais colunas sao calculadas. Gastar
 * chamada aqui seria pagar para reler o que o arquivo entrega de graca.
 *
 * O que fica em aberto vai para `formulaColumnsPendentes`, e so isso e o que o
 * estagio -1c (com IA) precisa resolver depois.
 */
function finishProfile(profile: WorkbookProfile): WorkbookProfile {
  // -1b, parte gratuita: o uso real ja gravado na planilha e uma regra.
  profile.listColumns = profile.listColumns.map(orientacaoFromUsage);

  // -1c, parte gratuita: coluna acumulada, ou com formula em praticamente toda
  // linha de dados, e padrao da planilha. O resto fica pendente.
  const aprovadas: FormulaColumnRule[] = [];
  const pendentes: FormulaColumnRule[] = [];
  for (const r of profile.formulaColumns) {
    const d = decideDeterministic(r);
    if (!d.conclusivo) pendentes.push(r);
    else if (d.perpetuar) aprovadas.push(r);
  }
  profile.formulaColumns = aprovadas;
  profile.formulaColumnsPendentes = pendentes;

  // A lista da coluna de CATEGORIA e a fonte de verdade das categorias validas.
  // A aba `Categorias` continua servindo de origem, mas quem manda e a coluna:
  // se o dropdown aponta para outro lugar, e desse outro lugar que sai a lista.
  profile.categories = categoriesFromProfile(profile);
  return profile;
}

/**
 * ESTAGIOS -1b e -1c — a parte que custa uma chamada.
 *
 * Chamado pelo motor DEPOIS do perfil, e nunca de dentro dele: o perfil tem
 * como contrato resolver a planilha conhecida sem gastar nada, e misturar as
 * duas coisas quebraria isso.
 *
 *   -1b  REGRAS DE LISTAGEM: quando cada opcao do dropdown se aplica. Melhora
 *        a escolha da categoria; a lista de opcoes continua sendo a da planilha.
 *   -1c  COLUNAS CALCULADAS: decide as que ficaram pendentes — as que tem
 *        formula em parte das linhas e nao em outras.
 *
 * Nunca lanca. Se as duas falharem, vale exatamente o que o perfil ja tinha
 * decidido sozinho.
 */
export async function refineColumnRules(
  profile: WorkbookProfile,
  deps: ProfileDeps & { destination?: string } = {},
): Promise<WorkbookProfile> {
  const lista = await analyzeListColumns(profile.listColumns, deps);
  profile.listColumns = lista.rules;
  profile.warnings.push(...lista.warnings);

  if (profile.formulaColumnsPendentes.length > 0) {
    const formulas = await analyzeFormulaColumns(profile.formulaColumnsPendentes, deps);
    for (const r of formulas.rules) {
      if (r.perpetuar) profile.formulaColumns.push(r);
    }
    profile.formulaColumns.sort((a, b) => a.letter.localeCompare(b.letter));
    profile.formulaColumnsPendentes = [];
    profile.warnings.push(...formulas.warnings);
  }

  profile.categories = categoriesFromProfile(profile);
  return profile;
}

/** Categorias validas: as opcoes do dropdown da coluna de categoria, se houver. */
function categoriesFromProfile(profile: WorkbookProfile): string[] {
  const letra = profile.columns.find((c) => c.role === "categoria")?.letter ?? null;
  const regra: ListColumnRule | null = ruleForColumn(profile.listColumns, letra);
  if (regra && regra.options.length) return regra.options;
  return profile.categories;
}
