import { AccountRef } from "./transaction";

/**
 * IDENTIDADE DA CONTA — de onde saiu o extrato.
 *
 * Fica no dominio, e nao em um adapter, porque o `id` entra no hash de dedup
 * (ver `transactionHash`): duas leituras do MESMO extrato precisam produzir a
 * MESMA conta, venham elas do parser deterministico ou da extracao por IA. Se
 * cada caminho inventasse seu proprio identificador, reimportar o mesmo arquivo
 * por outro caminho duplicaria tudo.
 */

const CONHECIDAS = [
  "stone",
  "pagseguro",
  "pagbank",
  "mercado pago",
  "nubank",
  "inter",
  "itau",
  "bradesco",
  "caixa",
  "santander",
  "banco do brasil",
  "sicoob",
  "sicredi",
];

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Prefixo curto e estavel da instituicao ("PagSeguro Internet S/A" -> "pagseguro"). */
export function shortInstitution(instituicao: string): string {
  const low = instituicao.toLowerCase();
  const hit = CONHECIDAS.find((k) => low.includes(k));
  return hit ? slug(hit) : slug(instituicao) || "conta";
}

/** Monta a referencia de conta a partir da instituicao e do numero. */
export function accountRefFor(instituicao: string, numero: string): AccountRef {
  const num = (numero || "").replace(/\s/g, "");
  const inst = shortInstitution(instituicao || "");
  const id = num ? `${inst}-${num.replace(/\D/g, "")}` : inst;
  const label = instituicao
    ? `${instituicao}${num ? ` - Conta ${num}` : ""}`
    : num
      ? `Conta ${num}`
      : "Conta";
  return { id, label };
}
