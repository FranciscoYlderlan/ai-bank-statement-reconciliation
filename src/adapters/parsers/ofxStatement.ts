import { Transaction } from "../../domain/transaction";
import { Money } from "../../domain/money";
import { PlainDate } from "../../domain/dateptbr";
import { accountRefFor } from "../../domain/accountRef";
import { montarDescricao } from "./tabularStatement";

/**
 * PARSER DETERMINISTICO — OFX (Open Financial Exchange), 1.x SGML e 2.x XML.
 *
 * ─── por que este formato dispensa a IA ─────────────────────────────────
 *
 * O OFX nao e um documento para pessoa ler: e um formato de troca entre
 * sistemas, e cada lancamento e um registro DELIMITADO — `<STMTTRN>` abre,
 * `</STMTTRN>` fecha, e dentro dele cada campo tem nome proprio. Nao existe a
 * ambiguidade que justifica a IA num PDF, onde a contraparte pode estar na
 * linha de cima e uma coluna pode escorregar para o lado.
 *
 * A prova aqui e ESTRUTURAL, e nao aritmetica como no extrato tabular — o OFX
 * nao declara o saldo de cada lancamento, so o saldo final (`LEDGERBAL`), e sem
 * o saldo inicial nao ha corrente para fechar. Em compensacao, a estrutura
 * permite uma checagem que o PDF nunca permitiria: CONTAR. Exigimos que
 *
 *   - todo bloco `<STMTTRN>` do arquivo vire exatamente um lancamento;
 *   - todo bloco traga data e valor legiveis;
 *   - nao sobre, dentro da lista de transacoes, nenhuma marcacao que nao
 *     tenhamos interpretado — o equivalente a "linha nao lida" do PagBank;
 *   - nenhuma data caia fora do periodo declarado em `DTSTART`/`DTEND`.
 *
 * Falhando qualquer uma, o resultado INTEIRO e descartado e a IA le o arquivo.
 *
 * ─── o limite que o formato impoe ───────────────────────────────────────
 *
 * O OFX da Stone entrega o valor JA LIQUIDO da tarifa: a venda de R$ 25,00 com
 * R$ 0,24 de tarifa aparece como R$ 24,76, uma linha so. O valor bruto e a
 * tarifa nao estao no arquivo — nao ha o que deduzir. Por isso o mesmo extrato
 * rende 315 lancamentos em PDF/CSV/XLS e 277 em OFX, e por isso `avisos`
 * carrega essa frase ate o relatorio: e informacao que o usuario precisa ter
 * antes de escolher por qual arquivo importar o mes.
 */

export const OFX_PARSER_ID = "ofx";

export interface UnreadBlock {
  /** indice do bloco no arquivo (1-based). */
  index: number;
  text: string;
  motivo: string;
}

export interface OfxAudit {
  /** blocos <STMTTRN> encontrados no arquivo. */
  declarados: number;
  /** blocos que viraram lancamento. */
  lidos: number;
  /** lancamentos com data fora de DTSTART/DTEND. */
  foraDoPeriodo: number;
  /** marcacoes dentro da lista de transacoes que o parser nao entendeu. */
  sobras: string[];
  detalhes: string[];
}

export interface OfxHeader {
  instituicao: string;
  banco: string;
  conta: string;
  periodoInicio: PlainDate | null;
  periodoFim: PlainDate | null;
  saldoFinal: number | null; // centavos
}

export interface OfxParseResult {
  transactions: Transaction[];
  audit: OfxAudit;
  unread: UnreadBlock[];
  cabecalho: OfxHeader;
  /** observacoes que devem chegar ao relatorio (ex.: valor liquido de tarifa). */
  avisos: string[];
}

/* ── leitura de tags ────────────────────────────────────────────────────── */

/**
 * Valor de uma tag, tolerando as DUAS gramaticas do OFX: a 2.x fecha tudo
 * (`<TRNAMT>161.00</TRNAMT>`) e a 1.x deixa as folhas abertas
 * (`<TRNAMT>161.00` seguido da proxima tag). Por isso a captura para no
 * primeiro `<` que aparecer, seja ele um fechamento ou a tag seguinte.
 */
function tag(bloco: string, nome: string): string {
  const m = bloco.match(new RegExp(`<${nome}>([^<]*)`, "i"));
  return m ? m[1].trim() : "";
}

function temTag(bloco: string, nome: string): boolean {
  return new RegExp(`<${nome}>`, "i").test(bloco);
}

/** `20260831200244[-3:BRT]` -> data pura. A hora e o fuso sao descartados. */
export function parseOfxDate(bruto: string): PlainDate | null {
  const m = bruto.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** `-94.00` / `161.00` / `1.234,56` -> centavos com sinal. NaN quando ilegivel. */
export function parseOfxAmount(bruto: string): number {
  const s = bruto.trim().replace(/\s/g, "");
  if (!s) return NaN;
  const negativo = s.startsWith("-");
  let n = s.replace(/^[+-]/, "");
  // o padrao do OFX e ponto decimal; alguns emissores brasileiros mandam virgula
  if (n.includes(",")) n = n.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(n)) return NaN;
  const cents = Math.round(Number(n) * 100);
  return negativo ? -cents : cents;
}

