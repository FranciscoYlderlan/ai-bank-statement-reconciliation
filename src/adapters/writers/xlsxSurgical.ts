import JSZip from "jszip";
import { SpreadsheetTarget, AppendOutcome } from "../../application/ports";
import { SheetRow, SheetRowLayout } from "../../domain/layout";
import { Transaction } from "../../domain/transaction";
import { Money, parseMoneyPtBr } from "../../domain/money";
import {
  findRow,
  cellStyle,
  cellIsEmpty,
  readCellRaw,
  numberCell,
  inlineStringCell,
  upsertCellInRow,
  unescapeXml,
  escapeXml,
  plainDateFromCell,
  excelSerialToPlainDate,
  readCellXml,
  retargetCell,
  emptyCell,
} from "./xmlCells";
import { detectFormulaColumns } from "./inspectFormulas";
import { extendValidationRange } from "./inspectValidations";
import { FormulaColumnRule, translateFormula } from "../../domain/formulaColumns";
import { ObservacaoHistorica } from "../../domain/ruleMining";
import { applyColumnWidths, byColumnNumber, widthForTexts } from "./columnWidths";
import { buildStyleFormats, ensureDateStyle, isDateFormat, StyleFormat } from "./numberFormats";
import { isSupportSheet } from "../../domain/competence";
import {
  DateOrder,
  ItemDatado,
  detectDateOrder,
  planInsertion,
} from "../../domain/dateOrder";
import { PlainDate, parseDatePtBr } from "../../domain/dateptbr";

/**
 * XlsxSurgicalWriter — escreve numa planilha .xlsx viva SEM reescrever o arquivo
 * inteiro. Trabalha diretamente no XML de cada aba dentro do ZIP:
 *  - preenche APENAS B, C, D, F, G na proxima linha vazia (>= firstDataRow);
 *  - NUNCA toca em A, E, H, nas formulas, nos merges, no <extLst> (dropdown de
 *    validacao) nem no dashboard.
 * Isso satisfaz T-PRES e T-NOFORMULA por construcao: apenas celulas de dados
 * vazias sao substituidas; todo o resto do XML permanece byte-a-byte igual.
 */
export class XlsxSurgicalWriter implements SpreadsheetTarget {
  /** cache: estilo herdado -> estilo garantidamente com formato de data. */
  private dateStyleCache = new Map<string, string | null>();
  private stylesDirty = false;

  private constructor(
    private zip: JSZip,
    private sheetFileByName: Map<string, string>,
    private sharedStrings: string[],
    private styleFormats: StyleFormat[],
    private stylesXml: string,
  ) {}

