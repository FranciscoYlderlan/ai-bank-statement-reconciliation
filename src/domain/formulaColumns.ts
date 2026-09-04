/**
 * COLUNAS (E CELULAS) PREENCHIDAS POR FORMULA.
 *
 * A linha que o sistema insere nasce do nada: ele grava data, descricao,
 * categoria e valor, e para por ai. So que numa planilha viva a linha tem mais
 * do que os campos digitados — tem os campos CALCULADOS. Na planilha real sao
 * dois: `Fluxo de Caixa` (E), um VLOOKUP da categoria na aba `Categorias`, e
 * `Saldo` (H), o saldo corrente `H(anterior) + F - G`.
 *
 * O sintoma que o cliente ve e "a formula sumiu". Nao sumiu: a linha nova
 * simplesmente nunca a teve. Enquanto o usuario digitava, o Excel copiava a
 * formula para baixo; quando quem escreve e o nosso writer, ninguem copia.
 *
 * Este arquivo guarda o que uma coluna calculada E (o modelo da formula e a
 * linha de onde ele veio) e a regra pura de TRANSPOR esse modelo para outra
 * linha — exatamente como o Excel faz ao copiar uma formula para baixo:
 * referencia relativa anda com a linha, referencia travada com `$` nao anda.
 *
 * Quem le o `.xlsx` e `adapters/writers/inspectFormulas.ts`; quem grava e
 * `adapters/writers/xlsxSurgical.ts`.
 */

/** O que a coluna calculada representa, quando da para saber. */
export type FormulaKind =
  /** depende so da propria linha (ex.: VLOOKUP da categoria). */
  | "linha"
  /** encadeada: usa o resultado da linha anterior (ex.: saldo corrente). */
  | "acumulada"
  /** nao classificada. */
  | "outra";

export interface FormulaColumnRule {
  /** letra da coluna (ex.: "E"). */
  letter: string;
  /** cabecalho como esta na planilha. */
  header: string;
  /**
   * A formula-modelo, JA sem escape de XML e sem o `=` inicial, exatamente como
   * aparece dentro de `<f>` na linha `templateRow`.
   */
  template: string;
  /** a linha de onde o modelo foi tirado (base do deslocamento relativo). */
  templateRow: number;
  /**
   * Modelo especifico da PRIMEIRA linha de dados, quando ela e diferente. Numa
   * coluna acumulada a primeira linha nao aponta para a linha de cima (que e
   * cabecalho) e sim para a celula do saldo inicial — `G7+F13-G13`.
   */
  templateFirstRow?: string;
  templateFirstRowOrigin?: number;
  kind: FormulaKind;
  /** valor do atributo `t` da celula (ex.: "str"), para manter o tipo. */
  cellType: string | null;
  /** estilo predominante das celulas dessa coluna que tem formula. */
  styleNum: string | null;
  /** true quando a coluna e calculada em TODAS as linhas com dados. */
  porColuna: boolean;
  /** quantas linhas de dados carregam essa formula. */
  ocorrencias: number;
  /** aba de onde o modelo foi lido. */
  sheet: string;
  /** por que esta coluna deve ser perpetuada (texto curto, para o relatorio). */
  motivo: string;
}

/**
 * Desloca as referencias RELATIVAS de uma formula de `fromRow` para `toRow`.
 *
 * E a mesma semantica de copiar a celula para baixo no Excel:
 *   `H13+F14-G14` copiado de 14 para 300  →  `H299+F300-G300`
 *   `VLOOKUP(D13,Categorias!A:B,2,0)` de 13 para 300 → `VLOOKUP(D300,…)`
 *   `$B$5` nao anda; `B$5` nao anda na linha; `$B5` anda na linha.
 *
 * Cuidados que o codigo toma de proposito:
 *  - NAO mexe no que esta dentro de aspas (`"01/01/2026"` continua igual);
 *  - NAO confunde nome de funcao com referencia (`LOG10(` nao vira `LOG` + 10);
 *  - preserva a parte da aba (`Categorias!A:B`), que nao tem linha;
 *  - se a transposicao levar a linha para menos de 1, devolve `null` — melhor
 *    nao gravar formula nenhuma do que gravar `#REF!`.
 */