function antes(a: PlainDate, b: PlainDate): boolean {
  return (
    a.year < b.year ||
    (a.year === b.year && (a.month < b.month || (a.month === b.month && a.day < b.day)))
  );
}

/* ── reconhecimento ─────────────────────────────────────────────────────── */

/** Este texto e um OFX? Exige o cabecalho (1.x) ou a tag raiz (2.x) E a lista. */
export function isOfxStatement(text: string): boolean {
  const t = text.slice(0, 8192).toUpperCase();
  const raiz = t.includes("OFXHEADER") || t.includes("<OFX>");
  return raiz && text.toUpperCase().includes("<STMTTRN>");
}

/* ── descricao no padrao da planilha ────────────────────────────────────── */

/**
 * O MEMO do OFX da Stone vem no formato `NOME - Instrumento | Detalhe`
 * (`BUMBA ACAI - Transferência | Pix`). A planilha do cliente escreve
 * `Pix - NOME`, e e desse padrao que as regras da casa dependem (§3.3) — entao
 * viramos a frase, usando o mesmo dicionario de instrumento do extrato
 * tabular, para que os dois caminhos escrevam a MESMA descricao.
 *
 * Memo que nao siga esse formato passa adiante intacto: um OFX de outro banco
 * nao tem por que ser reescrito segundo a convencao da Stone.
 */
export function descricaoDoMemo(memo: string, entrada: boolean): string {
  const texto = memo.replace(/\s+/g, " ").trim();
  if (!texto) return entrada ? "Recebimento vendas" : "Lançamento";
  const corte = texto.lastIndexOf(" - ");
  if (corte < 0) return texto;
  const nome = texto.slice(0, corte).trim();
  const instrumento = texto.slice(corte + 3).trim();
  const metodo = metodoDoInstrumento(instrumento);
  if (!metodo) return texto;
  return montarDescricao(metodo, nome, entrada);
}

function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * `Transferência | Pix` -> `Pix`; `Pix | Maquininha` -> `Maquininha`;
 * `Antecipação | Crédito` -> `Antecipação`; `Maestro | Débito` -> `Cartão`.
 *
 * A bandeira (Maestro, Visa Electron, Elo) nao entra na descricao de proposito:
 * o que a planilha classifica e o MEIO, e tres bandeiras diferentes gerariam
 * tres descricoes diferentes para o mesmo tipo de recebimento.
 */
export function metodoDoInstrumento(instrumento: string): string {
  const partes = instrumento.split("|").map((p) => semAcento(p));
  if (partes.length === 0) return "";
  const [a, b = ""] = partes;
  if (b.includes("maquinin") || a.includes("maquinin")) return "Maquininha";
  if (a.includes("antecipa") || b.includes("antecipa")) return "Antecipação";
  if (a === "pix" || b === "pix") return "Pix";
  if (b === "debito" || b === "credito") return "Cartão";
  if (a.includes("recarga")) return "Recarga";
  if (a.includes("boleto")) return "Boleto";
  if (a.includes("transferencia")) return "Transferência";
  return instrumento.trim();
}

/* ── leitura ────────────────────────────────────────────────────────────── */

/**
 * Le um OFX inteiro. NAO lanca: devolve as transacoes mais a auditoria e as
 * sobras, para o roteador decidir se aceita a leitura.
 */
