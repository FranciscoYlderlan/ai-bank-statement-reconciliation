import { describe, it, expect } from "vitest";
import {
  EstadoNavegacao,
  Screen,
  aoClicarNaEngrenagem,
  aoFecharSettings,
} from "../src/ui/navigation";

/**
 * T-NAV — a engrenagem leva e traz, e o "Voltar" nunca prende ninguém.
 *
 * O bug que originou estes testes só aparecia numa SEQUÊNCIA: clicar na
 * engrenagem duas vezes gravava `returnTo = "settings"`, e a partir dali o
 * "← Voltar" mandava o usuário para a tela em que ele já estava. O app ficava
 * preso nas Configurações. Um teste de clique único jamais pegaria isso.
 */

const em = (screen: Screen, returnTo: Screen = "main"): EstadoNavegacao => ({ screen, returnTo });

/** Aplica uma sequência de cliques, como o usuário faria. */
function clicar(inicial: EstadoNavegacao, ...acoes: ("engrenagem" | "voltar")[]) {
  return acoes.reduce(
    (e, a) => (a === "engrenagem" ? aoClicarNaEngrenagem(e) : aoFecharSettings(e)),
    inicial,
  );
}

describe("T-NAV — a engrenagem é um interruptor", () => {
  it("leva às Configurações e lembra de onde veio", () => {
    expect(clicar(em("report"), "engrenagem")).toEqual({ screen: "settings", returnTo: "report" });
  });

  it("clicada de novo, VOLTA", () => {
    expect(clicar(em("report"), "engrenagem", "engrenagem").screen).toBe("report");
  });

  it("o bug: dois cliques na engrenagem e depois Voltar", () => {
    // era exatamente isto que travava — o segundo clique gravava
    // returnTo = "settings" e o Voltar virava um nada
    const fim = clicar(em("main"), "engrenagem", "engrenagem", "voltar");
    expect(fim.screen).not.toBe("settings");
  });

  it("três, cinco, dez cliques: nunca sobra preso", () => {
    for (let n = 1; n <= 10; n++) {
      const cliques = Array.from({ length: n }, () => "engrenagem" as const);
      const fim = clicar(em("main"), ...cliques);
      // ímpar entra, par volta — e o Voltar sempre resolve
      expect(aoFecharSettings(fim).screen).toBe("main");
    }
  });

  it("returnTo NUNCA guarda 'settings'", () => {
    let estado = em("report");
    for (let i = 0; i < 6; i++) estado = aoClicarNaEngrenagem(estado);
    expect(estado.returnTo).not.toBe("settings");
  });

  it("de qualquer tela, ida e volta devolvem a mesma tela", () => {
    for (const tela of ["onboarding", "main", "report"] as Screen[]) {
      expect(clicar(em(tela), "engrenagem", "voltar").screen).toBe(tela);
    }
  });
});

describe("T-NAV — o Voltar nunca prende", () => {
  it("volta para a tela de origem", () => {
    expect(aoFecharSettings(em("settings", "report")).screen).toBe("report");
  });

  it("estado corrompido (returnTo = settings) ainda assim libera o usuário", () => {
    // cinto e suspensório: mesmo que algo grave "settings" ali, sair funciona
    expect(aoFecharSettings(em("settings", "settings")).screen).toBe("main");
    expect(aoClicarNaEngrenagem(em("settings", "settings")).screen).toBe("main");
  });

  it("Voltar duas vezes não faz nada de estranho", () => {
    expect(clicar(em("main"), "engrenagem", "voltar", "voltar").screen).toBe("main");
  });
});
