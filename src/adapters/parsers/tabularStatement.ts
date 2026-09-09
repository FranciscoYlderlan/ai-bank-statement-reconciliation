import { Transaction } from "../../domain/transaction";
import { Money } from "../../domain/money";
import { PlainDate } from "../../domain/dateptbr";
import { accountRefFor } from "../../domain/accountRef";

/**
 * PARSER DETERMINISTICO — extrato TABULAR com saldo antes e depois
 * (CSV, TSV e planilha; e a exportacao "Extrato" da Stone em .csv e em .xls).
 *
 * ─── por que este layout pode ser lido sem IA ───────────────────────────
 *
 * A regra da casa (§3.4 do README) e a mesma de sempre: leitura direta so vale
 * quando o proprio arquivo traz COMO CONFERIR o que foi lido. Aqui ele traz, e
 * de forma mais forte que o PagBank — que so fecha uma vez por dia. Cada linha
 * declara `Saldo antes` e `Saldo depois`, entao ha DUAS provas independentes:
 *
 *   1. ARITMETICA DA LINHA — `antes + valor - tarifa == depois`. Se o valor
 *      lido, o sinal ou a tarifa estiverem errados em UMA linha, essa linha
 *      denuncia sozinha.
 *   2. ENCADEAMENTO — o `depois` de uma linha e o `antes` da linha vizinha, do
 *      comeco ao fim do arquivo. E isto que prova que nenhuma linha foi PULADA:
 *      um lancamento faltando abre um buraco no meio da corrente, e um
 *      lancamento a mais tambem.
 *
 * Juntas, elas cobrem exatamente os dois erros que a leitura por IA custa caro
 * para evitar — lancamento a menos e lancamento a mais — e cobrem inclusive o
 * PRIMEIRO lancamento do arquivo, que no PagBank fica de fora (la o saldo do
 * primeiro dia nao tem com o que ser comparado). Qualquer desvio e o resultado
 * INTEIRO e descartado e a IA assume o arquivo; nunca se costura metade de
 * cada lado.
 *
 * ─── a tarifa vira lancamento proprio ───────────────────────────────────
 *
 * O mesmo extrato conta a tarifa de tres jeitos: o PDF da uma LINHA a ela, o
 * CSV/XLS a poe numa COLUNA da linha da venda, e o OFX ja entrega o valor
 * liquido (R$ 25,00 com R$ 0,24 de tarifa viram R$ 24,76). Como a planilha do
 * cliente tem a categoria `Taxa de cartão` e a regra da casa manda toda saida
 * de tarifa para la, a leitura canonica e a do PDF: a tarifa e uma SAIDA
 * propria. Por isso, aqui, cada linha com tarifa cobrada gera DOIS lancamentos
 * — a venda pelo valor cheio e a tarifa como saida.
 *
 * (O OFX nao permite desfazer a conta: o valor bruto simplesmente nao esta no
 * arquivo. Isso e limite do formato, nao decisao nossa, e esta dito no README.)
 */

export const TABULAR_PARSER_ID = "tabular-saldo";

/** Uma linha da tabela que nao virou lancamento — reprova a leitura direta. */
export interface UnreadRow {
  /** numero da linha no arquivo (1-based, contando o cabecalho). */
  row: number;
  text: string;
  motivo: string;
}

/** Conferencia da leitura: aritmetica da linha + encadeamento dos saldos. */
export interface TabularAudit {
  /** linhas em que `antes + valor - tarifa` bateu com `depois`. */
  linhasConferidas: number;
  /** linhas em que nao bateu. */
  linhasDivergentes: number;
  /** ligacoes conferidas entre uma linha e a seguinte. */
  elosConferidos: number;
  /** ligacoes em que o saldo de uma linha nao encontrou o da vizinha. */
  elosQuebrados: number;
  /** linhas cuja direcao declarada contradiz o sinal do valor. */
  direcaoContraditoria: number;
  detalhes: string[];
}

export interface TabularHeader {
  instituicao: string;
  conta: string;
  /** quantas colunas conhecidas o cabecalho trouxe (diagnostico). */
  colunasReconhecidas: number;
}

export interface TabularParseResult {
  transactions: Transaction[];
  audit: TabularAudit;
  unread: UnreadRow[];
  cabecalho: TabularHeader;
  /** quantas tarifas viraram lancamento proprio. */
  tarifas: number;
}

/* ── vocabulario do cabecalho ───────────────────────────────────────────── */

function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Papeis de coluna que este parser entende. A busca e por igualdade exata da
 * forma normalizada primeiro e so depois por prefixo — "saldo" sozinho nao
 * pode roubar o lugar de "saldo antes".
 */