export function parseOfx(text: string): OfxParseResult {
  const banco = tag(text, "BANKID");
  const conta = tag(text, "ACCTID");
  const instituicao = tag(text, "ORG") || tag(text, "FID");
  const saldoBruto = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\s]*)/i);
  const saldoFinal = saldoBruto ? parseOfxAmount(saldoBruto[1]) : NaN;

  const cabecalho: OfxHeader = {
    instituicao,
    banco,
    conta,
    periodoInicio: parseOfxDate(tag(text, "DTSTART")),
    periodoFim: parseOfxDate(tag(text, "DTEND")),
    saldoFinal: Number.isNaN(saldoFinal) ? null : saldoFinal,
  };
  const account = accountRefFor(instituicao || banco, conta);

  const blocos = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  const transactions: Transaction[] = [];
  const unread: UnreadBlock[] = [];
  const detalhes: string[] = [];
  let foraDoPeriodo = 0;
  let temTarifaEmbutida = false;

  blocos.forEach((m, i) => {
    const bloco = m[1];
    const resumo = bloco.replace(/\s+/g, " ").trim().slice(0, 120);
    const data = parseOfxDate(tag(bloco, "DTPOSTED"));
    if (!data) {
      unread.push({ index: i + 1, text: resumo, motivo: "sem DTPOSTED legível" });
      return;
    }
    const cents = parseOfxAmount(tag(bloco, "TRNAMT"));
    if (Number.isNaN(cents)) {
      unread.push({ index: i + 1, text: resumo, motivo: "sem TRNAMT legível" });
      return;
    }

    // DIRECAO: o sinal do TRNAMT e a fonte, como manda a especificacao do OFX.
    // TRNTYPE serve de conferencia — CREDIT com valor negativo (ou o contrario)
    // significa arquivo inconsistente, e ai nao ha leitura direta.
    const tipo = tag(bloco, "TRNTYPE").toUpperCase();
    const entrada = cents >= 0;
    if ((tipo === "CREDIT" && !entrada) || (tipo === "DEBIT" && entrada)) {
      unread.push({
        index: i + 1,
        text: resumo,
        motivo: `TRNTYPE ${tipo} não combina com o valor ${Money.fromCents(Math.abs(cents)).format()}`,
      });
      return;
    }

    if (
      (cabecalho.periodoInicio && antes(data, cabecalho.periodoInicio)) ||
      (cabecalho.periodoFim && antes(cabecalho.periodoFim, data))
    ) {
      foraDoPeriodo++;
      if (detalhes.length < 6) {
        detalhes.push(
          `lançamento ${i + 1} em ${String(data.day).padStart(2, "0")}/${String(data.month).padStart(2, "0")}/${data.year} está fora do período declarado no arquivo.`,
        );
      }
    }

    const memo = tag(bloco, "MEMO") || tag(bloco, "NAME");
    const descricao = descricaoDoMemo(memo, entrada);
    if (/maquinin/i.test(memo)) temTarifaEmbutida = true;

    transactions.push({
      date: data,
      description: descricao,
      direction: entrada ? "credit" : "debit",
      amount: Money.fromCents(Math.abs(cents)),
      account,
      sourceOrder: transactions.length,
      rawLine: resumo,
    });
  });

  // SOBRAS: dentro de <BANKTRANLIST>, o que nao e um <STMTTRN> nem a moldura
  // (DTSTART/DTEND) e conteudo que este parser nao soube interpretar — o
  // equivalente da "linha nao lida" do PagBank, e motivo de recusa.
  const lista = text.match(/<BANKTRANLIST>([\s\S]*?)<\/BANKTRANLIST>/i);
  const sobras: string[] = [];
  if (lista) {
    const resto = lista[1].replace(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi, "");
    for (const t of resto.matchAll(/<\/?([A-Z0-9.]+)>/gi)) {
      const nome = t[1].toUpperCase();
      if (nome === "DTSTART" || nome === "DTEND" || nome === "BANKTRANLIST") continue;
      if (!sobras.includes(nome)) sobras.push(nome);
    }
  }

  const avisos: string[] = [];
  if (temTarifaEmbutida) {
    avisos.push(
      "Neste OFX o valor das vendas por maquininha já vem líquido da tarifa; " +
        "a tarifa não aparece como lançamento próprio. O mesmo extrato em PDF, CSV ou XLS traz as duas linhas.",
    );
  }

  return {
    transactions,
    audit: {
      declarados: blocos.length,
      lidos: transactions.length,
      foraDoPeriodo,
      sobras,
      detalhes,
    },
    unread,
    cabecalho,
    avisos,
  };
}

/**
 * A leitura pode ser aceita? Todo bloco declarado tem de ter virado
 * lancamento, nada pode ter sobrado dentro da lista e nenhuma data pode estar
 * fora do periodo do proprio arquivo.
 */
export function isTrustworthy(r: OfxParseResult): boolean {
  return (
    r.audit.declarados > 0 &&
    r.audit.lidos === r.audit.declarados &&
    r.unread.length === 0 &&
    r.audit.sobras.length === 0 &&
    r.audit.foraDoPeriodo === 0
  );
}

/** Motivo da recusa, em uma frase (vai para o log e para o relatorio). */
export function rejectionReason(r: OfxParseResult): string | null {
  if (isTrustworthy(r)) return null;
  if (r.audit.declarados === 0) return "o arquivo não traz nenhum bloco <STMTTRN>";
  if (r.unread.length > 0) {
    return `${r.unread.length} de ${r.audit.declarados} lançamento(s) ilegível(is) (${r.unread[0].motivo})`;
  }
  if (r.audit.sobras.length > 0) {
    return `a lista de transações traz marcações não interpretadas: ${r.audit.sobras.slice(0, 4).join(", ")}`;
  }
  if (r.audit.foraDoPeriodo > 0) {
    return `${r.audit.foraDoPeriodo} lançamento(s) com data fora do período do arquivo`;
  }
  return "leitura direta não confirmada";
}
