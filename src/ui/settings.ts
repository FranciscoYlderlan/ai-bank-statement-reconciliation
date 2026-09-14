import { AiProviderId } from "../application/ports";
import {
  DEFAULT_PROVIDERS,
  PROVIDER_ORDER,
  resolveModel,
} from "../adapters/ai/providers";

/**
 * Preferencias NAO-SECRETAS do app (provedor ativo, modelo por provedor, conta
 * e planilha Google). Persistidas em localStorage do WebView — NUNCA guardamos
 * segredos aqui (API keys e tokens ficam no Credential Manager, via Rust).
 */
export interface PersistedSettings {
  activeProvider: AiProviderId;
  models: Record<AiProviderId, string>;
  googleEmail: string | null;
  googleSheetId: string | null;
  googleSheetLink: string | null;
  /** liga o log da resposta crua por chamada de IA (diagnóstico). */
  debugAiLogging: boolean;
  /**
   * Conferência por IA em PARALELO à leitura direta (§3.8).
   *
   * Ligada por padrão. Quando o parser determinístico já provou a leitura, a IA
   * lê apenas uma AMOSTRA de blocos — custo fixo, que não cresce com o tamanho
   * do extrato — e serve de testemunha independente. Desligar economiza essas
   * chamadas e NÃO muda o resultado: muda a confiança que o relatório pode
   * declarar, de "corroborada" para "provada".
   */
  validarComIa: boolean;
}

const KEY = "conciliador.settings.v1";

export function defaultSettings(): PersistedSettings {
  const models = {} as Record<AiProviderId, string>;
  for (const id of PROVIDER_ORDER) models[id] = DEFAULT_PROVIDERS[id].model;
  return {
    activeProvider: "openai",
    models,
    googleEmail: null,
    googleSheetId: null,
    googleSheetLink: null,
    debugAiLogging: false,
    validarComIa: true,
  };
}

/**
 * Normaliza preferencias vindas do disco: provedor ativo tem de existir, e o
 * modelo de CADA provedor tem de estar no catalogo atual. Uma preferencia
 * gravada por uma versao antiga (modelo que saiu do catalogo) e reescrita para
 * o default do provedor — sem isso, o <select> mostra a 1a opcao e o app segue
 * chamando o modelo velho, que e exatamente o sintoma de "a build ignora as
 * Configuracoes".
 */
export function sanitizeSettings(parsed: Partial<PersistedSettings>): PersistedSettings {
  const base = defaultSettings();
  const merged: PersistedSettings = {
    ...base,
    ...parsed,
    models: { ...base.models, ...parsed.models },
  };
  if (!PROVIDER_ORDER.includes(merged.activeProvider)) {
    merged.activeProvider = base.activeProvider;
  }
  for (const id of PROVIDER_ORDER) {
    merged.models[id] = resolveModel(id, merged.models[id]);
  }
  return merged;
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return defaultSettings();
    const limpo = sanitizeSettings(JSON.parse(raw) as Partial<PersistedSettings>);
    // regrava ja normalizado: a correcao vale para a proxima abertura tambem.
    saveSettings(limpo);
    return limpo;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: PersistedSettings): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* WebView sem storage: ignora (settings voltam ao default) */
  }
}
