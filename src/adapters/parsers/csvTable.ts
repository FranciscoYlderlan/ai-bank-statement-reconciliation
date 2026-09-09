/**
 * CSV/TSV → MATRIZ DE TEXTO. Nada de banco aqui: este arquivo so sabe separar
 * campos. Quem entende de extrato e `parsers/stoneTabular.ts`, que recebe a
 * matriz pronta e nao precisa saber se ela veio de um .csv ou de um .xlsx.
 *
 * Por que nao `split(",")`: o extrato real tem campos entre aspas com virgula
 * dentro — `"161,00"`, `"R$ 1.234,56"` — que sao a REGRA e nao a excecao num
 * arquivo brasileiro, onde a virgula tambem e o separador decimal. Um split
 * ingenuo quebra a linha no meio do valor e desloca todas as colunas
 * seguintes; o resultado nao e um erro visivel, e uma leitura errada com cara
 * de certa.
 *
 * O separador tambem e detectado, e nao presumido: `,` no arquivo da Stone,
 * mas `;` e o que o Excel em pt-BR grava quando o usuario reexporta.
 */

const CANDIDATOS = [",", ";", "\t", "|"] as const;

/**
 * Descobre o separador contando quantos aparecem FORA de aspas na primeira
 * linha nao-vazia. Contar dentro das aspas daria vitoria a virgula em qualquer
 * arquivo brasileiro, que e justamente o erro que queremos evitar.
 */
export function sniffDelimiter(text: string): string {
  const linha = primeiraLinhaUtil(text);
  let melhor = ",";
  let max = 0;
  for (const sep of CANDIDATOS) {
    const n = contarForaDeAspas(linha, sep);
    if (n > max) {
      max = n;
      melhor = sep;
    }
  }
  return melhor;
}

function primeiraLinhaUtil(text: string): string {
  let aspas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') aspas = !aspas;
    else if (!aspas && (c === "\n" || c === "\r")) {
      const linha = text.slice(0, i);
      if (linha.trim().length > 0) return linha;
      return primeiraLinhaUtil(text.slice(i + 1));
    }
  }
  return text;
}

function contarForaDeAspas(linha: string, sep: string): number {
  let aspas = false;
  let n = 0;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') aspas = !aspas;
    else if (!aspas && c === sep) n++;
  }
  return n;
}

/**
 * Le o texto inteiro em linhas de campos, no estilo RFC 4180: campo entre
 * aspas pode conter o separador, quebra de linha e a propria aspa (duplicada).
 * Linhas totalmente vazias sao descartadas — sao o rodape em branco que quase
 * todo exportador deixa no fim do arquivo.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const sep = delimiter ?? sniffDelimiter(text);
  const linhas: string[][] = [];
  let campo = "";
  let atual: string[] = [];
  let aspas = false;

  const fechaCampo = () => {
    atual.push(campo);
    campo = "";
  };
  const fechaLinha = () => {
    fechaCampo();
    if (atual.some((c) => c.trim().length > 0)) linhas.push(atual);
    atual = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (aspas) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') aspas = true;
    else if (c === sep) fechaCampo();
    else if (c === "\n") fechaLinha();
    else if (c === "\r") {
      /* \r\n: o \n seguinte fecha a linha */
      if (text[i + 1] !== "\n") fechaLinha();
    } else campo += c;
  }
  if (campo.length > 0 || atual.length > 0) fechaLinha();
  return linhas;
}
