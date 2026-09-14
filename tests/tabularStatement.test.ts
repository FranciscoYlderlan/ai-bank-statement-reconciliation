import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { sniffFileKind, decodeText } from "../src/adapters/parsers/fileKind";
import { parseCsv, sniffDelimiter } from "../src/adapters/parsers/csvTable";
import { readFirstSheet, SpreadsheetReadError } from "../src/adapters/parsers/xlsxTable";
import {
  TABULAR_PARSER_ID,
  isTabularStatement,
  isTrustworthy,
  metodoDoTipo,
  montarDescricao,
  parseDataTabular,
  parseTabularStatement,
  parseValorTabular,
  rejectionReason,
} from "../src/adapters/parsers/tabularStatement";
import {
  HybridStatementParser,
  LegacyXlsError,
  MemoPageTextExtractor,
  StrategyInfo,
} from "../src/adapters/parsers/hybrid";
import { RawStatement, StatementParser } from "../src/application/ports";
import { Transaction } from "../src/domain/transaction";
import { applyHouseRules } from "../src/domain/houseRules";

/**
 * T-TABULAR — extrato TABULAR (CSV e planilha) lido de forma DETERMINISTICA.
 *
 * A fixture e um recorte de 16 linhas do extrato real da Stone (agosto/2026),
 * com os nomes trocados e os documentos mascarados; os VALORES e os SALDOS sao
 * os do arquivo original, porque e sobre eles que a conferencia roda. O recorte
 * e contiguo de proposito: a corrente de saldos so fecha se nenhuma linha do
 * meio tiver sido removida — que e justamente o que o parser precisa provar.
 *
 * Tres das 16 linhas cobram tarifa, entao a leitura correta rende 19
 * lancamentos: 16 movimentacoes + 3 tarifas como saida propria.
 */

const here = dirname(fileURLToPath(import.meta.url));
const csvTexto = readFileSync(join(here, "fixtures", "stone_extrato.csv"), "utf-8");
const rows = parseCsv(csvTexto);

const LINHAS = 16;
const TARIFAS = 3;
const LANCAMENTOS = LINHAS + TARIFAS;

/* ── o tipo do arquivo vem dos BYTES ────────────────────────────────────── */

describe("T-TIPO — o tipo do arquivo é decidido pelo conteúdo, não pela extensão", () => {
  const bytesDe = (s: string) => new TextEncoder().encode(s);

  it("PDF pela assinatura %PDF", () => {
    expect(sniffFileKind(bytesDe("%PDF-1.4\n..."), "extrato.pdf")).toBe("pdf");
  });

  it("CSV é texto", () => {
    expect(sniffFileKind(bytesDe(csvTexto), "extrato.csv")).toBe("text");
  });

  it("OFX é reconhecido pelo cabeçalho, mesmo salvo como .txt", () => {
    expect(sniffFileKind(bytesDe("OFXHEADER:100\nDATA:OFXSGML\n"), "extrato.txt")).toBe("ofx");
  });

  it("OFX 2.x (XML) também", () => {
    expect(sniffFileKind(bytesDe('<?xml version="1.0"?>\n<OFX>\n'), "x.ofx")).toBe("ofx");
  });

  it("o .xls da Stone é, por dentro, um .xlsx — e é assim que ele é tratado", async () => {
    const bytes = await planilhaMinima([["Data"], ["01/08/2026"]]);
    // o nome mente; os bytes nao
    expect(sniffFileKind(bytes, "extrato-ABC.xls")).toBe("spreadsheet");
  });

  it("o .xls ANTIGO (OLE2) é reconhecido como tal, para poder ser recusado com explicação", () => {
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(sniffFileKind(ole2, "extrato.xls")).toBe("xls-legacy");
  });

  it("acento sobrevive quando o arquivo é UTF-8 apesar de dizer que é 1252", () => {
    const utf8 = new TextEncoder().encode("CHARSET:1252\nTransferência | Pix");
    expect(decodeText(utf8)).toContain("Transferência");
  });

  it("e sobrevive também quando é mesmo Windows-1252", () => {
    // "Transferência" em 1252: o ê e o byte 0xEA, sequencia invalida em UTF-8
    const w1252 = new Uint8Array([0x54, 0x72, 0x61, 0x6e, 0x73, 0x66, 0x65, 0x72, 0xea, 0x6e, 0x63, 0x69, 0x61]);
    expect(decodeText(w1252)).toBe("Transferência");
  });
});

