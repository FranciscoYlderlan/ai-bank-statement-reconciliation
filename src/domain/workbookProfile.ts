import { SheetRowLayout, DONA_MARI_LAYOUT } from "./layout";
import { ListColumnRule, describeListColumnsForPrompt } from "./listColumns";
import { FormulaColumnRule, describeFormulaColumnsForPrompt } from "./formulaColumns";
import { DateOrder, DateOrderEvidence, describeDateOrder } from "./dateOrder";

/**
 * PERFIL DA PLANILHA — o contrato de "para onde estamos escrevendo".
 *
 * Antes desta camada, o sistema assumia SEMPRE o layout da planilha Cantina Bom Prato:
 * cabecalho na linha 12, B..H nessa ordem. Quando o usuario trazia outra
 * planilha como base, o resultado era previsivel — colunas em branco, dados no
 * campo errado, formatacao de descricao diferente da que ja estava la e, por
 * tabela, um dedup ruim (descricao fora do padrao nao casa com a linha que ja
 * existe).
 *
 * O perfil resolve isso ANTES de qualquer agente rodar: descobrimos quais
 * colunas existem, o que cada uma recebe, como as que ja estao preenchidas
 * estao escritas, e so entao os proximos estagios (extracao e categorizacao)
 * trabalham em cima desse contrato.
 *
 * Este arquivo e DOMINIO: so tipos e regras puras. Quem le o .xlsx e
 * `adapters/writers/inspectWorkbook.ts`; quem chama a IA quando a inspecao nao
 * basta e `adapters/ai/workbookProfiler.ts`.
 */

/** Papel de uma coluna no contrato de escrita. */
export type ColumnRole =
  | "data"
  | "descricao"
  | "categoria"
  | "fluxo"
  | "entrada"
  | "saida"
  | "saldo"
  | "ignorar";

/** Papeis que o writer PODE preencher (os demais sao formula ou nao nossos). */
export const WRITABLE_ROLES: ColumnRole[] = ["data", "descricao", "categoria", "entrada", "saida"];

export interface ProfiledColumn {
  letter: string; // "B"
  header: string; // texto do cabecalho, como esta na planilha
  role: ColumnRole;
  /** true quando as linhas de dados dessa coluna contem formula (nunca escrever). */
  hasFormula: boolean;
  /** tipo do conteudo observado nas linhas ja preenchidas. */
  kind: "date" | "money" | "text" | "number" | "formula" | "empty";
  /** amostras do conteudo real (ja formatado como o usuario ve). */
  samples: string[];
  /** frase curta: o que esta coluna recebe. Vai nos prompts dos proximos agentes. */
  recebe: string;
}

/** Como as descricoes ja gravadas na planilha estao escritas. */
export interface DescriptionStyle {
  exemplos: string[];
  caixa: "maiuscula" | "minuscula" | "mista";
  /** separador recorrente entre contraparte e tipo, se houver ("|", "-", "/"). */
  separador: string | null;
  tamanhoMedio: number;
}

export interface WorkbookProfile {
  /** de onde veio o perfil: inspecao local, IA, ou o padrao embutido. */
  source: "deterministico" | "ia" | "padrao";
  sheetNames: string[];
  /** abas de lancamento (meses) encontradas. */
  monthSheets: string[];
  /** abas de apoio (Categorias, dashboard…). */
  supportSheets: string[];
  headerRow: number;
  firstDataRow: number;
  columns: ProfiledColumn[];
  /** categorias validas lidas da planilha (aba Categorias, coluna A). */
  categories: string[];
  /**
   * Colunas preenchidas por LISTAGEM (dropdown), com as opcoes na grafia exata
   * e a regra de quando cada uma se aplica. Estagio -1b.
   */
  listColumns: ListColumnRule[];
  /**
   * Colunas CALCULADAS que o writer tem de repetir nas linhas novas, ja com a
   * formula-modelo lida do arquivo. Estagio -1c.
   */
  formulaColumns: FormulaColumnRule[];
  /**
   * Colunas com formula em que a leitura do arquivo NAO concluiu sozinha —
   * tem formula em parte das linhas e nao em outras. Ficam de fora da escrita
   * ate o estagio -1c decidir; e so por elas que vale gastar uma chamada.
   */
  formulaColumnsPendentes: FormulaColumnRule[];
  /**
   * ORDEM DAS DATAS que a planilha pratica. Sai da analise (inspecao local, sem
   * custo) e viaja ate o writer: e ela que decide se o lancamento novo entra no
   * topo, no meio ou no fim da aba.
   */
  dateOrder: DateOrder;
  /** a evidencia por tras do veredito (quantos pares concordaram). */
  dateOrderEvidence: DateOrderEvidence;
  /** a mesma leitura, aba a aba: uma aba pode divergir do resto da planilha. */
  dateOrderBySheet: Record<string, DateOrderEvidence>;
  descriptionStyle: DescriptionStyle;
  /** o que impediu uma leitura 100% confiante (mostrado ao usuario). */
  warnings: string[];
}

function columnOf(profile: WorkbookProfile, role: ColumnRole): string | null {
  return profile.columns.find((c) => c.role === role)?.letter ?? null;
}

/**
 * Converte o perfil no contrato de layout que o writer consome. Colunas com
 * formula entram em `forbiddenColumns` — e assim que o T-NOFORMULA passa a
 * valer para QUALQUER planilha, nao so para a Cantina Bom Prato.
 */
