/**
 * NAVEGACAO — as unicas duas transicoes que o app tem, isoladas como funcoes
 * puras.
 *
 * Isto virou arquivo proprio por causa de um bug real: a engrenagem gravava
 * `returnTo` a CADA clique, entao clicar nela duas vezes gravava
 * `returnTo = "settings"`. O "← Voltar" passava a mandar o usuario para a tela
 * em que ele ja estava — nada acontecia, e o app ficava preso nas
 * Configuracoes. O botao nao estava quebrado: ele obedecia, so que para o lugar
 * errado.
 *
 * Bug de navegacao e barato de escrever e caro de achar, porque so aparece numa
 * SEQUENCIA de cliques. Com as transicoes puras, a sequencia vira teste.
 */

export type Screen = "onboarding" | "main" | "report" | "settings";

export interface EstadoNavegacao {
  screen: Screen;
  /** para onde o "voltar" das Configuracoes leva. NUNCA "settings". */
  returnTo: Screen;
}

/** A tela para onde e seguro voltar. */
function destinoSeguro(returnTo: Screen): Screen {
  return returnTo === "settings" ? "main" : returnTo;
}

/**
 * A engrenagem e um INTERRUPTOR: leva as Configuracoes e traz de volta.
 * `returnTo` so e gravado na IDA — e nunca com "settings".
 */
export function aoClicarNaEngrenagem(estado: EstadoNavegacao): EstadoNavegacao {
  if (estado.screen === "settings") {
    return { screen: destinoSeguro(estado.returnTo), returnTo: estado.returnTo };
  }
  return { screen: "settings", returnTo: estado.screen };
}

/** O "← Voltar" das Configuracoes. */
export function aoFecharSettings(estado: EstadoNavegacao): EstadoNavegacao {
  return { screen: destinoSeguro(estado.returnTo), returnTo: estado.returnTo };
}