/* ── o CSV brasileiro ───────────────────────────────────────────────────── */

describe("leitura de CSV", () => {
  it("não quebra o valor entre aspas na vírgula decimal", () => {
    const t = 'Valor,Tipo\n"1.234,56",Pix\n';
    expect(parseCsv(t)).toEqual([
      ["Valor", "Tipo"],
      ["1.234,56", "Pix"],
    ]);
  });

  it("descobre o separador FORA das aspas (ponto-e-vírgula do Excel pt-BR)", () => {
    const t = 'Valor;Tipo\n"1.234,56";Pix\n';
    expect(sniffDelimiter(t)).toBe(";");
    expect(parseCsv(t)[1]).toEqual(["1.234,56", "Pix"]);
  });

  it("aspas duplicadas dentro do campo viram uma só", () => {
    expect(parseCsv('a,b\n"diz ""oi""",2\n')[1]).toEqual(['diz "oi"', "2"]);
  });

  it("a fixture real abre com cabeçalho e 16 linhas", () => {
    expect(rows.length).toBe(LINHAS + 1);
    expect(rows[0]).toContain("Saldo antes");
    expect(rows[0]).toContain("Saldo depois");
  });
});

/* ── valores e datas ────────────────────────────────────────────────────── */

describe("leitura de valores e datas", () => {
  it("valor pt-BR com R$, milhar e sinal", () => {
    expect(parseValorTabular("R$ 1.234,56")).toBe(123456);
    expect(parseValorTabular("-94,00")).toBe(-9400);
    expect(parseValorTabular("R$ 0,00")).toBe(0);
  });

  it('"Grátis" não é zero: é ausência de valor', () => {
    expect(parseValorTabular("Grátis")).toBeNull();
    expect(parseValorTabular("")).toBeNull();
  });

  it("texto que deveria ser número devolve NaN — e vira linha não lida", () => {
    expect(Number.isNaN(parseValorTabular("aproximadamente 20"))).toBe(true);
  });

  it("a hora da coluna Data é descartada", () => {
    expect(parseDataTabular("31/08/2026 20:02")).toEqual({ year: 2026, month: 8, day: 31 });
    expect(parseDataTabular("01/08/26")).toEqual({ year: 2026, month: 8, day: 1 });
  });
});

/* ── a descricao no padrao da planilha ──────────────────────────────────── */

describe("T-PADRAO — a descrição sai no padrão que a planilha pratica", () => {
  it("o vocabulário do extrato vira o vocabulário da planilha", () => {
    expect(metodoDoTipo("Pix")).toBe("Pix");
    expect(metodoDoTipo("Transação")).toBe("Maquininha");
    expect(metodoDoTipo("Recebível de Cartão")).toBe("Cartão");
    expect(metodoDoTipo("Transferência entre contas Stone")).toBe("Antecipação");
  });

  it("tipo desconhecido não vira chute: passa como veio", () => {
    expect(metodoDoTipo("Resgate CDB")).toBe("Resgate CDB");
  });

  it("`Método - CONTRAPARTE`, como o cliente escreve", () => {
    expect(montarDescricao("Pix", "ACAI DO LARGO", true)).toBe("Pix - ACAI DO LARGO");
  });

  it("sem contraparte, uma ENTRADA usa a frase do próprio banco", () => {
    expect(montarDescricao("Cartão", "Desconhecido", true)).toBe("Cartão - Recebimento vendas");
  });

  it("e é esse padrão que faz a regra da casa disparar sem IA", () => {
    const cats = ["Recebimento de venda", "Taxa de cartão", "Fornecedor"];
    expect(applyHouseRules("Pix - ACAI DO LARGO", "entrada", cats)?.option).toBe(
      "Recebimento de venda",
    );
    expect(applyHouseRules("Tarifa", "saida", cats)?.option).toBe("Taxa de cartão");
    // a direcao e parte da regra: o mesmo texto saindo nao e venda nenhuma
    expect(applyHouseRules("Pix - ACAI DO LARGO", "saida", cats)).toBeNull();
  });
});

