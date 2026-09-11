import { create } from "zustand";
import { ImportReport } from "../application/report";
import { Dashboard } from "../application/dashboard";
import { AiRuntimeConfig, AiPartitionState } from "../adapters/ai/aiStatementParser";
import { AiProviderId } from "../application/ports";
import { WorkbookProfile } from "../domain/workbookProfile";
import { StrategyInfo } from "../adapters/parsers/hybrid";
import { DecisaoAuditada, ResumoCategorizacao } from "../adapters/ai/aiCategorizer";
import { UserRule } from "../domain/userRules";
import { MotivoEscolha, RuleSet, usarCarteira } from "../domain/ruleSet";
import { SugestaoDeRegra } from "../domain/ruleMining";
import { PreAnalise, analisarPlanilha } from "./analyzeWorkbook";
import { TauriAiClient } from "../adapters/ai/tauriAiClient";
import { FileRulesRepository } from "../adapters/repo/rulesRepository";
import { createTextStore } from "../adapters/tauri/tauriTextStore";
import { agoraIso } from "./ids";
import { Screen, aoClicarNaEngrenagem, aoFecharSettings } from "./navigation";
import { DEFAULT_PROVIDERS, resolveModel } from "../adapters/ai/providers";
import {
  PersistedSettings,
  loadSettings,
  saveSettings,
} from "./settings";

export type { Screen };

/**
 * Config de IA EFETIVA — o que o motor realmente vai chamar. E derivada das
 * preferencias a cada mudanca, entao a tela (que mostra `aiConfig.model`) e a
 * chamada ao provedor leem sempre a MESMA fonte: nao ha como a UI dizer um
 * modelo e o backend receber outro.
 */
function aiConfigFrom(s: PersistedSettings): AiRuntimeConfig {
  const p = s.activeProvider;
  return {
    provider: p,
    model: resolveModel(p, s.models[p]),
    supportsDocument: DEFAULT_PROVIDERS[p].supportsDocument,
  };
}

interface AppState {
  screen: Screen;
  /** de onde o usuario veio, p/ o botao "voltar" das Configuracoes. */
  returnTo: Screen;

  // planilha local + extrato em memoria
  xlsxName: string | null;
  xlsxBytes: Uint8Array | null;
  extBytes: Uint8Array | null;
  extName: string | null;

  running: boolean;
  progress: number; // 0..1
  progressLabel: string;
  partitions: AiPartitionState[]; // estado por partição (pending→running→done|error)
  report: ImportReport | null;
  dashboard: Dashboard | null;
  /**
   * Serializador do .xlsx final (sob demanda, com progresso). Guardamos a
   * FUNCAO em vez dos bytes: compactar so acontece quando o usuario clica em
   * baixar, e e dai que sai a porcentagem real da barra de download.
   */
  serialize: ((onProgress?: (pct: number) => void) => Promise<Uint8Array>) | null;
  parsedCount: number;
  /** perfil da planilha de destino usado nesta conciliação. */
  profile: WorkbookProfile | null;
  /** quantos lançamentos saíram com categoria preenchida. */
  categorizedCount: number;
  /** quem decidiu a categoria de cada lançamento (painel do relatório). */
  auditoriaCategoria: DecisaoAuditada[];
  /** contagem por decisor + custo do agente de identidade. */
  resumoCategoria: ResumoCategorizacao | null;
  /** avisos do estágio de categorização. */
  avisosCategoria: string[];
  /**
   * As regras depois desta execução — com os aliases que o agente de
   * identidade confirmou. É isto que a carteira grava para a próxima vez.
   */
  regras: UserRule[];
  /** como o extrato foi lido nesta execução (leitura direta x IA). */
  strategy: StrategyInfo | null;

  /* ── regras do usuário (pré-análise da planilha) ────────────────────── */
  /** resultado da pré-análise: perfil, impressão, arquivo de regras, sugestões. */
  preAnalise: PreAnalise | null;
  /** a carteira em edição na tela — só vira disco quando o usuário salva. */
  carteira: RuleSet | null;
  sugestoes: SugestaoDeRegra[];
  motivoCarteira: MotivoEscolha;
  analisando: boolean;
  salvandoRegras: boolean;
  regrasSalvas: boolean;
  erroRegras: string | null;

  // configuracoes (nao-secretas) persistidas
  settings: PersistedSettings;
  aiConfig: AiRuntimeConfig;

