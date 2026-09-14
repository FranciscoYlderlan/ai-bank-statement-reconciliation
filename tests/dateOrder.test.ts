import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DateOrder,
  combineDateOrder,
  detectDateOrder,
  planInsertion,
} from "../src/domain/dateOrder";
import { PlainDate } from "../src/domain/dateptbr";
import { DONA_MARI_LAYOUT, SheetRow, SheetRowLayout } from "../src/domain/layout";
import { toExcelSerial } from "../src/domain/dateptbr";
import { createWorkbook } from "../src/adapters/writers/createWorkbook";
import {
  XlsxSurgicalWriter,
  resolveSheetDateOrder,
} from "../src/adapters/writers/xlsxSurgical";
import { inspectWorkbook } from "../src/adapters/writers/inspectWorkbook";

const here = dirname(fileURLToPath(import.meta.url));
const templateBytes = () =>
  new Uint8Array(readFileSync(join(here, "fixtures", "template_bomprato.xlsx")));

const SHEET_FILES: Record<string, string> = {
  MAIO: "xl/worksheets/sheet8.xml",
  JULHO: "xl/worksheets/sheet10.xml",
};

async function sheetXmlOf(bytes: Uint8Array, sheet: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(SHEET_FILES[sheet])!.async("string");
}

const dt = (dia: number, mes = 5, ano = 2026): PlainDate => ({ year: ano, month: mes, day: dia });

/* ════════════════════════════════════════════════════════════════════════
 * T-ORDEM — a planilha sobe ou desce?
 * ════════════════════════════════════════════════════════════════════════ */