  static async load(bytes: Uint8Array): Promise<XlsxSurgicalWriter> {
    const zip = await JSZip.loadAsync(bytes);
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    const relsFile = zip.file("xl/_rels/workbook.xml.rels");
    const rels = relsFile ? await relsFile.async("string") : "";
    const relMap = new Map<string, string>();
    for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="(worksheets\/sheet\d+\.xml)"/g)) {
      relMap.set(m[1], "xl/" + m[2]);
    }
    const sheetFileByName = new Map<string, string>();
    for (const m of workbook.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)) {
      const file = relMap.get(m[2]);
      if (file) sheetFileByName.set(decodeXmlName(m[1]), file);
    }
    // sharedStrings (para leitura de celulas t="s")
    let sharedStrings: string[] = [];
    const sst = zip.file("xl/sharedStrings.xml");
    if (sst) {
      const xml = await sst.async("string");
      sharedStrings = [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
        [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => unescapeXml(t[1])).join(""),
      );
    }
    // styles.xml: precisamos saber quais estilos EXIBEM data (numFmt), senao um
    // serial gravado numa celula sem formato aparece como numero cru.
    const stylesFile = zip.file("xl/styles.xml");
    const stylesXml = stylesFile ? await stylesFile.async("string") : "";
    const styleFormats = stylesXml ? buildStyleFormats(stylesXml) : [];
    return new XlsxSurgicalWriter(zip, sheetFileByName, sharedStrings, styleFormats, stylesXml);
  }

  /**
   * GARANTIA DE FORMATO DE DATA. Recebe o estilo que a celula herdaria e devolve
   * um estilo que com certeza EXIBE data — reaproveitando o herdado quando ele ja
   * serve, ou registrando um clone dele com `numFmtId=14` em `styles.xml`.
   *
   * E o que fecha, na raiz, o "46201 no lugar de 20/08/2026": o valor gravado
   * continua sendo o serial (data de verdade, que ordena e entra em formula),
   * mas o formato deixa de depender de a celula de destino ja ter, por acaso,
   * um estilo de data. Devolve null quando a planilha nao tem `cellXfs` — ai o
   * chamador grava a data como texto, que e o unico jeito honesto de exibi-la.
   */
  private guaranteeDateStyle(base: string | null): string | null {
    const chave = base ?? "";
    const cache = this.dateStyleCache.get(chave);
    if (cache !== undefined) return cache;

    const baseIndex = base != null && /^\d+$/.test(base) ? Number(base) : null;
    if (baseIndex != null && isDateFormat(this.styleFormats[baseIndex])) {
      this.dateStyleCache.set(chave, base);
      return base;
    }
    if (!this.stylesXml) {
      this.dateStyleCache.set(chave, null);
      return null;
    }
    const r = ensureDateStyle(this.stylesXml, baseIndex);
    if (r.changed) {
      this.stylesXml = r.stylesXml;
      this.styleFormats = buildStyleFormats(this.stylesXml);
      this.stylesDirty = true;
    }
    const resolvido = String(r.index);
    this.dateStyleCache.set(chave, resolvido);
    return resolvido;
  }

  /** Grava styles.xml de volta no ZIP quando um estilo de data foi acrescentado. */
  private flushStyles(): void {
    if (!this.stylesDirty) return;
    this.zip.file("xl/styles.xml", this.stylesXml);
    this.stylesDirty = false;
  }

  async sheetNames(): Promise<string[]> {
    return [...this.sheetFileByName.keys()];
  }

  private async sheetXml(sheet: string): Promise<string> {
    const file = this.sheetFileByName.get(sheet);
    if (!file) throw new Error(`Aba nao encontrada: ${sheet}`);
    return this.zip.file(file)!.async("string");
  }

  /**
   * Le os lancamentos JA presentes numa aba. E a FONTE DE VERDADE do dedup:
   * quando o usuario traz a planilha dele, o que ja esta gravado ali e o unico
   * jeito de saber o que nao deve ser inserido de novo (o ledger local comeca
   * vazio a cada execucao). Por isso a leitura e tolerante: a data pode estar
   * como serial do Excel OU como texto dd/mm/aaaa; a descricao pode estar em
   * sharedStrings ou inline. Linha com data ilegivel e ignorada (nao inventamos
   * competencia).
   */
  async readExisting(sheet: string, layout: SheetRowLayout): Promise<Transaction[]> {
    const xml = await this.sheetXml(sheet);
    const txs: Transaction[] = [];
    const { columns, firstDataRow } = layout;
    for (const row of iterRows(xml)) {
      const r = row.r;
      if (r < firstDataRow) continue;
      const bRaw = readCellRaw(row.xml, `${columns.date}${r}`);
      const cRaw = readCellRaw(row.xml, `${columns.description}${r}`);
      const fRaw = readCellRaw(row.xml, `${columns.entrada}${r}`);
      const gRaw = readCellRaw(row.xml, `${columns.saida}${r}`);
      const entrada = toCents(fRaw, this.sharedStrings);
      const saida = toCents(gRaw, this.sharedStrings);
      const hasDate = bRaw.value != null && bRaw.value !== "";
      if (!hasDate && entrada === 0 && saida === 0) continue; // linha vazia
      const date = plainDateFromCell(bRaw, this.sharedStrings);
      if (!date) continue; // sem data legivel nao da para rotear/deduplicar
      const description = resolveText(cRaw, this.sharedStrings);
      const direction = saida > 0 ? "debit" : "credit";
      txs.push({
        date,
        description,
        direction,
        amount: Money.fromCents(saida > 0 ? saida : entrada),
        account: { id: `xlsx-${sheet}`, label: sheet },
        sourceOrder: r,
        rawLine: `row ${r}`,
      });
    }
    return txs;
  }

  /**
   * O HISTORICO JA CLASSIFICADO de uma aba: descricao + categoria + direcao,
   * uma entrada por linha preenchida. E a materia-prima da mineracao de regras
   * (`domain/ruleMining.ts`).
   *
   * Por que nao aproveitar `readExisting`: aquilo e o dedup, e o dedup nao le a
   * coluna de categoria — acrescentar um campo la mudaria o objeto que meia
   * duzia de testes ja compara. E por que nao aproveitar os `examples` do
   * perfil: eles sao amostra para prompt (deduplicados, no maximo 30), e
   * mineracao precisa exatamente do que a deduplicacao joga fora — a CONTAGEM.
   * Tres "Wanda Lemos -> Motoboys" e a evidencia; um exemplo unico nao e nada.
   *
   * Linha sem categoria e ignorada: ela nao ensina nada.
   */
  async readCategoryHistory(sheet: string, layout: SheetRowLayout): Promise<ObservacaoHistorica[]> {
    const xml = await this.sheetXml(sheet);
    const { columns, firstDataRow } = layout;
    const out: ObservacaoHistorica[] = [];
    for (const row of iterRows(xml)) {
      const r = row.r;
      if (r < firstDataRow) continue;
      const categoria = resolveText(
        readCellRaw(row.xml, `${columns.category}${r}`),
        this.sharedStrings,
      );
      if (!categoria.trim()) continue;
      const descricao = resolveText(
        readCellRaw(row.xml, `${columns.description}${r}`),
        this.sharedStrings,
      );
      if (!descricao.trim()) continue;
      const saida = toCents(readCellRaw(row.xml, `${columns.saida}${r}`), this.sharedStrings);
      const entrada = toCents(readCellRaw(row.xml, `${columns.entrada}${r}`), this.sharedStrings);
      if (saida === 0 && entrada === 0) continue; // sem valor nao da para saber a direcao
      out.push({
        descricao,
        // grafia EXATA da planilha: e ela que a regra tem de devolver depois
        categoria,
        direcao: saida > 0 ? "saida" : "entrada",
        aba: sheet,
      });
    }
    return out;
  }

  /**
   * INSERCAO POR ENCAIXE.
   *
   * Antes, isto era "ache a primeira linha vazia e grave ali". Numa aba em
   * ordem CRESCENTE o fim da lista e mesmo o lugar da data mais nova, entao
   * passava por certo. Numa aba DECRESCENTE nao: o fim e a data mais ANTIGA, e
   * foi assim que os lancamentos de 15 a 31 de setembro foram parar embaixo do
   * dia 1 — ordenados entre si, no lugar errado.
   *
   * Agora cada linha entra ONDE a data dela pede: no topo, no meio ou no fim.
   * Como um `.xlsx` nao tem "inserir linha" (isso mexeria em merges, validacao,
   * formatacao condicional e em toda formula que aponta para baixo), o que se
   * faz aqui e o equivalente cirurgico: as celulas GRAVAVEIS dos lancamentos
   * que ficam abaixo do encaixe sao REALOCADAS para as linhas seguintes,
   * byte a byte, e a linha nova ocupa o lugar aberto. Nenhuma linha e criada ou
   * removida dentro do bloco; as formulas (E/H), os merges e o dropdown ficam
   * onde estao, e cada uma continua valendo para a sua propria linha.
   *
   * Tres travas:
   *  - a ordem RELATIVA do que ja estava gravado nunca muda;
   *  - nada acima do ponto de encaixe e tocado (append puro continua sendo
   *    append puro, sem reescrever a aba inteira);
   *  - ordem "indefinida" volta ao comportamento historico: tudo no fim.
   */
  async appendRows(sheet: string, rows: SheetRow[], layout: SheetRowLayout): Promise<AppendOutcome> {
    const file = this.sheetFileByName.get(sheet)!;
    let xml = await this.sheetXml(sheet);
    const { columns, firstDataRow } = layout;
    // Convencao da ABA (estilo herdado por coluna + data como texto ou serial).
    // Calculada UMA vez sobre o estado inicial: as linhas que ja estao la sao a
    // referencia, e as que vamos escrever devem sair iguais a elas.
    const convention = analyzeSheetConventions(xml, layout);
    // FORMULAS A PERPETUAR. A aba de destino tem a ultima palavra — e o padrao
    // desta aba que a linha nova precisa imitar. So quando a aba nao ensina
    // nada (o caso de um mes que o cliente ainda nao usou) recorremos ao modelo
    // consolidado da planilha, que veio do perfil.
    const formulaRules = resolveFormulaRules(xml, sheet, layout);

    const warnings: string[] = [];
    if (rows.length === 0) {
      return { sheet, appended: 0, firstRow: -1, lastRow: -1, warnings };
    }

    // ── 1. a ordem que ESTA aba pratica ───────────────────────────────────
    const ordem = resolveSheetDateOrder(xml, sheet, layout, this.sharedStrings);

    // ── 2. o que ja esta gravado, capturado antes de qualquer alteracao ───
    const existentes = readDataBlock(xml, layout, this.sharedStrings);

    // ── 3. o plano de encaixe ─────────────────────────────────────────────
    const novos: Array<ItemDatado<SheetRow>> = rows.map((r) => ({
      item: r,
      date: dateOfSheetRow(r),
    }));
    const plano = planInsertion<LinhaExistente, SheetRow>(existentes, novos, ordem);

    // ── 4. que linha do arquivo recebe cada item ──────────────────────────
    // Tudo o que esta ANTES da primeira mudanca fica exatamente como esta: nem
    // uma celula reescrita. Do ponto de encaixe para baixo, as linhas que os
    // lancamentos existentes ocupavam sao reaproveitadas na mesma ordem — os
    // buracos que houver no meio do bloco continuam onde estavam — e o que
    // faltar sai de linhas novas depois da ultima.
    const inicio = plano.primeiraMudanca === -1 ? plano.sequencia.length : plano.primeiraMudanca;
    const reposicionados = plano.sequencia.slice(inicio);
    const vagas: number[] = reposicionados
      .filter((e): e is { tipo: "existente"; item: LinhaExistente } => e.tipo === "existente")
      .map((e) => e.item.row);
    const ultimaOcupada = Math.max(
      firstDataRow - 1,
      ...existentes.map((e) => e.item.row),
      ...vagas,
    );
    let proxima = ultimaOcupada + 1;
    while (vagas.length < reposicionados.length) vagas.push(proxima++);
    vagas.sort((a, b) => a - b);

    // ── 5. escrita ────────────────────────────────────────────────────────
    let firstNovo = -1;
    let lastWritten = -1;
    for (let i = 0; i < reposicionados.length; i++) {
      const alvo = vagas[i];
      const entrada = reposicionados[i];
      // linha existente que nao saiu do lugar: nada a fazer.
      if (entrada.tipo === "existente" && entrada.item.row === alvo) continue;

      xml = ensureRow(xml, alvo);
      xml = clearWritableCells(xml, alvo, layout);
      if (entrada.tipo === "existente") {
        xml = placeCapturedCells(xml, alvo, entrada.item);
      } else {
        if (firstNovo === -1) {
          warnings.push(...checkChainGap(xml, alvo, formulaRules, firstDataRow, sheet));
          firstNovo = alvo;
        }
        xml = writeCellsIntoRow(xml, alvo, entrada.item, columns, convention, (base) =>
          this.guaranteeDateStyle(base),
        );
      }
      // A linha nasce COMPLETA: os campos digitados e os calculados. Vale
      // tambem para a linha que so recebeu um lancamento realocado — ela pode
      // ser uma linha que antes estava vazia e nunca teve formula.
      xml = perpetuateFormulas(xml, alvo, formulaRules, firstDataRow);
      lastWritten = Math.max(lastWritten, alvo);
    }
    if (lastWritten === -1) lastWritten = ultimaOcupada;

    if (!plano.apenasNoFim) {
      warnings.push(
        `Na aba ${sheet}, os lançamentos novos foram encaixados pela data ` +
          `(a aba está em ordem ${ordem}); as linhas seguintes desceram para abrir espaço.`,
      );
    }

    // A lista suspensa tem de alcancar as linhas novas. Sem isso, gravar abaixo
    // do intervalo original (`D13:D254`) produz uma celula com o texto certo
    // mas sem o dropdown — a linha nova nao se comporta como as de cima.
    if (lastWritten > 0) {
      for (const regra of layout.listColumns ?? []) {
        xml = extendValidationRange(xml, regra.letter, lastWritten);
      }
    }

    this.zip.file(file, xml);
    this.flushStyles();
    // As formulas que acabamos de gravar entram SEM valor em cache, e as que ja
    // existiam ficaram com o cache velho (inserir uma linha muda o saldo das
    // linhas seguintes). Pedir recalculo na abertura e o que faz o usuario ver
    // numero, e nao celula vazia ou valor defasado.
    if (lastWritten > 0) await this.requestFullRecalc();
    return {
      sheet,
      appended: rows.length,
      firstRow: firstNovo === -1 ? lastWritten : firstNovo,
      lastRow: lastWritten,
      warnings,
    };
  }

  /**
   * Marca a pasta de trabalho para RECALCULAR ao abrir e descarta a cadeia de
   * calculo em cache (`calcChain.xml`), que passa a estar incompleta assim que
   * acrescentamos formulas. Mexe so em metadados: nenhuma celula, formula,
   * merge ou validacao e tocada, entao T-PRES continua valendo.
   */
  private async requestFullRecalc(): Promise<void> {
    const calcChain = this.zip.file("xl/calcChain.xml");
    if (calcChain) this.zip.remove("xl/calcChain.xml");

    const wbFile = this.zip.file("xl/workbook.xml");
    if (!wbFile) return;
    const wb = await wbFile.async("string");
    if (/<calcPr\b[^>]*fullCalcOnLoad="1"/.test(wb)) return;
    let next: string;
    if (/<calcPr\b/.test(wb)) {
      next = wb.replace(/<calcPr\b([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
      if (next === wb) {
        next = wb.replace(/<calcPr\b([^>]*?)>/, '<calcPr$1 fullCalcOnLoad="1">');
      }
    } else {
      next = wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
    }
    if (next !== wb) this.zip.file("xl/workbook.xml", next);
  }

  /**
   * Finaliza uma planilha GERADA por nos (createWorkbook): remove as formulas
   * E (Fluxo de Caixa) e H (Saldo) das linhas de dados VAZIAS — ou seja, deixa
   * formula APENAS nas linhas que tem dados. Sem isso, o saldo corrente (H) se
   * arrastaria por centenas de linhas em branco.
   *
   * NUNCA deve ser chamada sobre o template REAL do usuario: la as formulas sao
   * preservadas byte-a-byte (contrato T-PRES / T-NOFORMULA). Por isso o engine
   * so a invoca quando a planilha foi criada por nos. Pula "Categorias" e o
   * dashboard (cujas formulas de SUM devem permanecer).
   */
  async finalizeGeneratedTemplate(layout: SheetRowLayout): Promise<void> {
    const skip = new Set(["Categorias", "FLUXO DE CAIXA  SIMPLIFICADO"]);
    for (const [name, file] of this.sheetFileByName) {
      if (skip.has(name)) continue;
      const xml = await this.zip.file(file)!.async("string");
      const trimmed = trimEmptyFormulaRows(xml, layout);
      if (trimmed !== xml) this.zip.file(file, trimmed);
    }
  }

  /**
   * AUTO-AJUSTE DE LARGURA — mede o conteudo REAL das linhas (cabecalho + dados)
   * e alarga as colunas que nao cabem. Mexe SO no elemento `<cols>`: nenhuma
   * celula, formula, merge ou validacao e tocada, entao T-PRES/T-NOFORMULA
   * continuam valendo.
   *
   * `onlyExpand` (default true) e o que torna seguro rodar isso na planilha
   * VIVA do usuario: a coluna que ele ja alargou fica como esta; so mexemos
   * quando o texto que gravamos nao cabe na largura atual.
   */
  async autofitColumns(
    sheet: string,
    layout: SheetRowLayout,
    opts: { onlyExpand?: boolean } = {},
  ): Promise<Record<string, number>> {
    const file = this.sheetFileByName.get(sheet);
    if (!file) return {};
    const xml = await this.zip.file(file)!.async("string");
    const widths = measureSheetWidths(xml, layout, this.sharedStrings);
    if (Object.keys(widths).length === 0) return {};
    const next = applyColumnWidths(xml, byColumnNumber(widths), {
      onlyExpand: opts.onlyExpand !== false,
    });
    if (next !== xml) this.zip.file(file, next);
    return widths;
  }

  /** Auto-ajuste em todas as abas de lancamento (pula as abas de apoio). */
  async autofitAllSheets(
    layout: SheetRowLayout,
    opts: { onlyExpand?: boolean } = {},
  ): Promise<void> {
    for (const name of this.sheetFileByName.keys()) {
      if (isSupportSheet(name)) continue;
      await this.autofitColumns(name, layout, opts);
    }
  }

  /**
   * Serializa o arquivo final preservando tudo o que nao foi tocado.
   * `onProgress` recebe 0..1 — a compactacao do ZIP e a parte demorada e e o
   * que alimenta a barra de progresso do download.
   */
  async toBytes(onProgress?: (pct: number) => void): Promise<Uint8Array> {
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }, (meta) =>
      onProgress?.(Math.max(0, Math.min(1, meta.percent / 100))),
    );
  }
}