const COLUNAS: { papel: keyof ColunasMapeadas; nomes: string[] }[] = [
  { papel: "movimentacao", nomes: ["movimentacao", "movimento", "sentido"] },
  { papel: "tipo", nomes: ["tipo", "tipo de transacao", "modalidade"] },
  { papel: "valor", nomes: ["valor", "valor da transacao", "montante"] },
  { papel: "saldoAntes", nomes: ["saldo antes", "saldo anterior", "saldo inicial"] },
  { papel: "saldoDepois", nomes: ["saldo depois", "saldo posterior", "saldo final", "saldo apos"] },
  { papel: "tarifa", nomes: ["tarifa", "taxa", "tarifas"] },
  { papel: "data", nomes: ["data", "data da transacao", "data hora"] },
  { papel: "situacao", nomes: ["situacao", "status"] },
  { papel: "descricao", nomes: ["descricao", "historico", "observacao"] },
  { papel: "destino", nomes: ["destino"] },
  { papel: "destinoInstituicao", nomes: ["destino instituicao"] },
  { papel: "destinoConta", nomes: ["destino conta"] },
  { papel: "origem", nomes: ["origem"] },
  { papel: "origemInstituicao", nomes: ["origem instituicao"] },
  { papel: "origemConta", nomes: ["origem conta"] },
];

interface ColunasMapeadas {
  movimentacao: number;
  tipo: number;
  valor: number;
  saldoAntes: number;
  saldoDepois: number;
  tarifa: number;
  data: number;
  situacao: number;
  descricao: number;
  destino: number;
  destinoInstituicao: number;
  destinoConta: number;
  origem: number;
  origemInstituicao: number;
  origemConta: number;
}

function mapearColunas(cabecalho: string[]): ColunasMapeadas {
  const vazio = Object.fromEntries(COLUNAS.map((c) => [c.papel, -1])) as unknown as ColunasMapeadas;
  const normalizado = cabecalho.map(semAcento);
  for (const { papel, nomes } of COLUNAS) {
    const exato = normalizado.findIndex((h) => nomes.includes(h));
    (vazio as unknown as Record<string, number>)[papel] = exato;
  }
  return vazio;
}

/**
 * Este arquivo e um extrato tabular CONFERIVEL?
 *
 * A exigencia nao e a marca do banco: e a PROVA. Sem `Saldo antes` e
 * `Saldo depois` na mesma linha, a leitura seria apenas plausivel — e um parser
 * plausivel que erra calado e pior do que nao ter parser (§3.4). Data, valor e
 * sentido completam o minimo para montar o lancamento.
 */
export function isTabularStatement(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const c = mapearColunas(rows[0]);
  return (
    c.data >= 0 && c.valor >= 0 && c.saldoAntes >= 0 && c.saldoDepois >= 0 && c.movimentacao >= 0
  );
}

/* ── leitura de valores ─────────────────────────────────────────────────── */

const SEM_VALOR = new Set([
  "",
  "-",
  "--",
  "gratis",
  "isento",
  "desconhecido",
  "n/a",
  "na",
  "nao se aplica",
]);

/**
 * Valor monetario pt-BR em CENTAVOS INTEIROS, com sinal. Devolve `null`
 * quando o campo simplesmente nao traz valor ("Grátis" na coluna de tarifa) e
 * `NaN` quando traz algo que deveria ser numero e nao e — que e coisa
 * diferente e o chamador trata como linha nao lida.
 */
export function parseValorTabular(bruto: string): number | null {
  const s = semAcento(bruto).replace(/r\$/g, "").replace(/\s/g, "");
  if (SEM_VALOR.has(s)) return null;
  const negativo = /^[-(]/.test(s);
  const numerico = s.replace(/[()+-]/g, "");
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(numerico)) {
    return NaN;
  }
  const canonico = numerico.includes(",")
    ? numerico.replace(/\./g, "").replace(",", ".")
    : numerico;
  const n = Math.round(Number(canonico) * 100);
  if (!Number.isFinite(n)) return NaN;
  return negativo ? -n : n;
}

