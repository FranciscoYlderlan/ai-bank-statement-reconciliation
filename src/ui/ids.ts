/**
 * Identificadores e relogio ficam AQUI, na borda, e nao no dominio.
 *
 * `domain/ruleSet.ts` recebe `id` e `agora` de fora justamente para continuar
 * puro e determinista no teste — a mesma disciplina da porta `Clock`. Este
 * arquivo e o unico lugar do lado das regras que fala com o mundo real.
 */

/** Id estavel e unico para uma carteira ou uma regra. */
export function novoId(prefixo: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const base =
    typeof c?.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefixo}-${base}`;
}

export function agoraIso(): string {
  return new Date().toISOString();
}
