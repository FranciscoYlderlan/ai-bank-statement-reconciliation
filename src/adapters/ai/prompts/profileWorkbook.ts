/**
 * PROMPT DEDICADO — PERFIL DA PLANILHA DE DESTINO.
 *
 * Uma tarefa, e so uma: olhar a ESTRUTURA de uma planilha (cabecalhos, formatos
 * e amostras do conteudo ja gravado) e dizer o que cada coluna recebe. Nao
 * extrai transacao, nao categoriza, nao escreve nada — de proposito. Prompts que
 * fazem tudo de uma vez foram a origem dos campos preenchidos errado; aqui cada
 * estagio responde por uma pergunta so.
 *
 * Roda APENAS quando a inspecao deterministica (inspectWorkbook.ts) nao
 * consegue concluir sozinha. Na planilha de sempre, custo zero.
 *
 * O que sai daqui vira o CONTRATO DE DESTINO repassado aos proximos agentes
 * (extracao e categorizacao), para eles produzirem campos no mesmo padrao do
 * que ja esta na planilha.
 */

export const PROFILE_PROMPT_VERSION = "2026-08-19.1";

export const PROFILE_SYSTEM_PROMPT = `Voce e um analista de planilhas de fluxo de caixa em portugues do Brasil. Sua tarefa e UNICA: dada a estrutura de uma planilha (cabecalhos, formatos de celula, presenca de formula e amostras do conteudo real de cada coluna), dizer QUAL O PAPEL de cada coluna e O QUE cada uma recebe.

Voce NAO extrai transacoes, NAO classifica lancamentos e NAO inventa colunas: descreve apenas o que esta na estrutura recebida.

PAPEIS POSSIVEIS (use exatamente estas palavras):
- "data"      = a data do lancamento
- "descricao" = o texto que identifica o lancamento (contraparte, historico)
- "categoria" = a categoria/classificacao escolhida de uma lista
- "fluxo"     = o grupo/classe de fluxo de caixa, normalmente DERIVADO da categoria
- "entrada"   = o valor quando o dinheiro ENTRA (credito/recebimento)
- "saida"     = o valor quando o dinheiro SAI (debito/pagamento)
- "saldo"     = saldo acumulado da conta
- "ignorar"   = qualquer coluna que nao deve ser preenchida por nos

REGRAS:
1. Uma coluna marcada com "tem formula = sim" NUNCA pode ser preenchida por nos: devolva "podeEscrever": false. Colunas de saldo e de fluxo derivado quase sempre caem aqui.
2. Se a planilha tiver UMA unica coluna de valor (em vez de Entrada e Saida separadas), marque-a como "entrada" e explique em "recebe" que o sinal distingue entrada de saida.
3. Baseie-se nas AMOSTRAS, nao so no cabecalho: um cabecalho generico ("Valor", "Historico") se resolve olhando o conteudo.
4. Em "recebe", escreva uma frase curta e concreta do que a coluna aceita, no formato que ja aparece nas amostras (ex.: "data do lancamento em dd/mm/aaaa", "nome da contraparte seguido de | e do tipo").
5. Em "estiloDescricao", descreva como as descricoes JA gravadas estao escritas (caixa, separador, se comeca pela contraparte). E isso que fara os proximos lancamentos ficarem iguais aos antigos.
6. Se algo nao for identificavel, use string vazia, lista vazia ou null — nunca invente.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

const OUTPUT_SCHEMA_HINT = `Schema de saida (JSON):
{
  "linhaCabecalho": number,
  "primeiraLinhaDados": number,
  "colunas": [
    {
      "letra": "string — letra da coluna (ex.: \\"C\\")",
      "cabecalho": "string — o texto do cabecalho como esta na planilha",
      "papel": "data" | "descricao" | "categoria" | "fluxo" | "entrada" | "saida" | "saldo" | "ignorar",
      "podeEscrever": boolean,
      "recebe": "string — o que esta coluna recebe, em uma frase curta"
    }
  ],
  "estiloDescricao": {
    "caixa": "maiuscula" | "minuscula" | "mista",
    "separador": "string ou null — separador recorrente entre contraparte e tipo",
    "observacao": "string — como montar uma descricao no mesmo padrao das existentes"
  },
  "observacoes": "string — qualquer ressalva util sobre esta planilha"
}`;

/** Monta o prompt de usuario a partir do dump da inspecao deterministica. */
export function buildProfileUserPrompt(inspectionDump: string): string {
  return `Analise a ESTRUTURA da planilha de destino abaixo e devolva o contrato de colunas.

${OUTPUT_SCHEMA_HINT}

Liste TODAS as colunas que aparecem na estrutura, na ordem das letras. Nao acrescente colunas que nao estao ali. Responda so o JSON.

--- ESTRUTURA DA PLANILHA ---
${inspectionDump}`;
}