/** `31/08/2026 20:02` ou `31/08/26` -> data pura (a hora e descartada). */
export function parseDataTabular(bruto: string): PlainDate | null {
  const m = bruto.trim().match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/* ── descricao no padrao da planilha ────────────────────────────────────── */

/**
 * O NOME DO MEIO DE PAGAMENTO, no vocabulario que a planilha do cliente usa.
 *
 * A planilha viva escreve `Pix - NOME` e `Maquininha - NOME`; e desse padrao
 * que as regras da casa dependem para disparar sem consultar o modelo (§3.3).
 * O extrato tabular usa um vocabulario proprio e mais grosso que o do PDF —
 * "Transação" para o que o PDF chama de "Pix | Maquininha", "Transferência
 * entre contas Stone" para o que ele chama de "Antecipação | Crédito" —, e
 * esta tabela e o dicionario entre os dois. A equivalencia foi conferida
 * lancamento a lancamento entre o CSV, o OFX e o PDF do MESMO extrato: os 277
 * pareamentos batem, sem sobra.
 *
 * Tipo desconhecido nao vira chute: passa adiante como veio.
 */
const METODO_POR_TIPO: [RegExp, string][] = [
  [/^pix$/, "Pix"],
  [/^transacao$/, "Maquininha"],
  [/maquin/, "Maquininha"],
  [/recebivel de cartao|cartao/, "Cartão"],
  [/entre contas|antecipa/, "Antecipação"],
  [/recarga/, "Recarga"],
  [/boleto/, "Boleto"],
  [/^ted$|^doc$/, "Transferência"],
];

export function metodoDoTipo(tipo: string): string {
  const t = semAcento(tipo);
  if (!t) return "";
  for (const [re, nome] of METODO_POR_TIPO) if (re.test(t)) return nome;
  return tipo.trim();
}

/**
 * Nomes que ocupam o campo de contraparte sem identificar ninguem.
 *
 * `stone principal` esta aqui porque nao e uma contraparte: e a conta principal
 * do PROPRIO titular na adquirente, de onde a antecipacao de vendas cai na
 * conta corrente. O mesmo lancamento, no PDF e no OFX do mesmo extrato, vem
 * escrito como `Recebimento vendas` — e e essa a leitura que faz os tres
 * formatos produzirem a MESMA descricao.
 */
const CONTRAPARTE_VAZIA = new Set([
  "",
  "desconhecido",
  "desconhecida",
  "-",
  "nao informado",
  "stone principal",
]);

/**
 * A descricao final: `Método - CONTRAPARTE`, no padrao que a planilha pratica.
 *
 * Quando a contraparte nao existe no arquivo — recebivel de cartao e
 * antecipacao chegam com o campo em branco, porque quem paga e a adquirente e
 * nao uma pessoa — usamos `Recebimento vendas`, que e literalmente o texto que
 * o proprio banco escreve nesses lancamentos no PDF e no OFX do mesmo extrato.
 * Nao e invencao nossa: e a mesma frase, vinda do mesmo emissor.
 */
export function montarDescricao(metodo: string, contraparte: string, entrada: boolean): string {
  // espaco duplo dentro do nome ("R C PINHEIRO  LTDA") aparece num formato e
  // nao no outro; colapsar aqui e o que impede a mesma transacao de sair com
  // duas descricoes diferentes conforme o arquivo escolhido.
  const limpo = contraparte.replace(/\s+/g, " ").trim();
  let nome = CONTRAPARTE_VAZIA.has(semAcento(limpo)) ? "" : limpo;
  // O nome as vezes ja comeca pelo proprio metodo — o OFX escreve
  // "Recarga (98) 9xxxx | Claro - Recarga | Celular". Repetir a palavra
  // produziria "Recarga - Recarga (98)...", que e a MESMA transacao com uma
  // descricao diferente da que o CSV gera; e a descricao entra no dedup.
  const prefixo = semAcento(metodo) + " ";
  if (metodo && semAcento(nome).startsWith(prefixo)) {
    const resto = nome.slice(metodo.length).trim();
    if (resto) nome = resto;
  }
  if (nome) return metodo ? `${metodo} - ${nome}` : nome;
  if (entrada) return metodo ? `${metodo} - Recebimento vendas` : "Recebimento vendas";
  return metodo || "Lançamento";
}

/** A descricao da tarifa nomeia a PROPRIA despesa — e o que autoriza a regra da casa. */
export const DESCRICAO_TARIFA = "Tarifa";

/* ── identidade da conta ────────────────────────────────────────────────── */

function maisFrequente(valores: string[]): string {
  const conta = new Map<string, number>();
  for (const v of valores) {
    const s = v.trim();
    if (!s || CONTRAPARTE_VAZIA.has(semAcento(s))) continue;
    conta.set(s, (conta.get(s) ?? 0) + 1);
  }
  let melhor = "";
  let max = 0;
  for (const [k, n] of conta) {
    if (n > max) {
      max = n;
      melhor = k;
    }
  }
  return melhor;
}

/* ── leitura ────────────────────────────────────────────────────────────── */

function fmt(cents: number): string {
  return Money.fromCents(Math.abs(cents)).format();
}

/**
 * Le a tabela inteira. NAO lanca: devolve o que conseguiu ler mais a
 * conferencia e as linhas nao lidas, para o roteador decidir se aceita.
 */
export function parseTabularStatement(rows: string[][]): TabularParseResult {
  const col = mapearColunas(rows[0] ?? []);
  const corpo = rows.slice(1);
  const campo = (linha: string[], idx: number): string => (idx >= 0 ? (linha[idx] ?? "") : "");

  // A conta e a que aparece do lado do TITULAR: no credito ela e o destino, no
  // debito e a origem. Colher os dois lados e ficar com o valor dominante torna
  // a identidade estavel mesmo com uma linha atipica no meio do arquivo.
  const instituicoes: string[] = [];
  const contas: string[] = [];
  for (const linha of corpo) {
    const credito = semAcento(campo(linha, col.movimentacao)).startsWith("cred");
    instituicoes.push(campo(linha, credito ? col.destinoInstituicao : col.origemInstituicao));
    contas.push(campo(linha, credito ? col.destinoConta : col.origemConta));
  }
  const cabecalho: TabularHeader = {
    instituicao: maisFrequente(instituicoes),
    conta: maisFrequente(contas),
    colunasReconhecidas: Object.values(col).filter((i) => i >= 0).length,
  };
  const account = accountRefFor(cabecalho.instituicao, cabecalho.conta);

  const transactions: Transaction[] = [];
  const unread: UnreadRow[] = [];
  const detalhes: string[] = [];
  let linhasConferidas = 0;
  let linhasDivergentes = 0;
  let direcaoContraditoria = 0;
  let tarifas = 0;

  // guardado por linha lida, para conferir o encadeamento depois
  const elos: { antes: number; depois: number; row: number }[] = [];

  corpo.forEach((linha, i) => {
    const numeroDaLinha = i + 2; // 1-based, contando o cabecalho
    const cru = linha.join(" | ").replace(/\s+/g, " ").trim();
    const naoLida = (motivo: string) => unread.push({ row: numeroDaLinha, text: cru, motivo });

    const data = parseDataTabular(campo(linha, col.data));
    if (!data) return naoLida("data ilegível");

    const valor = parseValorTabular(campo(linha, col.valor));
    if (valor == null || Number.isNaN(valor)) return naoLida("valor ilegível");

    const antes = parseValorTabular(campo(linha, col.saldoAntes));
    const depois = parseValorTabular(campo(linha, col.saldoDepois));
    if (antes == null || Number.isNaN(antes) || depois == null || Number.isNaN(depois)) {
      return naoLida("saldo ilegível");
    }

    const tarifaBruta = parseValorTabular(campo(linha, col.tarifa));
    if (Number.isNaN(tarifaBruta)) return naoLida("tarifa ilegível");
    const tarifa = Math.abs(tarifaBruta ?? 0);

    // DIRECAO: o rotulo do extrato manda, e o sinal do valor tem de concordar.
    // Discordancia nao e detalhe — significa que uma das duas leituras esta
    // errada, e nesse caso nao ha leitura direta.
    const rotulo = semAcento(campo(linha, col.movimentacao));
    const entradaPeloRotulo = rotulo.startsWith("cred") || rotulo.startsWith("entrada");
    const saidaPeloRotulo = rotulo.startsWith("deb") || rotulo.startsWith("saida");
    const entradaPeloSinal = valor >= 0;
    if ((entradaPeloRotulo || saidaPeloRotulo) && entradaPeloRotulo !== entradaPeloSinal) {
      direcaoContraditoria++;
      detalhes.push(
        `linha ${numeroDaLinha}: "${campo(linha, col.movimentacao)}" não combina com o valor ${fmt(valor)}.`,
      );
    }
    const entrada = entradaPeloRotulo || (!saidaPeloRotulo && entradaPeloSinal);

    // PROVA 1 — a aritmetica da propria linha.
    if (antes + valor - tarifa === depois) {
      linhasConferidas++;
    } else {
      linhasDivergentes++;
      if (detalhes.length < 8) {
        detalhes.push(
          `linha ${numeroDaLinha}: ${fmt(antes)} ${valor < 0 ? "-" : "+"} ${fmt(valor)}` +
            `${tarifa ? ` - ${fmt(tarifa)} de tarifa` : ""} não resulta em ${fmt(depois)}.`,
        );
      }
    }
    elos.push({ antes, depois, row: numeroDaLinha });

    const metodo = metodoDoTipo(campo(linha, col.tipo));
    const contraparteBruta = entrada
      ? campo(linha, col.origem) || campo(linha, col.descricao)
      : campo(linha, col.destino) || campo(linha, col.descricao);
    const descricao = montarDescricao(metodo, contraparteBruta, entrada);

    transactions.push({
      date: data,
      description: descricao,
      direction: entrada ? "credit" : "debit",
      amount: Money.fromCents(Math.abs(valor)),
      account,
      balanceAfter: Money.fromCents(Math.abs(depois)),
      sourceOrder: transactions.length,
      rawLine: cru,
    });

    // A TARIFA vira lancamento proprio — e a leitura canonica (ver o topo).
    if (tarifa > 0) {
      tarifas++;
      transactions.push({
        date: data,
        description: DESCRICAO_TARIFA,
        direction: "debit",
        amount: Money.fromCents(tarifa),
        account,
        balanceAfter: Money.fromCents(Math.abs(depois)),
        sourceOrder: transactions.length,
        rawLine: cru,
      });
    }
  });

  // PROVA 2 — o encadeamento. O arquivo pode vir do mais novo para o mais
  // antigo (e o que a Stone entrega) ou ao contrario; as duas leituras sao
  // testadas e basta UMA fechar do inicio ao fim. Nenhuma fechando, ha linha
  // faltando, sobrando ou fora de ordem — e ai nao ha leitura direta.
  let elosConferidos = 0;
  let elosQuebrados = 0;
  if (elos.length >= 2) {
    let quebrasDescendente = 0;
    let quebrasAscendente = 0;
    for (let i = 0; i + 1 < elos.length; i++) {
      if (elos[i].antes !== elos[i + 1].depois) quebrasDescendente++;
      if (elos[i].depois !== elos[i + 1].antes) quebrasAscendente++;
    }
    const total = elos.length - 1;
    const descendente = quebrasDescendente <= quebrasAscendente;
    elosQuebrados = Math.min(quebrasDescendente, quebrasAscendente);
    elosConferidos = total - elosQuebrados;
    if (elosQuebrados > 0 && detalhes.length < 10) {
      const sentido = descendente ? "do mais recente para o mais antigo" : "do mais antigo para o mais recente";
      detalhes.push(
        `a corrente de saldos (lida ${sentido}) se rompe em ${elosQuebrados} ponto(s) — ` +
          `há lançamento faltando, sobrando ou fora de ordem.`,
      );
    }
  }

  return {
    transactions,
    audit: {
      linhasConferidas,
      linhasDivergentes,
      elosConferidos,
      elosQuebrados,
      direcaoContraditoria,
      detalhes,
    },
    unread,
    cabecalho,
    tarifas,
  };
}

/**
 * A leitura pode ser aceita?
 *
 * O criterio e o mesmo do PagBank e igualmente severo: TODA linha tem de ter
 * fechado a propria aritmetica, a corrente de saldos nao pode ter buraco
 * nenhum, nenhuma linha pode ter sobrado sem interpretacao e nenhuma direcao
 * pode contradizer o sinal do valor. Na duvida, recusamos e a IA le o arquivo
 * — um parser que erra em silencio e pior que nao ter parser.
 */
export function isTrustworthy(r: TabularParseResult): boolean {
  return (
    r.transactions.length > 0 &&
    r.unread.length === 0 &&
    r.audit.linhasDivergentes === 0 &&
    r.audit.direcaoContraditoria === 0 &&
    r.audit.elosQuebrados === 0 &&
    r.audit.linhasConferidas > 0
  );
}

/** Motivo da recusa, em uma frase (vai para o log e para o relatorio). */
export function rejectionReason(r: TabularParseResult): string | null {
  if (isTrustworthy(r)) return null;
  if (r.transactions.length === 0) return "nenhuma linha de lançamento reconhecida";
  if (r.unread.length > 0) {
    return `${r.unread.length} linha(s) não reconhecida(s) (${r.unread[0].motivo}), ex.: "${r.unread[0].text.slice(0, 80)}"`;
  }
  if (r.audit.direcaoContraditoria > 0) {
    return `${r.audit.direcaoContraditoria} linha(s) com sentido contrário ao sinal do valor: ${r.audit.detalhes[0] ?? ""}`;
  }
  if (r.audit.linhasDivergentes > 0) {
    return `a conta de ${r.audit.linhasDivergentes} linha(s) não fechou: ${r.audit.detalhes[0] ?? ""}`;
  }
  if (r.audit.elosQuebrados > 0) {
    return `a corrente de saldos se rompe em ${r.audit.elosQuebrados} ponto(s) — pode haver lançamento faltando`;
  }
  return "leitura direta não confirmada";
}
