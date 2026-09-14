import { describe, it, expect, vi } from "vitest";
import { PdfjsTextExtractor } from "../src/adapters/pdf/pdfText";
import { HybridStatementParser } from "../src/adapters/parsers/hybrid";
import { RawStatement, StatementParser } from "../src/application/ports";

/**
 * O ARQUIVO DO USUARIO TEM DE SOBREVIVER A LEITURA.
 *
 * `pdfjs.getDocument({ data })` TRANSFERE o ArrayBuffer para o worker: quem
 * chamou fica com um buffer desanexado (`byteLength` 0). Enquanto a extracao de
 * texto era a ULTIMA coisa a tocar os bytes, ninguem sentia. Quando o roteador
 * passou a ler o texto ANTES de decidir a estrategia, o passo seguinte — a IA
 * conferindo a assinatura do arquivo — estourava com
 * "Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer".
 *
 * A correcao e entregar uma COPIA ao pdf.js. Estes testes rodam o pdf.js de
 * verdade, porque o que precisa ser garantido e o comportamento dele.
 */

/** PDF valido minimo, gerado aqui — sem depender de arquivo real do cliente. */
function miniPdf(texto = "Extrato de teste"): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] " +
    "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  const stream = `BT /F1 12 Tf 20 150 Td (${texto}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const assinatura = (b: Uint8Array) => String.fromCharCode(...b.slice(0, 5));

/**
 * Carregador do pdf.js para NODE. No app quem resolve o worker e o Vite, que
 * reescreve o `new URL(..., import.meta.url)` no build; em Node esse caminho
 * nao existe, entao apontamos o worker do pacote diretamente. O que esta sob
 * teste e o comportamento do pdf.js de verdade, nao um dublê.
 */
const pdfjsNode = async () => {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url,
  ).href;
  return pdfjs;
};
const extractor = () => new PdfjsTextExtractor(pdfjsNode);

describe("PdfjsTextExtractor — não consome os bytes de quem chamou", () => {
  it("extrai o texto e deixa o arquivo intacto e legível depois", async () => {
    const bytes = miniPdf();
    const antes = bytes.byteLength;

    const pages = await extractor().extractPages(bytes);
    expect(pages.join(" ")).toContain("Extrato de teste");

    // era exatamente isto que quebrava: buffer zerado e slice impossível
    expect(bytes.byteLength).toBe(antes);
    expect(() => bytes.slice(0, 8)).not.toThrow();
    expect(assinatura(bytes)).toBe("%PDF-");
  }, 30_000);

  it("o mesmo arquivo pode ser lido duas vezes (conciliar de novo na mesma sessão)", async () => {
    const bytes = miniPdf("Segunda leitura");
    const e = extractor();
    const p1 = await e.extractPages(bytes);
    const p2 = await e.extractPages(bytes);
    expect(p1).toEqual(p2);
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 30_000);
});

describe("HybridStatementParser — o roteador entrega o arquivo inteiro à IA", () => {
  it("depois de ler o texto para reconhecer o layout, a IA ainda enxerga os bytes", async () => {
    const bytes = miniPdf("Layout desconhecido qualquer");
    const raw: RawStatement = { fileName: "extrato.pdf", bytes };

    let vistoPelaIa = -1;
    const ai: StatementParser = {
      id: "ai",
      canParse: () => true,
      // a IA precisa dos bytes para farejar o tipo e, se for o caso, mandar o
      // PDF como documento nativo — e aqui que o buffer desanexado estourava
      parse: async (r) => {
        vistoPelaIa = r.bytes.slice(0, 8).length;
        return [];
      },
    };

    const h = new HybridStatementParser({
      ai,
      pdfText: extractor(),
      logger: { log: vi.fn(), warn: vi.fn() } as never,
    });
    await h.parse(raw);
    expect(vistoPelaIa).toBe(8);
  }, 30_000);

  it("bytes já esvaziados dão uma mensagem acionável, não o erro nativo", async () => {
    const raw: RawStatement = { fileName: "extrato.pdf", bytes: new Uint8Array(0) };
    const ai: StatementParser = { id: "ai", canParse: () => true, parse: async () => [] };
    const h = new HybridStatementParser({ ai, pdfText: extractor() });
    await expect(h.parse(raw)).rejects.toThrow(/Selecione o arquivo novamente/i);
  });
});
