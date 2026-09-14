import { useEffect, useState } from "react";
import { useStore } from "../store";
import {
  Button,
  Card,
  SectionTitle,
  Field,
  Input,
  Select,
  StatusBadge,
} from "../components/ui";
import { AiProviderId, ProviderStatus } from "../../application/ports";
import {
  DEFAULT_PROVIDERS,
  PROVIDER_ORDER,
  secretKeyFor,
  resolveModel,
} from "../../adapters/ai/providers";
import { TauriSecretsStore } from "../../adapters/secrets/tauriSecrets";
import { TauriAiClient } from "../../adapters/ai/tauriAiClient";
import { googleClient } from "../../adapters/google/tauriGoogle";
import { sheetIdFromLink } from "../../adapters/sheets/googleSheetsTarget";

const secrets = new TauriSecretsStore();
const aiClient = new TauriAiClient();

export function Settings() {
  const fecharSettings = useStore((s) => s.fecharSettings);
  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <span className="competence-tag">Configurações</span>
          <h2 className="font-display text-2xl font-bold tracking-tight">Chaves, modelos e destino</h2>
        </div>
        <Button variant="subtle" onClick={fecharSettings}>
          ← Voltar
        </Button>
      </div>

      <section className="space-y-4">
        <SectionTitle hint="a chave fica no cofre do Windows, nunca em texto puro">
          Provedores de inteligência artificial
        </SectionTitle>
        {PROVIDER_ORDER.map((id) => (
          <ProviderCard key={id} id={id} />
        ))}
      </section>

      <section className="space-y-4">
        <SectionTitle hint="alternativa à planilha local .xlsx">Google Sheets</SectionTitle>
        <GoogleCard />
      </section>

      <section className="space-y-4">
        <SectionTitle hint="ajuda a diagnosticar extrações que saíram erradas">Diagnóstico</SectionTitle>
        <DiagnosticsCard />
      </section>
    </div>
  );
}

function DiagnosticsCard() {
  const { settings, setDebugLogging, setValidarComIa } = useStore();
  return (
    <Card className="space-y-3 p-5">
      {/* A CONFERENCIA por IA. Ligada por padrao: quando a leitura direta ja se
          provou, a IA le so uma amostra — custo fixo, que nao cresce com o
          tamanho do extrato — e serve de segunda opiniao independente. */}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-cofre"
          checked={settings.validarComIa}
          onChange={(e) => setValidarComIa(e.target.checked)}
        />
        <span>
          <span className="font-display font-semibold text-ink">Conferir a leitura com a IA</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            Depois da leitura direta, a IA relê uma <b>amostra</b> do arquivo e o relatório mostra
            se as duas enxergaram o mesmo conjunto. Não muda o resultado — a leitura provada
            continua valendo mesmo se a IA discordar —, muda o que dá para afirmar sobre ela.
            Desligado, você economiza essas chamadas.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-cofre"
          checked={settings.debugAiLogging}
          onChange={(e) => setDebugLogging(e.target.checked)}
        />
        <span>
          <span className="font-display font-semibold text-ink">Registrar a resposta crua da IA</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            Loga no console a resposta de cada chamada (reconhecimento e cada partição). Use quando
            faltarem ou sobrarem transações — mostra exatamente o que o modelo devolveu. Também há o
            log no backend via variável de ambiente <span className="font-mono">CONCILIADOR_AI_DEBUG=1</span>.
          </span>
        </span>
      </label>
    </Card>
  );
}

