import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import {
  HybridStatementParser,
  MemoPageTextExtractor,
  StrategyInfo,
} from "../src/adapters/parsers/hybrid";
import { PdfjsTextExtractor } from "../src/adapters/pdf/pdfText";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import { importStatement } from "../src/application/importStatement";
import { DONA_MARI_LAYOUT } from "../src/domain/layout";
import { Transaction } from "../src/domain/transaction";
import { MemoryLedger, RecordingBackup, FixedClock, StubParser } from "./mocks";

/**
 * CONFERENCIA PONTA A PONTA sobre os SEUS arquivos — OPCIONAL, fora do
 * `npm test` por padrao.
 *
 * O `npm test` roda sobre fixtures anonimizadas: e o que da para versionar e o
 * que trava a regressao. Mas a pergunta que o dono do projeto faz antes de
 * entregar uma versao e outra — "funciona nos arquivos QUE EU TENHO?" —, e ela
 * so se responde com os arquivos de verdade, que trazem nomes de clientes e
 * nao entram no repositorio.
 *
 * Este teste responde essa pergunta. Aponte-o para uma pasta de extratos e ele
 * le CADA arquivo pelo roteador de producao, grava numa COPIA da planilha,
 * reabre o resultado e confere que nada quebrou no caminho — inclusive que o
 * mesmo arquivo, importado duas vezes, insere zero na segunda.
 *
 * PowerShell:
 *   $env:EXTRATOS_DIR="C:\Users\Ylderlan\Downloads"
 *   npx vitest run tests/arquivosReais.test.ts
 *
 * A conferencia por IA fica DESLIGADA aqui de proposito: este teste mede a
 * leitura deterministica, que e a que tem de valer sempre e sem custo. Para
 * exercitar o caminho empirico com um provedor de verdade, veja
 * `tests/ai.integration.test.ts`.
 */

const dir = process.env.EXTRATOS_DIR;
const enabled = !!dir && existsSync(dir);

const here = dirname(fileURLToPath(import.meta.url));
const template = () => new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

const LIDOS = new Set([".csv", ".tsv", ".xls", ".xlsx", ".ofx", ".qfx", ".pdf"]);

function arquivosDeExtrato(): string[] {
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => LIDOS.has(extname(f).toLowerCase()))
    .filter((f) => /extrato|fatura|statement/i.test(f))
    .map((f) => join(dir, f))
    .sort();
}

function leitor(onStrategy?: (i: StrategyInfo) => void): HybridStatementParser {
  return new HybridStatementParser({
    // Sem chave de API neste teste: a IA e um stub. Se o roteador tentasse
    // usa-la como LEITURA, o stub devolveria vazio e o teste acusaria — que e
    // exatamente o sinal util (aquele arquivo nao tem leitura direta).
    ai: { id: "ai", canParse: () => true, parse: async () => [] as Transaction[] },
    pdfText: new MemoPageTextExtractor(
      new PdfjsTextExtractor(async () => await import("pdfjs-dist/legacy/build/pdf.mjs")),
    ),
    validacaoIa: { ativa: false },
    onStrategy,
    logger: { log: () => {}, warn: () => {} },
  });
}

async function gravar(txs: Transaction[], nome: string) {
  const w = await XlsxSurgicalWriter.load(template());
  const rep = await importStatement(
    { fileName: nome, bytes: new Uint8Array(0) },
    {
      parser: new StubParser(txs),
      local: w,
      ledger: new MemoryLedger(),
      backup: new RecordingBackup([]),
      clock: new FixedClock(),
      layout: DONA_MARI_LAYOUT,
      localFileId: "fluxo.xlsx",
    },
  );
  return { rep, bytes: await w.toBytes(), writer: w };
}

describe.skipIf(!enabled)("conferência ponta a ponta sobre os arquivos reais", () => {
  const arquivos = arquivosDeExtrato();

  it("a pasta tem extratos para conferir", () => {
    expect(arquivos.length).toBeGreaterThan(0);
  });

  for (const caminho of arquivos) {
    const nome = caminho.split(/[\\/]/).pop()!;

    it(`${nome}: lê, grava na planilha, reabre e confere`, async () => {
      const bytes = new Uint8Array(readFileSync(caminho));
      const tamanhoAntes = bytes.byteLength;

      let info: StrategyInfo | undefined;
      const txs = await leitor((i) => (info = i)).parse({ fileName: nome, bytes });

      // T-BYTES: ler o arquivo NAO pode consumir os bytes de quem chamou.
      expect(bytes.byteLength, "bytes do usuário desanexados").toBe(tamanhoAntes);

      if (info?.kind === "ai") {
        // Nao ha leitura direta para este layout — informacao, nao falha.
        console.log(`  ${nome}: sem leitura direta (${info.reason ?? "layout sem parser"}) → IA`);
        return;
      }

      expect(txs.length, "leitura direta sem lançamentos").toBeGreaterThan(0);
      expect(info!.nivel).toBe("provada");

      const { rep, bytes: saida } = await gravar(txs, nome);
      const novos = rep.competences.reduce((s, c) => s + c.novos.length, 0);
      const dups = rep.competences.reduce((s, c) => s + c.duplicados, 0);
      const inconsist = rep.competences.reduce((s, c) => s + c.inconsistencias.length, 0);
      console.log(
        `  ${nome}: ${txs.length} lidos · ${novos} novos · ${dups} duplicados · ` +
          `abas ${rep.competences.map((c) => c.targetSheet).join(", ")} · ${info!.parserId}`,
      );

      expect(inconsist, "inconsistências na gravação").toBe(0);
      // o .xlsx gerado tem de REABRIR: XML quebrado estoura aqui
      const reaberto = await XlsxSurgicalWriter.load(saida);
      expect((await reaberto.sheetNames()).length).toBeGreaterThan(10);
    }, 180000);
  }

  it("idempotência: reimportar o primeiro extrato lido direto insere 0", async () => {
    for (const caminho of arquivos) {
      const nome = caminho.split(/[\\/]/).pop()!;
      const bytes = new Uint8Array(readFileSync(caminho));
      let info: StrategyInfo | undefined;
      const txs = await leitor((i) => (info = i)).parse({ fileName: nome, bytes });
      if (info?.kind !== "deterministic") continue;

      const primeira = await gravar(txs, nome);
      const w2 = await XlsxSurgicalWriter.load(primeira.bytes);
      const r2 = await importStatement(
        { fileName: nome, bytes: new Uint8Array(0) },
        {
          parser: new StubParser(txs),
          local: w2,
          ledger: new MemoryLedger(),
          backup: new RecordingBackup([]),
          clock: new FixedClock(),
          layout: DONA_MARI_LAYOUT,
          localFileId: "fluxo.xlsx",
        },
      );
      const novos2 = r2.competences.reduce((s, c) => s + c.novos.length, 0);
      console.log(`  ${nome}: 2ª importação inseriu ${novos2}`);
      expect(novos2, `${nome} duplicou na reimportação`).toBe(0);
      return;
    }
  }, 180000);
});
