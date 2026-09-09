import { Transaction } from "../../domain/transaction";
import { Money } from "../../domain/money";
import { PlainDate } from "../../domain/dateptbr";
import { accountRefFor } from "../../domain/accountRef";

/**
 * PARSER DETERMINISTICO — extrato de conta PagBank / PagSeguro (PDF).
 *
 * Este layout nao precisa de modelo nenhum: cada lancamento ocupa UMA linha, no
 * formato `dd/mm/aaaa <descricao> R$ 0,00`, e a saida vem com sinal negativo.
 * Ler isso com IA e pagar latencia e incerteza por um trabalho que uma regex
 * faz sem errar — e sem variar de uma execucao para a outra.
 *
 * O que torna esta leitura CONFERIVEL, e nao apenas plausivel, sao as linhas
 * "Saldo do dia" que o extrato traz ao fim de cada data. Elas nao viram
 * lancamento: viram CONFERENCIA. A soma dos lancamentos do dia tem de explicar
 * exatamente a diferenca entre o saldo daquele dia e o do dia anterior. Se
 * fechar em todos os dias, a extracao esta provadamente completa — nenhum
 * lancamento a mais, nenhum a menos. Se nao fechar, o resultado e recusado e
 * quem le o arquivo passa a ser a IA (ver adapters/parsers/hybrid.ts).
 */

/** Uma linha do extrato que nao virou lancamento nem conferencia. */
export interface UnreadLine {
  page: number;
  text: string;
}

/** Conferencia da extracao pela cadeia de "Saldo do dia". */
export interface BalanceAudit {
  /** dias com saldo declarado que foi possivel conferir contra o dia anterior. */
  conferidos: number;
  /** dias em que a soma dos lancamentos NAO explicou a variacao do saldo. */
  divergentes: number;
  /** lancamentos com data fora do periodo declarado no cabecalho. */
  foraDoPeriodo: number;
  /** detalhe das divergencias, para o log de diagnostico. */
  detalhes: string[];
}

export interface PagBankParseResult {
  transactions: Transaction[];
  audit: BalanceAudit;
  unread: UnreadLine[];
  cabecalho: PagBankHeader;
}

export interface PagBankHeader {
  instituicao: string;
  agencia: string;
  conta: string;
  periodoInicio: PlainDate | null;
  periodoFim: PlainDate | null;
}

export const PAGBANK_PARSER_ID = "pagbank-pdf";

/* ── reconhecimento ─────────────────────────────────────────────────────── */

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Este texto e um extrato PagBank/PagSeguro? Exige as TRES marcas juntas —
 * emissor, titulo do documento e as colunas da tabela. Uma so delas apareceria
 * por acaso em outro documento; as tres, nao.
 */
export function isPagBankStatement(text: string): boolean {
  const t = semAcento(text);
  const emissor = /pagseguro|pagbank/.test(t);
  const documento = /extrato da conta/.test(t);
  const colunas = /\bdata\b/.test(t) && /\bvalor\b/.test(t) && /descric/.test(t);
  return emissor && documento && colunas;
}

/* ── leitura do cabecalho ───────────────────────────────────────────────── */

const RE_DATA = /(\d{2})\/(\d{2})\/(\d{4})/;

function parseData(s: string): PlainDate | null {
  const m = s.match(RE_DATA);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function readHeader(text: string): PagBankHeader {
  const linhas = text.split(/\r?\n/);
  const achar = (re: RegExp): string => {
    for (const l of linhas) {
      const m = l.match(re);
      if (m) return (m[1] ?? "").trim();
    }
    return "";
  };
  // "290 - PagSeguro Internet S/A" -> o nome vem depois do codigo do banco
  const emissor =
    achar(/^\s*\d{3}\s*-\s*(.+?)\s*$/) ||
    (/pagbank/i.test(text) ? "PagBank" : "PagSeguro Internet S/A");
  const periodo = linhas.find((l) => /per[ií]odo/i.test(l)) ?? "";
  const datasPeriodo = [...periodo.matchAll(new RegExp(RE_DATA, "g"))].map((m) => parseData(m[0]));
  return {
    instituicao: emissor,
    agencia: achar(/Ag[êe]ncia\s+([\d-]+)/i),
    conta: achar(/Conta\s+([\d.-]+)/i),
    periodoInicio: datasPeriodo[0] ?? null,
    periodoFim: datasPeriodo[1] ?? null,
  };
}

/* ── leitura das linhas ─────────────────────────────────────────────────── */

/**
 * `17/07/2026 Vendas - Disponivel PIX R$ 49,28`
 * `11/08/2026 QR Code Pix enviado - UMBU SOLUCOES LTDA -R$ 456,00`
 *
 * O sinal pode vir antes do "R$" (como neste extrato) ou depois; a descricao e
 * capturada de forma nao-gulosa e o valor esta ancorado no FIM da linha, entao
 * um "R$" que apareca no meio da descricao nao confunde a leitura.
 */
const RE_LANCAMENTO =
  /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-)?\s*R\$\s*(-)?\s*([\d.]+,\d{2})\s*$/;