  setScreen: (s: Screen) => void;
  /** a engrenagem: leva às Configurações e traz de volta (é um interruptor). */
  openSettings: () => void;
  /** o "← Voltar" das Configurações. Nunca deixa o usuário preso. */
  fecharSettings: () => void;
  setActiveProvider: (p: AiProviderId) => void;
  setProviderModel: (p: AiProviderId, model: string) => void;
  setGoogleAccount: (email: string | null) => void;
  setGoogleSheet: (link: string | null, id: string | null) => void;
  setDebugLogging: (on: boolean) => void;
  setValidarComIa: (on: boolean) => void;

  setXlsx: (name: string | null, bytes: Uint8Array | null) => void;
  /** roda a pré-análise da planilha atual (perfil + carteira + sugestões). */
  analisarXlsx: () => Promise<void>;
  /** edição local da carteira — não grava em disco. */
  setCarteira: (c: RuleSet) => void;
  /** grava a carteira e registra a impressão desta planilha. */
  salvarRegras: () => Promise<void>;
  /**
   * Absorve as regras que voltaram da conciliação com os aliases confirmados
   * pelo agente de identidade, e grava. Isto NÃO é decisão do usuário — é fato
   * aprendido —, então salva sozinho.
   */
  absorverRegrasAprendidas: (regras: UserRule[]) => Promise<void>;
  setExt: (name: string | null, bytes: Uint8Array | null) => void;
  setRunning: (r: boolean) => void;
  setProgress: (p: number, label?: string, partitions?: AiPartitionState[]) => void;
  setResult: (r: {
    report: ImportReport;
    dashboard: Dashboard;
    serialize: (onProgress?: (pct: number) => void) => Promise<Uint8Array>;
    parsedCount: number;
    profile: WorkbookProfile;
    categorizedCount: number;
    auditoriaCategoria: DecisaoAuditada[];
    resumoCategoria: ResumoCategorizacao | null;
    avisosCategoria: string[];
    regras: UserRule[];
    strategy: StrategyInfo;
  }) => void;
}

const initialSettings = loadSettings();

/**
 * O repositorio de regras, criado sob demanda. No desktop grava um arquivo no
 * diretorio de dados do app; fora do Tauri cai no storage do navegador, so para
 * a tela poder ser desenvolvida sem subir o backend nativo.
 */
let repo: FileRulesRepository | null = null;
function rulesRepo(): FileRulesRepository {
  if (!repo) repo = new FileRulesRepository(createTextStore());
  return repo;
}

