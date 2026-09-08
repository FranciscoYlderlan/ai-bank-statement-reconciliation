import { Transaction, competence } from "../domain/transaction";
import { Competence, competenceKey, monthSheetName } from "../domain/competence";

export interface CompetencePartition {
  competence: Competence;
  key: string; // "2026-07"
  targetSheet: string; // "JULHO"
  transactions: Transaction[];
}

/**
 * PartitionByCompetence (§10) — substitui a nocao de "o mes do arquivo".
 * Um arquivo pode conter varias competencias; cada uma vai para a aba do seu mes.
 */
export function partitionByCompetence(txs: Transaction[]): CompetencePartition[] {
  const groups = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const key = competenceKey(competence(tx));
    const arr = groups.get(key) ?? [];
    arr.push(tx);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, transactions]) => {
      const comp = competence(transactions[0]);
      return { competence: comp, key, targetSheet: monthSheetName(comp), transactions };
    });
}
