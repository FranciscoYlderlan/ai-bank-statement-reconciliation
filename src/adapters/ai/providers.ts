import { AiProviderConfig, AiProviderId } from "../../application/ports";

/**
 * Catalogo de provedores de IA (configuracao NAO-secreta). O modelo default de
 * cada um pode ser trocado na tela de Configuracoes. Adicionar um provedor novo
 * = adicionar uma entrada aqui + o ramo correspondente no comando Rust
 * `ai_complete` (src-tauri/src/infra/ai.rs). Nenhuma string espalhada no codigo.
 *
 * INVARIANTE: `model` (o default) TEM de existir em `models` (o catalogo). Se o
 * default nao estiver na lista, o <select> das Configuracoes exibe a primeira
 * opcao enquanto o estado guarda outra coisa — a tela mostra um modelo e o app
 * usa outro, sem nenhum erro visivel. `assertProvidersConsistent()` e o teste
 * `providers.test.ts` travam essa regressao.
 */
export const DEFAULT_PROVIDERS: Record<AiProviderId, AiProviderConfig> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    model: "gpt-5.4-nano",
    supportsDocument: true,
    models: [
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    model: "claude-sonnet-4-20250514",
    supportsDocument: true,
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
    ],
  },
  gemini: {
    id: "gemini",
    label: "Google (Gemini)",
    model: "gemini-1.5-pro",
    supportsDocument: true,
    models: [
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
};

export const PROVIDER_ORDER: AiProviderId[] = ["openai", "anthropic", "gemini"];

/** Chave usada no SecretsStore para a API key de cada provedor. */
export function secretKeyFor(provider: AiProviderId): string {
  return `ai.apikey.${provider}`;
}

/** true se `model` existe no catalogo do provedor. */
export function isKnownModel(provider: AiProviderId, model: string | null | undefined): boolean {
  if (!model) return false;
  return DEFAULT_PROVIDERS[provider].models.some((m) => m.id === model);
}

/**
 * Resolve o modelo que sera REALMENTE usado: devolve `model` quando ele existe
 * no catalogo do provedor; caso contrario cai no default do provedor. Isso
 * conserta preferencias antigas gravadas no localStorage apontando para um
 * modelo que saiu do catalogo — que e como o app acabava chamando um modelo
 * diferente do que a tela mostrava.
 */
export function resolveModel(provider: AiProviderId, model: string | null | undefined): string {
  return isKnownModel(provider, model) ? (model as string) : DEFAULT_PROVIDERS[provider].model;
}

/**
 * Verifica a INVARIANTE do catalogo (default sempre presente em `models`, sem
 * ids duplicados, lista nao-vazia). Devolve a lista de problemas — vazia = ok.
 */
export function assertProvidersConsistent(): string[] {
  const problemas: string[] = [];
  for (const id of PROVIDER_ORDER) {
    const cfg = DEFAULT_PROVIDERS[id];
    if (cfg.models.length === 0) {
      problemas.push(`${id}: catalogo de modelos vazio.`);
      continue;
    }
    if (!cfg.models.some((m) => m.id === cfg.model)) {
      problemas.push(
        `${id}: modelo default "${cfg.model}" nao esta no catalogo (${cfg.models.map((m) => m.id).join(", ")}).`,
      );
    }
    const vistos = new Set<string>();
    for (const m of cfg.models) {
      if (vistos.has(m.id)) problemas.push(`${id}: modelo duplicado "${m.id}".`);
      vistos.add(m.id);
    }
  }
  return problemas;
}
