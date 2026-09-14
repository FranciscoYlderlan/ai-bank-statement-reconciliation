import { describe, it, expect } from "vitest";
import {
  AiClient,
  AiExtractionRequest,
  AiError,
  RawStatement,
} from "../src/application/ports";
import {
  AiStatementParser,
  AiRuntimeConfig,
  AiProgress,
} from "../src/adapters/ai/aiStatementParser";
import { parseExtractionTransactions } from "../src/adapters/ai/schema";
import { withDedupHashes } from "../src/domain/transaction";
import { deduplicate } from "../src/application/deduplicate";
import { competenceOf, competenceKey } from "../src/domain/competence";

/**
 * Testes DETERMINISTICOS do PIPELINE de IA (mockam o provedor — sem rede/API).
 * O mock responde diferente para a etapa de RECONHECIMENTO e a de EXTRACAO,
 * conforme o system prompt. Substituem os antigos testes de contagem por banco.
 */

const RECOGNITION = JSON.stringify({
  instituicao: "Stone Instituicao de Pagamento S.A.",
  numero: "892952680",
  rotuloEntrada: "Entrada",
  rotuloSaida: "Saida",
  excluir: ["Saldo do dia"],
  observacoes: "VALOR e o movimentado; SALDO e informativo",
});

/** Mock que distingue reconhecimento (systemPrompt tem 'NAO extrai') de extracao. */
class MockAiClient implements AiClient {
  lastRequest?: AiExtractionRequest;
  calls: AiExtractionRequest[] = [];
  constructor(
    private readonly extraction: string,
    private readonly recognition: string = RECOGNITION,
  ) {}
  async complete(req: AiExtractionRequest): Promise<string> {
    this.lastRequest = req;
    this.calls.push(req);
    return req.systemPrompt.includes("NAO extrai") ? this.recognition : this.extraction;
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

const cfg: AiRuntimeConfig = { provider: "openai", model: "gpt-4o", supportsDocument: true };

const SAMPLE = JSON.stringify({
  transacoes: [
    { data: "2026-07-31", descricao: "MARIA DA SILVA | Transferencia Pix", direcao: "saida", valor: 1008.0, saldoApos: 499.49 },
    { data: "2026-07-31", descricao: "ANDREA COSTA | Pix Maquininha", direcao: "entrada", valor: 57.0, saldoApos: 1510.49 },
    { data: "2026-08-07", descricao: "Tarifa", direcao: "saida", valor: 0.56, saldoApos: 377.46 },
  ],
});

// PDF sem extrator de texto injetado -> vira 1 "chunk" de documento nativo
// (1 chamada de reconhecimento + 1 de extracao).
const pdfRaw: RawStatement = { fileName: "extrato.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) };

function parser(extraction: string, recognition?: string) {
  return new AiStatementParser({
    client: new MockAiClient(extraction, recognition),
    resolveConfig: () => cfg,
  });
}

describe("AiStatementParser — pipeline reconhecer → extrair → montar", () => {
  it("converte todas as transacoes preservando a ordem", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    expect(txs.length).toBe(3);
    expect(txs.map((t) => t.sourceOrder)).toEqual([0, 1, 2]);
  });

  it("mapeia direcao entrada->credit e saida->debit", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    expect(txs[0].direction).toBe("debit");
    expect(txs[1].direction).toBe("credit");
  });

  it("dinheiro em centavos; VALOR (nao o saldo) vira amount", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    expect(txs[0].amount.cents).toBe(100800); // valor 1008,00 (nao o saldo 499,49)
    expect(txs[2].amount.cents).toBe(56); // 0,56
    expect(txs[0].balanceAfter?.cents).toBe(49949); // saldo vai em balanceAfter
    expect(txs.every((t) => Number.isInteger(t.amount.cents) && t.amount.cents >= 0)).toBe(true);
  });

  it("conta (id estavel p/ dedup) vem do reconhecimento", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    expect(txs[0].account.id).toBe("stone-892952680");
  });

