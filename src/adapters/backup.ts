import { BackupService, Clock } from "../application/ports";

/**
 * Backup imutavel em memoria (para o demo web e testes). No desktop (Tauri) a
 * implementacao equivalente copia o arquivo para `backups/` no disco.
 * Invariante (§13 / T-BACKUP): o backup e criado ANTES de qualquer escrita.
 */
export class InMemoryBackup implements BackupService {
  snapshots = new Map<string, { at: string; bytes: Uint8Array }>();
  constructor(
    private readonly clock: Clock,
    private readonly source: () => Uint8Array,
  ) {}
  async backup(fileId: string): Promise<string> {
    const at = this.clock.now().toISOString().replace(/[:.]/g, "-");
    const label = `backups/${fileId}_backup_${at}.xlsx`;
    this.snapshots.set(label, { at, bytes: this.source() });
    return label;
  }
}

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}