export function layoutFromProfile(profile: WorkbookProfile): SheetRowLayout {
  const d = DONA_MARI_LAYOUT.columns;
  const columns = {
    date: columnOf(profile, "data") ?? d.date,
    description: columnOf(profile, "descricao") ?? d.description,
    category: columnOf(profile, "categoria") ?? d.category,
    flow: columnOf(profile, "fluxo") ?? d.flow,
    entrada: columnOf(profile, "entrada") ?? d.entrada,
    saida: columnOf(profile, "saida") ?? d.saida,
    saldo: columnOf(profile, "saldo") ?? d.saldo,
  };
  const forbidden = new Set<string>(["A"]);
  for (const c of profile.columns) {
    if (c.hasFormula || c.role === "fluxo" || c.role === "saldo") forbidden.add(c.letter);
  }
  forbidden.add(columns.flow);
  forbidden.add(columns.saldo);
  const writable = [
    columns.date,
    columns.description,
    columns.category,
    columns.entrada,
    columns.saida,
  ].filter((c) => !forbidden.has(c));

  return {
    headerRow: profile.headerRow,
    firstDataRow: profile.firstDataRow,
    columns,
    forbiddenColumns: [...forbidden].sort(),
    writableColumns: writable,
    listColumns: profile.listColumns,
    dateOrder: profile.dateOrder,
    dateOrderBySheet: profile.dateOrderBySheet,
    // Só viajam para o writer as colunas calculadas que o estágio -1c aprovou
    // para repetição. "Proibido escrever valor" e "tem de repetir a fórmula"
    // convivem: a célula continua sendo da planilha, nunca recebe um número
    // nosso — recebe a mesma fórmula que as linhas de cima já tinham.
    formulaColumns: profile.formulaColumns,
  };
}

/** Perfil padrao (planilha gerada por nos / nenhuma base fornecida). */
export function defaultProfile(categories: string[] = []): WorkbookProfile {
  const c = DONA_MARI_LAYOUT.columns;
  const col = (
    letter: string,
    header: string,
    role: ColumnRole,
    kind: ProfiledColumn["kind"],
    recebe: string,
    hasFormula = false,
  ): ProfiledColumn => ({ letter, header, role, kind, samples: [], recebe, hasFormula });
  return {
    source: "padrao",
    sheetNames: [],
    monthSheets: [],
    supportSheets: [],
    headerRow: DONA_MARI_LAYOUT.headerRow,
    firstDataRow: DONA_MARI_LAYOUT.firstDataRow,
    categories,
    listColumns: [],
    formulaColumns: [],
    formulaColumnsPendentes: [],
    // Planilha nova nasce vazia: nao ha data gravada para ensinar ordem
    // nenhuma. `createWorkbook` grava de cima para baixo, entao o primeiro
    // extrato conciliado estabelece a ordem crescente naturalmente.
    dateOrder: "indefinida",
    dateOrderEvidence: {
      ordem: "indefinida",
      tendencia: null,
      amostra: 0,
      comparados: 0,
      crescentes: 0,
      decrescentes: 0,
      empates: 0,
      confianca: 0,
      conclusiva: false,
    },
    dateOrderBySheet: {},
    columns: [
      col(c.date, "Data", "data", "date", "a data do lancamento, dd/mm/aaaa"),
      col(
        c.description,
        "Descrição",
        "descricao",
        "text",
        "quem pagou/recebeu e o tipo do lancamento",
      ),
      col(c.category, "Categoria", "categoria", "text", "uma categoria da aba Categorias"),
      col(c.flow, "Fluxo de Caixa", "fluxo", "formula", "FORMULA — nunca escrever", true),
      col(c.entrada, "Entrada", "entrada", "money", "o valor quando e credito/recebimento"),
      col(c.saida, "Saída", "saida", "money", "o valor quando e debito/pagamento"),
      col(c.saldo, "Saldo", "saldo", "formula", "FORMULA — nunca escrever", true),
    ],
    descriptionStyle: {
      exemplos: [],
      caixa: "mista",
      separador: "|",
      tamanhoMedio: 0,
    },
    warnings: [],
  };
}

/**
 * Bloco de texto com o CONTRATO DE DESTINO, injetado no prompt dos proximos
 * agentes. E o que faz a extracao produzir campos no mesmo padrao do que ja
 * esta na planilha, em vez de um formato proprio.
 */
export function describeProfileForPrompt(profile: WorkbookProfile): string {
  const cols = profile.columns
    .filter((c) => c.role !== "ignorar")
    .map((c) => {
      const trava = c.hasFormula ? " [FORMULA — nao preencher]" : "";
      const amostra = c.samples.length ? ` | exemplos: ${c.samples.slice(0, 3).join(" ; ")}` : "";
      return `- ${c.letter} "${c.header}" (${c.role})${trava}: ${c.recebe}${amostra}`;
    })
    .join("\n");

  const style = profile.descriptionStyle;
  const estilo = [
    style.exemplos.length
      ? `- Como as descricoes JA gravadas estao escritas: ${style.exemplos.slice(0, 5).join(" ; ")}`
      : "",
    style.separador
      ? `- Separador usado entre contraparte e tipo: "${style.separador}"`
      : "- Sem separador fixo observado entre contraparte e tipo",
    `- Caixa predominante: ${style.caixa}`,
    style.tamanhoMedio
      ? `- Tamanho medio da descricao: ~${Math.round(style.tamanhoMedio)} caracteres`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "PLANILHA DE DESTINO (siga este padrao — os dados serao gravados nela):",
    cols,
    estilo,
    `- Ordem dos lancamentos na aba: ${describeDateOrder(profile.dateOrder)}`,
    profile.categories.length
      ? `- Categorias validas da planilha: ${profile.categories.join(" ; ")}`
      : "",
    describeListColumnsForPrompt(profile.listColumns),
    describeFormulaColumnsForPrompt(profile.formulaColumns),
  ]
    .filter(Boolean)
    .join("\n");
}