describe("T-ORDEM: identificacao do padrao de datas", () => {
  it("sequencia crescente e reconhecida", () => {
    const e = detectDateOrder([dt(1), dt(3), dt(7), dt(9), dt(20)]);
    expect(e.ordem).toBe("crescente");
    expect(e.conclusiva).toBe(true);
    expect(e.confianca).toBe(1);
  });

  it("sequencia decrescente e reconhecida", () => {
    const e = detectDateOrder([dt(19), dt(15), dt(9), dt(4), dt(1)]);
    expect(e.ordem).toBe("decrescente");
    expect(e.conclusiva).toBe(true);
  });

  it("datas repetidas nao votam — o padrao vem dos pares que mudam", () => {
    const e = detectDateOrder([dt(19), dt(19), dt(19), dt(15), dt(15), dt(9), dt(4)]);
    expect(e.ordem).toBe("decrescente");
    expect(e.empates).toBe(3);
    expect(e.comparados).toBe(3);
  });

  it("um lancamento fora de ordem nao derruba o padrao da aba", () => {
    const e = detectDateOrder([dt(19), dt(17), dt(15), dt(16), dt(12), dt(10), dt(4)]);
    expect(e.ordem).toBe("decrescente");
    expect(e.confianca).toBeGreaterThanOrEqual(0.75);
  });

  it("aba bagunçada nao vira ordem — devolve indefinida", () => {
    const e = detectDateOrder([dt(5), dt(20), dt(1), dt(19), dt(3), dt(14)]);
    expect(e.ordem).toBe("indefinida");
    expect(e.conclusiva).toBe(false);
    expect(e.tendencia).not.toBeNull(); // a maioria bruta continua visivel
  });

  it("evidencia curta demais nao decide (dois lancamentos nao sao padrao)", () => {
    const e = detectDateOrder([dt(9), dt(4)]);
    expect(e.ordem).toBe("indefinida");
    expect(e.tendencia).toBe("decrescente");
  });

  it("aba vazia ou com uma unica data devolve indefinida sem erro", () => {
    expect(detectDateOrder([]).ordem).toBe("indefinida");
    expect(detectDateOrder([dt(9)]).ordem).toBe("indefinida");
  });

  it("abas que discordam somam-se em indefinida — nao se escolhe uma vencedora", () => {
    const sobe = detectDateOrder([dt(1), dt(2), dt(3), dt(4), dt(5)]);
    const desce = detectDateOrder([dt(9), dt(8), dt(7), dt(6), dt(5)]);
    expect(combineDateOrder([sobe, desce]).ordem).toBe("indefinida");
    // duas contra uma ainda e discordancia demais (0,67 < 0,75); tres contra uma passa
    expect(combineDateOrder([sobe, sobe, desce]).ordem).toBe("indefinida");
    expect(combineDateOrder([sobe, sobe, sobe, desce]).ordem).toBe("crescente");
  });

  it("na planilha REAL, MAIO desce e JUNHO sobe", async () => {
    const ins = await inspectWorkbook(templateBytes());
    expect(ins.dateOrderBySheet.MAIO.ordem).toBe("decrescente");
    expect(ins.dateOrderBySheet.JUNHO.ordem).toBe("crescente");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * T-ENCAIXE (dominio) — onde cada lancamento novo entra
 * ════════════════════════════════════════════════════════════════════════ */
describe("T-ENCAIXE: o plano de insercao", () => {
  const ex = (dia: number) => ({ item: `e${dia}`, date: dt(dia) });
  const nv = (dia: number) => ({ item: `n${dia}`, date: dt(dia) });
  const nomes = (p: { sequencia: Array<{ item: unknown }> }) => p.sequencia.map((s) => s.item);

  it("CRESCENTE: data mais nova vai para o fim", () => {
    const p = planInsertion([ex(1), ex(5), ex(9)], [nv(20)], "crescente");
    expect(nomes(p)).toEqual(["e1", "e5", "e9", "n20"]);
    expect(p.apenasNoFim).toBe(true);
  });

  it("DECRESCENTE: data mais nova vai para o COMECO", () => {
    const p = planInsertion([ex(19), ex(10), ex(1)], [nv(31)], "decrescente");
    expect(nomes(p)).toEqual(["n31", "e19", "e10", "e1"]);
    expect(p.primeiraMudanca).toBe(0);
    expect(p.apenasNoFim).toBe(false);
  });

  it("data intermediaria entra no MEIO, nos dois sentidos", () => {
    expect(nomes(planInsertion([ex(1), ex(9), ex(20)], [nv(5)], "crescente"))).toEqual([
      "e1",
      "n5",
      "e9",
      "e20",
    ]);
    expect(nomes(planInsertion([ex(20), ex(9), ex(1)], [nv(15)], "decrescente"))).toEqual([
      "e20",
      "n15",
      "e9",
      "e1",
    ]);
  });

  it("o caso do cliente: aba de 19 a 1, chegam lancamentos de 15 a 31", () => {
    // a aba tem 19..1 (decrescente); o extrato traz 15, 20, 31 fora de ordem
    const existentes = [ex(19), ex(15), ex(10), ex(1)];
    const p = planInsertion(existentes, [nv(20), nv(31), nv(15)], "decrescente");
    // 31 e 20 acima do 19; o 15 novo entra DEPOIS do 15 que ja estava la
    expect(nomes(p)).toEqual(["n31", "n20", "e19", "e15", "n15", "e10", "e1"]);
  });

  it("empate de data: o novo entra DEPOIS do que o usuario ja digitou", () => {
    const p = planInsertion([ex(9), ex(9), ex(4)], [nv(9)], "decrescente");
    expect(nomes(p)).toEqual(["e9", "e9", "n9", "e4"]);
  });

  it("os novos entre si saem na ordem da aba (foi a metade que faltava)", () => {
    const p = planInsertion([], [nv(15), nv(31), nv(20)], "decrescente");
    expect(nomes(p)).toEqual(["n31", "n20", "n15"]);
  });

  it("ordem INDEFINIDA repete o comportamento historico: tudo no fim, na ordem que veio", () => {
    const p = planInsertion([ex(9), ex(1)], [nv(15), nv(31)], "indefinida");
    expect(nomes(p)).toEqual(["e9", "e1", "n15", "n31"]);
    expect(p.apenasNoFim).toBe(true);
  });

  it("a ordem RELATIVA do que ja estava gravado nunca muda", () => {
    // aba com um lancamento fora de ordem: ele fica onde o usuario o deixou
    const p = planInsertion([ex(19), ex(3), ex(10)], [nv(31)], "decrescente");
    expect(nomes(p).filter((n) => String(n).startsWith("e"))).toEqual(["e19", "e3", "e10"]);
  });

  it("lancamento sem data legivel vai para o fim, nunca no meio", () => {
    const p = planInsertion([ex(19), ex(1)], [{ item: "n?", date: null }], "decrescente");
    expect(nomes(p)).toEqual(["e19", "e1", "n?"]);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * T-ENCAIXE-XLSX — o encaixe dentro do arquivo real
 * ════════════════════════════════════════════════════════════════════════ */
describe("T-ENCAIXE-XLSX: a linha nova entra no lugar certo da aba real", () => {
  const row = (dia: number, mes = 5, over: Partial<SheetRow> = {}): SheetRow => ({
    dateSerial: toExcelSerial({ year: 2026, month: mes, day: dia }),
    dateText: `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/2026`,
    description: `LANCAMENTO ${dia}/${mes}`,
    category: null,
    entradaCents: null,
    saidaCents: 1000 + dia,
    ...over,
  });

  /** As datas da coluna B, de cima para baixo, como o Excel as mostraria. */
  async function datasDaAba(bytes: Uint8Array, sheet: string): Promise<string[]> {
    const xml = await sheetXmlOf(bytes, sheet);
    const out: string[] = [];
    for (const m of xml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
      const r = Number(m[1]);
      if (r < DONA_MARI_LAYOUT.firstDataRow) continue;
      const cel = m[0].match(new RegExp(`<c r="B${r}"[^>]*?>[\\s\\S]*?</c>`));
      if (!cel) continue;
      const t = cel[0].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (t) out.push(t[1]);
    }
    return out;
  }

  it("a aba MAIO se declara decrescente sozinha, sem depender do perfil", async () => {
    const zip = await JSZip.loadAsync(templateBytes());
    const xml = await zip.file(SHEET_FILES.MAIO)!.async("string");
    const sst = await zip.file("xl/sharedStrings.xml")!.async("string");
    const shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
    );
    // o perfil aqui NAO sabe de nada (DONA_MARI_LAYOUT nasce "indefinida"):
    // quem responde e a propria aba
    const ordem: DateOrder = resolveSheetDateOrder(xml, "MAIO", DONA_MARI_LAYOUT, shared);
    expect(ordem).toBe("decrescente");
  });

  it("numa aba DECRESCENTE, a data mais recente vai para a PRIMEIRA linha", async () => {
    // aba nossa, escrita do zero, para o topo ser um lugar verificavel
    const w = await XlsxSurgicalWriter.load(await createWorkbook());
    const layout: SheetRowLayout = { ...DONA_MARI_LAYOUT, dateOrder: "decrescente" };
    await w.appendRows("MAIO", [row(10), row(20), row(5)], layout);
    const primeira = await w.appendRows("MAIO", [row(28)], layout);
    expect(primeira.firstRow).toBe(DONA_MARI_LAYOUT.firstDataRow);
    const lidas = await w.readExisting("MAIO", layout);
    expect(lidas.map((t) => t.date.day)).toEqual([28, 20, 10, 5]);
  });

  it("no MEIO de uma aba nossa, o encaixe respeita as duas vizinhas", async () => {
    const w = await XlsxSurgicalWriter.load(await createWorkbook());
    const layout: SheetRowLayout = { ...DONA_MARI_LAYOUT, dateOrder: "decrescente" };
    await w.appendRows("MAIO", [row(28), row(20), row(5)], layout);
    await w.appendRows("MAIO", [row(12)], layout);
    const lidas = await w.readExisting("MAIO", layout);
    expect(lidas.map((t) => t.date.day)).toEqual([28, 20, 12, 5]);
    // e os valores acompanharam a linha, nao ficaram para tras
    const doDia20 = lidas.find((t) => t.date.day === 20)!;
    expect(doDia20.amount.cents).toBe(1020);
  });

  it("a coluna de datas continua monotonica depois da gravacao (o bug do cliente)", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    // o caso real: a aba ja tinha 31..09 e chegam datas do meio e do fim
    await w.appendRows("MAIO", [row(12), row(28), row(9), row(20)], DONA_MARI_LAYOUT);
    const datas = await datasDaAba(await w.toBytes(), "MAIO");
    const iso = datas.map((d) => d.split("/").reverse().join("-"));
    for (let i = 1; i < iso.length; i++) {
      expect(iso[i] <= iso[i - 1]).toBe(true); // nunca sobe numa aba decrescente
    }
  });

  it("os lancamentos que ja estavam la continuam na planilha, com o mesmo valor", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const antes = await w.readExisting("MAIO", DONA_MARI_LAYOUT);
    await w.appendRows("MAIO", [row(31), row(15)], DONA_MARI_LAYOUT);
    const depois = await w.readExisting("MAIO", DONA_MARI_LAYOUT);
    expect(depois.length).toBe(antes.length + 2);
    const chave = (t: { date: PlainDate; amount: { cents: number }; description: string }) =>
      `${t.date.year}-${t.date.month}-${t.date.day}|${t.amount.cents}|${t.description}`;
    const conjunto = new Set(depois.map(chave));
    for (const t of antes) expect(conjunto.has(chave(t))).toBe(true);
  });

  it("a ordem RELATIVA das linhas antigas e preservada na realocacao", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const antes = (await w.readExisting("MAIO", DONA_MARI_LAYOUT)).map((t) => t.description);
    await w.appendRows("MAIO", [row(31)], DONA_MARI_LAYOUT);
    const depois = (await w.readExisting("MAIO", DONA_MARI_LAYOUT)).map((t) => t.description);
    expect(depois.filter((d) => antes.includes(d))).toEqual(antes);
  });

  it("a linha realocada leva junto a categoria — nada fica para tras", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const antes = await w.readCategoryHistory("MAIO", DONA_MARI_LAYOUT);
    await w.appendRows("MAIO", [row(31)], DONA_MARI_LAYOUT);
    const depois = await w.readCategoryHistory("MAIO", DONA_MARI_LAYOUT);
    expect(depois.length).toBeGreaterThanOrEqual(antes.length);
    expect(depois.map((o) => `${o.descricao}|${o.categoria}`)).toEqual(
      expect.arrayContaining(antes.map((o) => `${o.descricao}|${o.categoria}`)),
    );
  });

  it("as formulas E/H seguem na planilha e cada linha nova nasce com as suas", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const layout: SheetRowLayout = {
      ...DONA_MARI_LAYOUT,
      formulaColumns: [
        {
          letter: "H",
          header: "Saldo",
          kind: "acumulada",
          template: "H13+F14-G14",
          templateRow: 14,
          styleNum: null,
          cellType: null,
          porColuna: true,
          ocorrencias: 200,
          sheet: "MAIO",
          motivo: "coluna acumulada",
        },
      ],
    };
    const antesXml = await sheetXmlOf(templateBytes(), "MAIO");
    const antes = (antesXml.match(/<f>/g) ?? []).length;
    await w.appendRows("MAIO", [row(31)], layout);
    const depoisXml = await sheetXmlOf(await w.toBytes(), "MAIO");
    expect((depoisXml.match(/<f>/g) ?? []).length).toBeGreaterThanOrEqual(antes);
  });

  it("numa aba CRESCENTE o comportamento continua sendo acrescentar no fim", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const antes = (await w.readExisting("JUNHO", DONA_MARI_LAYOUT)).length;
    const outcome = await w.appendRows("JUNHO", [row(30, 6)], DONA_MARI_LAYOUT);
    const depois = await w.readExisting("JUNHO", DONA_MARI_LAYOUT);
    expect(depois.length).toBe(antes + 1);
    // nada foi realocado: o aviso de encaixe so aparece quando alguem desce
    expect(outcome.warnings ?? []).not.toContain(expect.stringContaining("encaixados"));
  });

  it("aba VAZIA usa a ordem da planilha e nao quebra", async () => {
    const w = await XlsxSurgicalWriter.load(templateBytes());
    const layout: SheetRowLayout = { ...DONA_MARI_LAYOUT, dateOrder: "decrescente" };
    const outcome = await w.appendRows(
      "DEZEMBRO",
      [row(5, 12), row(20, 12)],
      layout,
    );
    expect(outcome.appended).toBe(2);
    const zip = await JSZip.loadAsync(await w.toBytes());
    expect(zip.file("xl/worksheets/sheet15.xml")).toBeTruthy();
  });
});
