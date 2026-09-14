import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OFX_PARSER_ID,
  descricaoDoMemo,
  isOfxStatement,
  isTrustworthy,
  metodoDoInstrumento,
  parseOfx,
  parseOfxAmount,
  parseOfxDate,
  rejectionReason,
} from "../src/adapters/parsers/ofxStatement";
import { HybridStatementParser, MemoPageTextExtractor, StrategyInfo } from "../src/adapters/parsers/hybrid";
import { StatementParser } from "../src/application/ports";
import { applyHouseRules } from "../src/domain/houseRules";

/**
 * T-OFX — leitura DETERMINISTICA do OFX.
 *
 * A fixture reproduz as mesmas 16 movimentacoes da fixture do extrato tabular,
 * no formato que a Stone entrega: OFX 1.x (SGML), cabecalho declarando
 * CHARSET:1252 e conteudo em UTF-8, e — o detalhe que muda a contagem — o valor
 * das vendas por maquininha JA LIQUIDO da tarifa. Por isso aqui sao 16
 * lancamentos, e nao os 19 do CSV: a tarifa nao existe como linha neste
 * formato, e nao ha como reconstrui-la.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ofxTexto = readFileSync(join(here, "fixtures", "stone_extrato.ofx"), "utf-8");

const LANCAMENTOS = 16;

describe("reconhecimento do OFX", () => {
  it("reconhece o 1.x (SGML) pelo cabeçalho e pela lista de transações", () => {
    expect(isOfxStatement(ofxTexto)).toBe(true);
  });

  it("reconhece o 2.x (XML)", () => {
    expect(isOfxStatement('<?xml version="1.0"?><OFX><STMTTRN></STMTTRN></OFX>')).toBe(true);
  });

  it("cabeçalho sem lista de transações não é extrato", () => {
    expect(isOfxStatement("OFXHEADER:100\nDATA:OFXSGML\n<OFX></OFX>")).toBe(false);
  });
});

describe("leitura de campos do OFX", () => {
  it("data descarta hora e fuso", () => {
    expect(parseOfxDate("20260831200244")).toEqual({ year: 2026, month: 8, day: 31 });
    expect(parseOfxDate("20260801000000[-3:BRT]")).toEqual({ year: 2026, month: 8, day: 1 });
  });

  it("valor com ponto decimal (o padrão do formato) e com vírgula (emissor br)", () => {
    expect(parseOfxAmount("161.00")).toBe(16100);
    expect(parseOfxAmount("-94.00")).toBe(-9400);
    expect(parseOfxAmount("1.234,56")).toBe(123456);
  });

  it("valor ilegível devolve NaN — e o bloco vira lançamento não lido", () => {
    expect(Number.isNaN(parseOfxAmount("uns cem reais"))).toBe(true);
  });

  it("a tag fechada (2.x) e a aberta (1.x) são lidas do mesmo jeito", () => {
    const fechada = parseOfx(
      "<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260801</DTPOSTED><TRNAMT>10.00</TRNAMT><MEMO>x</MEMO></STMTTRN></BANKTRANLIST></OFX>",
    );
    const aberta = parseOfx(
      "<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260801<TRNAMT>10.00<MEMO>x</STMTTRN></BANKTRANLIST></OFX>",
    );
    expect(fechada.transactions[0].amount.cents).toBe(1000);
    expect(aberta.transactions[0].amount.cents).toBe(1000);
  });
});

describe("T-PADRAO — o MEMO vira a descrição no padrão da planilha", () => {
  it("o instrumento é reconhecido, não a bandeira do cartão", () => {
    expect(metodoDoInstrumento("Transferência | Pix")).toBe("Pix");
    expect(metodoDoInstrumento("Pix | Maquininha")).toBe("Maquininha");
    expect(metodoDoInstrumento("Antecipação | Crédito")).toBe("Antecipação");
    expect(metodoDoInstrumento("Maestro | Débito")).toBe("Cartão");
    expect(metodoDoInstrumento("Visa Electron | Débito")).toBe("Cartão");
  });

  it("`NOME - Instrumento` vira `Método - NOME`", () => {
    expect(descricaoDoMemo("ACAI DO LARGO - Transferência | Pix", true)).toBe("Pix - ACAI DO LARGO");
  });

  it("memo de outro banco, que não segue esse formato, passa intacto", () => {
    expect(descricaoDoMemo("COMPRA CARTAO 1234 SUPERMERCADO", false)).toBe(
      "COMPRA CARTAO 1234 SUPERMERCADO",
    );
  });

  it("e a descrição resultante faz a regra da casa disparar sem IA", () => {
    const cats = ["Recebimento de venda", "Taxa de cartão"];
    const d = descricaoDoMemo("ACAI DO LARGO - Pix | Maquininha", true);
    expect(d).toBe("Maquininha - ACAI DO LARGO");
    expect(applyHouseRules(d, "entrada", cats)?.option).toBe("Recebimento de venda");
  });
});

describe("T-OFX — leitura determinística do arquivo real", () => {
  it("lê a conta e o período declarados no arquivo", () => {
    const r = parseOfx(ofxTexto);
    expect(r.cabecalho.instituicao).toContain("Stone");
    expect(r.cabecalho.conta).toBe("11223344-5");
    expect(r.cabecalho.periodoInicio).toEqual({ year: 2026, month: 8, day: 1 });
    expect(r.cabecalho.periodoFim).toEqual({ year: 2026, month: 8, day: 31 });
    expect(r.cabecalho.saldoFinal).toBe(87004);
  });

  it("a conta é a MESMA do CSV — os dois caminhos têm de chegar no mesmo id", () => {
    const r = parseOfx(ofxTexto);
    expect(new Set(r.transactions.map((t) => t.account.id))).toEqual(new Set(["stone-112233445"]));
  });

  it("todo bloco declarado vira lançamento — nada some, nada sobra", () => {
    const r = parseOfx(ofxTexto);
    expect(r.audit.declarados).toBe(LANCAMENTOS);
    expect(r.audit.lidos).toBe(LANCAMENTOS);
    expect(r.unread).toEqual([]);
    expect(r.audit.sobras).toEqual([]);
    expect(isTrustworthy(r)).toBe(true);
    expect(rejectionReason(r)).toBeNull();
  });

  it("a direção vem do sinal do valor", () => {
    const r = parseOfx(ofxTexto);
    expect(r.transactions[0].direction).toBe("credit");
    expect(r.transactions[1].direction).toBe("debit");
    expect(r.transactions[1].amount.cents).toBe(9400);
  });

  it("acento sobrevive: o arquivo diz 1252 e é UTF-8", () => {
    const r = parseOfx(ofxTexto);
    expect(r.cabecalho.instituicao).toBe("Stone Instituição de Pagamento S.A.");
  });

  it("avisa que o valor já vem líquido da tarifa — é o que explica a contagem menor", () => {
    const r = parseOfx(ofxTexto);
    expect(r.avisos.join(" ")).toMatch(/líquido da tarifa/);
    const maquininha = r.transactions.find((t) => t.description.startsWith("Maquininha"))!;
    expect(maquininha.amount.cents).toBe(2476); // 25,00 menos 0,24 de tarifa
  });
});

describe("T-OFX — a leitura direta se recusa quando a estrutura não fecha", () => {
  it("bloco sem data é lançamento não lido", () => {
    const r = parseOfx(ofxTexto.replace("<DTPOSTED>20260831200200</DTPOSTED>", ""));
    expect(r.unread.length).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/ilegível/);
  });

  it("TRNTYPE que contradiz o sinal do valor recusa a leitura", () => {
    const r = parseOfx(ofxTexto.replace("<TRNTYPE>DEBIT</TRNTYPE>", "<TRNTYPE>CREDIT</TRNTYPE>"));
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/não combina/);
  });

  it("marcação desconhecida DENTRO da lista de transações recusa — pode ser lançamento que não sabemos ler", () => {
    const r = parseOfx(
      ofxTexto.replace("</BANKTRANLIST>", "<STMTTRNP2P><VALOR>10.00</VALOR></STMTTRNP2P></BANKTRANLIST>"),
    );
    expect(r.audit.sobras).toContain("STMTTRNP2P");
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/marcações não interpretadas/);
  });

  it("data fora do período declarado no próprio arquivo recusa", () => {
    const r = parseOfx(ofxTexto.replace("<DTPOSTED>20260831200200</DTPOSTED>", "<DTPOSTED>20260731200200</DTPOSTED>"));
    expect(r.audit.foraDoPeriodo).toBe(1);
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/fora do período/);
  });

  it("arquivo sem nenhum bloco não é lido direto", () => {
    const r = parseOfx("<OFX><BANKTRANLIST></BANKTRANLIST></OFX>");
    expect(isTrustworthy(r)).toBe(false);
    expect(rejectionReason(r)).toMatch(/nenhum bloco/);
  });
});

function aiFake(): StatementParser & { chamou: boolean } {
  const parser = {
    id: "ai",
    chamou: false,
    canParse: () => true,
    parse: async () => {
      parser.chamou = true;
      return [];
    },
  };
  return parser;
}

describe("T-ROTA — o OFX é lido direto, e os avisos chegam ao relatório", () => {
  it("a IA não é chamada, e a estratégia carrega o aviso da tarifa embutida", async () => {
    const ai = aiFake();
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: new MemoPageTextExtractor({ extractPages: async () => [] }),
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await parser.parse({
      fileName: "extrato.ofx",
      bytes: new TextEncoder().encode(ofxTexto),
    });
    expect(ai.chamou).toBe(false);
    expect(txs.length).toBe(LANCAMENTOS);
    expect(info!.parserId).toBe(OFX_PARSER_ID);
    expect(info!.avisos?.join(" ")).toMatch(/líquido da tarifa/);
  });

  it("um OFX salvo como .txt continua sendo lido como OFX", async () => {
    const ai = aiFake();
    const parser = new HybridStatementParser({
      ai,
      pdfText: new MemoPageTextExtractor({ extractPages: async () => [] }),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const txs = await parser.parse({
      fileName: "extrato.txt",
      bytes: new TextEncoder().encode(ofxTexto),
    });
    expect(ai.chamou).toBe(false);
    expect(txs.length).toBe(LANCAMENTOS);
  });

  it("OFX quebrado cai para a IA, com o motivo", async () => {
    const ai = aiFake();
    let info: StrategyInfo | null = null;
    const parser = new HybridStatementParser({
      ai,
      pdfText: new MemoPageTextExtractor({ extractPages: async () => [] }),
      onStrategy: (i) => (info = i),
      validacaoIa: { ativa: false },
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    await parser.parse({
      fileName: "x.ofx",
      bytes: new TextEncoder().encode(ofxTexto.replace(/<TRNAMT>161.00<\/TRNAMT>/, "<TRNAMT>cento e sessenta e um</TRNAMT>")),
    });
    expect(ai.chamou).toBe(true);
    expect(info!.kind).toBe("ai");
    expect(info!.reason).toMatch(/ilegível/);
  });
});
