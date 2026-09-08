import {
  RawStatement,
  StatementParser,
  SpreadsheetTarget,
  LedgerRepository,
  BackupService,
  Clock,
} from "./ports";
import { competenceOf } from "../domain/competence";
import { SheetRowLayout } from "../domain/layout";
import { partitionByCompetence } from "./partitionByCompetence";
import { deduplicate } from "./deduplicate";
import { writeToSpreadsheet, toSheetRows } from "./writeToSpreadsheet";
import { ImportReport, CompetenceReport, summarizeTotals, totalsOf } from "./report";
import { isSupportSheet } from "../domain/competence";

export interface ImportDeps {
  parser: StatementParser;
  local?: SpreadsheetTarget; // XLSX local
  sheets?: SpreadsheetTarget; // Google Sheets (opcional)
  ledger: LedgerRepository;
  backup?: BackupService;
  clock: Clock;
  layout: SheetRowLayout;
  localFileId?: string;
}

export interface ImportOptions {
  /** se true, apenas simula (dry-run) sem escrever nem fazer backup */
  dryRun?: boolean;
}

/**
 * ImportStatement (orquestrador §1). Fluxo:
 *  1. extrai transacoes (parser injetado)
 *  2. particiona por competencia (§10)
 *  3. por competencia: dedup contra ledger + aba real (fonte de verdade)
 *  4. BACKUP imutavel antes de qualquer escrita (T-BACKUP)
 *  5. escreve local e Sheets de forma INDEPENDENTE (T-INDEP)
 *  6. registra ledger e monta relatorio por competencia
 */
export async function importStatement(
  raw: RawStatement,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const startedAt = deps.clock.now().toISOString();
  const txs = await deps.parser.parse(raw);
  const partitions = partitionByCompetence(txs);

  // nomes de aba disponiveis (para detectar aba inexistente)
  const localSheetNames = deps.local ? await deps.local.sheetNames() : [];

  // BACKUP antes de escrever qualquer coisa
  let backupPath: string | undefined;
  const willWrite = !opts.dryRun && partitions.length > 0;
  if (willWrite && deps.backup && deps.localFileId) {
    backupPath = await deps.backup.backup(deps.localFileId);
  }

  const competences: CompetenceReport[] = [];
  let localError: string | undefined;
  let sheetsError: string | undefined;

  for (const part of partitions) {
    const sheetExists =
      localSheetNames.length === 0 || localSheetNames.includes(part.targetSheet);

    // fonte de verdade: le a aba real (se existir) + ledger local
    const known = await deps.ledger.knownHashes(part.competence);
    let existing = [] as Awaited<ReturnType<SpreadsheetTarget["readExisting"]>>;
    if (deps.local && sheetExists && !isSupportSheet(part.targetSheet)) {
      try {
        existing = await deps.local.readExisting(part.targetSheet, deps.layout);
      } catch {
        existing = [];
      }
    }

    const dd = deduplicate(part.transactions, known, existing);
    const t = totalsOf(dd.novos.map((n) => n.tx));

    const report: CompetenceReport = {
      competenceKey: part.key,
      targetSheet: part.targetSheet,
      sheetExists,
      novos: dd.novos.map((n) => n.tx),
      duplicados: dd.duplicados.length,
      duplicadosNomeDivergente: dd.duplicadosNomeDivergente,
      inconsistencias: dd.inconsistencias,
      avisos: [],
      writtenToLocal: false,
      writtenToSheets: false,
      totalEntradaCents: t.entrada,
      totalSaidaCents: t.saida,
    };

    if (!sheetExists) {
      report.inconsistencias.push({
        tx: part.transactions[0],
        motivo: `aba inexistente para competencia ${part.key} (esperada: ${part.targetSheet})`,
      });
    }

    if (!opts.dryRun && sheetExists && dd.novos.length > 0) {
      // escrita LOCAL (independente)
      if (deps.local) {
        try {
          const outcome = await writeToSpreadsheet(
            deps.local,
            part.targetSheet,
            dd.novos,
            deps.layout,
          );
          report.avisos.push(...(outcome.warnings ?? []));
          report.writtenToLocal = true;
        } catch (e) {
          localError = (e as Error).message;
        }
      }
      // escrita SHEETS (independente — se local falhar, ainda tenta)
      if (deps.sheets) {
        try {
          await writeToSpreadsheet(deps.sheets, part.targetSheet, dd.novos, deps.layout);
          report.writtenToSheets = true;
        } catch (e) {
          sheetsError = (e as Error).message;
        }
      }
      // registra ledger (cache/historico)
      await deps.ledger.appendLedger(
        dd.novos.map((n) => ({
          competenceKey: part.key,
          hash: n.hash,
          dateIso: `${n.tx.date.year}-${String(n.tx.date.month).padStart(2, "0")}-${String(
            n.tx.date.day,
          ).padStart(2, "0")}`,
          description: n.tx.description,
          direction: n.tx.direction,
          amountCents: n.tx.amount.cents,
          category: n.tx.category ?? null,
          account: n.tx.account.id,
        })),
      );
    }

    competences.push(report);
  }

  return {
    sourceFile: raw.fileName,
    strategy: deps.parser.id,
    startedAt,
    finishedAt: deps.clock.now().toISOString(),
    competences,
    totals: summarizeTotals(competences),
    localError,
    sheetsError,
    backupPath,
  };
}

export { toSheetRows, competenceOf };
