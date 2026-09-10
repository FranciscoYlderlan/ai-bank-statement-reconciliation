/**
 * PROMPT DEDICADO — CATEGORIZACAO.
 *
 * Uma tarefa, e so uma: dado um lancamento JA transcrito e a lista de
 * categorias VALIDAS da planilha do usuario, escolher uma categoria da lista.
 * Nao le extrato, nao decide valor, nao mexe em data ou direcao.
 *
 * Ficou separado do prompt de extracao de proposito: misturar "transcreva
 * fielmente" com "classifique" degrada as duas tarefas — o modelo comeca a
 * ajustar a descricao para caber na categoria que escolheu. Aqui a transcricao
 * ja esta congelada e so a coluna Categoria esta em jogo.
 *
 * A lista de categorias NAO e fixa no codigo: vem da aba `Categorias` da
 * planilha que o usuario forneceu (via perfil). Qualquer resposta fora da lista
 * e descartada pelo validador — preferimos categoria vazia a categoria errada,
 * porque a coluna tem dropdown e um valor invalido quebra a validacao da celula.
 */

export const CATEGORIZE_PROMPT_VERSION = "2026-08-19.2";

export const CATEGORIZE_SYSTEM_PROMPT = `Voce classifica lancamentos financeiros de uma pequena empresa brasileira. Sua tarefa e UNICA: para cada lancamento recebido, escolher UMA categoria da LISTA FORNECIDA.

REGRAS INVIOLAVEIS:
1. So use categorias que estao EXATAMENTE na lista, copiadas com a mesma grafia, acentuacao, caixa e espacamento. Nao crie, nao traduza, nao abrevie, nao pluralize e NAO APARE ESPACO: as categorias aparecem entre aspas justamente para o espaco no comeco ou no fim ficar visivel, e a planilha trata "Salario " e "Salario" como valores diferentes.
2. Se nenhuma categoria da lista servir, ou se voce estiver em duvida entre duas sem elementos para decidir, devolva null. Categoria vazia e melhor que categoria errada: a coluna tem lista suspensa e um valor fora dela quebra a planilha.
3. Respeite a DIRECAO: um lancamento de entrada nao recebe categoria de despesa, e um de saida nao recebe categoria de receita.
4. Classifique pelo QUE O LANCAMENTO E, nao pelo valor. Valor alto nao torna algo investimento.
5. Devolva exatamente um item por lancamento recebido, com o mesmo "indice" que veio na entrada. Nao reordene, nao agrupe, nao omita.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

const OUTPUT_SCHEMA_HINT = `Schema de saida (JSON):
{
  "classificacoes": [
    { "indice": number, "categoria": "string da lista" | null }
  ]
}`;

export interface CategorizeItem {
  indice: number;
  descricao: string;
  direcao: "entrada" | "saida";
  valor: string; // ja formatado (ex.: "R$ 1.234,56") — so contexto
}

/**
 * Monta o prompt de usuário de UM lote de lançamentos.
 *
 * `regras` e a saida do estagio -1b (regras das colunas por listagem): a
 * orientacao da coluna e, por categoria, quando ela se aplica segundo o uso que
 * a PROPRIA planilha ja faz. E o que faz o mesmo tipo de despesa cair sempre na
 * mesma categoria, em vez de o modelo reinventar o criterio a cada lote.
 */
export function buildCategorizeUserPrompt(
  categorias: string[],
  itens: CategorizeItem[],
  destino?: string,
  regras?: string,
): string {
  const lista = categorias.map((c) => `- "${c}"`).join("\n");
  const linhas = itens
    .map((i) => `${i.indice}. [${i.direcao}] ${i.valor} — ${i.descricao}`)
    .join("\n");
  const contexto = destino && destino.trim() ? `\n${destino.trim()}\n` : "";
  const guia = regras && regras.trim() ? `\n${regras.trim()}\n` : "";
  return `CATEGORIAS VALIDAS (use SOMENTE estas; copie o texto de dentro das aspas, sem aparar espaco):
${lista}
${guia}${contexto}
${OUTPUT_SCHEMA_HINT}

Classifique cada lancamento abaixo. Devolva um item por lancamento, com o mesmo indice. Em duvida, use null. Responda so o JSON.

--- LANCAMENTOS ---
${linhas}`;
}
