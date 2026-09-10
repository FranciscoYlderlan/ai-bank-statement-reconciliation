/**
 * PROMPT DEDICADO — REGRAS DAS COLUNAS POR LISTAGEM.
 *
 * Uma tarefa, e so uma: dada uma coluna que so aceita valores de uma lista, e
 * dado o uso que a planilha JA faz dessa lista, escrever a REGRA de quando cada
 * opcao se aplica. Nao le extrato, nao classifica lancamento nenhum, nao inventa
 * opcao.
 *
 * Por que isso e um estagio proprio, e nao um paragrafo a mais no prompt de
 * categorizacao: sao perguntas de natureza diferente. Aqui a pergunta e sobre a
 * PLANILHA ("o que esta lista significa nesta empresa?"), e a resposta vale para
 * o arquivo inteiro, uma vez so. La a pergunta e sobre o LANCAMENTO ("qual
 * destas opcoes e esta compra?"), e a resposta e por linha. Misturar as duas
 * fazia o modelo redefinir o significado da lista a cada lote — e a mesma
 * despesa recebia categorias diferentes em paginas diferentes do extrato.
 *
 * A saida daqui nao decide nada sozinha: ela vira CONTEXTO do estagio que
 * preenche. A lista de opcoes continua sendo a da planilha, e qualquer valor
 * fora dela e descartado depois, como sempre foi.
 */

export const LIST_COLUMNS_PROMPT_VERSION = "2026-08-19.1";

export const LIST_COLUMNS_SYSTEM_PROMPT = `Voce analisa a estrutura de uma planilha de fluxo de caixa de uma pequena empresa brasileira. Sua tarefa e UNICA: para cada coluna que so aceita valores de uma LISTA, explicar QUANDO cada opcao da lista e usada.

Voce NAO classifica lancamentos, NAO le extrato bancario e NAO propoe opcoes novas: descreve o criterio de uso das opcoes que ja existem.

COMO CHEGAR A REGRA:
1. Olhe o USO REAL. Junto de cada coluna vem uma amostra de linhas que a empresa ja preencheu, no formato "descricao da linha → opcao escolhida". E dali que sai o criterio de verdade, nao do nome bonito da opcao.
2. Repare na DIRECAO. Uma opcao que so aparece em linhas de entrada nao serve para saida, e vice-versa. Diga isso quando for o caso.
3. Diferencie as opcoes PARECIDAS. O valor de uma dica esta em separar o que se confunde ("Fornecedor" x "Embalagens", "Investimento" x "Manutencao"). Dica que so repete o nome da opcao nao ajuda ninguem.
4. Nao invente criterio para opcao que nao aparece no uso real: descreva o sentido obvio do nome em poucas palavras, ou devolva string vazia.

REGRAS DE FORMA:
- Copie o campo "opcao" EXATAMENTE como ele aparece na lista recebida, inclusive espaco no comeco ou no fim. A planilha compara texto literal: "Salario " e "Salario" sao valores diferentes para ela.
- Devolva uma entrada para cada coluna recebida, com a mesma letra.
- Dicas curtas: no maximo uma frase por opcao.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

const OUTPUT_SCHEMA_HINT = `Schema de saida (JSON):
{
  "colunas": [
    {
      "letra": "string — letra da coluna (ex.: \\"D\\")",
      "orientacao": "string — como escolher a opcao nesta coluna, em uma frase",
      "opcoes": [
        {
          "opcao": "string — copiada EXATAMENTE da lista recebida",
          "quandoUsar": "string — quando esta opcao se aplica (uma frase, ou vazio)",
          "direcao": "entrada" | "saida" | "ambas"
        }
      ]
    }
  ],
  "observacoes": "string — qualquer ressalva util sobre estas listas"
}`;

/** Monta o prompt de usuario a partir do dump das colunas de listagem. */
export function buildListColumnsUserPrompt(listDump: string, destino?: string): string {
  const contexto = destino && destino.trim() ? `\n${destino.trim()}\n` : "";
  return `Analise as colunas de LISTAGEM abaixo e devolva a regra de uso de cada opcao.
${contexto}
${OUTPUT_SCHEMA_HINT}

Devolva uma entrada por coluna e uma entrada por opcao, sem omitir nenhuma. Responda so o JSON.

--- COLUNAS POR LISTAGEM ---
${listDump}`;
}
