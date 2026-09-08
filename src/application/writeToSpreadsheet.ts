import { SpreadsheetTarget } from "./ports";
import { HashedTransaction } from "./deduplicate";
import { SheetRow, SheetRowLayout } from "../domain/layout";
import { toExcelSerial, toBr } from "../domain/dateptbr";

/**
 * Converte transacoes novas em linhas de planilha, preenchendo APENAS
 * B (data), C (descricao), D (categoria = null no MVP), F (entrada), G (saida).
 * NUNCA gera valores para A, E, H (T-NOFORMULA / §12.0).
 */
export function toSheetRows(hashed: HashedTransaction[]): SheetRow[] {
  return hashed.map(({ tx }) => ({
    dateSerial: toExcelSerial(tx.date),
    dateText: toBr(tx.date), // o writer escolhe serial x texto pela convencao da aba
    description: tx.description,
    category: tx.category ?? null, // None no MVP (§3.1)
    entradaCents: tx.direction === "credit" ? tx.amount.cents : null,
    saidaCents: tx.direction === "debit" ? tx.amount.cents : null,
  }));
}

/**
 * WriteToSpreadsheet — orquestra a escrita numa aba via a porta SpreadsheetTarget.
 * A porta e responsavel por localizar a proxima linha vazia e preservar formulas.
 */
export async function writeToSpreadsheet(
  target: SpreadsheetTarget,
  sheet: string,
  hashed: HashedTransaction[],
  layout: SheetRowLayout,
) {
  const rows = toSheetRows(hashed);
  return target.appendRows(sheet, rows, layout);
}