  it("particiona por competencia (julho vs agosto)", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    const comps = txs.map((t) => competenceKey(competenceOf(t.date)));
    expect(comps.filter((c) => c === "2026-07").length).toBe(2);
    expect(comps.filter((c) => c === "2026-08").length).toBe(1);
  });

  it("faz DUAS etapas: 1 reconhecimento + 1 extracao", async () => {
    const client = new MockAiClient(SAMPLE);
    const p = new AiStatementParser({ client, resolveConfig: () => cfg });
    await p.parse(pdfRaw);
    expect(client.calls.length).toBe(2);
    expect(client.calls[0].systemPrompt).toContain("NAO extrai");
  });

  it("envia o PDF como DOCUMENTO quando nao ha extrator de texto", async () => {
    const client = new MockAiClient(SAMPLE);
    const p = new AiStatementParser({ client, resolveConfig: () => cfg });
    await p.parse(pdfRaw);
    expect(client.lastRequest?.document?.mime).toBe("application/pdf");
  });

  it("pagina PDFs por pagina quando ha extrator de texto", async () => {
    const client = new MockAiClient(SAMPLE);
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: { extractPages: async () => ["pagina 1 texto", "pagina 2 texto", "pagina 3 texto"] },
    });
    await p.parse(pdfRaw);
    // 1 reconhecimento + 3 extracoes (uma por pagina)
    expect(client.calls.length).toBe(4);
    expect(client.calls.filter((c) => !c.systemPrompt.includes("NAO extrai")).length).toBe(3);
  });

  it("envia TEXTO (nao documento) para OFX/CSV", async () => {
    const client = new MockAiClient(SAMPLE);
    const p = new AiStatementParser({ client, resolveConfig: () => cfg });
    const csv = new TextEncoder().encode("Data;Descricao;Valor\n07/07/2026;Venda;32,00");
    await p.parse({ fileName: "extrato.csv", bytes: csv });
    expect(client.lastRequest?.document).toBeUndefined();
    expect(client.lastRequest?.userPrompt).toContain("Venda");
  });
});

describe("AiStatementParser — rede de seguranca e dedup", () => {
  it("descarta linhas de saldo mesmo se o modelo devolver", async () => {
    const withSaldo = JSON.stringify({
      transacoes: [
        { data: "2026-07-17", descricao: "Vendas - Disponivel PIX", direcao: "entrada", valor: 65.35, saldoApos: 250.38 },
        { data: "2026-07-17", descricao: "Saldo do dia", direcao: "entrada", valor: 250.38, saldoApos: null },
      ],
    });
    const txs = await parser(withSaldo).parse(pdfRaw);
    expect(txs.length).toBe(1);
    expect(txs[0].description).toContain("Vendas");
  });

  it("3 transacoes identicas no mesmo dia viram 3 novos", async () => {
    const three = JSON.stringify({
      transacoes: Array.from({ length: 3 }, () => ({
        data: "2026-08-04", descricao: "FULANO | Pix", direcao: "entrada", valor: 25.0, saldoApos: null,
      })),
    });
    const txs = await parser(three).parse(pdfRaw);
    const r = deduplicate(txs, new Set());
    expect(r.novos.length).toBe(3);
  });

  it("T-IDEM: reimportar o MESMO resultado nao insere nada", async () => {
    const txs = await parser(SAMPLE).parse(pdfRaw);
    const allKnown = new Set(withDedupHashes(txs).map((h) => h.hash));
    const r = deduplicate(txs, allKnown);
    expect(r.novos.length).toBe(0);
    expect(r.duplicados.length).toBe(3);
  });
});

describe("AiStatementParser — erros explicitos", () => {
  it("extracao com JSON invalido -> AiError('bad_schema')", async () => {
    await expect(parser("desculpe, nao consegui").parse(pdfRaw)).rejects.toMatchObject({ kind: "bad_schema" });
  });

  it("direcao fora do enum -> bad_schema", async () => {
    const bad = JSON.stringify({ transacoes: [{ data: "2026-08-01", descricao: "x", direcao: "credito", valor: 1, saldoApos: null }] });
    await expect(parser(bad).parse(pdfRaw)).rejects.toBeInstanceOf(AiError);
  });

  it("reconhecimento falho NAO derruba o pipeline (usa guia padrao)", async () => {
    // recognition invalido, extraction valido -> ainda extrai
    const txs = await parser(SAMPLE, "nao sei ler isso").parse(pdfRaw);
    expect(txs.length).toBe(3);
  });
});

/**
 * PIPELINE PARALELO (Estágio 2) — mock programável que distingue reconhecimento
 * de extração, mede a concorrência real, conta chamadas por partição e permite
 * simular falhas (transiente/permanente) e truncamento por partição.
 */
const noop = () => Promise.resolve();
const pages6: { extractPages: () => Promise<string[]> } = {
  extractPages: async () => ["PAG1", "PAG2", "PAG3", "PAG4", "PAG5", "PAG6"],
};
const pageTx = (k: number) =>
  JSON.stringify({
    transacoes: [
      { data: `2026-08-0${k}`, descricao: `Tx pagina ${k}`, direcao: "entrada", valor: k, saldoApos: null },
    ],
  });
/**
 * Recupera o trecho enviado ao modelo, removendo a numeracao "L<n>| " que o
 * prompt adiciona (a ancora de linha usada na associacao nome<->valor).
 */
