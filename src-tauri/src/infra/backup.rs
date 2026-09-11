//! Backup imutavel (§13 / T-BACKUP): copia o .xlsx para `backups/` com
//! timestamp, ANTES de qualquer escrita. Nunca sobrescreve um backup existente.
use std::fs;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

pub fn backup_file(source: &Path) -> Result<PathBuf, String> {
    if !source.exists() {
        return Err(format!("arquivo inexistente: {}", source.display()));
    }
    let dir = source.parent().unwrap_or(Path::new(".")).join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let now = OffsetDateTime::now_utc();
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("planilha");
    let ts = format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let dest = dir.join(format!("{stem}_backup_{ts}.xlsx"));
    if dest.exists() {
        return Err("backup ja existe (imutavel)".into());
    }
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}
