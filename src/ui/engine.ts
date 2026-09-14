/**
 * Wiring do MOTOR no WebView do desktop (Tauri). O pipeline completo, na ordem:
 *
 *   -1. PERFIL da planilha de destino  (workbookProfiler — deterministico, IA so se preciso)
 *    0a. ROTEAMENTO: layout conhecido e conferivel?  (parsers/hybrid)
 *    0. RECONHECIMENTO do layout do extrato        (aiStatementParser)
 *    1..3. EXTRACAO paginada + agregacao           (aiStatementParser)
 *    4. CATEGORIZACAO em prompt proprio            (aiCategorizer)
 *    5. CONCILIACAO: particiona, deduplica contra a aba, faz backup e grava
 *    6. AUTO-AJUSTE das larguras de coluna
 *    7. SERIALIZACAO sob demanda, com progresso (o download)
 *
 * Cada estagio tem um prompt so seu. O perfil (estagio -1) e o que torna o
 * sistema adaptavel: e dele que sai o layout de escrita, a lista de categorias
 * validas e o padrao de descricao repassado aos estagios seguintes.
 */
import { RawStatement } from "../application/ports";
import {
  AiStatementParser,
  AiRuntimeConfig,
  AiPartitionState,
} from "../adapters/ai/aiStatementParser";
import { TauriAiClient } from "../adapters/ai/tauriAiClient";
import {
  HybridStatementParser,
  MemoPageTextExtractor,
  StrategyInfo,
} from "../adapters/parsers/hybrid";
import {
  AiCategorizer,
  DecisaoAuditada,
  ResumoCategorizacao,
} from "../adapters/ai/aiCategorizer";
import { IdentityAgent } from "../adapters/ai/identityAgent";
import { UserRule } from "../domain/userRules";
import { profileWorkbook, refineColumnRules } from "../adapters/ai/workbookProfiler";
import { PdfjsTextExtractor } from "../adapters/pdf/pdfText";
import { GoogleSheetsTarget } from "../adapters/sheets/googleSheetsTarget";
import { XlsxSurgicalWriter } from "../adapters/writers/xlsxSurgical";
import { createWorkbook } from "../adapters/writers/createWorkbook";
import { MemoryLedger } from "../adapters/repo/memoryLedger";
import { InMemoryBackup, SystemClock } from "../adapters/backup";
import { importStatement } from "../application/importStatement";
import { buildDashboard, Dashboard } from "../application/dashboard";
import {
  WorkbookProfile,
  layoutFromProfile,
  describeProfileForPrompt,
  defaultProfile,
} from "../domain/workbookProfile";
import { ruleForColumn } from "../domain/listColumns";
import { DEFAULT_CATEGORIES } from "../domain/category";
import { Money } from "../domain/money";
import { ImportReport } from "../application/report";

export interface ReconcileInput {
  fileBytes: Uint8Array;
  fileName: string;
  xlsxBytes: Uint8Array | null;
  /** provedor/modelo de IA ativos (vindos das Configuracoes). */
  aiConfig: AiRuntimeConfig;
  /**
   * As regras do usuario da carteira desta planilha (estagio 4a). Vazio => o
   * comportamento e exatamente o de antes: regras da casa e depois o modelo.
   */
  regras?: UserRule[];
  /**
   * O perfil ja calculado pela pre-analise (quando o usuario soltou o .xlsx).
   * Reaproveitar evita repetir o estagio -1 — que na planilha fora do padrao
   * custa uma chamada de IA. Ausente, o perfil e calculado aqui, como antes.
   */
  profilePronto?: WorkbookProfile | null;
  /** se presente, tambem grava no Google Sheets (escrita independente). */
  googleSheetId?: string | null;
  /** liga o log da resposta crua por chamada (modo debug). */
  debug?: boolean;
  /**
   * Conferencia por IA em paralelo (§3.8). Ligada por padrao; desligada,
   * a leitura provada segue valendo — muda so a confianca declarada.
   */
  validarComIa?: boolean;
  /** progresso 0..1 + rotulo + estado por particao, para a barra de loading. */
  onProgress?: (value: number, label: string, partitions?: AiPartitionState[]) => void;
}

