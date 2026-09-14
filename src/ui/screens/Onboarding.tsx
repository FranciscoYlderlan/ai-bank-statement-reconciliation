import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Dropzone } from "../components/Dropzone";
import { Button, Card, SectionTitle, StatusBadge } from "../components/ui";
import { ProviderStatus } from "../../application/ports";
import { DEFAULT_PROVIDERS, secretKeyFor } from "../../adapters/ai/providers";
import { TauriSecretsStore } from "../../adapters/secrets/tauriSecrets";

const secrets = new TauriSecretsStore();

export function Onboarding() {
  const { settings, xlsxName, setXlsx, setScreen, openSettings } = useStore();
  const provider = DEFAULT_PROVIDERS[settings.activeProvider];
  const [aiStatus, setAiStatus] = useState<ProviderStatus>("unconfigured");

  useEffect(() => {
    let alive = true;
    secrets
      .hasSecret(secretKeyFor(settings.activeProvider))
      .then((has) => alive && setAiStatus(has ? "connected" : "unconfigured"))
      .catch(() => alive && setAiStatus("unconfigured"));
    return () => {
      alive = false;
    };
  }, [settings.activeProvider]);

  const aiReady = aiStatus === "connected";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 md:p-8">
      <div className="space-y-1">
        <span className="competence-tag">Primeiros passos</span>
        <h2 className="font-display text-2xl font-bold tracking-tight">
          Vamos preparar sua conciliação
        </h2>
        <p className="text-sm text-ink-soft">
          Dois passos rápidos: conectar a leitura por IA e escolher a planilha de destino.
          Depois é só soltar o extrato.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <StepDot done={aiReady} n={1} />
              <span className="font-display font-semibold">Leitura por inteligência artificial</span>
            </div>
            <p className="pl-8 text-sm text-ink-soft">
              CSV, planilha (.xls/.xlsx) e OFX são lidos direto do arquivo, sem IA e sem custo. A
              IA entra nos layouts que não se autoconferem — PDF de banco novo, extrato escaneado.
              Provedor atual: <b className="text-ink">{provider.label}</b> · modelo{" "}
              <span className="font-mono text-ink">{settings.models[settings.activeProvider]}</span>.
            </p>
          </div>
          <StatusBadge status={aiStatus} />
        </div>
        <div className="mt-3 pl-8">
          <Button variant={aiReady ? "ghost" : "primary"} onClick={openSettings}>
            {aiReady ? "Ajustar chave e modelo" : "Configurar chave da API"}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <StepDot done={!!xlsxName} n={2} />
          <span className="font-display font-semibold">Planilha de fluxo de caixa</span>
        </div>
        <Dropzone
          title="Solte sua planilha .xlsx aqui"
          hint="Opcional — sem planilha, criamos uma nova no padrão Cantina Bom Prato"
          accept={{
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          }}
          fileName={xlsxName}
          onFile={(name, bytes) => setXlsx(name, bytes)}
        />
        <p className="mt-3 text-xs text-ink-soft">
          <b className="text-ink">Contrato de layout:</b> conferimos as 12 abas de mês, o
          cabeçalho (Data · Descrição · Categoria · Fluxo de Caixa · Entrada · Saída · Saldo) e a
          aba Categorias. Se algo divergir, a importação é bloqueada com a diferença exata — e as
          fórmulas de Fluxo (E) e Saldo (H) nunca são tocadas.
        </p>
      </Card>

      <div className="space-y-3">
        <SectionTitle>Pronto para conciliar</SectionTitle>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-soft">
            {aiReady
              ? "Tudo certo com a IA. Você pode importar um extrato agora."
              : "Você pode entrar mesmo sem a chave, mas a conciliação só roda com a IA configurada."}
          </p>
          <Button onClick={() => setScreen("main")}>Continuar</Button>
        </div>
      </div>
    </div>
  );
}

function StepDot({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      className={`grid h-6 w-6 place-items-center rounded-full font-display text-xs font-bold ${
        done ? "bg-cofre text-white" : "border border-line bg-surface text-ink-soft"
      }`}
    >
      {done ? "✓" : n}
    </span>
  );
}
