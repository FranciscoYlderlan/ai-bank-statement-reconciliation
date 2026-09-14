import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { XlsxSurgicalWriter } from "../src/adapters/writers/xlsxSurgical";
import { DONA_MARI_LAYOUT } from "../src/domain/layout";
import { SheetRow } from "../src/domain/layout";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

const SHEET = "JULHO";
const SHEET_FILE = "xl/worksheets/sheet10.xml"; // JULHO no arquivo real

const sampleRows: SheetRow[] = [
  { dateSerial: 46210, dateText: "07/07/2026", description: "NOME01 Transferência | Pix", category: null, entradaCents: 3200, saidaCents: null },
  { dateSerial: 46210, dateText: "07/07/2026", description: "Tarifa", category: null, entradaCents: null, saidaCents: 56 },
  { dateSerial: 46211, dateText: "08/07/2026", description: "NOME02 Pix", category: null, entradaCents: 10000, saidaCents: null },
];

async function sheetXmlOf(bytes: Uint8Array, file: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(file)!.async("string");
}

describe("XlsxSurgicalWriter — T-PRES (preservacao)", () => {
  it("mapeia os nomes de aba reais", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const names = await w.sheetNames();
    expect(names).toContain("JULHO");
    expect(names).toContain("AGOSTO");
    expect(names).toContain("Categorias");
    expect(names.length).toBe(15);
  });

  it("preserva formulas E/H, merges e o dropdown (extLst) apos escrever", async () => {
    const before = await sheetXmlOf(templateBytes(), SHEET_FILE);
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows(SHEET, sampleRows, DONA_MARI_LAYOUT);
    const out = await w.toBytes();
    const after = await sheetXmlOf(out, SHEET_FILE);

    // (a) formulas E e H continuam presentes
    expect(after).toContain("VLOOKUP(D13,Categorias!A:B,2,0)");
    expect(after).toContain("<f>G7+F13-G13</f>");
    // contagem de formulas E/H preservada (nada apagado)
    const countF = (s: string) => (s.match(/<f/g) || []).length;
    expect(countF(after)).toBe(countF(before));

    // (b) dropdown de validacao (x14:dataValidation) sobrevive
    expect(after).toContain("x14:dataValidation");
    expect(after).toContain("Categorias!$A:$A");
    expect(after).toContain("<xm:sqref>D13:D254</xm:sqref>");

    // (c) os 12 merges sobrevivem
    expect(after).toContain('<mergeCells count="12">');
    expect(after).toContain('<mergeCell ref="B2:H5"/>');
  });

  it("T-NOFORMULA: E e H das linhas escritas permanecem intactas (formula, sem valor cravado)", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows(SHEET, sampleRows, DONA_MARI_LAYOUT);
    const after = await sheetXmlOf(await w.toBytes(), SHEET_FILE);

    for (let r = outcome.firstRow; r <= outcome.lastRow; r++) {
      // E ainda e formula VLOOKUP (nao viramos valor)
      const eCell = new RegExp(`<c r="E${r}"[^>]*><f>IF\\(ISERROR\\(VLOOKUP\\(D${r}`);
      expect(eCell.test(after)).toBe(true);
      // H ainda tem <f> (formula de saldo)
      const hCell = new RegExp(`<c r="H${r}"[^>]*><f[^>]*>`);
      expect(hCell.test(after)).toBe(true);
    }
  });

  it("escreve B,C,F,G nas linhas novas com os valores corretos", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const outcome = await w.appendRows(SHEET, sampleRows, DONA_MARI_LAYOUT);
    const after = await sheetXmlOf(await w.toBytes(), SHEET_FILE);
    const r0 = outcome.firstRow;
    // B: serial de data
    expect(after).toContain(`<c r="B${r0}" s="74"><v>46210</v></c>`);
    // C: descricao inline
    expect(after).toMatch(new RegExp(`<c r="C${r0}"[^>]*t="inlineStr"><is><t[^>]*>NOME01`));
    // F: entrada 32.00
    expect(after).toMatch(new RegExp(`<c r="F${r0}"[^>]*><v>32.00</v></c>`));
  });

  it("depois de escrever, readExisting reconhece as novas linhas (base p/ idempotencia)", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const existingBefore = (await w.readExisting(SHEET, DONA_MARI_LAYOUT)).length;
    await w.appendRows(SHEET, sampleRows, DONA_MARI_LAYOUT);
    const existingAfter = await w.readExisting(SHEET, DONA_MARI_LAYOUT);
    expect(existingAfter.length).toBe(existingBefore + 3);
    // valores reconstruidos corretamente
    const tarifa = existingAfter.find((t) => t.direction === "debit" && t.amount.cents === 56);
    expect(tarifa).toBeTruthy();
  });

  it("nao altera outras abas (AGOSTO permanece byte-identica)", async () => {
    const beforeAgosto = await sheetXmlOf(templateBytes(), "xl/worksheets/sheet11.xml");
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows(SHEET, sampleRows, DONA_MARI_LAYOUT);
    const afterAgosto = await sheetXmlOf(await w.toBytes(), "xl/worksheets/sheet11.xml");
    expect(afterAgosto).toBe(beforeAgosto);
  });
});