export const useStore = create<AppState>((set, get) => {
  const persist = (settings: PersistedSettings) => {
    saveSettings(settings);
    set({ settings, aiConfig: aiConfigFrom(settings) });
  };
  return {
    screen: "onboarding",
    returnTo: "main",
    xlsxName: null,
    xlsxBytes: null,
    extBytes: null,
    extName: null,
    running: false,
    progress: 0,
    progressLabel: "",
    partitions: [],
    report: null,
    dashboard: null,
    serialize: null,
    parsedCount: 0,
    profile: null,
    categorizedCount: 0,
    auditoriaCategoria: [],
    resumoCategoria: null,
    avisosCategoria: [],
    regras: [],
    strategy: null,
    preAnalise: null,
    carteira: null,
    sugestoes: [],
    motivoCarteira: "nova",
    analisando: false,
    salvandoRegras: false,
    regrasSalvas: false,
    erroRegras: null,
    settings: initialSettings,
    aiConfig: aiConfigFrom(initialSettings),

    setScreen: (screen) => set({ screen }),

    /**
     * A ENGRENAGEM E UM INTERRUPTOR: leva as Configuracoes e traz de volta.
     *
     * Antes ela so ia, e gravava `returnTo` a cada clique. Clicar duas vezes
     * gravava `returnTo = "settings"` — e ai o "Voltar" mandava para a tela em
     * que o usuario ja estava, sem nada acontecer. O app ficava preso nas
     * Configuracoes, e o botao parecia quebrado porque ele de fato executava:
     * so que para o lugar errado.
     *
     * As duas travas: a engrenagem VOLTA quando ja estamos nas Configuracoes, e
     * `returnTo` nunca recebe "settings".
     */
    openSettings: () => set(aoClicarNaEngrenagem({ screen: get().screen, returnTo: get().returnTo })),
    fecharSettings: () => set(aoFecharSettings({ screen: get().screen, returnTo: get().returnTo })),
    setActiveProvider: (p) => persist({ ...get().settings, activeProvider: p }),
    setProviderModel: (p, model) =>
      persist({
        ...get().settings,
        models: { ...get().settings.models, [p]: resolveModel(p, model) },
      }),
    setGoogleAccount: (email) => persist({ ...get().settings, googleEmail: email }),
    setGoogleSheet: (link, id) =>
      persist({ ...get().settings, googleSheetLink: link, googleSheetId: id }),
    setDebugLogging: (on) => persist({ ...get().settings, debugAiLogging: on }),
    setValidarComIa: (on) => persist({ ...get().settings, validarComIa: on }),

    // Soltar a planilha dispara a PRE-ANALISE: e dela que saem a carteira de
    // regras e as sugestoes que o usuario revisa antes de soltar o extrato.
    setXlsx: (xlsxName, xlsxBytes) => {
      set({
        xlsxName,
        xlsxBytes,
        preAnalise: null,
        carteira: null,
        sugestoes: [],
        motivoCarteira: "nova",
        regrasSalvas: false,
        erroRegras: null,
      });
      if (xlsxBytes) void get().analisarXlsx();
    },

    analisarXlsx: async () => {
      const { xlsxBytes, xlsxName } = get();
      if (!xlsxBytes) return;
      set({ analisando: true, erroRegras: null });
      try {
        const pre = await analisarPlanilha(xlsxBytes, xlsxName, {
          client: new TauriAiClient(),
          resolveConfig: () => get().aiConfig,
          rules: rulesRepo(),
        });
        set({
          preAnalise: pre,
          carteira: pre.carteira,
          sugestoes: pre.sugestoes,
          motivoCarteira: pre.motivo,
          analisando: false,
        });
      } catch (e) {
        // A conciliacao nao depende disto: sem pre-analise, a tela segue sem o
        // painel de regras e o perfil e calculado no reconcile, como antes.
        set({ analisando: false, erroRegras: (e as Error).message });
      }
    },

    setCarteira: (carteira) => set({ carteira, regrasSalvas: false }),

    salvarRegras: async () => {
      const { preAnalise, carteira } = get();
      if (!preAnalise || !carteira) return;
      set({ salvandoRegras: true, erroRegras: null });
      try {
        // `usarCarteira` tambem REGISTRA a impressao desta planilha: e o que faz
        // a proxima abertura reconhecer a carteira sem perguntar.
        const file = usarCarteira(preAnalise.file, carteira, preAnalise.impressao, agoraIso());
        await rulesRepo().save(file);
        set({
          preAnalise: { ...preAnalise, file, carteira },
          salvandoRegras: false,
          regrasSalvas: true,
        });
      } catch (e) {
        set({ salvandoRegras: false, erroRegras: (e as Error).message });
      }
    },

    absorverRegrasAprendidas: async (regras) => {
      const { preAnalise, carteira } = get();
      if (!preAnalise || !carteira || regras.length === 0) return;
      const atualizada: RuleSet = { ...carteira, regras, atualizadoEm: agoraIso() };
      set({ carteira: atualizada });
      try {
        const file = usarCarteira(preAnalise.file, atualizada, preAnalise.impressao, agoraIso());
        await rulesRepo().save(file);
        set({ preAnalise: { ...preAnalise, file, carteira: atualizada } });
      } catch {
        // alias nao gravado so custa uma conferencia a mais na proxima vez
      }
    },
    setExt: (extName, extBytes) => set({ extName, extBytes }),
    setRunning: (running) => set(running ? { running, partitions: [] } : { running }),
    setProgress: (progress, progressLabel, partitions) =>
      set({
        progress,
        ...(progressLabel !== undefined ? { progressLabel } : {}),
        ...(partitions !== undefined ? { partitions } : {}),
      }),
    setResult: ({
      report,
      dashboard,
      serialize,
      parsedCount,
      profile,
      categorizedCount,
      auditoriaCategoria,
      resumoCategoria,
      avisosCategoria,
      regras,
      strategy,
    }) =>
      set({
        report,
        dashboard,
        serialize,
        parsedCount,
        profile,
        categorizedCount,
        auditoriaCategoria,
        resumoCategoria,
        avisosCategoria,
        regras,
        strategy,
        screen: "report",
        running: false,
      }),
  };
});
