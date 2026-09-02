/**
 * Normalizacao de descricao (regra de negocio testavel isoladamente).
 * - trim + colapso de espacos
 * - remove quebras de linha herdadas do PDF
 * - junta contraparte multi-linha (correcao C8/§7.1)
 */
export function normalizeDescription(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(" ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Chave de comparacao: uppercase, sem acento, espacos colapsados. */
export function comparisonKey(desc: string): string {
  return desc
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sufixos societarios: presentes ou ausentes, nao mudam QUEM e a contraparte.
 * O extrato as vezes traz "FULANO COMERCIO LTDA", as vezes "FULANO COMERCIO".
 */
const SUFIXOS_SOCIETARIOS = new Set([
  "LTDA",
  "LTDA ME",
  "ME",
  "MEI",
  "EPP",
  "EIRELI",
  "SA",
  "S A",
  "CIA",
  "EI",
  "SS",
]);

/** Separadores usados entre a contraparte e o tipo do lancamento. */
const SEPARADORES = /\s*(?:\||•|\s-\s|\s\/\s)\s*/;

/**
 * Chave da CONTRAPARTE — quem pagou/recebeu, sem o tipo do lancamento e sem
 * sufixo societario.
 *
 * "FULANO COMERCIO LTDA | Pix"        -> "FULANO COMERCIO"
 * "FULANO COMERCIO | Transferência"   -> "FULANO COMERCIO"
 * "Fulano Comercio"                   -> "FULANO COMERCIO"
 *
 * Serve para reconhecer que a MESMA transacao, relida, voltou com a descricao
 * escrita de outro jeito — sem nunca confundir duas pessoas diferentes, porque
 * a comparacao continua sendo de IGUALDADE, nao de parecenca.
 */
export function counterpartyKey(desc: string): string {
  const head = comparisonKey(desc).split(SEPARADORES)[0] ?? "";
  const tokens = head
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  while (tokens.length > 1 && SUFIXOS_SOCIETARIOS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * Duas descricoes apontam para a MESMA contraparte?
 *
 * ATENCAO ao papel disto: NAO e o criterio de duplicata. A identidade de um
 * lancamento e data + valor + direcao + ordem (ver `deduplicate.ts`); o nome nao
 * decide se algo entra ou nao.
 *
 * Esta funcao serve para ESCOLHER, dentro de um balde com varios candidatos,
 * qual linha existente parear com qual lancamento. Isso mantem o pareamento
 * correto quando o extrato e a planilha estao em ordens diferentes e evita
 * alarme falso no relatorio de "nome divergente".
 *
 * A comparacao e por IGUALDADE da chave de contraparte (sem sufixo societario,
 * sem o tipo do lancamento), nunca por parecenca — parecenca aqui so trocaria
 * um pareamento certo por um errado.
 */
export function sameCounterparty(a: string, b: string): boolean {
  const ka = counterpartyKey(a);
  const kb = counterpartyKey(b);
  if (!ka || !kb) return false;
  return ka === kb;
}
