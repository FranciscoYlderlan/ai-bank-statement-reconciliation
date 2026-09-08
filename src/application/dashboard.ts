import { Transaction } from "../domain/transaction";
import { competence } from "../domain/transaction";
import { competenceKey, monthSheetName } from "../domain/competence";

export interface MonthlyBalance {
  competenceKey: string; // "2026-07"
  label: string; // "JULHO"
  entradaCents: number;
  saidaCents: number;
  netCents: number; // entrada - saida
  cumulativeCents: number; // saldo acumulado
  count: number;
}

export interface Dashboard {
  months: MonthlyBalance[];
  totalEntradaCents: number;
  totalSaidaCents: number;
  totalNetCents: number;
  count: number;
}

/**
 * Constroi o balanco mensal a partir de um conjunto de transacoes. Puro e
 * testavel; alimenta o dashboard visual (§18). Dinheiro em centavos (T-MONEY).
 */
export function buildDashboard(txs: Transaction[]): Dashboard {
  const map = new Map<string, MonthlyBalance>();
  for (const tx of txs) {
    const key = competenceKey(competence(tx));
    const mb =
      map.get(key) ??
      ({
        competenceKey: key,
        label: monthSheetName(competence(tx)),
        entradaCents: 0,
        saidaCents: 0,
        netCents: 0,
        cumulativeCents: 0,
        count: 0,
      } as MonthlyBalance);
    if (tx.direction === "credit") mb.entradaCents += tx.amount.cents;
    else mb.saidaCents += tx.amount.cents;
    mb.count++;
    map.set(key, mb);
  }
  const months = [...map.values()].sort((a, b) => a.competenceKey.localeCompare(b.competenceKey));
  let running = 0;
  for (const m of months) {
    m.netCents = m.entradaCents - m.saidaCents;
    running += m.netCents;
    m.cumulativeCents = running;
  }
  return {
    months,
    totalEntradaCents: months.reduce((a, m) => a + m.entradaCents, 0),
    totalSaidaCents: months.reduce((a, m) => a + m.saidaCents, 0),
    totalNetCents: months.reduce((a, m) => a + m.netCents, 0),
    count: txs.length,
  };
}
