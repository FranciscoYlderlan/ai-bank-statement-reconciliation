/**
 * PROMPT DEDICADO — COLUNAS CALCULADAS (FORMULAS).
 *
 * Uma tarefa, e so uma: dada a lista de colunas em que a planilha guarda
 * formula, dizer QUAIS delas tem de ser repetidas em toda linha nova e SE a
 * formula depende da linha anterior. Nao le extrato, nao classifica, nao escreve
 * formula nova — no maximo confirma a que ja existe.
 *
 * O texto da formula e um FATO lido do arquivo, nao opiniao: quem le e
 * `adapters/writers/inspectFormulas.ts`, e o que ele leu vale sempre. Este
 * estagio responde a pergunta que o arquivo nao responde sozinho: quando uma
 * coluna tem formula em parte das linhas e nao em outras, isso e o padrao da
 * planilha ou e um resto? Por isso ele so roda quando a leitura fica ambigua —
 * na planilha de sempre, custo zero.
 *
 * Motivo de existir: a linha que o sistema insere nascia so com os campos
 * digitados. `Fluxo de Caixa` e `Saldo` ficavam em branco para sempre, e o
 * cliente — com razao — lia isso como "o sistema apagou minhas formulas".
 */

export const FORMULA_COLUMNS_PROMPT_VERSION = "2026-08-19.1";

export const FORMULA_COLUMNS_SYSTEM_PROMPT = `Voce analisa a estrutura de uma planilha de fluxo de caixa. Sua tarefa e UNICA: dada a lista de colunas que contem formula, dizer, para cada uma, se a formula deve ser REPETIDA em toda linha nova e de que tipo ela e.

Voce NAO reescreve a formula, NAO cria formula nova e NAO opina sobre valores: o texto da formula ja foi lido do arquivo e e verdade.

TIPOS POSSIVEIS (use exatamente estas palavras):
- "linha"      = a formula usa apenas celulas da PROPRIA linha (ex.: procura a categoria da linha numa tabela)
- "acumulada"  = a formula usa o resultado da LINHA ANTERIOR (ex.: saldo corrente = saldo anterior + entrada - saida)
- "outra"      = nao se encaixa nas duas acima

REGRAS:
1. "perpetuar": true quando a formula representa o PADRAO da coluna — isto e, toda linha de lancamento deveria te-la. Uma coluna com formula em quase todas as linhas de dados e padrao, mesmo que algumas linhas antigas tenham ficado sem.
2. "perpetuar": false quando a formula e claramente pontual: um total no rodape, um calculo avulso, uma linha de fechamento. Somar totais nao e padrao de linha.
3. Uma coluna "acumulada" quase sempre e para perpetuar: sem ela a corrente do saldo quebra a partir da primeira linha nova.
4. Em duvida entre perpetuar e nao perpetuar, prefira NAO perpetuar e explique em "motivo". Formula sobrando num lugar errado e mais dificil de perceber do que formula faltando.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

const OUTPUT_SCHEMA_HINT = `Schema de saida (JSON):
{
  "colunas": [
    {
      "letra": "string — letra da coluna (ex.: \\"H\\")",
      "tipo": "linha" | "acumulada" | "outra",
      "perpetuar": boolean,
      "motivo": "string — por que sim ou por que nao, em uma frase"
    }
  ],
  "observacoes": "string — qualquer ressalva util sobre estas formulas"
}`;

/** Monta o prompt de usuario a partir do dump das colunas calculadas. */
export function buildFormulaColumnsUserPrompt(formulaDump: string, destino?: string): string {
  const contexto = destino && destino.trim() ? `\n${destino.trim()}\n` : "";
  return `Analise as colunas CALCULADAS abaixo e diga quais devem ser repetidas em toda linha nova.
${contexto}
${OUTPUT_SCHEMA_HINT}

Devolva uma entrada por coluna recebida, com a mesma letra. Responda so o JSON.

--- COLUNAS CALCULADAS ---
${formulaDump}`;
}
