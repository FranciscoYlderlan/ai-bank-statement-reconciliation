import { PlainDate } from "./dateptbr";

/**
 * Competencia = mes/ano ao qual a transacao pertence (pela sua propria data),
 * independente da data de emissao do extrato. Correcao C5 da especificacao:
 * um arquivo pode conter varias competencias.
 */
export interface Competence {
  year: number;
  month: number; // 1..12
}

export function competenceOf(date: PlainDate): Competence {
  return { year: date.year, month: date.month };
}

export function competenceKey(c: Competence): string {
  return `${c.year}-${c.month.toString().padStart(2, "0")}`; // "2026-07"
}

export function competenceEquals(a: Competence, b: Competence): boolean {
  return a.year === b.year && a.month === b.month;
}

const MESES_PT = [
  "JANEIRO",
  "FEVEREIRO",
  "MARÇO",
  "ABRIL",
  "MAIO",
  "JUNHO",
  "JULHO",
  "AGOSTO",
  "SETEMBRO",
  "OUTUBRO",
  "NOVEMBRO",
  "DEZEMBRO",
];

/**
 * MonthSheetResolver — mapeia o numero do mes para o nome da aba em PT-BR
 * maiusculo (correcao C1: as abas sao "JANEIRO".."DEZEMBRO", nao "MM-AAAA").
 */
export function monthSheetName(c: Competence): string {
  if (c.month < 1 || c.month > 12) throw new Error(`Mes invalido: ${c.month}`);
  return MESES_PT[c.month - 1];
}

/** Abas de apoio que NUNCA devem receber escrita. */
export const SUPPORT_SHEETS = [
  "Categorias",
  "FLUXO DE CAIXA  SIMPLIFICADO",
  "ANÁLISE",
];

export function isSupportSheet(name: string): boolean {
  return SUPPORT_SHEETS.some(
    (s) => s.replace(/\s+/g, " ").toUpperCase() === name.replace(/\s+/g, " ").toUpperCase(),
  );
}