/* ── a leitura e a prova ────────────────────────────────────────────────── */

describe("T-TABULAR — leitura determinística do extrato real", () => {
  it("reconhece o layout pela PROVA (saldo antes e depois), não pela marca do banco", () => {
    expect(isTabularStatement(rows)).toBe(true);
    expect(isTabularStatement([["Data", "Descrição", "Valor"], ["01/08/2026", "x", "10,00"]])).toBe(
      false,
    );
  });

  it("lê as 16 linhas e transforma as 3 tarifas em lançamento próprio", () => {
    const r = parseTabularStatement(rows);
    expect(r.transactions.length).toBe(LANCAMENTOS);
    expect(r.tarifas).toBe(TARIFAS);
    expect(r.transactions.filter((t) => t.description === "Tarifa").length).toBe(TARIFAS);
  });

  it("a tarifa entra como SAÍDA, no valor da coluna Tarifa", () => {
    const r = parseTabularStatement(rows);
    const tarifa = r.transactions.find((t) => t.description === "Tarifa")!;
    expect(tarifa.direction).toBe("debit");
    expect(tarifa.amount.cents).toBeGreaterThan(0);
    expect(tarifa.amount.cents).toBeLessThan(100); // centavos, nao reais
  });

  it("o valor da venda continua BRUTO — a tarifa não é descontada dele", () => {
    const r = parseTabularStatement(rows);
    const maquininha = r.transactions.find((t) => t.description.startsWith("Maquininha"))!;
    expect(maquininha.amount.cents).toBe(2500);
    expect(maquininha.direction).toBe("credit");
  });

  it("a conta sai do lado do TITULAR e é a mesma para todos os lançamentos", () => {
    const r = parseTabularStatement(rows);
    expect(r.cabecalho.instituicao).toContain("Stone");
    expect(r.cabecalho.conta).toBe("11223344-5");
    const ids = new Set(r.transactions.map((t) => t.account.id));
    expect([...ids]).toEqual(["stone-112233445"]);
  });

  it("PROVA 1 — toda linha fecha a própria conta (antes + valor − tarifa = depois)", () => {
    const r = parseTabularStatement(rows);
    expect(r.audit.linhasConferidas).toBe(LINHAS);
    expect(r.audit.linhasDivergentes).toBe(0);
  });

  it("PROVA 2 — os saldos encadeiam do começo ao fim, sem buraco", () => {
    const r = parseTabularStatement(rows);
    expect(r.audit.elosConferidos).toBe(LINHAS - 1);
    expect(r.audit.elosQuebrados).toBe(0);
  });

  it("nenhuma linha fica sem interpretação, e a leitura é aceita", () => {
    const r = parseTabularStatement(rows);
    expect(r.unread).toEqual([]);
    expect(isTrustworthy(r)).toBe(true);
    expect(rejectionReason(r)).toBeNull();
  });
});

/* ── a recusa: o que faz a leitura direta perder para a IA ───────────────── */

