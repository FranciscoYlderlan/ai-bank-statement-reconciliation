import { useState } from "react";
import { useStore } from "../store";
import { Dropzone } from "../components/Dropzone";
import { reconcile, createNewWorkbook } from "../engine";
import { Button, Card, SectionTitle, EmptyState, DownloadButton } from "../components/ui";
import { useDownload } from "../download";
import { AiError } from "../../application/ports";
import { DEFAULT_PROVIDERS } from "../../adapters/ai/providers";
import { RulesPanel } from "../components/RulesPanel";
import { regrasAtivas } from "../../domain/ruleSet";
import { LegacyXlsError } from "../../adapters/parsers/hybrid";

/** Traduz a categoria do erro de IA numa mensagem no tom da interface. */
function friendlyError(e: unknown): { title: string; detail: string } {
  // Arquivo que nao da para ler nem direto nem por IA: a mensagem ja vem
  // pronta e diz o que fazer, entao nao vale reescreve-la aqui.
  if (e instanceof LegacyXlsError) {
    return { title: "Formato de planilha antigo", detail: e.message };
  }
  if (e instanceof AiError) {
    switch (e.kind) {
      case "no_key":
        return {
          title: "Falta configurar a chave da API",
          detail: "Abra as Configurações (engrenagem) e cole sua chave para a IA ler o extrato.",
        };
      case "invalid_key":
        return { title: "A chave da API foi recusada", detail: "Confira se a chave está correta e ativa nas Configurações." };
      case "rate_limit":
        return { title: "Limite de uso atingido", detail: "O provedor pediu para aguardar. Tente novamente em instantes." };
      case "timeout":
        return { title: "O provedor demorou a responder", detail: "Verifique a internet e tente conciliar de novo." };
      case "bad_schema":
        return { title: "A IA não devolveu os dados no formato esperado", detail: "Tente novamente; se persistir, troque o modelo nas Configurações." };
      case "network":
        return { title: "Sem conexão com o provedor", detail: "Verifique sua internet e tente novamente." };
    }
  }
  return { title: "Não foi possível concluir a conciliação", detail: (e as Error)?.message ?? "Erro desconhecido." };
}