function ProviderCard({ id }: { id: AiProviderId }) {
  const cfg = DEFAULT_PROVIDERS[id];
  const { settings, setActiveProvider, setProviderModel } = useStore();
  const active = settings.activeProvider === id;
  // `resolveModel` garante que o valor do <select> SEMPRE bate com uma <option>.
  // Sem isso, um modelo fora do catalogo faz o navegador exibir a 1a opcao
  // enquanto o app usa outro modelo — a tela mente e nenhum onChange dispara.
  const model = resolveModel(id, settings.models[id]);

  const [status, setStatus] = useState<ProviderStatus>("unconfigured");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const secretKey = secretKeyFor(id);

  useEffect(() => {
    let alive = true;
    secrets
      .hasSecret(secretKey)
      .then((has) => alive && setStatus(has ? "connected" : "unconfigured"))
      .catch(() => alive && setStatus("unconfigured"));
    return () => {
      alive = false;
    };
  }, [secretKey]);

  async function saveKey() {
    if (!keyInput.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await secrets.setSecret(secretKey, keyInput.trim());
      setKeyInput("");
      setStatus("connected");
      setMsg({ ok: true, text: "Chave salva no cofre do sistema." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    setMsg(null);
    try {
      await secrets.deleteSecret(secretKey);
      setStatus("unconfigured");
      setMsg({ ok: true, text: "Chave removida." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function testConn() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await aiClient.testConnection(id, model);
      setStatus(r.ok ? "connected" : "error");
      setMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setStatus("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`p-5 ${active ? "ring-1 ring-cofre" : ""}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold text-ink">{cfg.label}</span>
          {active && (
            <span className="rounded-pill bg-cofre-soft px-2 py-0.5 text-xs font-semibold text-cofre">
              Em uso
            </span>
          )}
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="API key" hint={status === "connected" ? "Uma chave já está salva. Digite para substituir." : "Cole a chave do provedor."}>
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={status === "connected" ? "•••••••••• (salva)" : "sk-…"}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="shrink-0 rounded-card border border-line px-3 text-xs font-semibold text-ink-soft hover:bg-surface-muted"
              aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
            >
              {showKey ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        </Field>

        <Field
          label="Modelo"
          hint={active ? `Em uso agora: ${model}` : "Selecione e clique em “Usar este provedor”."}
        >
          <Select value={model} onChange={(e) => setProviderModel(id, e.target.value)}>
            {cfg.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={saveKey} disabled={busy || !keyInput.trim()}>
          Salvar chave
        </Button>
        <Button variant="ghost" onClick={testConn} disabled={busy}>
          {busy ? "Testando…" : "Testar conexão"}
        </Button>
        {status === "connected" && (
          <Button variant="danger" onClick={removeKey} disabled={busy}>
            Remover
          </Button>
        )}
        {!active && (
          <Button variant="subtle" onClick={() => setActiveProvider(id)}>
            Usar este provedor
          </Button>
        )}
      </div>

      {msg && (
        <p className={`mt-3 text-sm ${msg.ok ? "text-entrada" : "text-saida"}`}>
          {msg.ok ? "✓ " : "⚠ "}
          {msg.text}
        </p>
      )}
    </Card>
  );
}

function GoogleCard() {
  const { settings, setGoogleAccount, setGoogleSheet } = useStore();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [link, setLink] = useState(settings.googleSheetLink ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    googleClient
      .status()
      .then((s) => alive && s.connected && setGoogleAccount(s.email))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setBusy(true);
    setMsg(null);
    try {
      const acc = await googleClient.connect(clientId.trim(), clientSecret.trim() || undefined);
      setGoogleAccount(acc.email);
      setMsg({ ok: true, text: `Conta ${acc.email || "Google"} conectada.` });
    } catch (e) {
      setMsg({ ok: false, text: cleanError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await googleClient.disconnect();
      setGoogleAccount(null);
      setMsg({ ok: true, text: "Conta desconectada." });
    } catch (e) {
      setMsg({ ok: false, text: cleanError(e) });
    } finally {
      setBusy(false);
    }
  }

  function linkSheet() {
    const id = sheetIdFromLink(link);
    if (!id) {
      setMsg({ ok: false, text: "Link de planilha inválido. Cole a URL do Google Sheets." });
      return;
    }
    setGoogleSheet(link, id);
    setMsg({ ok: true, text: "Planilha vinculada. As conciliações também gravarão nela." });
  }

  const connected = !!settings.googleEmail;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <span className="font-display font-semibold">Conta Google</span>
        <StatusBadge status={connected ? "connected" : "unconfigured"} />
      </div>

      {connected ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink">
            Conectado como <b>{settings.googleEmail}</b>
          </p>
          <Button variant="danger" onClick={disconnect} disabled={busy}>
            Desconectar
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">
            Use um OAuth Client (tipo <b>Desktop</b>) do seu projeto no Google Cloud. O login abre
            no navegador; guardamos apenas o token de atualização no cofre do sistema.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID">
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
            </Field>
            <Field label="Client secret (se exigido)">
              <Input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="opcional" />
            </Field>
          </div>
          <Button onClick={connect} disabled={busy || !clientId.trim()}>
            {busy ? "Abrindo o navegador…" : "Conectar conta Google"}
          </Button>
        </div>
      )}

      <div className="border-t border-line pt-4">
        <Field label="Planilha de destino no Google Sheets" hint="cole a URL da planilha (mesmo layout Cantina Bom Prato)">
          <div className="flex gap-2">
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            <Button variant="ghost" onClick={linkSheet} className="shrink-0">
              Vincular
            </Button>
          </div>
        </Field>
        {settings.googleSheetId && (
          <p className="mt-2 text-xs text-ink-soft">
            Vinculada: <span className="font-mono">{settings.googleSheetId}</span>
          </p>
        )}
      </div>

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-entrada" : "text-saida"}`}>
          {msg.ok ? "✓ " : "⚠ "}
          {msg.text}
        </p>
      )}
    </Card>
  );
}

/** Remove o prefixo de categoria "kind:" das mensagens de erro do backend. */
function cleanError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const idx = m.indexOf(":");
  return idx > 0 && idx < 16 ? m.slice(idx + 1).trim() : m;
}
