import { Word, WordExtractor, TextExtractor } from "../../application/ports";

/**
 * Extracao de TEXTO de PDF via pdf.js EMPACOTADO (pdfjs-dist) — offline-first,
 * sem depender de CDN. NAO e um parser de banco: e apenas um utilitario de
 * FALLBACK, usado quando o provedor de IA selecionado nao aceita PDF como
 * documento nativo. Nesse caso mandamos o texto do PDF em vez do binario.
 *
 * (Migrado de adapters/parsers/pdfWords.ts na Fase 2, quando os parsers
 * deterministicos foram removidos.)
 */
/**
 * Carrega o pdf.js e aponta o worker EMPACOTADO. O `new URL(..., import.meta.url)`
 * e reescrito pelo Vite na hora do build — e por isso que funciona no WebView e
 * NAO resolve em Node puro. Por isso `PdfjsWordExtractor` aceita um carregador
 * alternativo: e o que permite aos testes exercitarem o pdf.js de verdade.
 */
async function loadPdfjs(): Promise<any> {
  const pdfjs = await import("pdfjs-dist");
  try {
    // @ts-ignore
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url);
    (pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl.toString();
  } catch {
    /* ambiente sem URL de worker: pdf.js usa fake worker */
  }
  return pdfjs;
}

/**
 * COPIA DEFENSIVA antes de entregar o PDF ao pdf.js.
 *
 * `getDocument({ data })` TRANSFERE o ArrayBuffer para o worker — quem chamou
 * fica com um buffer DESANEXADO (`byteLength` 0). Qualquer leitura posterior
 * dos mesmos bytes estoura com "Cannot perform %TypedArray%.prototype.slice on
 * a detached ArrayBuffer": ler a assinatura %PDF, mandar o arquivo como
 * documento nativo para a IA, ou simplesmente conciliar o mesmo arquivo duas
 * vezes na mesma sessao.
 *
 * O pdf.js nao oferece opcao de nao transferir; entao entregamos uma COPIA e
 * deixamos que ele desanexe a copia. O custo e um clone do arquivo em memoria,
 * uma vez por leitura — barato perto de perder o extrato do usuario.
 */
function copiaParaPdfjs(bytes: Uint8Array): Uint8Array {
  const copia = new Uint8Array(bytes.byteLength);
  copia.set(bytes);
  return copia;
}

export type PdfjsLoader = () => Promise<any>;

export class PdfjsWordExtractor implements WordExtractor {
  constructor(private readonly load: PdfjsLoader = loadPdfjs) {}

  async extract(bytes: Uint8Array): Promise<Word[]> {
    const pdfjs = await this.load();
    const doc = await pdfjs.getDocument({ data: copiaParaPdfjs(bytes) }).promise;
    const words: Word[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items as any[]) {
        const str: string = item.str;
        if (!str || !str.trim()) continue;
        const x = item.transform[4];
        const yBottom = item.transform[5];
        const top = viewport.height - yBottom;
        const width = item.width ?? 0;
        const pieces = str.split(/\s+/).filter(Boolean);
        if (pieces.length === 1) {
          words.push({ page: p - 1, text: pieces[0], x0: x, x1: x + width, top });
        } else {
          const per = width / str.length;
          let cursor = x;
          for (const piece of pieces) {
            const w = piece.length * per;
            words.push({ page: p - 1, text: piece, x0: cursor, x1: cursor + w, top });
            cursor += w + per;
          }
        }
      }
    }
    return words;
  }
}

function linesFromWords(words: Word[]): { page: number; line: string }[] {
  const byLine = new Map<string, Word[]>();
  for (const w of words) {
    const key = `${w.page}:${Math.round(w.top)}`;
    const arr = byLine.get(key) ?? [];
    arr.push(w);
    byLine.set(key, arr);
  }
  return [...byLine.entries()]
    .sort((a, b) => {
      const [pa, ta] = a[0].split(":").map(Number);
      const [pb, tb] = b[0].split(":").map(Number);
      return pa - pb || ta - tb;
    })
    .map(([key, ws]) => ({
      page: Number(key.split(":")[0]),
      line: ws.sort((x, y) => x.x0 - y.x0).map((x) => x.text).join(" "),
    }));
}

export class PdfjsTextExtractor implements TextExtractor {
  constructor(private readonly load: PdfjsLoader = loadPdfjs) {}

  async extractLines(bytes: Uint8Array): Promise<string[]> {
    const words = await new PdfjsWordExtractor(this.load).extract(bytes);
    return linesFromWords(words).map((l) => l.line);
  }

  /** Uma string de texto por PÁGINA — usado para paginar a extração via IA. */
  async extractPages(bytes: Uint8Array): Promise<string[]> {
    const words = await new PdfjsWordExtractor(this.load).extract(bytes);
    const pages = new Map<number, string[]>();
    for (const { page, line } of linesFromWords(words)) {
      const arr = pages.get(page) ?? [];
      arr.push(line);
      pages.set(page, arr);
    }
    return [...pages.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, lines]) => lines.join("\n"));
  }
}