/**
 * T-LINHA-VAZIA — o escritor não pode perder linha em silêncio.
 *
 * O Excel grava uma linha sem conteúdo como elemento AUTOFECHADO
 * (`<row r="462" ht="13.2"/>`). Na planilha real do cliente, a aba `JULHO` tem
 * linhas de verdade até a 454 e autofechadas dali para baixo — e `upsertCellInRow`,
 * para inserir a primeira célula de uma linha, procura `</row>`, que numa linha
 * autofechada não existe. O `replace` não casava nada, devolvia a string intacta,
 * e a célula era descartada SEM ERRO NENHUM.
 *
 * O sintoma no cliente é exatamente o que ele relatou: "a planilha ignorou
 * alguns registros". O relatório dizia 500 inseridos e a aba recebia 442.
 *
 * Este teste grava do lado de cá da fronteira para o lado de lá e conta. Ele
 * falha com a versão antiga do `ensureRow`.
 */
describe("XlsxSurgicalWriter — T-LINHA-VAZIA (linha autofechada aceita célula)", () => {
  /** Última linha que existe como `<row>…</row>` de verdade na aba do template. */
  const ULTIMA_ABERTA = 454;
  const firstDataRow = DONA_MARI_LAYOUT.firstDataRow;
  /** o bastante para passar da fronteira com folga */
  const QUANTAS = ULTIMA_ABERTA - firstDataRow + 60;

  const muitasLinhas: SheetRow[] = Array.from({ length: QUANTAS }, (_, i) => ({
    dateSerial: 46210,
    dateText: "07/07/2026",
    description: `LANCAMENTO ${String(i + 1).padStart(4, "0")}`,
    category: null,
    entradaCents: 1000 + i,
    saidaCents: null,
  }));

  it("grava ALÉM da última linha materializada, e todas voltam na releitura", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const antes = (await w.readExisting(SHEET, DONA_MARI_LAYOUT)).length;
    const outcome = await w.appendRows(SHEET, muitasLinhas, DONA_MARI_LAYOUT);

    // a gravação passou mesmo da fronteira — senão o teste não prova nada
    expect(outcome.lastRow).toBeGreaterThan(ULTIMA_ABERTA);

    const depois = await w.readExisting(SHEET, DONA_MARI_LAYOUT);
    expect(depois.length).toBe(antes + QUANTAS);

    // e sobrevivem ao round-trip pelo arquivo
    const reaberto = await XlsxSurgicalWriter.load(await w.toBytes());
    const relidas = await reaberto.readExisting(SHEET, DONA_MARI_LAYOUT);
    expect(relidas.length).toBe(antes + QUANTAS);

    // a ÚLTIMA gravada, que é a que sumia, está lá com o valor certo
    const ultima = relidas.find((t) => t.amount.cents === 1000 + QUANTAS - 1);
    expect(ultima, "o último lançamento gravado desapareceu").toBeTruthy();
  });

  it("a linha autofechada vira `<row>…</row>` preservando altura e spans", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    await w.appendRows(SHEET, muitasLinhas, DONA_MARI_LAYOUT);
    const xml = await sheetXmlOf(await w.toBytes(), SHEET_FILE);
    const alvo = ULTIMA_ABERTA + 5;
    const linha = xml.match(new RegExp(`<row r="${alvo}"[^>]*>`))![0];
    expect(linha).toContain('ht="'); // a altura da linha não se perdeu
    expect(xml).toMatch(new RegExp(`<c r="B${alvo}"`)); // e a célula entrou
  });
});
