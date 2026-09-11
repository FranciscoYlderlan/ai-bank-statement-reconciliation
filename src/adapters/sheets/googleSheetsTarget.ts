import {
  SpreadsheetTarget,
  AppendOutcome,
} from "../../application/ports";
import { SheetRow, SheetRowLayout } from "../../domain/layout";
import { Transaction } from "../../domain/transaction";
import { Money, parseMoneyPtBr } from "../../domain/money";
import { parseDatePtBr } from "../../domain/dateptbr";
import { invokeTauri } from "../tauri/invoke";

/** Linha traduzida para valores do Google Sheets (o Rust monta os ranges B..G). */
interface SheetValueRow {
  date: string; // dd/mm/aaaa (USER_ENTERED -> o Sheets interpreta como data)
  description: string;
  category: string | null;
  entrada: number | null; // reais
  saida: number | null; // reais
}

/** Converte serial do Excel (epoca 1899-12-30) de volta para dd/mm/aaaa. */
function serialToBr(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

const PLACEHOLDER_ACCOUNT = { id: "google-sheet", label: "Google Sheets" };

/**
 * GoogleSheetsTarget — implementa a MESMA port SpreadsheetTarget do XLSX local.
 * A escrita respeita o contrato de layout: so B,C,D,F,G, nunca A,E,H (as
 * formulas de E/H ficam intactas). A conversao de dominio (serial de data,
 * centavos->reais) acontece aqui; o Rust so faz o HTTP com a API do Sheets.
 *
 * NOTA: requer conta Google conectada e OAuth validado on-device.
 */
export class GoogleSheetsTarget implements SpreadsheetTarget {
  constructor(private readonly spreadsheetId: string) {}

  async sheetNames(): Promise<string[]> {
    // Nao bloqueia por aba inexistente — o contrato de layout e validado a parte.
    return [];
  }

  async readExisting(sheet: string, _layout: SheetRowLayout): Promise<Transaction[]> {
    const rows = await invokeTauri<string[][]>("sheets_read_existing", {
      spreadsheetId: this.spreadsheetId,
      sheet,
    });
    const out: Transaction[] = [];
    rows.forEach((r, i) => {
      // r = [B data, C desc, D cat, E fluxo, F entrada, G saida]
      const dateStr = (r[0] ?? "").trim();
      const desc = (r[1] ?? "").trim();
      const entrada = (r[4] ?? "").trim();
      const saida = (r[5] ?? "").trim();
      if (!dateStr || !desc || (!entrada && !saida)) return;
      try {
        const date = parseDatePtBr(dateStr);
        const isEntrada = entrada !== "";
        const money = parseMoneyPtBr(isEntrada ? entrada : saida).money;
        out.push({
          date,
          description: desc,
          direction: isEntrada ? "credit" : "debit",
          amount: money,
          account: PLACEHOLDER_ACCOUNT,
          sourceOrder: i,
          rawLine: "",
        });
      } catch {
        /* linha ilegivel (formato de data/valor inesperado): ignora no dedup */
      }
    });
    return out;
  }

  async appendRows(
    sheet: string,
    rows: SheetRow[],
    _layout: SheetRowLayout,
  ): Promise<AppendOutcome> {
    const values: SheetValueRow[] = rows.map((r) => ({
      date: serialToBr(r.dateSerial),
      description: r.description,
      category: r.category,
      entrada: r.entradaCents !== null ? r.entradaCents / 100 : null,
      saida: r.saidaCents !== null ? r.saidaCents / 100 : null,
    }));
    return invokeTauri<AppendOutcome>("sheets_append_rows", {
      spreadsheetId: this.spreadsheetId,
      sheet,
      rows: values,
    });
  }
}

/** Extrai o ID da planilha de uma URL do Google Sheets (ou aceita o ID cru). */
export function sheetIdFromLink(link: string): string | null {
  const m = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(link.trim())) return link.trim();
  return null;
}
