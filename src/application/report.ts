import { Transaction } from "../domain/transaction";
import { Money } from "../domain/money";

export interface CompetenceReport {
  competenceKey: string; // "2026-07"
  targetSheet: string; // "JULHO"
  sheetExists: boolean;
  novos: Transaction[];
  duplicados: number;
  /**
   * Subconjunto de `duplicados` casado por data+valor+direcao com o nome
   * divergente. Não bloqueia nada — é o ponto cego da regra de identidade,
   * exposto para auditoria.
   */
  duplicadosNomeDivergente: { tx: Transaction; naPlanilha: string }[];
  inconsistencias: { tx: Transaction; motivo: string }[];
  /** observacoes da escrita (nao sao erro; ver AppendOutcome.warnings). */
  avisos: string[];
  writtenToLocal: boolean;
  writtenToSheets: boolean;
  totalEntradaCents: number;
  totalSaidaCents: number;
}

export interface ImportReport {
  sourceFile: string;
  strategy: string;
  startedAt: string;
  finishedAt: string;
  competences: CompetenceReport[];
  totals: {
    novos: number;
    duplicados: number;
    duplicadosNomeDivergente: number;
    inconsistencias: number;
  };
  localError?: string;
  sheetsError?: string;
  backupPath?: string;
}

export function summarizeTotals(comps: CompetenceReport[]) {
  return {
    novos: comps.reduce((a, c) => a + c.novos.length, 0),
    duplicados: comps.reduce((a, c) => a + c.duplicados, 0),
    duplicadosNomeDivergente: comps.reduce((a, c) => a + c.duplicadosNomeDivergente.length, 0),
    inconsistencias: comps.reduce((a, c) => a + c.inconsistencias.length, 0),
  };
}

/** Soma entradas e saidas de um conjunto (dinheiro em centavos — T-MONEY). */
export function totalsOf(txs: Transaction[]): { entrada: number; saida: number } {
  let entrada = 0;
  let saida = 0;
  for (const t of txs) {
    if (t.direction === "credit") entrada += t.amount.cents;
    else saida += t.amount.cents;
  }
  return { entrada, saida };
}

export function formatCents(cents: number): string {
  return Money.fromCents(cents).format();
}