export function translateFormula(template: string, fromRow: number, toRow: number): string | null {
  const delta = toRow - fromRow;
  if (delta === 0) return template;

  let out = "";
  let i = 0;
  let invalido = false;

  while (i < template.length) {
    const ch = template[i];

    // literal de texto: copiado como esta
    if (ch === '"') {
      let j = i + 1;
      while (j < template.length) {
        if (template[j] === '"') {
          if (template[j + 1] === '"') j += 2; // aspas escapada ("")
          else break;
        } else j++;
      }
      out += template.slice(i, Math.min(j + 1, template.length));
      i = j + 1;
      continue;
    }

    // possivel referencia: [$]COL[$]LINHA
    const rest = template.slice(i);
    const m = rest.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
    if (m) {
      const antes = i > 0 ? template[i - 1] : "";
      const depois = template[i + m[0].length] ?? "";
      const precedidoPorIdentificador = /[A-Za-z0-9_.]/.test(antes);
      const ehChamadaDeFuncao = depois === "(";
      if (!precedidoPorIdentificador && !ehChamadaDeFuncao) {
        const linhaTravada = m[3] === "$";
        const linha = Number(m[4]);
        const nova = linhaTravada ? linha : linha + delta;
        if (nova < 1) invalido = true;
        out += `${m[1]}${m[2]}${m[3]}${nova}`;
        i += m[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return invalido ? null : out;
}

/**
 * O menor DESLOCAMENTO de linha que a formula pede, em relacao a linha de onde
 * ela veio. `H13+F14-G14` na linha 14 pede -1 (a linha de cima) e 0; ja
 * `G7+F13-G13` na linha 13 pede -6 — ele nao esta olhando a linha anterior,
 * esta olhando o cabecalho.
 *
 * E essa a diferenca entre uma formula que pode ser arrastada para baixo e uma
 * que nao pode. A do saldo inicial so faz sentido onde ela esta; copiada para a
 * linha 300 vira `G294+F300-G300`, um numero tirado do meio do cabecalho.
 * Referencias travadas com `$` nao entram na conta — elas nao andam.
 */
export function minRowOffset(template: string, originRow: number): number {
  let min = 0;
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < template.length) {
        if (template[j] === '"') {
          if (template[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      continue;
    }
    const m = template.slice(i).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
    if (m) {
      const antes = i > 0 ? template[i - 1] : "";
      const depois = template[i + m[0].length] ?? "";
      if (!/[A-Za-z0-9_.]/.test(antes) && depois !== "(") {
        if (m[3] !== "$") min = Math.min(min, Number(m[4]) - originRow);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return min;
}

/**
 * Uma formula pode virar MODELO da coluna quando, arrastada para qualquer linha
 * de dados, ela nunca alcanca acima da linha imediatamente anterior. E a
 * fronteira entre "saldo corrente" (usa a linha de cima, generaliza) e "saldo
 * inicial" (usa o cabecalho, nao generaliza).
 */
export function isGeneralizable(template: string, originRow: number): boolean {
  return minRowOffset(template, originRow) >= -1;
}

/** A regra da coluna `letter`, se ela for calculada. */
export function formulaRuleFor(
  rules: FormulaColumnRule[],
  letter: string | null,
): FormulaColumnRule | null {
  if (!letter) return null;
  return rules.find((r) => r.letter === letter) ?? null;
}

/** Dump compacto das colunas calculadas — entra no prompt de analise. */
export function formulaColumnsToPromptDump(rules: FormulaColumnRule[]): string {
  if (rules.length === 0) return "(nenhuma coluna calculada encontrada)";
  return rules
    .map((r) =>
      [
        `Coluna ${r.letter} | cabecalho "${r.header}" | aba ${r.sheet}`,
        `  Formula na linha ${r.templateRow}: =${r.template}`,
        `  Linhas de dados com essa formula: ${r.ocorrencias}${
          r.porColuna ? " (todas as linhas com dados)" : " (apenas parte das linhas)"
        }`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** Bloco informativo para os prompts seguintes: estas colunas NAO se digitam. */
export function describeFormulaColumnsForPrompt(rules: FormulaColumnRule[]): string {
  if (rules.length === 0) return "";
  return [
    "COLUNAS CALCULADAS (o sistema repete a formula sozinho — nao devolva valor para elas):",
    ...rules.map(
      (r) =>
        `- ${r.letter} "${r.header}": ${
          r.kind === "acumulada" ? "acumulada (usa a linha anterior)" : "calculada na propria linha"
        } — =${r.template}`,
    ),
  ].join("\n");
}
