import { LedgerRepository, LedgerEntry } from "../../application/ports";
import { Competence, competenceKey } from "../../domain/competence";

/** LedgerRepository em memoria (demo web). No desktop e SQLite (rusqlite). */
export class MemoryLedger implements LedgerRepository {
  private byComp = new Map<string, Set<string>>();
  entries: LedgerEntry[] = [];

  async knownHashes(comp: Competence): Promise<Set<string>> {
    return this.byComp.get(competenceKey(comp)) ?? new Set();
  }

  async appendLedger(entries: LedgerEntry[]): Promise<void> {
    for (const e of entries) {
      const set = this.byComp.get(e.competenceKey) ?? new Set<string>();
      set.add(e.hash);
      this.byComp.set(e.competenceKey, set);
      this.entries.push(e);
    }
  }
}