export interface ReconcileOutput {
  report: ImportReport;
  dashboard: Dashboard;
  parsedCount: number;
  /** perfil da planilha de destino (exibido no relatorio). */
  profile: WorkbookProfile;
  /** quantos lancamentos sairam com categoria preenchida. */
  categorizedCount: number;
  /** quem decidiu a categoria de cada lancamento (painel do relatorio). */
  auditoriaCategoria: DecisaoAuditada[];
  /** contagem por decisor + custo do agente de identidade. */
  resumoCategoria: ResumoCategorizacao | null;
  /**
   * As regras com os aliases que o agente de identidade confirmou nesta
   * execucao. A UI grava isto na carteira — e o que faz a proxima conciliacao
   * do mesmo cliente nao gastar a chamada de novo.
   */
  regras: UserRule[];
  /** avisos do estagio de categorizacao (lote de identidade que falhou, etc.). */
  avisosCategoria: string[];
  /** como o extrato foi lido: layout conhecido (sem IA) ou extracao empirica. */
  strategy: StrategyInfo;
  /**
   * Serializa o .xlsx final. Fica SOB DEMANDA de proposito: compactar o ZIP e a
   * parte demorada, e e ela que alimenta a barra de progresso do download. O
   * resultado e memorizado — clicar duas vezes nao recompacta.
   */
  serialize: (onProgress?: (pct: number) => void) => Promise<Uint8Array>;
}

