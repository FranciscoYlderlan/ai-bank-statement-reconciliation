/**
 * COLUNAS PREENCHIDAS POR LISTAGEM (dropdown / validacao de dados).
 *
 * Existe uma classe de coluna que o sistema nao enxergava: a que so aceita
 * valores de uma LISTA. Na planilha real e a coluna `Categoria`, cujo dropdown
 * aponta para `Categorias!$A:$A`. O efeito de nao enxergar isso e duplo:
 *
 *  1. o preenchimento sai vazio (nao havia como saber o que a coluna aceita); e
 *  2. quando saia preenchido, saia com a grafia "arrumada" — e a planilha nao
 *     perdoa: `"Salário "` (com espaco no fim, como esta na aba `Categorias`)
 *     nao e o mesmo texto que `"Salário"`. O VLOOKUP da coluna Fluxo de Caixa
 *     nao casa e a validacao da celula rejeita o valor.
 *
 * Por isso as opcoes viajam daqui ate a celula **byte a byte como estao na
 * planilha**. Nada de `trim()`, nada de normalizar acento, nada de Title Case.
 * A normalizacao existe so para CASAR a resposta do modelo com a opcao real
 * (`optionKey`), nunca para decidir o que sera gravado.
 *
 * Este arquivo e DOMINIO: so tipos e regras puras. Quem le o `.xlsx` e
 * `adapters/writers/inspectValidations.ts`; quem chama a IA para entender
 * QUANDO cada opcao se aplica e `adapters/ai/listColumnAnalyzer.ts`.
 */

/** Um par (contexto ja gravado -> opcao escolhida) lido da propria planilha. */
export interface ListUsageExample {
  /** o que estava na linha (normalmente a descricao) quando a opcao foi usada. */
  contexto: string;
  /** a opcao escolhida, exatamente como esta na planilha. */
  opcao: string;
  /** "entrada" | "saida" | null — direcao daquela linha, quando da para saber. */
  direcao: "entrada" | "saida" | null;
}

/** De onde saiu a lista de opcoes de uma coluna. */
export type ListSource =
  /** `<dataValidation type="list">` apontando para um intervalo. */
  | "validacao-intervalo"
  /** `<dataValidation type="list">` com a lista escrita na propria formula. */
  | "validacao-inline"
  /** sem validacao: a lista foi inferida dos valores repetidos ja gravados. */
  | "conteudo";

/**
 * A REGRA de uma coluna de listagem: o que ela aceita e quando cada opcao vale.
 *
 * `options` e o contrato duro (o que a planilha aceita). `orientacao` e
 * `dicaPorOpcao` sao o contrato mole, produzido pelo estagio dedicado de
 * analise — servem para o preenchimento escolher melhor, nunca para inventar
 * uma opcao fora de `options`.
 */
export interface ListColumnRule {
  /** letra da coluna na aba de lancamentos (ex.: "D"). */
  letter: string;
  /** cabecalho como esta na planilha (ex.: "Categoria"). */
  header: string;
  /** as opcoes VALIDAS, na ordem e na grafia EXATAS da planilha. */
  options: string[];
  source: ListSource;
  /** referencia crua da origem (ex.: "Categorias!$A:$A"), quando houver. */
  sourceRef: string | null;
  /** intervalo de celulas coberto pela validacao (ex.: "D13:D254"). */
  appliesTo: string | null;
  /** abas em que esta coluna tem a mesma listagem. */
  sheets: string[];
  /** exemplos reais de uso, lidos das linhas ja preenchidas. */
  examples: ListUsageExample[];
  /** frase curta: como escolher a opcao nesta coluna (vem do estagio de analise). */
  orientacao: string;
  /** por opcao, quando ela se aplica. Chave = opcao exata. */
  dicaPorOpcao: Record<string, string>;
}

/**
 * Chave canonica de uma opcao — usada SO para casar a resposta do modelo com a
 * opcao real da planilha. Tolera diferenca de acento, caixa, pontuacao e —
 * ponto central aqui — de espaco sobrando, que e justamente o que existe em
 * `"Salário "` e `"Empréstimos "`.
 */
export function optionKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Devolve a opcao EXATA da planilha correspondente a resposta do modelo, ou
 * null quando nao ha correspondencia. Nunca devolve o texto do modelo: o que
 * vai para a celula e sempre a string que ja existe na planilha.
 */
export function matchOption(rule: ListColumnRule, answer: string | null): string | null {
  if (!answer) return null;
  const key = optionKey(answer);
  if (!key) return null;
  for (const opt of rule.options) {
    if (optionKey(opt) === key) return opt;
  }
  return null;
}

/** A regra da coluna com um papel especifico, se houver. */
export function ruleForColumn(rules: ListColumnRule[], letter: string | null): ListColumnRule | null {
  if (!letter) return null;
  return rules.find((r) => r.letter === letter) ?? null;
}

/**
 * Bloco de texto com as REGRAS DE LISTAGEM, injetado no prompt do estagio que
 * preenche. Mostra a grafia exata (entre aspas, para o espaco no fim ficar
 * visivel) e, quando existir, a orientacao produzida pelo estagio de analise.
 */
export function describeListColumnsForPrompt(rules: ListColumnRule[]): string {
  if (rules.length === 0) return "";
  const blocos = rules.map((r) => {
    const linhas: string[] = [];
    linhas.push(`Coluna ${r.letter} "${r.header}" — preenchida por LISTA${
      r.sourceRef ? ` (origem: ${r.sourceRef})` : ""
    }.`);
    if (r.orientacao) linhas.push(`  Como escolher: ${r.orientacao}`);
    linhas.push("  Opcoes validas (copie a grafia EXATA que esta entre aspas):");
    for (const opt of r.options) {
      const dica = r.dicaPorOpcao[opt];
      linhas.push(`    - "${opt}"${dica ? ` → ${dica}` : ""}`);
    }
    if (r.examples.length) {
      linhas.push("  Exemplos reais ja gravados nesta planilha:");
      for (const ex of r.examples.slice(0, 12)) {
        linhas.push(`    - ${ex.contexto} → "${ex.opcao}"`);
      }
    }
    return linhas.join("\n");
  });
  return ["COLUNAS PREENCHIDAS POR LISTAGEM (dropdown):", ...blocos].join("\n");
}

/** Dump compacto para o prompt de ANALISE (o estagio que descobre as regras). */
export function listColumnsToPromptDump(rules: ListColumnRule[]): string {
  return rules
    .map((r) => {
      const ex = r.examples
        .slice(0, 25)
        .map((e) => `    ${e.direcao ? `[${e.direcao}] ` : ""}${e.contexto} → "${e.opcao}"`)
        .join("\n");
      return [
        `Coluna ${r.letter} | cabecalho "${r.header}" | origem ${r.source}${
          r.sourceRef ? ` (${r.sourceRef})` : ""
        }`,
        `  Opcoes (${r.options.length}), grafia exata entre aspas:`,
        ...r.options.map((o) => `    - "${o}"`),
        ex ? `  Uso real ja gravado na planilha:\n${ex}` : "  Sem uso registrado ainda.",
      ].join("\n");
    })
    .join("\n\n");
}
