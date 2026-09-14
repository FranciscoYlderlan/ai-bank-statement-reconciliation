import { useCallback, useRef, useState } from "react";

/**
 * DOWNLOAD COM INDICATIVO.
 *
 * Antes, baixar a planilha era um `a.click()` mudo: o usuario clicava e nao
 * acontecia nada visivel — nem "preparando", nem porcentagem, nem confirmacao.
 * Em arquivo grande a compactacao do ZIP leva segundos, e o silencio parecia
 * travamento (levando a clicar de novo, gerando dois downloads).
 *
 * Aqui o download tem estados explicitos e um progresso REAL: a porcentagem vem
 * do proprio compactador (JSZip informa o avanco), nao de uma animacao fingida.
 */

export type DownloadPhase = "idle" | "preparing" | "done" | "error";

export interface DownloadState {
  phase: DownloadPhase;
  /** 0..1 — progresso real da compactacao. */
  pct: number;
  error: string | null;
  /** nome do arquivo entregue (mostrado na confirmacao). */
  fileName: string | null;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Entrega os bytes ao navegador/WebView como um arquivo baixado. */
export function saveBytesAsFile(bytes: Uint8Array, name: string, mime = XLSX_MIME): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // o objeto so pode ser revogado depois que o download comeca de fato
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Nome de arquivo seguro (sem caracteres que o Windows recusa). */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

/**
 * Hook do botao de download. `produce` recebe um callback de progresso 0..1 e
 * devolve os bytes; o hook cuida do estado, do arquivo e do erro.
 */
export function useDownload() {
  const [state, setState] = useState<DownloadState>({
    phase: "idle",
    pct: 0,
    error: null,
    fileName: null,
  });
  const running = useRef(false);

  const start = useCallback(
    async (
      fileName: string,
      produce: (onProgress: (pct: number) => void) => Promise<Uint8Array>,
    ) => {
      if (running.current) return; // clique duplo nao gera dois downloads
      running.current = true;
      const name = safeFileName(fileName);
      setState({ phase: "preparing", pct: 0, error: null, fileName: name });
      try {
        const bytes = await produce((pct) =>
          setState((s) => (s.phase === "preparing" ? { ...s, pct } : s)),
        );
        saveBytesAsFile(bytes, name);
        setState({ phase: "done", pct: 1, error: null, fileName: name });
      } catch (e) {
        setState({
          phase: "error",
          pct: 0,
          error: (e as Error)?.message ?? "Erro desconhecido ao gerar o arquivo.",
          fileName: name,
        });
      } finally {
        running.current = false;
      }
    },
    [],
  );

  const reset = useCallback(
    () => setState({ phase: "idle", pct: 0, error: null, fileName: null }),
    [],
  );

  return { ...state, start, reset, busy: state.phase === "preparing" };
}
