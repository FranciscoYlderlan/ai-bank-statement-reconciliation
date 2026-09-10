/**
 * ESTAGIO 0 do pipeline — RECONHECIMENTO (uma tarefa só: entender o layout).
 *
 * Recebe apenas o CABEÇALHO/topo do extrato e devolve um "cabeçalho estruturado"
 * completo: instituição, conta, período, como o extrato marca entradas/saídas, a
 * REGRA de VALOR × SALDO e o que deve ser excluído. Esse cabeçalho é resolvido
 * UMA vez e repassado como contexto fixo a todas as partições do Estágio 2 — que
 * nunca mais precisam "adivinhar" o layout (evita drift entre páginas).
 * NÃO extrai transações aqui. Prompt pequeno, saída pequena → alta taxa de sucesso.
 */

export const RECOGNIZE_PROMPT_VERSION = "2026-08-17.2";

export const RECOGNIZE_SYSTEM_PROMPT = `Voce e um analista de extratos bancarios brasileiros. Sua tarefa e UNICA: olhar o topo/cabecalho de um extrato e descrever COMO le-lo. Voce NAO extrai transacoes aqui.

Preste atencao a DOIS pontos que mais causam erro:

1) VALOR x SALDO — duas colunas que costumam coexistir:
- VALOR (ou "Valor"): o valor MOVIMENTADO na transacao (o que entra ou sai).
- SALDO (ou "Saldo"): o saldo da conta APOS a transacao (corrente/acumulado).
Elas sao DIFERENTES. A transacao usa o VALOR, nunca o SALDO.

2) POSICAO DA CONTRAPARTE — onde aparece o NOME de quem pagou/recebeu em relacao
a linha do valor. Em varios extratos (ex.: Stone) a contraparte fica na linha
LOGO ACIMA da linha do valor; em outros, na mesma linha. Descreva isso com
precisao para nao trocar o nome de uma transacao pelo da vizinha.

Responda SOMENTE com JSON valido, sem markdown e sem texto extra.`;

export const RECOGNIZE_USER_PROMPT = `Analise o trecho inicial do extrato abaixo e devolva o CABECALHO ESTRUTURADO no schema:

{
  "instituicao": "string — nome do banco/instituicao",
  "numero": "string — numero da conta (so digitos e hifen)",
  "rotuloEntrada": "string — como o extrato indica ENTRADAS/creditos (ex.: 'Entrada', 'Credito', 'Vendas - Disponivel')",
  "rotuloSaida": "string — como indica SAIDAS/debitos (ex.: 'Saida', 'Debito', 'Tarifa')",
  "excluir": ["string — padroes de linhas que NAO sao transacao (ex.: 'Saldo do dia', 'Saldo anterior', subtotais)"],
  "observacoes": "string — qualquer observacao util de leitura",
  "periodoInicio": "string — data inicial do extrato em AAAA-MM-DD, ou vazio",
  "periodoFim": "string — data final do extrato em AAAA-MM-DD, ou vazio",
  "regraValorSaldo": "string — onde esta o VALOR movimentado e onde esta o SALDO, explicitamente, para nunca confundir um com o outro",
  "posicaoContraparte": "string — onde fica o NOME da contraparte em relacao ao valor: 'mesma linha', 'linha acima do valor' ou 'linha abaixo do valor'; descreva o suficiente para associar cada valor ao nome certo",
  "paginasAprox": number | null  — quantas paginas o extrato aparenta ter, ou null
}

Preencha TODOS os campos. Se algum nao for identificavel, use string vazia, lista vazia ou null. Responda so o JSON.`;
