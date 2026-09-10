import { RecognitionGuide } from "../schema";

/**
 * ESTAGIO 2 do pipeline — EXTRAÇÃO (uma tarefa só: transcrever as transações
 * de UMA partição do extrato). Recebe o CABEÇALHO ESTRUTURADO já resolvido no
 * Estágio 0 como CONTEXTO FIXO — nunca re-reconhece o layout — e o conteúdo da
 * partição → devolve SOMENTE as transações daquela partição, em schema estrito.
 * Poucas transações por chamada: evita truncamento e aumenta a precisão.
 *
 * Duas defesas de precisão vivem aqui:
 *  - LINHAS NUMERADAS: o trecho vai com "L1| ", "L2| " … e cada transação tem
 *    de declarar em `linha` a linha do seu VALOR. Isso ancora cada valor a UMA
 *    posição concreta do documento e é o que evita atribuir o lançamento ao
 *    cliente da transação vizinha (nome fica na linha ACIMA em vários bancos).
 *  - CONTAGEM POR LINHAS DE VALOR: o modelo conta antes de transcrever, e a
 *    quantidade de itens tem de bater com a quantidade de linhas de valor.
 *
 * Regra central: a IA transcreve, o domínio deduplica (ver domain/transaction.ts).
 */

export const EXTRACT_PROMPT_VERSION = "2026-08-17.3";

