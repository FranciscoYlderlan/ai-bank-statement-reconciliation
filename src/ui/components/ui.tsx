import React from "react";
import { ProviderStatus } from "../../application/ports";

/** Kit de UI da direcao "Verde-cofre" — mantem consistencia entre telas. */

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "subtle" | "danger";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-card px-4 py-2.5 font-display text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles: Record<string, string> = {
    primary: "bg-cofre text-white hover:bg-cofre-strong",
    ghost: "border border-line bg-surface text-ink hover:bg-surface-muted",
    subtle: "text-cofre hover:text-cofre-strong",
    danger: "border border-saida/30 bg-saida-soft text-saida hover:bg-saida/10",
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-card border border-line bg-surface shadow-card ${className}`}>
      {children}
    </div>
  );
}

/** Titulo de secao com a "linha de conciliacao" (regua dupla) por baixo. */
export function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-lg font-bold tracking-tight text-ink">{children}</h2>
        {hint ? <span className="text-xs text-ink-soft">{hint}</span> : null}
      </div>
      <hr className="ledger-rule" />
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="font-display text-xs font-semibold uppercase tracking-wide text-ink-soft">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-xs text-ink-soft">{hint}</span> : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-card border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-soft/70 focus:border-cofre focus:outline-none ${props.className ?? ""}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-card border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-cofre focus:outline-none ${props.className ?? ""}`}
    />
  );
}

export function StatusBadge({ status }: { status: ProviderStatus }) {
  const map: Record<ProviderStatus, { label: string; cls: string; dot: string }> = {
    connected: { label: "Conectado", cls: "bg-entrada-soft text-entrada", dot: "bg-entrada" },
    unconfigured: { label: "Não configurado", cls: "bg-surface-muted text-ink-soft", dot: "bg-ink-soft" },
    error: { label: "Erro", cls: "bg-saida-soft text-saida", dot: "bg-saida" },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/** Estado vazio/erro no tom da interface. */
export function EmptyState({
  icon,
  title,
  children,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  const toneCls =
    tone === "error" ? "border-saida/30 bg-saida-soft" : "border-line bg-surface-muted/60";
  return (
    <div className={`rounded-card border border-dashed ${toneCls} p-6 text-center`}>
      {icon ? <div className="mb-2 text-2xl">{icon}</div> : null}
      <p className="font-display text-sm font-semibold text-ink">{title}</p>
      {children ? <p className="mt-1 text-sm text-ink-soft">{children}</p> : null}
    </div>
  );
}

/**
 * Barra de progresso. `value` 0..1; sem `value` vira indeterminada (pulsa),
 * para o caso em que o trabalho existe mas ainda nao sabemos a fracao.
 */
export function ProgressBar({
  value,
  label,
  className = "",
}: {
  value?: number;
  label?: string;
  className?: string;
}) {
  const pct = value === undefined ? null : Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={`space-y-1.5 ${className}`} role="status" aria-live="polite">
      <div
        className="h-2 w-full overflow-hidden rounded-pill bg-surface-muted"
        role="progressbar"
        aria-label={label}
        {...(pct === null ? {} : { "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 })}
      >
        <div
          className={`h-full rounded-pill bg-cofre transition-all duration-200 ease-out ${
            pct === null ? "w-1/3 animate-pulse" : ""
          }`}
          style={pct === null ? undefined : { width: `${Math.max(4, pct)}%` }}
        />
      </div>
      {(label || pct !== null) && (
        <div className="flex items-center justify-between text-xs text-ink-soft">
          <span>{label}</span>
          {pct !== null ? <span className="font-mono">{pct}%</span> : null}
        </div>
      )}
    </div>
  );
}

/**
 * Botao de download com indicativo: enquanto prepara mostra a barra e a
 * porcentagem real da compactacao; ao terminar confirma o nome do arquivo
 * entregue; se falhar, diz o porque e deixa tentar de novo.
 */
export function DownloadButton({
  label,
  fileName,
  state,
  onStart,
  variant = "ghost",
  hint,
}: {
  label: string;
  fileName: string;
  state: { phase: "idle" | "preparing" | "done" | "error"; pct: number; error: string | null };
  onStart: () => void;
  variant?: "primary" | "ghost";
  hint?: React.ReactNode;
}) {
  const busy = state.phase === "preparing";
  return (
    <div className="min-w-[16rem] space-y-2">
      <Button variant={variant} onClick={onStart} disabled={busy} aria-busy={busy}>
        {busy ? "Preparando o arquivo…" : label}
      </Button>
      {busy && <ProgressBar value={state.pct} label={`Compactando ${fileName}`} />}
      {state.phase === "done" && (
        <p className="text-xs text-entrada">
          ✓ <b>{fileName}</b> foi baixado — confira a pasta de downloads.
        </p>
      )}
      {state.phase === "error" && (
        <p className="text-xs text-saida">Não foi possível gerar o arquivo: {state.error}</p>
      )}
      {!busy && state.phase === "idle" && hint ? (
        <p className="text-xs text-ink-soft">{hint}</p>
      ) : null}
    </div>
  );
}

/** Sinais de entrada/saida — cor + simbolo (nunca so cor). */
export function DirectionSign({ direction }: { direction: "credit" | "debit" }) {
  return direction === "credit" ? (
    <span className="text-entrada" aria-label="Entrada">▲</span>
  ) : (
    <span className="text-saida" aria-label="Saída">▼</span>
  );
}