describe("T-TABULAR — a leitura direta se recusa quando a prova não fecha", () => {
  it("lançamento FALTANDO rompe a corrente de saldos", () => {
    const furado = [rows[0], ...rows.slice(1, 5), ...rows.slice(6)];
    const r = parseTabularStatement(furado);
    expect(r.audit.elosQuebrados).toBeGreaterThan(0);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/corrente de saldos/);
  });

  it("lançamento DUPLICADO rompe a corrente também", () => {
    const dobrado = [rows[0], rows[1], rows[1], ...rows.slice(2)];
    const r = parseTabularStatement(dobrado);
    expect(isTrustworthy(r)).toBe(false);
  });

  it("valor adulterado derruba a conta da própria linha", () => {
    const adulterado = rows.map((l) => [...l]);
    adulterado[1][2] = "171,00"; // era 161,00
    const r = parseTabularStatement(adulterado);
    expect(r.audit.linhasDivergentes).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/não fechou/);
  });

  it("tarifa ignorada NÃO passa: a linha com tarifa só fecha se a tarifa entrar na conta", () => {
    const semTarifa = rows.map((l) => [...l]);
    const iTarifa = semTarifa.findIndex((l, i) => i > 0 && /^R\$ 0,[1-9]/.test(l[5] ?? ""));
    expect(iTarifa).toBeGreaterThan(0);
    semTarifa[iTarifa][5] = "Grátis";
    const r = parseTabularStatement(semTarifa);
    expect(r.audit.linhasDivergentes).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
  });

  it("sentido declarado que contradiz o sinal do valor também recusa", () => {
    const trocado = rows.map((l) => [...l]);
    trocado[1][0] = "Débito"; // valor continua positivo
    const r = parseTabularStatement(trocado);
    expect(r.audit.direcaoContraditoria).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/sentido contrário/);
  });

  it("linha ilegível no meio da tabela conta como não lida", () => {
    const sujo = rows.map((l) => [...l]);
    sujo[3][6] = "algum dia de agosto";
    const r = parseTabularStatement(sujo);
    expect(r.unread.length).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/não reconhecida/);
  });

  it("extrato em ordem CRESCENTE fecha igual — a corrente é testada nos dois sentidos", () => {
    const crescente = [rows[0], ...rows.slice(1).reverse()];
    const r = parseTabularStatement(crescente);
    expect(r.audit.elosQuebrados).toBe(0);
    expect(isTrustworthy(r)).toBe(true);
  });
});

/* ── a planilha ─────────────────────────────────────────────────────────── */

/** Monta um .xlsx minimo (uma aba, strings inline) para exercitar o leitor. */
async function planilhaMinima(matriz: string[][], nome = "Extrato"): Promise<Uint8Array> {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const col = (n: number) => {
    let s = "";
    let x = n;
    while (x > 0) {
      s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
      x = Math.floor((x - 1) / 26);
    }
    return s;
  };
  const linhas = matriz
    .map(
      (linha, i) =>
        `<row r="${i + 1}">` +
        linha
          .map((v, j) => `<c r="${col(j + 1)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)
          .join("") +
        `</row>`,
    )
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(nome)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("T-PLANILHA — a mesma leitura, vindo de .xls/.xlsx", () => {
  it("a planilha e o CSV produzem exatamente os mesmos lançamentos", async () => {
    const bytes = await planilhaMinima(rows);
    const table = await readFirstSheet(bytes);
    expect(table.sheetName).toBe("Extrato");
    const daPlanilha = parseTabularStatement(table.rows);
    const doCsv = parseTabularStatement(rows);
    expect(isTrustworthy(daPlanilha)).toBe(true);
    expect(daPlanilha.transactions.map((t) => `${t.description}|${t.amount.cents}|${t.direction}`)).toEqual(
      doCsv.transactions.map((t) => `${t.description}|${t.amount.cents}|${t.direction}`),
    );
  });

  it("célula ausente não desloca a linha: a coluna é dada pela referência", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    // a linha 2 pula a coluna B
    zip.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>um</t></is></c><c r="B1" t="inlineStr"><is><t>dois</t></is></c><c r="C1" t="inlineStr"><is><t>tres</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="C2" t="inlineStr"><is><t>z</t></is></c></row></sheetData></worksheet>`,
    );
    const table = await readFirstSheet(await zip.generateAsync({ type: "uint8array" }));
    expect(table.rows[1]).toEqual(["x", "", "z"]);
  });

  it("um ZIP que não é planilha vira erro explicado, não leitura errada", async () => {
    const zip = new JSZip();
    zip.file("leiame.txt", "nada aqui");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(readFirstSheet(bytes)).rejects.toBeInstanceOf(SpreadsheetReadError);
  });
});

