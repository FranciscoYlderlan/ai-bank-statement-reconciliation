import { FormulaColumnRule, FormulaKind, isGeneralizable } from "../../domain/formulaColumns";
import { unescapeXml } from "./xmlCells";

/**
 * INSPECAO DETERMINISTICA DAS COLUNAS CALCULADAS — sem IA e sem custo.
 *
 * Varre as linhas de dados de uma aba e descobre quais colunas sao preenchidas
 * por FORMULA, qual e a formula-modelo e de que linha ela veio. E a informacao
 * que faltava para a linha inserida pelo sistema nascer igual as linhas que o
 * usuario digitou.
 *
 * Dois detalhes do formato que, ignorados, fazem a deteccao falhar:
 *
 *  - FORMULA COMPARTILHADA. O Excel grava a formula UMA vez
 *    (`<f t="shared" ref="H14:H77" si="0">H13+F14-G14</f>`) e nas demais linhas
 *    deixa so o ponteiro (`<f t="shared" si="0"/>`). Quem le so o texto de `<f>`
 *    conclui que as outras linhas nao tem formula. Resolvemos o `si` antes.
 *  - A PRIMEIRA LINHA E DIFERENTE. Numa coluna acumulada, a primeira linha de
 *    dados nao aponta para a linha de cima (que e cabecalho) e sim para a
 *    celula do saldo inicial (`G7+F13-G13`). Guardamos esse modelo a parte.
 */

interface SharedMaster {
  text: string;
  row: number;
}

function* iterRows(xml: string): Generator<{ r: number; xml: string }> {
  const re = /<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) yield { r: Number(m[1]), xml: m[0] };
}

function* iterCells(rowXml: string): Generator<{ ref: string; raw: string }> {
  const re = /<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml))) yield { ref: m[1], raw: m[0] };
}

/** Mapa `si` -> formula-mestra, varrido uma vez por aba. */
export function sharedFormulaMasters(sheetXml: string): Map<string, SharedMaster> {
  const out = new Map<string, SharedMaster>();
  for (const row of iterRows(sheetXml)) {
    for (const cell of iterCells(row.xml)) {
      const m = cell.raw.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/);
      if (!m) continue;
      const si = m[1].match(/\ssi="(\d+)"/)?.[1];
      const texto = m[2].trim();
      if (!si || !texto) continue;
      if (!out.has(si)) out.set(si, { text: unescapeXml(texto), row: row.r });
    }
  }
  return out;
}

export interface CellFormula {
  column: string;
  row: number;
  /** formula ja sem escape de XML e sem o "=" inicial. */
  text: string;
  /** atributo `t` da celula (ex.: "str"). */
  cellType: string | null;
  styleNum: string | null;
  /** a linha de onde o texto veio (difere de `row` em formula compartilhada). */
  originRow: number;
}

/** Le a formula de uma celula, resolvendo o ponteiro de formula compartilhada. */
function readCellFormula(
  cellXml: string,
  ref: string,
  masters: Map<string, SharedMaster>,
): CellFormula | null {
  const column = ref.replace(/\d+/g, "");
  const row = Number(ref.replace(/\D/g, ""));
  const cellType = cellXml.match(/^<c [^>]*\st="([^"]+)"/)?.[1] ?? null;
  const styleNum = cellXml.match(/^<c [^>]*\ss="(\d+)"/)?.[1] ?? null;

  const comTexto = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/);
  if (comTexto && comTexto[2].trim()) {
    return {
      column,
      row,
      text: unescapeXml(comTexto[2].trim()),
      cellType,
      styleNum,
      originRow: row,
    };
  }
  const vazia = cellXml.match(/<f\b([^>]*)\/>|<f\b([^>]*)><\/f>/);
  const attrs = comTexto?.[1] ?? vazia?.[1] ?? vazia?.[2];
  if (attrs == null) return null;
  const si = attrs.match(/\ssi="(\d+)"/)?.[1];
  if (!si) return null;
  const master = masters.get(si);
  if (!master) return null;
  return { column, row, text: master.text, cellType, styleNum, originRow: master.row };
}

