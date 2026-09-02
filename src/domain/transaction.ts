import { Money, Direction } from "./money";
import { PlainDate } from "./dateptbr";
import { Competence, competenceOf } from "./competence";
import { comparisonKey } from "./normalize";
import { sha256Hex } from "./sha256";

/** Referencia da conta de origem (banco). */
export interface AccountRef {
  id: string; // ex.: "stone-892952680"
  label: string; // ex.: "Stone - Conta 892952680"
}

/**
 * Transaction — entidade central. Correcao C2: dinheiro absoluto + direcao
 * separada (nunca um `amount` assinado unico), casando com as colunas
 * Entrada (F) e Saida (G) da planilha.
 */
export interface Transaction {
  date: PlainDate;
  description: string; // descricao normalizada (contraparte + metodo)
  direction: Direction; // Entrada | Saida
  amount: Money; // valor ABSOLUTO (>= 0)
  category?: string; // None no MVP (§3.1); preenchida na Fase 2
  account: AccountRef;
  balanceAfter?: Money; // saldo informado pelo extrato (ordenacao/validacao)
  sourceOrder: number; // posicao no arquivo -> desempatador de dedup (C4)
  rawLine: string; // rastreabilidade
}

export function competence(tx: Transaction): Competence {
  return competenceOf(tx.date);
}

/**
 * Calcula o hash de deduplicacao (C4 / §11). Inclui o `ordinalNoDia`, um
 * desempatador para transacoes legitimas identicas no mesmo dia (ex.: 3 Pix de
 * R$ 25,00 no dia 04/08 geram 3 hashes distintos e nao colapsam como duplicata).
 */
export function transactionHash(tx: Transaction, ordinalNoDia: number): string {
  const dateIso = `${tx.date.year}-${tx.date.month}-${tx.date.day}`;
  const payload = [
    dateIso,
    tx.direction,
    tx.amount.cents.toString(),
    comparisonKey(tx.description),
    tx.account.id,
    ordinalNoDia.toString(),
  ].join("|");
  return sha256Hex(payload);
}

/**
 * Atribui `ordinalNoDia` a cada transacao: para cada grupo (dia + direcao +
 * valor + descricao + conta), enumera 0,1,2... na ordem do arquivo. Assim
 * duplicatas legitimas recebem ordinais diferentes e hashes distintos.
 */
export function withDedupHashes(
  txs: Transaction[],
): { tx: Transaction; hash: string; ordinalNoDia: number }[] {
  const counters = new Map<string, number>();
  // ordena por sourceOrder para estabilidade
  const ordered = [...txs].sort((a, b) => a.sourceOrder - b.sourceOrder);
  return ordered.map((tx) => {
    const dayKey = [
      tx.date.year,
      tx.date.month,
      tx.date.day,
      tx.direction,
      tx.amount.cents,
      comparisonKey(tx.description),
      tx.account.id,
    ].join("|");
    const n = counters.get(dayKey) ?? 0;
    counters.set(dayKey, n + 1);
    return { tx, hash: transactionHash(tx, n), ordinalNoDia: n };
  });
}
