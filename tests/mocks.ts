import {
  SpreadsheetTarget,
  LedgerRepository,
  BackupService,
  Clock,
  AppendOutcome,
  LedgerEntry,
  StatementParser,
  RawStatement,
} from "../src/application/ports";
import { SheetRow, SheetRowLayout } from "../src/domain/layout";
import { Transaction } from "../src/domain/transaction";
import { Competence, competenceKey, monthSheetName } from "../src/domain/competence";

const MONTHS = Array.from({ length: 12 }, (_, i) => monthSheetName({ year: 2026, month: i + 1 }));

/** SpreadsheetTarget em memoria que registra o que foi escrito e onde. */
export class MockSpreadsheet implements SpreadsheetTarget {
  appended: { sheet: string; rows: SheetRow[] }[] = [];
  failOnAppend = false;
  timeline?: string[];
  constructor(private readonly names: string[] = [...MONTHS, "Categorias"]) {}
  async sheetNames() {
    return this.names;
  }
  async readExisting(): Promise<Transaction[]> {
    return [];
  }
  async appendRows(sheet: string, rows: SheetRow[], _layout: SheetRowLayout): Promise<AppendOutcome> {
    if (this.failOnAppend) throw new Error("falha simulada de escrita");
    this.timeline?.push("append");
    this.appended.push({ sheet, rows });
    return { sheet, appended: rows.length, firstRow: 13, lastRow: 12 + rows.length };
  }
  allRows(): SheetRow[] {
    return this.appended.flatMap((a) => a.rows);
  }
}

/** Ledger em memoria: guarda hashes por competencia. */
export class MemoryLedger implements LedgerRepository {
  store = new Map<string, Set<string>>();
  appendCalls = 0;
  async knownHashes(comp: Competence): Promise<Set<string>> {
    return this.store.get(competenceKey(comp)) ?? new Set();
  }
  async appendLedger(entries: LedgerEntry[]): Promise<void> {
    this.appendCalls++;
    for (const e of entries) {
      const set = this.store.get(e.competenceKey) ?? new Set<string>();
      set.add(e.hash);
      this.store.set(e.competenceKey, set);
    }
  }
}

/** Backup que registra a ordem em que foi chamado. */
export class RecordingBackup implements BackupService {
  calls: string[] = [];
  timeline: string[];
  constructor(timeline: string[]) {
    this.timeline = timeline;
  }
  async backup(fileId: string): Promise<string> {
    this.calls.push(fileId);
    this.timeline.push("backup");
    return `backups/${fileId}_backup.xlsx`;
  }
}

export class FixedClock implements Clock {
  constructor(private readonly d = new Date("2026-08-14T12:00:00Z")) {}
  now() {
    return this.d;
  }
}

/** Parser que devolve transacoes pre-definidas (injeta o resultado do parsing). */
export class StubParser implements StatementParser {
  readonly id = "stub";
  constructor(private readonly txs: Transaction[]) {}
  canParse() {
    return true;
  }
  async parse(_raw: RawStatement): Promise<Transaction[]> {
    return this.txs;
  }
}