function chunkOf(userPrompt: string): string {
  const m = userPrompt.match(/--- TRECHO DO EXTRATO[^\n]*---\n/);
  if (!m || m.index === undefined) return "";
  return userPrompt
    .slice(m.index + m[0].length)
    .split("\n")
    .map((l) => l.replace(/^L\d+\|\s?/, ""))
    .join("\n")
    .trim();
}

type Responder = (chunk: string, nthForChunk: number) => { text: string } | { throw: AiError };

class ProgrammableClient implements AiClient {
  calls: AiExtractionRequest[] = [];
  extractionCalls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  perChunkCalls = new Map<string, number>();
  constructor(
    private readonly responder: Responder,
    private readonly recognition: string = RECOGNITION,
    private readonly delayMs = 5,
  ) {}
  async complete(req: AiExtractionRequest): Promise<string> {
    this.calls.push(req);
    if (req.systemPrompt.includes("NAO extrai")) return this.recognition;
    this.extractionCalls++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      const chunk = chunkOf(req.userPrompt);
      const n = (this.perChunkCalls.get(chunk) ?? 0) + 1;
      this.perChunkCalls.set(chunk, n);
      const res = this.responder(chunk, n);
      if ("throw" in res) throw res.throw;
      return res.text;
    } finally {
      this.concurrent--;
    }
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

describe("AiStatementParser — Estágio 2 paralelo (concorrência, retry, falha isolada)", () => {
  it("processa 6 partições em paralelo e preserva a ordem final", async () => {
    const client = new ProgrammableClient((chunk) => ({ text: pageTx(Number(chunk.replace("PAG", ""))) }));
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: pages6,
      concurrency: 3,
      sleep: noop,
    });
    const txs = await p.parse(pdfRaw);
    expect(txs.map((t) => t.description)).toEqual([1, 2, 3, 4, 5, 6].map((k) => `Tx pagina ${k}`));
    expect(txs.map((t) => t.sourceOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    // rodou de fato em paralelo, respeitando o limite de concorrência
    expect(client.maxConcurrent).toBeGreaterThan(1);
    expect(client.maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("uma falha permanente NÃO derruba as demais (falha isolada) e o retry funciona", async () => {
    const responder: Responder = (chunk, n) => {
      const k = Number(chunk.replace("PAG", ""));
      if (k === 3) {
        // schema inválido e NÃO truncado -> falha permanente e isolada
        return { text: '{"transacoes":[{"data":"data-ruim","descricao":"x","direcao":"entrada","valor":1,"saldoApos":null}]}' };
      }
      if (k === 5 && n === 1) return { throw: new AiError("rate_limit", "devagar") }; // transiente 1x
      return { text: pageTx(k) };
    };
    const client = new ProgrammableClient(responder);
    let last: AiProgress | undefined;
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: pages6,
      concurrency: 4,
      retry: { attempts: 3, baseMs: 1 },
      sleep: noop,
      onProgress: (pr) => {
        last = pr;
      },
    });
    const txs = await p.parse(pdfRaw);

    // página 3 falhou -> excluída; as outras 5 seguem, na ordem
    expect(txs.map((t) => t.description)).toEqual([1, 2, 4, 5, 6].map((k) => `Tx pagina ${k}`));
    // retry: a página 5 foi chamada 2x (1ª rate_limit, 2ª ok)
    expect(client.perChunkCalls.get("PAG5")).toBe(2);
    // estado por partição visível no progresso final
    expect(last?.phase).toBe("done");
    expect(last?.partitions[2].status).toBe("error");
    expect(last?.partitions.filter((s) => s.status === "done").length).toBe(5);
    expect(last?.partitions.filter((s) => s.status === "error").length).toBe(1);
    expect(last?.total).toBe(6);
  });

  it("reprocessa SÓ a partição truncada, subdividindo em sub-blocos", async () => {
    const responder: Responder = (chunk) => {
      const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
      // página inteira (4 linhas) volta truncada (JSON não fecha)
      if (lines.length >= 4) return { text: '{"transacoes":[{"data":"2026-08-01","descricao":"trunc' };
      // sub-bloco (2 linhas) volta OK, marcado pela 1ª linha
      return {
        text: JSON.stringify({
          transacoes: [
            { data: "2026-08-01", descricao: `H:${lines[0]}`, direcao: "entrada", valor: 1, saldoApos: null },
          ],
        }),
      };
    };
    const client = new ProgrammableClient(responder);
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: { extractPages: async () => ["L1\nL2\nL3\nL4"] },
      sleep: noop,
    });
    const txs = await p.parse(pdfRaw);
    // 1 página truncada -> 2 sub-blocos válidos -> 2 transações, na ordem
    expect(txs.map((t) => t.description)).toEqual(["H:L1", "H:L3"]);
    // 1 chamada da página inteira + 2 das metades = 3 extrações
    expect(client.extractionCalls).toBe(3);
  });

  it("erro FATAL (chave inválida) aborta o run inteiro", async () => {
    const client = new ProgrammableClient(() => ({ throw: new AiError("invalid_key", "chave recusada") }));
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: pages6,
      sleep: noop,
    });
    await expect(p.parse(pdfRaw)).rejects.toMatchObject({ kind: "invalid_key" });
  });
});