export const EXTRACT_SYSTEM_PROMPT = `Voce transcreve transacoes de um extrato bancario brasileiro para JSON. Voce nao interpreta nem resume: transcreve fielmente. O layout do extrato JA foi identificado e vem no "cabecalho de leitura" — confie nele, nao reinterprete o formato.

O trecho chega com as linhas NUMERADAS no formato "L<n>| conteudo". Os numeros sao apenas marcadores de posicao: nunca os transcreva como parte da descricao, do valor ou da data.

METODO OBRIGATORIO (siga nesta ordem, mentalmente, antes de responder):
A. Percorra o trecho e marque as LINHAS DE VALOR — as linhas que contem um valor MOVIMENTADO de uma transacao. Ignore linhas de saldo, subtotais, totais, cabecalhos, titulos, rodapes e numeros de pagina.
B. Conte quantas linhas de valor existem. Esse numero e EXATAMENTE quantos itens o seu JSON deve ter — nem um a mais, nem um a menos.
C. Para CADA linha de valor, e so entao, monte a transacao: data, contraparte, direcao, valor, saldo.

REGRAS INVIOLAVEIS:
1. Extraia TODA transacao desta particao, na ORDEM em que aparece. Se a particao nao tiver linhas de valor, devolva lista vazia.
2. NUNCA deduplique, agrupe ou resuma. 3 transacoes iguais no mesmo dia = 3 itens (em 3 linhas de valor diferentes).
3. "valor" = o VALOR MOVIMENTADO da transacao (coluna Valor). "saldoApos" = o SALDO da conta apos a transacao (coluna Saldo), apenas informativo. NUNCA coloque o saldo no campo "valor". Se nao houver saldo, use null.
4. "valor" e SEMPRE positivo. A direcao vai em "direcao": "entrada" (credito/recebimento) ou "saida" (debito/pagamento/tarifa). Determine a direcao pelo ROTULO/coluna indicado no cabecalho, NUNCA pelo sinal do saldo.
5. EXCLUA linhas que nao sao transacao: saldo do dia, saldo anterior/inicial/final, subtotais, totais, cabecalhos, titulos e numeros de pagina.
6. Datas no formato ISO "AAAA-MM-DD" (ano de 2 digitos vira 20xx). Descricao estavel: "<CONTRAPARTE> | <TIPO>" quando houver contraparte; senao o proprio tipo (ex.: "Tarifa").

ANCORA DE LINHA (campo "linha") — obrigatorio:
7. Em "linha", informe o numero N da linha "L<N>|" onde esta o VALOR daquela transacao (nao a linha do nome, nao a linha da data). Cada transacao aponta para uma linha de valor DIFERENTE. Se duas transacoes suas apontarem para a mesma linha, uma delas esta sobrando: remova-a.

ASSOCIACAO NOME <-> VALOR (evita trocar o cliente de uma transacao pelo de outra):
8. Cada VALOR pertence a UMA contraparte especifica. Use o campo "Posicao da contraparte" do cabecalho. Se o nome fica na LINHA ACIMA do valor, entao para o valor em L<N> a contraparte e a que aparece em L<N-1> (ou na linha nao-vazia imediatamente anterior) — NUNCA a de L<N-2>, nem a da transacao seguinte.
9. Confira par a par: antes de emitir cada item, releia a linha do valor e a linha da contraparte que voce escolheu. Um item a mais ou a menos desalinha TODOS os nomes seguintes — se dois valores consecutivos receberam o mesmo nome, ou um nome ficou sem valor, sua contagem esta errada: volte ao passo A.
10. Se um bloco tiver claramente 1 nome e 1 valor, eles formam 1 transacao. Nao "empreste" o nome da transacao anterior nem da seguinte.

INTEGRIDADE DA CONTAGEM (a quantidade tem que bater com o extrato real):
11. NAO invente transacoes e NAO desdobre uma transacao em duas. Uma transacao = uma data + um valor movimentado + (uma contraparte).
12. Linhas de CONTINUACAO da descricao (2a linha de texto do MESMO lancamento, sem valor proprio) NAO sao uma nova transacao: incorpore o texto a transacao acima e NAO gere item para elas.
13. Um mesmo valor que aparece duas vezes na MESMA linha (ex.: repetido na coluna de saldo) e UMA transacao so.
14. Cabecalhos de coluna repetidos no meio da pagina, faixas de "continuacao" e o total do dia NAO geram itens.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

/** Monta o bloco do cabecalho estruturado (contexto fixo) para o prompt. */
function guideBlock(guide: Partial<RecognitionGuide>): string {
  const linhas = [
    guide.instituicao ? `- Instituicao: ${guide.instituicao}` : "",
    guide.numero ? `- Conta: ${guide.numero}` : "",
    guide.periodoInicio || guide.periodoFim
      ? `- Periodo: ${guide.periodoInicio || "?"} a ${guide.periodoFim || "?"}`
      : "",
    guide.rotuloEntrada ? `- Entradas aparecem como: ${guide.rotuloEntrada}` : "",
    guide.rotuloSaida ? `- Saidas aparecem como: ${guide.rotuloSaida}` : "",
    guide.regraValorSaldo ? `- VALOR x SALDO: ${guide.regraValorSaldo}` : "",
    guide.posicaoContraparte ? `- Posicao da contraparte (nome x valor): ${guide.posicaoContraparte}` : "",
    guide.observacoes ? `- Observacao: ${guide.observacoes}` : "",
    guide.excluir && guide.excluir.length
      ? `- Excluir linhas como: ${guide.excluir.join("; ")}`
      : "",
  ].filter(Boolean);
  return linhas.length ? linhas.join("\n") : "(sem cabecalho — use as regras gerais)";
}

const OUTPUT_SCHEMA_HINT = `Schema de saida (JSON):
{
  "transacoes": [
    {
      "data": "AAAA-MM-DD",
      "descricao": "string",
      "direcao": "entrada" | "saida",
      "valor": number,
      "saldoApos": number | null,
      "linha": number | null
    }
  ]
}`;

const IMAGE_SCHEMA_HINT = OUTPUT_SCHEMA_HINT.replace(
  '"linha": number | null',
  '"linha": null',
);

/**
 * Numera as linhas do trecho ("L1| ...") para o modelo poder ancorar cada valor
 * a uma posicao concreta. Linhas em branco sao preservadas (mantem o
 * espacamento visual dos blocos) mas tambem recebem numero, para que "a linha
 * imediatamente acima" continue sendo uma referencia sem ambiguidade.
 */
export function numberLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line, i) => `L${i + 1}| ${line}`)
    .join("\n");
}

/**
 * Bloco do CONTRATO DE DESTINO (vem do perfil da planilha, quando existe).
 * Serve a um proposito so: a descricao transcrita tem de sair no MESMO padrao
 * do que ja esta gravado na planilha do usuario. Descricao fora do padrao nao
 * casa com a linha existente e volta a inflar o dedup com falsos "novos".
 */
function destinoBlock(destino?: string): string {
  if (!destino || !destino.trim()) return "";
  return `\n${destino.trim()}\nEscreva a "descricao" de cada transacao seguindo esse mesmo padrao. Nao preencha categoria nem valores derivados aqui — outro estagio cuida disso.\n`;
}

/** Monta o prompt de usuário da extração: cabeçalho fixo + o trecho numerado. */
export function buildExtractUserPrompt(
  guide: Partial<RecognitionGuide>,
  chunkText: string,
  destino?: string,
): string {
  return `Cabecalho de leitura deste extrato (ja identificado — use como verdade):
${guideBlock(guide)}
${destinoBlock(destino)}
${OUTPUT_SCHEMA_HINT}

Transcreva TODAS as transacoes do trecho abaixo (apenas as deste trecho), na ordem, sem deduplicar, excluindo linhas de saldo. Antes de responder: conte as linhas de valor e confira que a sua lista tem exatamente esse tamanho, e que cada item aponta para uma "linha" diferente. Responda so o JSON.

--- TRECHO DO EXTRATO (linhas numeradas) ---
${numberLines(chunkText)}`;
}

/** Prompt de usuário para quando o input é uma IMAGEM/documento nativo. */
export function buildExtractImageUserPrompt(
  guide: Partial<RecognitionGuide>,
  destino?: string,
): string {
  return `Cabecalho de leitura deste extrato (ja identificado — use como verdade):
${guideBlock(guide)}
${destinoBlock(destino)}
${IMAGE_SCHEMA_HINT}

Transcreva TODAS as transacoes do documento/imagem anexo, na ordem, sem deduplicar, excluindo linhas de saldo. Nao ha linhas numeradas aqui: use "linha": null, mas continue associando cada valor a contraparte da posicao indicada no cabecalho e confira a contagem antes de responder. Responda so o JSON.`;
}