/* ── o roteamento ───────────────────────────────────────────────────────── */

function aiFake(txs: Transaction[] = []): StatementParser & { chamou: boolean } {
  const parser = {
    id: "ai",
    chamou: false,
    canParse: () => true,
    parse: async () => {
      parser.chamou = true;
      return txs;
    },
  };
  return parser;
}

const pdfTextNunca = new MemoPageTextExtractor({ extractPages: async () => [] });

describe("T-ROTA — o roteador manda cada formato para o parser certo", () => {
  const bytesDe = (s: string) => new TextEncoder().encode(s);

  it("CSV conferível é lido direto e a IA nem é chamada", async () => {
    const ai = aiFake();
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: pdfTextNunca,
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await parser.parse({ fileName: "extrato.csv", bytes: bytesDe(csvTexto) });
    expect(ai.chamou).toBe(false);
    expect(txs.length).toBe(LANCAMENTOS);
    expect(info!.kind).toBe("deterministic");
    expect(info!.parserId).toBe(TABULAR_PARSER_ID);
  });

  it("planilha conferível também", async () => {
    const ai = aiFake();
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: pdfTextNunca,
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const bytes = await planilhaMinima(rows);
    const txs = await parser.parse({ fileName: "extrato-ABC.xls", bytes });
    expect(ai.chamou).toBe(false);
    expect(txs.length).toBe(LANCAMENTOS);
    expect(info!.parserId).toBe(TABULAR_PARSER_ID);
  });

  it("CSV sem coluna de saldo NÃO é lido direto: vai para a IA, com o motivo", async () => {
    const ai = aiFake([]);
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: pdfTextNunca,
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    await parser.parse({
      fileName: "outro.csv",
      bytes: bytesDe("Data,Descrição,Valor\n01/08/2026,Pix,10\n"),
    });
    expect(ai.chamou).toBe(true);
    expect(info!.kind).toBe("ai");
    expect(info!.reason).toMatch(/saldo antes\/depois/);
  });

  it("CSV com a corrente rompida vai para a IA, e o motivo diz o que houve", async () => {
    const ai = aiFake([]);
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: pdfTextNunca,
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const furado = [rows[0], ...rows.slice(1, 5), ...rows.slice(6)]
      .map((l) => l.map((c) => (/[,"]/.test(c) ? `"${c}"` : c)).join(","))
      .join("\n");
    await parser.parse({ fileName: "furado.csv", bytes: bytesDe(furado) });
    expect(ai.chamou).toBe(true);
    expect(info!.reason).toMatch(/corrente de saldos/);
  });

  it("o .xls ANTIGO para com uma frase que resolve — nunca vira prompt de IA", async () => {
    const ai = aiFake();
    const parser = new HybridStatementParser({
      ai,
      pdfText: pdfTextNunca,
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const ole2 = new Uint8Array(64);
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(parser.parse({ fileName: "antigo.xls", bytes: ole2 })).rejects.toBeInstanceOf(
      LegacyXlsError,
    );
    expect(ai.chamou).toBe(false);
  });

  it("arquivo vazio (buffer desanexado) explica o que fazer", async () => {
    const parser = new HybridStatementParser({
      ai: aiFake(),
      pdfText: pdfTextNunca,
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const raw: RawStatement = { fileName: "x.csv", bytes: new Uint8Array(0) };
    await expect(parser.parse(raw)).rejects.toThrow(/Selecione o arquivo novamente/);
  });
});