/** Todas as formulas das linhas de dados de uma aba. */
export function readSheetFormulas(
  sheetXml: string,
  firstDataRow: number,
): CellFormula[] {
  const masters = sharedFormulaMasters(sheetXml);
  const out: CellFormula[] = [];
  for (const row of iterRows(sheetXml)) {
    if (row.r < firstDataRow) continue;
    for (const cell of iterCells(row.xml)) {
      if (!/<f[\s/>]/.test(cell.raw)) continue;
      const f = readCellFormula(cell.raw, cell.ref, masters);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Uma formula e ACUMULADA quando referencia a propria coluna numa linha ACIMA
 * — a assinatura do saldo corrente. Reconhecer isso importa porque a linha
 * inserida no meio da aba tem de continuar a corrente, e nao reinicia-la.
 */
function classify(column: string, text: string, row: number): FormulaKind {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])\\$?${column}\\$?(\\d+)`, "g");
  for (const m of text.matchAll(re)) {
    if (Number(m[2]) < row) return "acumulada";
  }
  return /[A-Z]{1,3}\d+/.test(text) ? "linha" : "outra";
}

export interface FormulaDetectionInput {
  sheetName: string;
  sheetXml: string;
  firstDataRow: number;
  /** letra -> cabecalho (para nomear a coluna no relatorio e nos prompts). */
  headers: Map<string, string>;
  /** colunas que o writer preenche com dados — nunca sao "calculadas". */
  writableColumns?: string[];
}

/**
 * Monta a regra de cada coluna calculada de UMA aba.
 *
 * O modelo escolhido e o da MAIOR linha que tem a formula: e o padrao mais
 * recente da aba e o mais proximo de onde vamos escrever. A primeira linha de
 * dados fica guardada a parte (`templateFirstRow`) porque numa coluna acumulada
 * ela e legitimamente diferente das outras.
 */
export function detectFormulaColumns(input: FormulaDetectionInput): FormulaColumnRule[] {
  const { sheetName, sheetXml, firstDataRow, headers } = input;
  const graváveis = new Set(input.writableColumns ?? []);
  const formulas = readSheetFormulas(sheetXml, firstDataRow);
  if (formulas.length === 0) return [];

  interface Acc {
    ocorrencias: number;
    /** modelo GERAL: o de maior linha cuja ORIGEM esta abaixo da primeira linha. */
    melhor: CellFormula | null;
    naPrimeiraLinha: CellFormula | null;
    estilos: Map<string, number>;
  }
  const porColuna = new Map<string, Acc>();
  for (const f of formulas) {
    if (graváveis.has(f.column)) continue; // coluna de dados; formula ali seria acidente
    let a = porColuna.get(f.column);
    if (!a) {
      a = { ocorrencias: 0, melhor: null, naPrimeiraLinha: null, estilos: new Map() };
      porColuna.set(f.column, a);
    }
    a.ocorrencias++;
    // Nem toda formula da coluna serve de MODELO. A do saldo inicial
    // (`G7+F13-G13`, na primeira linha de dados) alcanca a area de cabecalho:
    // arrastada para a linha 300 viraria `G294+F300-G300`, um numero tirado do
    // meio do cabecalho. `isGeneralizable` separa esse caso do saldo corrente,
    // que so olha a linha imediatamente anterior e generaliza sem problema.
    if (isGeneralizable(f.text, f.originRow) && (!a.melhor || f.row > a.melhor.row)) a.melhor = f;
    if (f.row === firstDataRow) a.naPrimeiraLinha = f;
    if (f.styleNum) a.estilos.set(f.styleNum, (a.estilos.get(f.styleNum) ?? 0) + 1);
  }

  // quantas linhas de dados existem de fato (para saber se a formula e "da coluna")
  let linhasDeDados = 0;
  for (const row of iterRows(sheetXml)) {
    if (row.r >= firstDataRow) linhasDeDados++;
  }

  const regras: FormulaColumnRule[] = [];
  for (const [column, a] of porColuna) {
    // Sem modelo geral, so sobra o caso da primeira linha — a coluna entra na
    // regra com `template` vazio, e o writer so a aplica se estiver escrevendo
    // exatamente na primeira linha de dados. Preferimos celula sem formula a
    // formula transposta de um modelo que nao se generaliza.
    if (!a.melhor && !a.naPrimeiraLinha) continue;
    // a formula-modelo e a da maior linha; ela vale a partir da linha de origem
    // dela (que, em formula compartilhada, e a linha da mestra)
    const template = a.melhor?.text ?? "";
    const templateRow = a.melhor?.originRow ?? firstDataRow;
    const kind = template
      ? classify(column, template, templateRow)
      : classify(column, a.naPrimeiraLinha!.text, firstDataRow);
    let estiloTop: string | null = null;
    let n = 0;
    for (const [s, c] of a.estilos) {
      if (c > n) {
        n = c;
        estiloTop = s;
      }
    }
    regras.push({
      letter: column,
      header: headers.get(column) ?? "",
      template,
      templateRow,
      kind,
      cellType: (a.melhor ?? a.naPrimeiraLinha)!.cellType,
      styleNum: estiloTop,
      porColuna: linhasDeDados > 0 && a.ocorrencias >= Math.min(linhasDeDados, 3),
      ocorrencias: a.ocorrencias,
      sheet: sheetName,
      motivo:
        kind === "acumulada"
          ? "saldo/acumulado — a linha nova tem de continuar a corrente"
          : "coluna derivada de outras colunas da mesma linha",
      ...(a.naPrimeiraLinha
        ? {
            templateFirstRow: a.naPrimeiraLinha.text,
            templateFirstRowOrigin: a.naPrimeiraLinha.originRow,
          }
        : {}),
    });
  }
  return regras.sort((x, y) => x.letter.localeCompare(y.letter));
}

/**
 * Junta as regras de varias abas numa visao unica da planilha.
 *
 * Existe por um caso concreto: numa aba que o usuario nunca usou (JANEIRO, na
 * planilha real) a coluna Saldo pode nao ter formula NENHUMA. Sem o modelo
 * vindo de uma aba irma, gravar ali continuaria deixando o Saldo em branco. A
 * aba com mais ocorrencias ganha, por ser a mais representativa.
 */
export function mergeFormulaRules(porAba: FormulaColumnRule[][]): FormulaColumnRule[] {
  const melhor = new Map<string, FormulaColumnRule>();
  for (const regras of porAba) {
    for (const r of regras) {
      const atual = melhor.get(r.letter);
      if (!atual || r.ocorrencias > atual.ocorrencias) melhor.set(r.letter, r);
    }
  }
  return [...melhor.values()].sort((a, b) => a.letter.localeCompare(b.letter));
}
