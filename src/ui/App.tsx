import { useStore } from "./store";
import { Onboarding } from "./screens/Onboarding";
import { Main } from "./screens/Main";
import { Report } from "./screens/Report";
import { Settings } from "./screens/Settings";

export function App() {
  const screen = useStore((s) => s.screen);
  const openSettings = useStore((s) => s.openSettings);

  return (
    <div className="flex min-h-full flex-col bg-bg text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
          <Brasao />
          <div className="flex-1">
            <h1 className="font-display text-[15px] font-bold leading-tight tracking-tight">
              Conciliador de Extratos
            </h1>
            <p className="text-xs text-ink-soft">
              Cantina Bom Prato · fluxo de caixa
            </p>
          </div>
          {/* Interruptor: nas Configurações, a mesma engrenagem volta. */}
          <button
            onClick={openSettings}
            aria-label={screen === "settings" ? "Voltar" : "Configurações"}
            title={screen === "settings" ? "Voltar" : "Configurações"}
            aria-pressed={screen === "settings"}
            className={`grid h-9 w-9 place-items-center rounded-card border border-line text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink ${
              screen === "settings" ? "bg-surface-muted text-ink" : "bg-surface"
            }`}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <main className="flex-1">
        {screen === "onboarding" && <Onboarding />}
        {screen === "main" && <Main />}
        {screen === "report" && <Report />}
        {screen === "settings" && <Settings />}
      </main>
    </div>
  );
}

/** Brasão: um "livro-caixa" estilizado com a marca cofre. */
function Brasao() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-card bg-cofre font-display text-lg font-bold text-white shadow-card">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="4"
          y="3"
          width="16"
          height="18"
          rx="2"
          stroke="white"
          strokeWidth="1.6"
        />
        <path
          d="M8 8h8M8 12h8M8 16h5"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/**
 * 18px dentro de um botao de 36 — a mesma proporcao do brasao ao lado (20 em
 * 36). Em 24 ela encostava na borda e puxava o olho para o canto, que e
 * justamente onde a atencao NAO deve ficar.
 */
function GearIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
