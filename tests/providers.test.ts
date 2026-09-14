import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_PROVIDERS,
  PROVIDER_ORDER,
  assertProvidersConsistent,
  isKnownModel,
  resolveModel,
} from "../src/adapters/ai/providers";
import { defaultSettings, sanitizeSettings } from "../src/ui/settings";

/**
 * O modelo escolhido nas Configuracoes tem de ser o modelo REALMENTE chamado.
 * O bug que estes testes travam: o default do provedor nao existia no catalogo
 * de modelos, entao o <select> exibia a primeira opcao enquanto o app usava o
 * default antigo — a tela mostrava um modelo e a chamada ia com outro.
 */
describe("catalogo de provedores — invariante default ∈ catalogo", () => {
  it("todo provedor tem o modelo default dentro do proprio catalogo", () => {
    expect(assertProvidersConsistent()).toEqual([]);
  });

  it("o default de cada provedor e selecionavel na tela", () => {
    for (const id of PROVIDER_ORDER) {
      expect(isKnownModel(id, DEFAULT_PROVIDERS[id].model)).toBe(true);
    }
  });

  it("resolveModel mantem o modelo do catalogo e troca o desconhecido pelo default", () => {
    expect(resolveModel("openai", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(resolveModel("openai", "gpt-4o")).toBe(DEFAULT_PROVIDERS.openai.model);
    expect(resolveModel("openai", null)).toBe(DEFAULT_PROVIDERS.openai.model);
  });
});

describe("preferencias persistidas — saneamento na leitura", () => {
  it("preferencia antiga apontando p/ modelo fora do catalogo volta ao default", () => {
    const s = sanitizeSettings({
      activeProvider: "openai",
      models: { openai: "gpt-4o" } as never,
    });
    expect(s.models.openai).toBe(DEFAULT_PROVIDERS.openai.model);
  });

  it("preferencia valida e preservada", () => {
    const s = sanitizeSettings({
      activeProvider: "openai",
      models: { openai: "gpt-5.6-luna" } as never,
    });
    expect(s.models.openai).toBe("gpt-5.6-luna");
  });

  it("provedor ativo invalido volta ao default", () => {
    const s = sanitizeSettings({ activeProvider: "openai-antigo" as never });
    expect(s.activeProvider).toBe(defaultSettings().activeProvider);
  });
});

/**
 * A store deriva `aiConfig` (o que o motor chama) das preferencias. Este teste
 * fecha o circuito: escolher na tela muda o modelo enviado ao provedor.
 */
describe("store — o modelo escolhido chega em aiConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });

  it("setProviderModel atualiza aiConfig.model", async () => {
    const { useStore } = await import("../src/ui/store");
    expect(useStore.getState().aiConfig.model).toBe(DEFAULT_PROVIDERS.openai.model);
    useStore.getState().setProviderModel("openai", "gpt-5.6-luna");
    expect(useStore.getState().aiConfig.model).toBe("gpt-5.6-luna");
    expect(useStore.getState().settings.models.openai).toBe("gpt-5.6-luna");
  });

  it("trocar de provedor troca o modelo efetivo junto", async () => {
    const { useStore } = await import("../src/ui/store");
    useStore.getState().setActiveProvider("anthropic");
    expect(useStore.getState().aiConfig.provider).toBe("anthropic");
    expect(useStore.getState().aiConfig.model).toBe(DEFAULT_PROVIDERS.anthropic.model);
  });

  it("localStorage com modelo fora do catalogo NAO vaza para a chamada", async () => {
    localStorage.setItem(
      "conciliador.settings.v1",
      JSON.stringify({ activeProvider: "openai", models: { openai: "gpt-4o" } }),
    );
    const { useStore } = await import("../src/ui/store");
    expect(useStore.getState().aiConfig.model).toBe(DEFAULT_PROVIDERS.openai.model);
  });
});