/**
 * Cabecalho das colunas — marca onde a TABELA comeca em cada pagina. O pdf.js
 * agrupa por altura, entao "Data ... Valor" e "Descrição" caem em linhas
 * separadas; as duas formas contam.
 */
const RE_CABECALHO_TABELA = /^data\b.*\b(valor|descric)/i;

/**
 * Linhas estruturais que aparecem DENTRO da tabela e nao sao lancamento:
 * repeticao do cabecalho na virada de pagina, rodape, numero de pagina.
 *
 * O bloco de identificacao (nome do titular, CNPJ, agencia, conta, periodo) NAO
 * precisa estar aqui: ele fica ANTES do cabecalho da tabela, e tudo o que vem
 * antes e ignorado por posicao. Enumerar nome de empresa seria impossivel.
 */
const RE_RUIDO_NA_TABELA = [
  /^\s*$/,
  RE_CABECALHO_TABELA,
  /^descricao$/,
  /^valor$/,
  /^data$/,
  /^pagina\s+\d+/,
];

/** Descricao que representa SALDO — conferencia, nunca lancamento. */
function classificaSaldo(descricao: string): "dia" | "outro" | null {
  const d = semAcento(descricao).trim();
  if (/^saldo do dia\b/.test(d)) return "dia";
  if (/^saldo\s+(anterior|inicial|final|em conta|atual|disponivel)/.test(d)) return "outro";
  return null;
}

function parseValorBr(s: string): number {
  return Math.round(Number(s.replace(/\./g, "").replace(",", ".")) * 100);
}

function antes(a: PlainDate, b: PlainDate): boolean {
  return (
    a.year < b.year ||
    (a.year === b.year && (a.month < b.month || (a.month === b.month && a.day < b.day)))
  );
}

/**
 * Le as paginas de texto de um extrato PagBank. Nao lanca: devolve o que
 * conseguiu ler MAIS a conferencia e as linhas nao lidas, para quem chamou
 * decidir se aceita o resultado.
 */
