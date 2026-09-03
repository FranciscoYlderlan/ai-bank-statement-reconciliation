/**
 * Contrato de Layout da aba de mes (§12.0) — a fonte da verdade estrutural,
 * codificada a partir dos arquivos reais da Cantina Bom Prato. Dirige a escrita e os
 * testes de preservacao (T-PRES / T-NOFORMULA).
 */
import { ListColumnRule } from "./listColumns";
import { FormulaColumnRule } from "./formulaColumns";
import { DateOrder, DateOrderEvidence } from "./dateOrder";

export interface SheetRowLayout {
  headerRow: number; // linha do cabecalho
  firstDataRow: number; // primeira linha de dados
  columns: {
    date: string; // B
    description: string; // C
    category: string; // D
    flow: string; // E (FORMULA - nao escrever)
    entrada: string; // F
    saida: string; // G
    saldo: string; // H (FORMULA - nao escrever)
  };
  /** Colunas que o writer JAMAIS pode tocar. */
  forbiddenColumns: string[];
  /** Colunas de dados que o writer PODE preencher. */
  writableColumns: string[];
  /**
   * Colunas preenchidas por LISTAGEM (dropdown), com as opcoes na grafia exata
   * da planilha. O writer usa para garantir que o valor gravado e literalmente
   * um item da lista — e o dropdown e o VLOOKUP dependem disso.
   */
  listColumns?: ListColumnRule[];
  /**
   * Colunas CALCULADAS a repetir em toda linha nova. Sem elas a linha inserida
   * nasce sem `Fluxo de Caixa` e sem `Saldo` — que e como a fórmula "some" aos
   * olhos de quem abre a planilha depois.
   */
  formulaColumns?: FormulaColumnRule[];
  /**
   * ORDEM DAS DATAS da planilha, vinda da analise. O writer usa para decidir
   * ONDE cada linha nova entra — no topo (aba decrescente), no fim (crescente)
   * ou no meio (data intermediaria). Ausente ou "indefinida" mantem o
   * comportamento historico: tudo no fim, na ordem em que veio.
   */
  dateOrder?: DateOrder;
  /** a leitura por aba; quando a aba de destino tem opiniao propria, ela vence. */
  dateOrderBySheet?: Record<string, DateOrderEvidence>;
}

/** Layout observado na planilha real Cantina Bom Prato (todas as abas de mes). */
export const DONA_MARI_LAYOUT: SheetRowLayout = {
  headerRow: 12,
  firstDataRow: 13,
  columns: {
    date: "B",
    description: "C",
    category: "D",
    flow: "E",
    entrada: "F",
    saida: "G",
    saldo: "H",
  },
  forbiddenColumns: ["A", "E", "H"],
  writableColumns: ["B", "C", "D", "F", "G"],
  // As duas listas nascem vazias e sao preenchidas pelo perfil a partir do
  // arquivo real: e do .xlsx do usuario que saem o dropdown da coluna de
  // categoria e as formulas de E/H, nunca deste literal.
  listColumns: [],
  formulaColumns: [],
  dateOrder: "indefinida",
  dateOrderBySheet: {},
};

/** Cabecalho esperado (validacao do contrato de layout no onboarding). */
export const EXPECTED_HEADER = [
  "Data",
  "Descrição",
  "Categoria",
  "Fluxo de Caixa",
  "Entrada",
  "Saída",
  "Saldo",
];

/**
 * Uma linha pronta para escrita (apenas colunas de dados).
 *
 * A data viaja nas DUAS formas de proposito. Qual delas vai para a celula e
 * decisao do writer, que olha como a coluna daquela aba ja guarda data: se as
 * linhas existentes usam serial com formato de data, grava `dateSerial`; se
 * usam texto (o caso da planilha real), grava `dateText`. Gravar serial numa
 * celula sem formato de data faz o usuario ver "46169" no lugar de 27/05/2026.
 */
export interface SheetRow {
  dateSerial: number; // B — numero de serie Excel
  dateText: string; // B — mesma data em dd/mm/aaaa
  description: string; // C
  category: string | null; // D (vazia quando a IA nao tem certeza)
  entradaCents: number | null; // F
  saidaCents: number | null; // G
}