/** Itera as linhas do XML em UMA passada (evita varredura O(n²) por linha). */
function* iterRows(xml: string): Generator<{ r: number; xml: string }> {
  const re = /<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) yield { r: Number(m[1]), xml: m[0] };
}

/** Texto COMO O USUARIO VE — e o que determina a largura necessaria. */
function displayText(
  raw: { type: string | null; value: string | null },
  kind: "date" | "money" | "text",
  shared: string[],
): string {
  if (raw.value == null || raw.value === "") return "";
  // celula de texto: o <v> e indice de sharedString — nunca interpretar como numero
  if (kind === "text" || raw.type === "s" || raw.type === "inlineStr" || raw.type === "str") {
    return resolveText(raw, shared);
  }
  const n = Number(raw.value);
  if (!Number.isFinite(n)) return resolveText(raw, shared);
  if (kind === "date") {
    const d = excelSerialToPlainDate(n);
    if (!Number.isFinite(d.year)) return "";
    return `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
  }
  return Money.fromCents(Math.round(Math.abs(n) * 100)).format();
}

/**
 * Mede a largura necessaria de cada coluna do contrato (B..H) a partir do
 * conteudo real da aba. A coluna de FLUXO (E) e formula: seu texto calculado
 * nao esta no XML, entao reservamos a maior classe de fluxo conhecida.
 */
export function measureSheetWidths(
  xml: string,
  layout: SheetRowLayout,
  shared: string[] = [],
): Record<string, number> {
  const { columns, headerRow, firstDataRow } = layout;
  // PISO por papel: mesmo com a coluna vazia (ou com um unico valor curto), a
  // largura tem de comportar o que aquele campo normalmente recebe. Sem isso a
  // coluna de dinheiro nasceria com 9 caracteres e cortaria "R$ 1.234.567,89"
  // no primeiro lancamento grande.
  const roles: Array<{ col: string; kind: "date" | "money" | "text"; floor: number; extra?: string[] }> = [
    { col: columns.date, kind: "date", floor: 12 },
    { col: columns.description, kind: "text", floor: 28 },
    { col: columns.category, kind: "text", floor: 20 },
    { col: columns.flow, kind: "text", floor: 18, extra: ["NÃO OPERACIONAL"] },
    { col: columns.entrada, kind: "money", floor: 14 },
    { col: columns.saida, kind: "money", floor: 14 },
    { col: columns.saldo, kind: "money", floor: 15 },
  ];
  const texts = new Map<string, string[]>(roles.map((r) => [r.col, [...(r.extra ?? [])]]));

  for (const row of iterRows(xml)) {
    if (row.r !== headerRow && row.r < firstDataRow) continue;
    for (const { col, kind } of roles) {
      const raw = readCellRaw(row.xml, `${col}${row.r}`);
      const t = row.r === headerRow ? resolveText(raw, shared) : displayText(raw, kind, shared);
      if (t) texts.get(col)!.push(t);
    }
  }

  const out: Record<string, number> = {};
  for (const { col, floor } of roles) {
    out[col] = Math.max(floor, widthForTexts(texts.get(col)!));
  }
  return out;
}

/** true se a celula `ref` contem uma formula (<f>) dentro do <row>. */
function cellHasFormula(rowXml: string, ref: string): boolean {
  const re = new RegExp(`<c r="${ref}"[^>]*?>\\s*<f`);
  return re.test(rowXml);
}

/**
 * Remove as formulas de E (flow) e H (saldo) das linhas de dados que nao tem
 * nenhum dado (B/C/F/G vazias), transformando essas celulas em vazias (mantendo
 * o estilo). Linhas COM dados ficam intactas.
 */
function trimEmptyFormulaRows(xml: string, layout: SheetRowLayout): string {
  const { columns, firstDataRow } = layout;
  const maxRow = highestRow(xml);
  for (let r = firstDataRow; r <= maxRow; r++) {
    const found = findRow(xml, r);
    if (!found) continue;
    let rowXml = found.match;
    const empty =
      cellIsEmpty(rowXml, `${columns.date}${r}`) &&
      cellIsEmpty(rowXml, `${columns.description}${r}`) &&
      cellIsEmpty(rowXml, `${columns.entrada}${r}`) &&
      cellIsEmpty(rowXml, `${columns.saida}${r}`);
    if (!empty) continue;
    let changed = false;
    for (const col of [columns.flow, columns.saldo]) {
      const ref = `${col}${r}`;
      if (cellHasFormula(rowXml, ref)) {
        const s = cellStyle(rowXml, ref);
        rowXml = upsertCellInRow(rowXml, ref, `<c r="${ref}"${s ? ` s="${s}"` : ""}/>`);
        changed = true;
      }
    }
    if (changed) xml = xml.slice(0, found.start) + rowXml + xml.slice(found.end);
  }
  return xml;
}

// ---------- helpers ----------

function decodeXmlName(s: string): string {
  return unescapeXml(s);
}

function highestRow(xml: string): number {
  let max = 0;
  for (const m of xml.matchAll(/<row r="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * Valor de uma celula em centavos. Como a data, o valor tambem pode estar
 * gravado como TEXTO ("R$ 1.008,00") em planilhas montadas a mao — nesse caso o
 * <v> e indice de sharedString e precisa ser resolvido antes de virar numero.
 */
function toCents(raw: { type: string | null; value: string | null }, shared: string[] = []): number {
  if (raw.value == null || raw.value === "") return 0;
  const isText = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
  if (isText) {
    const text = resolveText(raw, shared).trim();
    if (!text) return 0;
    try {
      return parseMoneyPtBr(text).money.cents;
    } catch {
      return 0;
    }
  }
  const n = Number(raw.value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function resolveText(
  raw: { type: string | null; value: string | null },
  shared: string[],
): string {
  if (raw.value == null) return "";
  if (raw.type === "s") return shared[Number(raw.value)] ?? "";
  return raw.value;
}

/**
 * CONVENCAO DE ESCRITA DE UMA ABA — como as linhas que ja estao la guardam cada
 * coluna. Duas informacoes por coluna gravavel:
 *
 *  - `style`: o estilo predominante das celulas JA preenchidas. Serve de
 *    herança quando a linha de destino nao tem aquela celula (acontece nas abas
 *    que o usuario ja usou: a primeira linha livre costuma ter so F/G/H). Sem
 *    isso a celula nasce sem formato e o valor aparece cru.
 *  - `dateAsText`: se a coluna de data guarda TEXTO "dd/mm/aaaa" em vez de
 *    serial. Na planilha real e o caso — e gravar serial ali produzia "46169"
 *    na tela.
 */
interface SheetConventions {
  styleByColumn: Map<string, string>;
  dateAsText: boolean;
}

function analyzeSheetConventions(xml: string, layout: SheetRowLayout): SheetConventions {
  const { columns, firstDataRow } = layout;
  const graváveis = [
    columns.date,
    columns.description,
    columns.category,
    columns.entrada,
    columns.saida,
  ];
  // votos de estilo por coluna, contados apenas em celulas COM conteudo
  const styleVotes = new Map<string, Map<string, number>>(graváveis.map((c) => [c, new Map()]));
  const fallbackStyle = new Map<string, string>(); // estilo de celula vazia (2a opcao)
  let dateTexto = 0;
  let dateSerial = 0;

  for (const row of iterRows(xml)) {
    if (row.r < firstDataRow) continue;
    for (const col of graváveis) {
      const ref = `${col}${row.r}`;
      const raw = readCellRaw(row.xml, ref);
      const style = cellStyle(row.xml, ref);
      const preenchida = raw.value != null && raw.value !== "";
      if (!preenchida) {
        if (style && !fallbackStyle.has(col)) fallbackStyle.set(col, style);
        continue;
      }
      if (style) {
        const votes = styleVotes.get(col)!;
        votes.set(style, (votes.get(style) ?? 0) + 1);
      }
      if (col === columns.date) {
        const isText = raw.type === "s" || raw.type === "inlineStr" || raw.type === "str";
        if (isText) dateTexto++;
        else dateSerial++;
      }
    }
  }

  const styleByColumn = new Map<string, string>();
  for (const col of graváveis) {
    const votes = styleVotes.get(col)!;
    let best: string | null = null;
    let bestN = 0;
    for (const [s, n] of votes) {
      if (n > bestN) {
        bestN = n;
        best = s;
      }
    }
    const chosen = best ?? fallbackStyle.get(col) ?? null;
    if (chosen) styleByColumn.set(col, chosen);
  }

  // Decide texto x serial pelo que a ABA ja pratica: se as linhas existentes
  // guardam a data como texto, a linha nova sai igual (as formulas e o dedup do
  // usuario contam com isso). Sem nenhuma data gravada, o padrao e SERIAL —
  // data de verdade, que ordena e entra em calculo — porque o writer agora
  // GARANTE o formato de exibicao (ver `guaranteeDateStyle`) em vez de torcer
  // para a celula de destino ja ter um estilo de data.
  const dateAsText = dateTexto + dateSerial > 0 ? dateTexto > dateSerial : false;

  return { styleByColumn, dateAsText };
}

/* ────────────────────────────────────────────────────────────────────────
 * ENCAIXE — leitura do bloco existente e realocacao de celulas
 * ──────────────────────────────────────────────────────────────────────── */

/** Um lancamento JA gravado, capturado como esta no arquivo. */
export interface LinhaExistente {
  row: number;
  /** o XML das celulas graveis, intacto (valor, tipo e estilo). */
  cells: Array<{ col: string; xml: string }>;
}

/** As colunas que o writer pode preencher — e, portanto, mover. */
function writableColumnsOf(columns: SheetRowLayout["columns"]): string[] {
  return [columns.date, columns.description, columns.category, columns.entrada, columns.saida];
}

/**
 * A ORDEM QUE ESTA ABA PRATICA, com a aba tendo a ultima palavra.
 *
 * A hierarquia importa e e o que "fortalece a identificacao do padrao":
 *  1. as datas da PROPRIA aba de destino, que sao o fato mais proximo do que
 *     vamos escrever;
 *  2. a leitura que a analise fez dessa mesma aba, quando a aba (ainda) nao tem
 *     linhas suficientes para decidir sozinha;
 *  3. a ordem da planilha inteira — um mes novo, vazio, herda o costume da casa.
 *
 * Em nenhum ponto se chuta: sem evidencia, "indefinida", e o writer volta a
 * empilhar no fim, que e o comportamento de sempre.
 */
export function resolveSheetDateOrder(
  xml: string,
  sheet: string,
  layout: SheetRowLayout,
  shared: string[] = [],
): DateOrder {
  const datas: PlainDate[] = [];
  for (const row of iterRows(xml)) {
    if (row.r < layout.firstDataRow) continue;
    const d = plainDateFromCell(
      readCellRaw(row.xml, `${layout.columns.date}${row.r}`),
      shared,
    );
    if (d) datas.push(d);
  }
  const daAba = detectDateOrder(datas);
  if (daAba.conclusiva) return daAba.ordem;
  const doPerfil = layout.dateOrderBySheet?.[sheet];
  if (doPerfil?.conclusiva) return doPerfil.ordem;
  return layout.dateOrder ?? "indefinida";
}

/**
 * Os lancamentos ja gravados na aba, na ordem das linhas. Linha e considerada
 * ocupada pelo mesmo criterio do dedup (data, descricao ou valor): uma celula
 * de categoria solta nao faz de uma linha em branco um lancamento.
 */
function readDataBlock(
  xml: string,
  layout: SheetRowLayout,
  shared: string[],
): Array<ItemDatado<LinhaExistente>> {
  const { columns, firstDataRow } = layout;
  const graváveis = writableColumnsOf(columns);
  const out: Array<ItemDatado<LinhaExistente>> = [];
  for (const row of iterRows(xml)) {
    if (row.r < firstDataRow) continue;
    const ocupada =
      !cellIsEmpty(row.xml, `${columns.date}${row.r}`) ||
      !cellIsEmpty(row.xml, `${columns.description}${row.r}`) ||
      !cellIsEmpty(row.xml, `${columns.entrada}${row.r}`) ||
      !cellIsEmpty(row.xml, `${columns.saida}${row.r}`);
    if (!ocupada) continue;
    const cells: LinhaExistente["cells"] = [];
    for (const col of graváveis) {
      const c = readCellXml(row.xml, `${col}${row.r}`);
      if (c) cells.push({ col, xml: c });
    }
    const date = plainDateFromCell(readCellRaw(row.xml, `${columns.date}${row.r}`), shared);
    out.push({ item: { row: row.r, cells }, date });
  }
  return out;
}

/** A data de uma linha a gravar — serial primeiro, texto como rede. */
function dateOfSheetRow(row: SheetRow): PlainDate | null {
  if (Number.isFinite(row.dateSerial) && row.dateSerial > 0) {
    const d = excelSerialToPlainDate(row.dateSerial);
    if (Number.isFinite(d.year)) return d;
  }
  try {
    return parseDatePtBr(row.dateText);
  } catch {
    return null;
  }
}

/**
 * Esvazia as colunas graveis de uma linha, preservando o estilo de cada celula.
 * E o passo que impede um resto do lancamento anterior de sobreviver embaixo do
 * novo — a categoria da linha antiga, por exemplo, que so seria sobrescrita se
 * o lancamento que chega tambem tivesse categoria.
 */
function clearWritableCells(xml: string, r: number, layout: SheetRowLayout): string {
  const found = findRow(xml, r);
  if (!found) return xml;
  let rowXml = found.match;
  let mudou = false;
  for (const col of writableColumnsOf(layout.columns)) {
    const ref = `${col}${r}`;
    if (readCellXml(rowXml, ref) == null) continue;
    rowXml = upsertCellInRow(rowXml, ref, emptyCell(ref, cellStyle(rowXml, ref)));
    mudou = true;
  }
  return mudou ? xml.slice(0, found.start) + rowXml + xml.slice(found.end) : xml;
}

/** Reinstala, na linha `r`, as celulas capturadas de um lancamento existente. */
function placeCapturedCells(xml: string, r: number, linha: LinhaExistente): string {
  const found = findRow(xml, r);
  if (!found) return xml;
  let rowXml = found.match;
  for (const c of linha.cells) {
    const ref = `${c.col}${r}`;
    rowXml = upsertCellInRow(rowXml, ref, retargetCell(c.xml, ref));
  }
  return xml.slice(0, found.start) + rowXml + xml.slice(found.end);
}

/** Preenche as colunas graveis na linha `r`, sem nunca tocar em E/H. */
function writeCellsIntoRow(
  xml: string,
  r: number,
  row: SheetRow,
  columns: SheetRowLayout["columns"],
  convention: SheetConventions,
  guaranteeDateStyle: (base: string | null) => string | null,
): string {
  const found = findRow(xml, r);
  if (!found) throw new Error(`Linha ${r} inexistente`);
  let rowXml = found.match;

  /** Estilo da propria celula; se ela nao existir, o herdado da coluna. */
  const styleFor = (ref: string, col: string): string | null =>
    cellStyle(rowXml, ref) ?? convention.styleByColumn.get(col) ?? null;

  // B — data. Serial OU texto dd/mm/aaaa, conforme a convencao da aba.
  //
  // Quando gravamos SERIAL, o estilo passa pela garantia de formato de data: a
  // celula de destino pode ter estilo proprio (herdado de uma colagem, de uma
  // linha limpa a mao) que nao exibe data, e a heranca por coluna sozinha nao
  // percebe isso — era assim que o serial escapava para a tela como "46201".
  // Se a planilha nao permitir registrar um estilo de data, caimos para texto,
  // que exibe certo em qualquer caso.
  const bRef = `${columns.date}${r}`;
  const bStyleHerdado = styleFor(bRef, columns.date);
  const bStyleData = convention.dateAsText ? null : guaranteeDateStyle(bStyleHerdado);
  const gravarTexto = convention.dateAsText || bStyleData === null;
  rowXml = upsertCellInRow(
    rowXml,
    bRef,
    gravarTexto
      ? inlineStringCell(bRef, bStyleHerdado, row.dateText)
      : numberCell(bRef, bStyleData, row.dateSerial),
  );

  // C — descricao (inlineStr)
  const cRef = `${columns.description}${r}`;
  rowXml = upsertCellInRow(
    rowXml,
    cRef,
    inlineStringCell(cRef, styleFor(cRef, columns.description), row.description),
  );

  // D — categoria (so escreve se houver; vazia mantem o dropdown intacto)
  if (row.category) {
    const dRef = `${columns.category}${r}`;
    rowXml = upsertCellInRow(
      rowXml,
      dRef,
      inlineStringCell(dRef, styleFor(dRef, columns.category), row.category),
    );
  }

  // F — entrada (reais); so escreve se houver valor
  if (row.entradaCents != null) {
    const fRef = `${columns.entrada}${r}`;
    rowXml = upsertCellInRow(
      rowXml,
      fRef,
      numberCell(fRef, styleFor(fRef, columns.entrada), (row.entradaCents / 100).toFixed(2)),
    );
  }
  // G — saida (reais)
  if (row.saidaCents != null) {
    const gRef = `${columns.saida}${r}`;
    rowXml = upsertCellInRow(
      rowXml,
      gRef,
      numberCell(gRef, styleFor(gRef, columns.saida), (row.saidaCents / 100).toFixed(2)),
    );
  }

  return xml.slice(0, found.start) + rowXml + xml.slice(found.end);
}

/* ────────────────────────────────────────────────────────────────────────
 * PERPETUACAO DE FORMULA
 *
 * O sintoma que chegou do cliente foi "as formulas de Fluxo de Caixa e Saldo
 * sumiram nas linhas novas". Elas nao sumiram: a linha inserida nunca as teve.
 * Enquanto quem digita e o usuario, o Excel copia a formula para baixo sozinho;
 * quando quem escreve e o writer, ninguem copia — e a celula fica vazia para
 * sempre, com a corrente do saldo interrompida a partir dali.
 *
 * A regra aqui e a mesma do Excel ao arrastar uma formula: referencia relativa
 * anda com a linha, referencia com `$` fica. Duas travas:
 *  - NUNCA sobrescrevemos formula existente (a da planilha e soberana);
 *  - gravamos a formula SEM valor em cache; quem calcula e o Excel, na abertura
 *    (ver `requestFullRecalc`). Chutar o valor seria inventar dado.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * De onde saem as formulas a repetir nesta aba: primeiro o que a PROPRIA aba
 * pratica; para as colunas em que ela nao pratica nada, o modelo consolidado da
 * planilha (que o perfil montou olhando todas as abas de mes).
 */
export function resolveFormulaRules(
  xml: string,
  sheet: string,
  layout: SheetRowLayout,
): FormulaColumnRule[] {
  const doPerfil = layout.formulaColumns ?? [];
  let daAba: FormulaColumnRule[] = [];
  try {
    daAba = detectFormulaColumns({
      sheetName: sheet,
      sheetXml: xml,
      firstDataRow: layout.firstDataRow,
      headers: new Map(),
      writableColumns: layout.writableColumns,
    });
  } catch {
    daAba = [];
  }
  // So aproveitamos da aba as colunas que o perfil reconheceu como calculadas —
  // assim uma formula avulsa que alguem deixou numa celula solta nao vira regra.
  const aprovadas = new Set(doPerfil.map((r) => r.letter));
  const out = new Map<string, FormulaColumnRule>();
  for (const r of doPerfil) out.set(r.letter, r);
  for (const r of daAba) {
    if (doPerfil.length > 0 && !aprovadas.has(r.letter)) continue;
    const doPerfilDaColuna = out.get(r.letter);
    out.set(r.letter, {
      ...r,
      header: r.header || doPerfilDaColuna?.header || "",
      // a aba pode nao ter o caso da primeira linha; o perfil pode ter
      templateFirstRow: r.templateFirstRow ?? doPerfilDaColuna?.templateFirstRow,
      templateFirstRowOrigin:
        r.templateFirstRowOrigin ?? doPerfilDaColuna?.templateFirstRowOrigin,
    });
  }
  return [...out.values()];
}

/**
 * A corrente do saldo so continua se a linha de cima tiver saldo. Quando ela
 * esta vazia — porque alguem apagou uma linha no meio, ou deixou um lancamento
 * pela metade — a formula acumulada da linha nova soma a partir de zero.
 *
 * Nao consertamos isso: mexer numa linha que o usuario nao mandou mexer e
 * justamente o que o contrato de escrita cirurgica proibe. Mas avisamos, porque
 * um saldo que recomeca no meio da aba e facil de nao notar e caro de descobrir
 * depois.
 */
function checkChainGap(
  xml: string,
  target: number,
  rules: FormulaColumnRule[],
  firstDataRow: number,
  sheet: string,
): string[] {
  const out: string[] = [];
  if (target <= firstDataRow) return out;
  const anterior = findRow(xml, target - 1);
  if (!anterior) return out;
  for (const rule of rules) {
    if (rule.kind !== "acumulada") continue;
    const ref = `${rule.letter}${target - 1}`;
    const temFormula = cellHasFormula(anterior.match, ref);
    const raw = readCellRaw(anterior.match, ref);
    const temValor = raw.value != null && raw.value !== "";
    if (temFormula || temValor) continue;
    out.push(
      `Na aba ${sheet}, a linha ${target - 1} está sem ${rule.header || rule.letter}. ` +
        `Como a coluna é acumulada, o saldo das linhas novas recomeça a partir dela — ` +
        `preencha ou apague essa linha na planilha para a corrente voltar ao normal.`,
    );
  }
  return out;
}

/** Escreve a formula de cada coluna calculada na linha `r`, se ela ainda nao tiver. */
export function perpetuateFormulas(
  xml: string,
  r: number,
  rules: FormulaColumnRule[],
  firstDataRow: number,
): string {
  if (rules.length === 0) return xml;
  const found = findRow(xml, r);
  if (!found) return xml;
  let rowXml = found.match;
  let mudou = false;

  for (const rule of rules) {
    const ref = `${rule.letter}${r}`;
    if (cellHasFormula(rowXml, ref)) continue; // a planilha ja resolveu esta celula

    // A PRIMEIRA linha de dados e legitimamente diferente numa coluna
    // acumulada: ela aponta para o saldo inicial, nao para a linha de cima
    // (que e cabecalho). Se a planilha ensinou esse caso, e ele que vale.
    const usaModeloDaPrimeira = r === firstDataRow && rule.templateFirstRow;
    const template = usaModeloDaPrimeira ? rule.templateFirstRow! : rule.template;
    const origem = usaModeloDaPrimeira
      ? (rule.templateFirstRowOrigin ?? firstDataRow)
      : rule.templateRow;
    // Sem modelo geral (a coluna so tinha formula na primeira linha, que aponta
    // para o cabecalho) nao ha o que repetir: deixamos a celula como esta.
    if (!template) continue;

    const formula = translateFormula(template, origem, r);
    if (!formula) continue; // transposicao invalida — melhor sem formula que #REF!

    const s = cellStyle(rowXml, ref) ?? rule.styleNum ?? null;
    rowXml = upsertCellInRow(
      rowXml,
      ref,
      `<c r="${ref}"${s ? ` s="${s}"` : ""}><f>${escapeXml(formula)}</f></c>`,
    );
    mudou = true;
  }

  return mudou ? xml.slice(0, found.start) + rowXml + xml.slice(found.end) : xml;
}

/** Insere uma linha vazia <row r="N"/> na posicao ordenada (fora do range pre-preenchido). */
function ensureRow(xml: string, r: number): string {
  const existente = findRow(xml, r);
  if (existente) {
    /**
     * A LINHA VAZIA AUTOFECHADA — e o silencio que ela produzia.
     *
     * O Excel grava uma linha sem conteudo como `<row r="462" ht="13.2"/>`:
     * um elemento AUTOFECHADO, que so carrega a altura. Ela existe, entao
     * `findRow` a encontrava e `ensureRow` dava a linha por pronta. Mas
     * `upsertCellInRow`, para inserir a primeira celula de uma linha, procura
     * `</row>` — que numa linha autofechada NAO EXISTE. O `replace` nao casava
     * nada, devolvia a string intacta, e a celula era descartada SEM ERRO.
     *
     * O efeito no arquivo do cliente: a planilha tem linhas de verdade ate um
     * ponto (na aba JUNHO da planilha real, a linha 461) e autofechadas dali
     * para baixo. Gravar 305 lancamentos numa aba que ja tinha 219 exigia ir
     * ate a linha 536 — e os 75 que passavam de 461 sumiam. Nao havia mensagem,
     * nao havia aviso: o relatorio dizia "305 inseridos" e a planilha tinha
     * 230. Um escritor que perde linha em silencio e pior que um que falha,
     * porque o erro dele parece sucesso.
     *
     * A correcao e abrir a linha antes de escrever nela, preservando os
     * atributos (altura, `spans`, estilo) — sem isso a linha nova nasceria com
     * altura diferente das vizinhas.
     */
    if (existente.match.endsWith("/>")) {
      const aberta = `${existente.match.slice(0, -2)}></row>`;
      return xml.slice(0, existente.start) + aberta + xml.slice(existente.end);
    }
    return xml;
  }
  const cellRe = /<row r="(\d+)"[^>]*?(?:\/>|>.*?<\/row>)/gs;
  let insertPos = -1;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    if (Number(m[1]) > r) {
      insertPos = m.index;
      break;
    }
  }
  const newRow = `<row r="${r}">${""}</row>`;
  if (insertPos === -1) {
    return xml.replace("</sheetData>", `${newRow}</sheetData>`);
  }
  return xml.slice(0, insertPos) + newRow + xml.slice(insertPos);
}