export function parsePagBankPages(pages: string[]): PagBankParseResult {
  const textoTodo = pages.join("\n");
  const cabecalho = readHeader(textoTodo);
  const account = accountRefFor(cabecalho.instituicao, cabecalho.conta);

  const transactions: Transaction[] = [];
  const unread: UnreadLine[] = [];
  const detalhes: string[] = [];
  let conferidos = 0;
  let divergentes = 0;
  let foraDoPeriodo = 0;

  // cadeia de saldo: acumula o movimento do dia corrente ate aparecer o
  // "Saldo do dia" daquela data, que fecha (ou nao) a conta.
  let saldoAnterior: number | null = null;
  let movimentoDoDia = 0;

  const fechaDia = (data: PlainDate, saldoDeclarado: number) => {
    if (saldoAnterior !== null) {
      conferidos++;
      const esperado = saldoAnterior + movimentoDoDia;
      if (esperado !== saldoDeclarado) {
        divergentes++;
        detalhes.push(
          `${data.day.toString().padStart(2, "0")}/${data.month.toString().padStart(2, "0")}: ` +
            `saldo do dia R$ ${(saldoDeclarado / 100).toFixed(2)} nao confere com ` +
            `R$ ${(esperado / 100).toFixed(2)} (anterior + lancamentos lidos).`,
        );
      }
    }
    saldoAnterior = saldoDeclarado;
    movimentoDoDia = 0;
  };

  pages.forEach((pageText, pageIndex) => {
    // Cada pagina tem um bloco de identificacao antes da tabela (e o cabecalho
    // das colunas se repete na pagina 2). Tudo o que vem ANTES da tabela e
    // ignorado por POSICAO; dentro da tabela, o criterio passa a ser estrito —
    // linha que nao vira lancamento nem conferencia conta como nao lida.
    let naTabela = false;
    for (const bruta of pageText.split(/\r?\n/)) {
      const linha = bruta.replace(/\s+/g, " ").trim();
      // as comparacoes estruturais rodam SEM acento: o pdf.js entrega
      // "Descrição", e um /^descric/ literal nao casa com o "ç".
      const chave = semAcento(linha);
      if (!naTabela) {
        if (RE_CABECALHO_TABELA.test(chave) || RE_LANCAMENTO.test(linha)) naTabela = true;
        else continue;
      }
      if (RE_RUIDO_NA_TABELA.some((re) => re.test(chave))) continue;

      const m = linha.match(RE_LANCAMENTO);
      if (!m) {
        unread.push({ page: pageIndex, text: linha });
        continue;
      }
      const data = parseData(m[1]);
      if (!data) {
        unread.push({ page: pageIndex, text: linha });
        continue;
      }
      const descricao = m[2].replace(/\s+/g, " ").trim();
      const negativo = m[3] === "-" || m[4] === "-";
      const cents = parseValorBr(m[5]);

      // O acumulado do dia NAO e zerado na virada de pagina de proposito: neste
      // extrato os lancamentos de 10/08 terminam numa pagina e o "Saldo do dia"
      // da mesma data abre a seguinte. Quem zera o acumulado e o fechamento do
      // dia, nunca o fim da pagina.
      const saldo = classificaSaldo(descricao);
      if (saldo === "dia") {
        fechaDia(data, negativo ? -cents : cents);
        continue;
      }
      if (saldo === "outro") {
        // saldo anterior/inicial serve de ancora, nao de lancamento
        if (saldoAnterior === null) saldoAnterior = negativo ? -cents : cents;
        continue;
      }

      movimentoDoDia += negativo ? -cents : cents;

      if (
        (cabecalho.periodoInicio && antes(data, cabecalho.periodoInicio)) ||
        (cabecalho.periodoFim && antes(cabecalho.periodoFim, data))
      ) {
        foraDoPeriodo++;
      }

      transactions.push({
        date: data,
        description: descricao,
        direction: negativo ? "debit" : "credit",
        amount: Money.fromCents(cents),
        account,
        sourceOrder: transactions.length,
        rawLine: linha,
      });
    }
  });

  return {
    transactions,
    audit: { conferidos, divergentes, foraDoPeriodo, detalhes },
    unread,
    cabecalho,
  };
}

/**
 * A leitura pode ser aceita? Exige que a cadeia de saldo tenha FECHADO — ao
 * menos um dia conferido e nenhuma divergencia —, nenhuma data fora do periodo
 * e nada de sobra que o parser nao soube interpretar.
 *
 * O criterio e deliberadamente severo. Um parser deterministico que erra em
 * silencio e pior do que nao ter parser nenhum: o erro dele parece certeza. Na
 * duvida, recusamos e deixamos a IA ler o arquivo.
 *
 * LIMITE CONHECIDO: os lancamentos do PRIMEIRO dia do extrato nao entram na
 * conferencia. O saldo daquele dia e o primeiro elo da corrente — nao ha saldo
 * anterior no documento para compara-lo — entao ele so estabelece o ponto de
 * partida. Do segundo dia em diante, todo lancamento esta coberto.
 */
export function isTrustworthy(r: PagBankParseResult): boolean {
  return (
    r.transactions.length > 0 &&
    r.audit.conferidos > 0 &&
    r.audit.divergentes === 0 &&
    r.audit.foraDoPeriodo === 0 &&
    r.unread.length === 0
  );
}

/** Motivo da recusa, em uma frase (vai para o log e para o relatorio). */
export function rejectionReason(r: PagBankParseResult): string | null {
  if (isTrustworthy(r)) return null;
  if (r.transactions.length === 0) return "nenhum lançamento reconhecido";
  if (r.audit.conferidos === 0) return "o extrato não trouxe saldo do dia para conferir";
  if (r.audit.divergentes > 0) {
    return `a cadeia de saldo não fechou em ${r.audit.divergentes} dia(s): ${r.audit.detalhes[0]}`;
  }
  if (r.audit.foraDoPeriodo > 0) {
    return `${r.audit.foraDoPeriodo} lançamento(s) com data fora do período do extrato`;
  }
  return `${r.unread.length} linha(s) não reconhecida(s), ex.: "${r.unread[0]?.text ?? ""}"`;
}
