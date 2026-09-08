import { Transaction, withDedupHashes } from "../domain/transaction";
import { comparisonKey, sameCounterparty } from "../domain/normalize";

export interface HashedTransaction {
  tx: Transaction;
  hash: string;
  ordinalNoDia: number;
}

/** Uma duplicata aceita por valor/data/direcao, mas com nome divergente. */
export interface NameMismatch {
  tx: Transaction;
  /** descricao da linha que ja estava na planilha e absorveu este lancamento. */
  naPlanilha: string;
}

export interface DeduplicationResult {
  /** transacoes novas a inserir */
  novos: HashedTransaction[];
  /** ja existentes (hash conhecido OU ja gravadas na aba) — ignoradas */
  duplicados: HashedTransaction[];
  /**
   * Duplicatas casadas por data+valor+direcao cujo NOME nao bateu. Nao impedem
   * nada — sao um subconjunto de `duplicados`, exposto no relatorio para o
   * usuario poder auditar o unico ponto cego da regra (ver `matchAgainstExisting`).
   */
  duplicadosNomeDivergente: NameMismatch[];
  /** reservado para divergencias que impedem a escrita (aba inexistente etc.) */
  inconsistencias: { tx: Transaction; motivo: string }[];
}

/** Uma linha ja existente na aba, disponivel para casar com um lancamento novo. */
interface ExistingSlot {
  key: string; // comparisonKey da descricao
  description: string;
  used: boolean;
}

/**
 * Chave de balde: mesma data + mesmo valor (ao centavo) + mesma direcao.
 * É a identidade de uma transacao para efeito de conciliacao.
 */
function bucketKey(tx: Transaction): string {
  return `${tx.date.year}-${tx.date.month}-${tx.date.day}|${tx.amount.cents}|${tx.direction}`;
}

function buildPool(existing: Transaction[]): Map<string, ExistingSlot[]> {
  const pool = new Map<string, ExistingSlot[]>();
  for (const e of existing) {
    const k = bucketKey(e);
    const slots = pool.get(k) ?? [];
    slots.push({ key: comparisonKey(e.description), description: e.description, used: false });
    pool.set(k, slots);
  }
  return pool;
}

type MatchVerdict =
  | { kind: "duplicate"; naPlanilha: string; nomeDivergente: boolean }
  | { kind: "new" };

/**
 * Casa UM lancamento contra o que ja esta na aba.
 *
 * IDENTIDADE = DATA + VALOR (ao centavo) + DIRECAO + ORDEM.
 * O nome NAO entra na decisao. Dois lancamentos do mesmo dia, do mesmo centavo
 * e no mesmo sentido sao o mesmo lancamento — a chance de dois pagamentos
 * distintos coincidirem ate o centavo, no mesmo dia e no mesmo sentido, e
 * pequena perto da chance de o nome voltar escrito diferente de uma leitura
 * para outra (abreviado, com/sem sufixo, com/sem o tipo, com erro de OCR).
 * Era o nome que fazia duplicata escapar.
 *
 * O que protege contra fusao indevida e a CONTAGEM, nao o nome: cada linha
 * existente absorve no maximo UM lancamento. Aba com 2 Pix de R$ 25,00 no dia
 * 04/08 + extrato com 3 = 2 duplicados + 1 novo. Se o extrato traz Maria E Ana,
 * ambas de R$ 25,00 no mesmo dia, e a aba so tem uma delas, a segunda entra —
 * porque sobrou lancamento sem slot livre, independentemente de quem e quem.
 *
 * PONTO CEGO CONHECIDO: se a aba tiver um lancamento de R$ 25,00 em 04/08 que
 * NAO esta neste extrato (lancado a mao, ou vindo de outra conta) e o extrato
 * trouxer outro de R$ 25,00 em 04/08, o novo e absorvido pelo antigo. Por isso
 * esses casos sao devolvidos em `duplicadosNomeDivergente` e aparecem no
 * relatorio: a regra decide sozinha, mas nao decide as escondidas.
 *
 * O nome ainda serve para ESCOLHER qual slot consumir (casa primeiro o que tem
 * a mesma descricao), o que mantem o pareamento correto quando o extrato e a
 * aba estao em ordens diferentes e reduz alarme falso no relatorio.
 */
function matchAgainstExisting(pool: Map<string, ExistingSlot[]>, tx: Transaction): MatchVerdict {
  const slots = pool.get(bucketKey(tx));
  if (!slots) return { kind: "new" };
  const key = comparisonKey(tx.description);

  // preferencia 1 — descricao identica
  let slot = slots.find((s) => !s.used && s.key === key);
  // preferencia 2 — mesma contraparte escrita de outro jeito
  if (!slot) slot = slots.find((s) => !s.used && sameCounterparty(tx.description, s.description));
  // preferencia 3 — qualquer slot livre do balde: data+valor+direcao ja bastam
  const nomeDivergente = !slot;
  if (!slot) slot = slots.find((s) => !s.used);

  if (!slot) return { kind: "new" }; // baldes esgotados => lancamento a mais, e novo
  slot.used = true;
  return { kind: "duplicate", naPlanilha: slot.description, nomeDivergente };
}

/**
 * Deduplicate (§11). Duas fontes de verdade, nesta ordem:
 *
 *  1. `knownHashes` — o ledger local (historico de importacoes desta sessao).
 *  2. `existing`    — as linhas que JA estao na aba de destino.
 *
 * A fonte (2) e a que importa quando o usuario traz a planilha dele: o ledger
 * nasce vazio a cada execucao, entao sem olhar a aba o mesmo extrato seria
 * gravado de novo a cada importacao.
 *
 * Idempotencia: reimportar o mesmo arquivo produz 0 novos.
 */
export function deduplicate(
  txs: Transaction[],
  knownHashes: Set<string>,
  existing: Transaction[] = [],
): DeduplicationResult {
  const hashed = withDedupHashes(txs);
  const pool = buildPool(existing);

  const novos: HashedTransaction[] = [];
  const duplicados: HashedTransaction[] = [];
  const duplicadosNomeDivergente: NameMismatch[] = [];
  const inconsistencias: { tx: Transaction; motivo: string }[] = [];

  for (const h of hashed) {
    if (knownHashes.has(h.hash)) {
      duplicados.push(h);
      continue;
    }
    const verdict = matchAgainstExisting(pool, h.tx);
    if (verdict.kind === "duplicate") {
      duplicados.push(h);
      if (verdict.nomeDivergente) {
        duplicadosNomeDivergente.push({ tx: h.tx, naPlanilha: verdict.naPlanilha });
      }
      continue;
    }
    novos.push(h);
  }

  return { novos, duplicados, duplicadosNomeDivergente, inconsistencias };
}
