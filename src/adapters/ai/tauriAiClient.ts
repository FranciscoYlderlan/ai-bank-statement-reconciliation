import {
  AiClient,
  AiExtractionRequest,
  AiError,
  AiProviderId,
} from "../../application/ports";
import { invokeTauri } from "../tauri/invoke";

/**
 * Implementacao desktop do AiClient. A chamada HTTP ao provedor e feita no Rust
 * (reqwest nativo), que le a API key do Stronghold — a chave NUNCA transita pelo
 * WebView. Aqui so passamos prompts + documento e recebemos o texto da resposta.
 */
export class TauriAiClient implements AiClient {
  async complete(req: AiExtractionRequest): Promise<string> {
    try {
      const text = await invokeTauri<string>("ai_complete", {
        provider: req.provider,
        model: req.model,
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
        documentBase64: req.document?.base64 ?? null,
        documentMime: req.document?.mime ?? null,
        responseSchema: req.responseSchema ?? null,
      });
      return text;
    } catch (e) {
      throw mapInvokeError(e);
    }
  }

  async testConnection(
    provider: AiProviderId,
    model: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      return await invokeTauri<{ ok: boolean; message: string }>(
        "ai_test_connection",
        { provider, model },
      );
    } catch (e) {
      const err = mapInvokeError(e);
      return { ok: false, message: err.message };
    }
  }
}

/**
 * O Rust devolve o erro como string prefixada com a categoria, ex.:
 * "invalid_key: A chave da API foi recusada (401)". Traduzimos para AiError.
 */
function mapInvokeError(e: unknown): AiError {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/^(\w+):\s*([\s\S]*)$/);
  const kinds = [
    "invalid_key",
    "rate_limit",
    "timeout",
    "bad_schema",
    "network",
    "no_key",
    "unknown",
  ];
  if (m && kinds.includes(m[1])) {
    return new AiError(m[1] as AiError["kind"], m[2]);
  }
  return new AiError("unknown", msg);
}