export async function reconcile(input: ReconcileInput): Promise<ReconcileOutput> {
  const clock = new SystemClock();
  const emit = input.onProgress ?? (() => {});
  const client = new TauriAiClient();
  const resolveConfig = () => input.aiConfig;

  emit(0.02, "Lendo o arquivo…");

  // ── Estagio -1: perfil da planilha de destino ─────────────────────────────
  emit(0.04, "Analisando a estrutura da planilha de destino…");
  const generatedHere = input.xlsxBytes == null;
  const jaAnalisado = !generatedHere && input.profilePronto != null;
  const profile = generatedHere
    ? defaultProfile(DEFAULT_CATEGORIES.map((c) => c.name))
    : (input.profilePronto ?? (await profileWorkbook(input.xlsxBytes, { client, resolveConfig })));

  // ── Estagios -1b e -1c: regras das colunas por listagem e colunas calculadas
  // O perfil ja trouxe os FATOS (quais opcoes o dropdown aceita, quais colunas
  // tem formula). Estes dois estagios respondem o que o arquivo nao responde:
  // quando cada opcao se aplica, e o que fazer com a coluna cuja formula so
  // aparece em parte das linhas.
  // A pre-analise ja rodou -1b/-1c ao abrir a planilha; repetir aqui gastaria
  // as mesmas chamadas de novo para chegar no mesmo perfil.
  if (!generatedHere && !jaAnalisado) {
    emit(0.06, "Lendo as listas e as fórmulas da planilha…");
    await refineColumnRules(profile, { client, resolveConfig });
  }

  const layout = layoutFromProfile(profile);
  const destination = describeProfileForPrompt(profile);

  // ── Estagios 0..3: extracao ───────────────────────────────────────────────
  // O texto do PDF e extraido UMA vez e reaproveitado: o roteador precisa dele
  // para reconhecer o layout, e o pipeline de IA para paginar a extracao.
  const pdfText = new MemoPageTextExtractor(new PdfjsTextExtractor());
  const ai = new AiStatementParser({
    client,
    resolveConfig,
    pdfText,
    debug: input.debug,
    destination,
    onProgress: ({ phase, done, total, label, partitions }) => {
      let value: number;
      if (phase === "recognize") value = 0.08;
      else if (phase === "partition") value = 0.12;
      else if (phase === "done") value = 0.68;
      else value = 0.12 + 0.56 * (total > 0 ? done / total : 1);
      emit(value, label, partitions);
    },
  });
  // As DUAS vias de leitura, e uma arbitragem entre elas (§3.8): o parser
  // deterministico le e prova; a IA le em paralelo e serve de testemunha. A
  // prova vence sempre — a testemunha existe para CONFERIR, e a discordancia
  // dela vai para o relatorio em vez de mudar o resultado em silencio.
  let strategy: StrategyInfo = { kind: "ai", parserId: "ai", label: "Leitura por IA" };
  const parser = new HybridStatementParser({
    ai,
    pdfText,
    validacaoIa: { ativa: input.validarComIa !== false },
    onStrategy: (info) => {
      strategy = info;
      if (info.kind === "deterministic") {
        emit(0.68, `${info.label} — leitura ${info.nivel ?? "provada"}`);
      }
    },
  });
  const raw: RawStatement = { fileName: input.fileName, bytes: input.fileBytes };
  const allTx = (await parser.read(raw)).transactions;

  // ── Estagio 4: categorizacao (prompt proprio, nunca derruba a conciliacao) ─
  //    4a regras do usuario → 4b agente de identidade → 4c regras da casa → 4d IA
  let categorizedCount = 0;
  let auditoriaCategoria: DecisaoAuditada[] = [];
  let resumoCategoria: ResumoCategorizacao | null = null;
  let avisosCategoria: string[] = [];
  let regras = input.regras ?? [];
  if (profile.categories.length > 0 && allTx.length > 0) {
    emit(0.7, "Classificando os lançamentos…");
    // O agente de identidade so existe quando ha regra por NOME para conferir.
    // Sem isso ele nao teria pergunta nenhuma a fazer — e um estagio que nao
    // custa nada quando nao ha o que perguntar e melhor que um estagio opcional
    // que alguem esquece de ligar.
    const temRegraDeNome = regras.some((r) => r.ativo && r.quando.nome);
    const categorizer = new AiCategorizer({
      client,
      resolveConfig,
      destination,
      // regra da coluna de categoria (estagio -1b): opcoes na grafia da
      // planilha + quando cada uma se aplica, segundo o uso ja gravado
      rule: ruleForColumn(profile.listColumns, layout.columns.category),
      regras,
      identity: temRegraDeNome ? new IdentityAgent({ client, resolveConfig }) : null,
      onProgress: (done, total) =>
        emit(0.7 + 0.18 * (total > 0 ? done / total : 1), "Classificando os lançamentos…"),
    });
    const resultado = await categorizer.classificar(allTx, profile.categories);
    resultado.categorias.forEach((c, i) => {
      if (c) {
        allTx[i].category = c;
        categorizedCount++;
      }
    });
    auditoriaCategoria = resultado.auditoria;
    resumoCategoria = resultado.resumo;
    avisosCategoria = resultado.avisos;
    regras = resultado.regras;
  }

  emit(0.9, "Conciliando e gravando…");
  const dashboard = buildDashboard(allTx);

  // Planilha NOVA (gerada por nos) x planilha VIVA do usuario. So na nossa
  // podemos podar as formulas das linhas sem dados (ver finalize abaixo); no
  // template do usuario o contrato T-PRES/T-NOFORMULA proibe qualquer toque.
  const xlsxBytes = input.xlsxBytes ?? (await createWorkbook());
  const writer = await XlsxSurgicalWriter.load(xlsxBytes);
  const backup = new InMemoryBackup(clock, () => xlsxBytes);
  const ledger = new MemoryLedger();

  const sheets = input.googleSheetId ? new GoogleSheetsTarget(input.googleSheetId) : undefined;

  const report = await importStatement(raw, {
    parser: { id: "ai", canParse: () => true, parse: async () => allTx },
    local: writer,
    sheets,
    ledger,
    backup,
    clock,
    layout,
    localFileId: input.fileName.replace(/\.[^.]+$/, ".xlsx"),
  });

  // Fórmulas SÓ nas linhas que têm dados: a planilha nova nasce com E/H
  // pré-preenchidas em todo o range; depois de gravar, limpamos as que
  // sobraram vazias (senão o saldo se arrasta por centenas de linhas em branco).
  if (generatedHere) await writer.finalizeGeneratedTemplate(layout);

  // ── Estagio 6: larguras condizentes com o conteudo ────────────────────────
  // SEMPRE em modo "so alarga": na planilha do usuario isso preserva a largura
  // que ele escolheu, e na nossa preserva os pisos com que ela ja nasce — em
  // nenhum dos dois casos uma coluna encolhe por causa de um conteudo curto.
  emit(0.96, "Ajustando o layout da planilha…");
  await writer.autofitAllSheets(layout, { onlyExpand: true });

  emit(1, "Pronto");

  let cached: Uint8Array | null = null;
  const serialize = async (onProgress?: (pct: number) => void): Promise<Uint8Array> => {
    if (cached) {
      onProgress?.(1);
      return cached;
    }
    cached = await writer.toBytes(onProgress);
    return cached;
  };

  return {
    report,
    dashboard,
    parsedCount: allTx.length,
    profile,
    categorizedCount,
    auditoriaCategoria,
    resumoCategoria,
    regras,
    avisosCategoria,
    strategy,
    serialize,
  };
}

export async function createNewWorkbook(onProgress?: (pct: number) => void): Promise<Uint8Array> {
  return createWorkbook(undefined, onProgress);
}

export function formatCents(cents: number): string {
  return Money.fromCents(cents).format();
}
