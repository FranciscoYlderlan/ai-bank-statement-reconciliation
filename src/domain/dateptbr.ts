/** Data pura (sem fuso), representada por ano/mes/dia. */
export interface PlainDate {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

/**
 * Faz o parse de datas pt-BR:
 *   "07/08/26"   -> {2026, 8, 7}  (assume seculo 20xx)
 *   "17/07/2026" -> {2026, 7, 17}
 * Valida faixas basicas de mes/dia.
 */
export function parseDatePtBr(raw: string): PlainDate {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!m) throw new Error(`Data invalida (esperado dd/mm/aa ou dd/mm/aaaa): "${raw}"`);
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (m[3].length === 2) year = 2000 + year; // seculo 20xx
  if (month < 1 || month > 12) throw new Error(`Mes fora da faixa: "${raw}"`);
  if (day < 1 || day > 31) throw new Error(`Dia fora da faixa: "${raw}"`);
  return { year, month, day };
}

/** ISO curto para logs/ordenacao: "2026-08-07" */
export function toIso(d: PlainDate): string {
  return `${d.year.toString().padStart(4, "0")}-${d.month
    .toString()
    .padStart(2, "0")}-${d.day.toString().padStart(2, "0")}`;
}

/** dd/mm/aaaa para exibir/gravar. */
export function toBr(d: PlainDate): string {
  return `${d.day.toString().padStart(2, "0")}/${d.month
    .toString()
    .padStart(2, "0")}/${d.year}`;
}

/** Numero de serie do Excel (epoca 1899-12-30). Usado ao gravar na coluna Data. */
export function toExcelSerial(d: PlainDate): number {
  const utc = Date.UTC(d.year, d.month - 1, d.day);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86400000);
}

/** true se `d` estiver dentro do intervalo [start, end] inclusive. */
export function withinRange(d: PlainDate, start: PlainDate, end: PlainDate): boolean {
  const v = toIso(d);
  return v >= toIso(start) && v <= toIso(end);
}