export function Main() {
  const {
    extName, extBytes, xlsxName, xlsxBytes, running, progress, progressLabel, partitions, aiConfig, settings,
    setExt, setRunning, setProgress, setResult, setScreen, openSettings,
    preAnalise, carteira, sugestoes, motivoCarteira, analisando,
    salvandoRegras, regrasSalvas, erroRegras,
    setCarteira, salvarRegras, absorverRegrasAprendidas,
  } = useStore();
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const novaDownload = useDownload();

  const provider = DEFAULT_PROVIDERS[aiConfig.provider];

  async function run() {
    if (!extBytes || !extName) return;
    setError(null);
    setProgress(0, "Iniciando…");
    setRunning(true);
    try {
      const res = await reconcile({
        fileBytes: extBytes,
        fileName: extName,
        xlsxBytes,
        aiConfig,
        // as regras já foram revisadas pelo dono no painel acima; só as ativas
        // e válidas descem para o motor
        regras: regrasAtivas(carteira),
        // o perfil saiu da pré-análise: não repetimos o estágio -1
        profilePronto: preAnalise?.profile ?? null,
        googleSheetId: settings.googleSheetId,
        debug: settings.debugAiLogging,
        validarComIa: settings.validarComIa,
        onProgress: (value, label, parts) => setProgress(value, label, parts),
      });
      // o resultado inteiro vai para o estado: alem do relatorio, o rastro de
      // QUEM decidiu cada categoria e as regras com os aliases que o agente de
      // identidade confirmou nesta execucao.
      setResult(res);
      // aliases que o agente de identidade confirmou nesta execução são FATO
      // aprendido, não decisão do usuário: gravam sozinhos.
      void absorverRegrasAprendidas(res.regras);
    } catch (e) {
      setError(friendlyError(e));
      setRunning(false);
    }
  }

  function novaPlanilha() {
    void novaDownload.start("Fluxo de Caixa - novo.xlsx", (onProgress) =>
      createNewWorkbook(onProgress),
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <span className="competence-tag">Importar</span>
          <h2 className="font-display text-2xl font-bold tracking-tight">Conciliar um extrato</h2>
        </div>
        <Button variant="subtle" onClick={() => setScreen("onboarding")}>
          ← Configuração inicial
        </Button>
      </div>

      <Dropzone
        size="lg"
        title="Solte o extrato aqui"
        hint="PDF, CSV, XLS/XLSX ou OFX — de qualquer banco. CSV, planilha e OFX são lidos direto, sem IA."
        accept={{
          "application/pdf": [".pdf"],
          "application/x-ofx": [".ofx", ".qfx"],
          "text/csv": [".csv", ".tsv", ".txt"],
          "application/vnd.ms-excel": [".xls"],
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "image/*": [".png", ".jpg", ".jpeg"],
        }}
        fileName={extName}
        onFile={(name, bytes) => {
          setError(null);
          setExt(name, bytes);
        }}
      />

      {error && (
        <EmptyState tone="error" icon="⚠" title={error.title}>
          {error.detail}{" "}
          <button onClick={openSettings} className="font-semibold text-cofre underline-offset-2 hover:underline">
            Abrir Configurações
          </button>
        </EmptyState>
      )}

      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Destino</dt>
            <dd className="mt-0.5 text-ink">
              {xlsxName ? <b>{xlsxName}</b> : "Nova planilha (padrão Cantina Bom Prato)"}
              {settings.googleSheetId ? <span className="text-ink-soft"> · + Google Sheets</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Leitura</dt>
            <dd className="mt-0.5 text-ink">
              {provider.label} · <span className="font-mono text-xs">{aiConfig.model}</span>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-soft">
          A categoria é gravada vazia no início — preencha depois pelo dropdown da planilha para o
          dashboard somar. Um backup imutável é criado antes de qualquer escrita.
        </p>
      </Card>

      {/* As regras aparecem em TODA conciliação, com a carteira aberta. É o que
          impede a regra de envelhecer: o que não vale mais está na frente do
          dono antes de ele apertar o botão. */}
      {analisando && (
        <Card className="p-4 text-xs text-ink-soft">Lendo a planilha e as suas regras…</Card>
      )}
      {!analisando && carteira && (
        <RulesPanel
          carteira={carteira}
          sugestoes={sugestoes}
          categorias={preAnalise?.profile.categories ?? []}
          motivo={motivoCarteira}
          onChange={setCarteira}
          onSalvar={() => void salvarRegras()}
          salvando={salvandoRegras}
          salvo={regrasSalvas}
          erro={erroRegras}
        />
      )}

      <div className="flex flex-wrap items-start gap-3">
        <Button disabled={!extBytes || running} onClick={run}>
          {running ? "Conciliando…" : "Conciliar extrato"}
        </Button>
        <DownloadButton
          label="Criar planilha nova"
          fileName="Fluxo de Caixa - novo.xlsx"
          state={novaDownload}
          onStart={novaPlanilha}
        />
      </div>

      {running && (
        <div className="space-y-2" role="status" aria-live="polite">
          <div
            className="h-2.5 w-full overflow-hidden rounded-pill bg-surface-muted"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-pill bg-cofre transition-all duration-300 ease-out"
              style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-ink-soft">
            <span>{progressLabel || "Processando…"}</span>
            <span className="font-mono">{Math.round(progress * 100)}%</span>
          </div>
          {partitions.length > 0 && (
            <>
              <div className="flex items-center gap-3 text-xs text-ink-soft">
                <span>
                  <b className="text-ink">{partitions.filter((p) => p.status === "done").length}</b> concluídas
                </span>
                {partitions.some((p) => p.status === "running") && (
                  <span>{partitions.filter((p) => p.status === "running").length} em andamento</span>
                )}
                {partitions.some((p) => p.status === "error") && (
                  <span className="text-saida">
                    {partitions.filter((p) => p.status === "error").length} com erro
                  </span>
                )}
                <span className="text-ink-soft/70">de {partitions.length}</span>
              </div>
              <div className="flex flex-wrap gap-1" aria-hidden="true">
                {partitions.map((p) => (
                  <span
                    key={p.index}
                    title={`${p.label}${p.error ? ` — ${p.error}` : p.txCount !== undefined ? ` — ${p.txCount} transações` : ""}`}
                    className={
                      "h-1.5 w-4 rounded-pill " +
                      (p.status === "done"
                        ? "bg-cofre"
                        : p.status === "error"
                          ? "bg-saida"
                          : p.status === "running"
                            ? "bg-cofre/50 animate-pulse"
                            : "bg-surface-muted")
                    }
                  />
                ))}
              </div>
            </>
          )}
          <p className="text-xs text-ink-soft/80">
            As partições são lidas em paralelo — a barra avança conforme cada uma conclui.
          </p>
        </div>
      )}
    </div>
  );
}

/** Compatibilidade: a entrega do arquivo agora vive em `ui/download.ts`. */
export { saveBytesAsFile as download } from "../download";