/**
 * PRECISAO — as duas redes deterministicas contra "lancamento a mais" e a
 * ancora de linha que sustenta a associacao nome <-> valor.
 */
describe("AiStatementParser — integridade da contagem", () => {
  it("numera as linhas do trecho enviado ao modelo (ancora de posicao)", async () => {
    const client = new MockAiClient(SAMPLE);
    const p = new AiStatementParser({
      client,
      resolveConfig: () => cfg,
      pdfText: { extractPages: async () => ["JOAO VITOR\n33,00\nZAIRA FERNANDA\n37,20"] },
    });
    await p.parse(pdfRaw);
    const extract = client.calls.find((c) => !c.systemPrompt.includes("NAO extrai"))!;
    expect(extract.userPrompt).toContain("L1| JOAO VITOR");
    expect(extract.userPrompt).toContain("L2| 33,00");
    expect(extract.userPrompt).toContain("L4| 37,20");
  });

  it("descarta lancamento repetido ancorado na MESMA linha de origem", async () => {
    const repetido = JSON.stringify({
      transacoes: [
        { data: "2026-08-04", descricao: "JOAO VITOR DOS SANTOS MADEIRA | Pix", direcao: "entrada", valor: 33.0, saldoApos: null, linha: 4 },
        { data: "2026-08-04", descricao: "JOAO VITOR DOS SANTOS MADEIRA | Pix", direcao: "entrada", valor: 33.0, saldoApos: null, linha: 4 },
        { data: "2026-08-04", descricao: "ZAIRA FERNANDA MOTA BELFORT COSTA | Pix", direcao: "saida", valor: 37.2, saldoApos: null, linha: 6 },
      ],
    });
    const txs = await parser(repetido).parse(pdfRaw);
    expect(txs.length).toBe(2);
    expect(txs.map((t) => t.amount.cents)).toEqual([3300, 3720]);
  });

  it("valores iguais em LINHAS diferentes continuam sendo transacoes distintas", async () => {
    const tres = JSON.stringify({
      transacoes: [2, 4, 6].map((linha) => ({
        data: "2026-08-04", descricao: "FULANO | Pix", direcao: "entrada", valor: 25.0, saldoApos: null, linha,
      })),
    });
    const txs = await parser(tres).parse(pdfRaw);
    expect(txs.length).toBe(3);
  });

  it("auditoria da cadeia de saldo descarta o lancamento fantasma (saldo nao andou)", async () => {
    const fantasma = JSON.stringify({
      transacoes: [
        { data: "2026-08-01", descricao: "ZAIRA | Pix", direcao: "saida", valor: 10.0, saldoApos: 90.0, linha: 3 },
        // repeticao do mesmo lancamento em outra linha: o saldo NAO se move
        { data: "2026-08-01", descricao: "ZAIRA | Pix", direcao: "saida", valor: 10.0, saldoApos: 90.0, linha: 5 },
        { data: "2026-08-02", descricao: "JOAO | Pix", direcao: "entrada", valor: 5.0, saldoApos: 95.0, linha: 7 },
      ],
    });
    const txs = await parser(fantasma).parse(pdfRaw);
    expect(txs.length).toBe(2);
    expect(txs.map((t) => t.amount.cents)).toEqual([1000, 500]);
  });

  it("cadeia coerente com valores repetidos NAO perde lancamento", async () => {
    const coerente = JSON.stringify({
      transacoes: [
        { data: "2026-08-01", descricao: "FULANO | Pix", direcao: "saida", valor: 10.0, saldoApos: 90.0, linha: 3 },
        { data: "2026-08-01", descricao: "FULANO | Pix", direcao: "saida", valor: 10.0, saldoApos: 80.0, linha: 5 },
      ],
    });
    const txs = await parser(coerente).parse(pdfRaw);
    expect(txs.length).toBe(2);
  });
});

describe("schema — parseExtractionTransactions", () => {
  it("tolera JSON cercado por ```json ... ```", () => {
    const fenced = "```json\n" + SAMPLE + "\n```";
    expect(parseExtractionTransactions(fenced).length).toBe(3);
  });
  it("data em formato errado -> bad_schema", () => {
    const bad = JSON.stringify({ transacoes: [{ data: "31/07/2026", descricao: "x", direcao: "saida", valor: 1, saldoApos: null }] });
    expect(() => parseExtractionTransactions(bad)).toThrowError(/data invalida/i);
  });
});
