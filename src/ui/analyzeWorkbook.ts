import { AiClient, RulesRepository } from "../application/ports";
import { AiRuntimeConfig } from "../adapters/ai/aiStatementParser";
import { profileWorkbook, refineColumnRules } from "../adapters/ai/workbookProfiler";
import { XlsxSurgicalWriter } from "../adapters/writers/xlsxSurgical";
import { WorkbookProfile, layoutFromProfile } from "../domain/workbookProfile";
import {
  MotivoEscolha,
  RuleSet,
  RulesFile,
  carteiraVazia,
  escolherCarteira,
  impressaoDaPlanilha,
} from "../domain/ruleSet";
import { ObservacaoHistorica, SugestaoDeRegra, minerarRegras } from "../domain/ruleMining";
import { agoraIso, novoId } from "./ids";

/**
 * PRE-ANALISE DA PLANILHA — o que acontece quando o usuario solta o .xlsx,
 * ANTES de o extrato ser lido.
 *
 * A ordem importa e foi decidida assim de proposito: as regras sao escolhidas e
 * revisadas COM A PLANILHA EM MAOS e ANTES da leitura do extrato. Duas coisas
 * saem de graca disso:
 *
 *  1. as regras ja estao valendo quando o extrato chega, entao elas cortam
 *     chamadas de IA em vez de corrigir depois;
 *  2. a regra nunca envelhece. A tela aparece em TODA conciliacao, com a
 *     carteira aberta: se a funcionaria saiu da empresa, o dono ve a regra na
 *     frente dele e desliga. Regra que so existe num arquivo escondido e regra
 *     que ninguem revisa.
 *
 * O perfil calculado aqui e reaproveitado pelo `reconcile` (que o recebe pronto
 * em `profilePronto`), entao esta etapa nao cobra uma chamada a mais: ela
 * apenas ANTECIPA a que ja seria feita.
 */

export interface PreAnaliseDeps {
  client: AiClient;
  resolveConfig: () => AiRuntimeConfig;
  rules: RulesRepository;
  logger?: Pick<Console, "warn">;
}

export interface PreAnalise {
  profile: WorkbookProfile;
  /** hash da estrutura desta planilha. */
  impressao: string;
  /** o arquivo de regras inteiro (todas as carteiras). */
  file: RulesFile;
  /** a carteira que vai valer nesta conciliacao. */
  carteira: RuleSet;
  /** como ela foi escolhida — `"ultima"` significa PALPITE, e a tela avisa. */
  motivo: MotivoEscolha;
  /** padroes achados no historico da planilha que ainda nao sao regra. */
  sugestoes: SugestaoDeRegra[];
  avisos: string[];
}

/** "Fluxo de Caixa 2026 - Cantina Bom Prato - atualizado.xlsx" -> "Fluxo de Caixa 2026 - Cantina Bom Prato" */
export function nomeDeCarteira(nomeArquivo: string | null): string {
  if (!nomeArquivo) return "Minha planilha";
  return (
    nomeArquivo
      .replace(/\.xlsx?$/i, "")
      .replace(/\s*[-–]\s*atualizad[oa]\s*$/i, "")
      .trim() || "Minha planilha"
  );
}

export async function analisarPlanilha(
  xlsxBytes: Uint8Array,
  nomeArquivo: string | null,
  deps: PreAnaliseDeps,
): Promise<PreAnalise> {
  const log = deps.logger ?? console;

  // ── perfil (o mesmo do estagio -1; sera reaproveitado no reconcile) ──────
  const profile = await profileWorkbook(xlsxBytes, {
    client: deps.client,
    resolveConfig: deps.resolveConfig,
  });
  await refineColumnRules(profile, { client: deps.client, resolveConfig: deps.resolveConfig });

  const impressao = impressaoDaPlanilha(profile);

  // ── carteira ────────────────────────────────────────────────────────────
  const { file, avisos } = await deps.rules.load();
  const escolha = escolherCarteira(file, impressao);
  const carteira =
    escolha.carteira ?? carteiraVazia(novoId("carteira"), nomeDeCarteira(nomeArquivo), agoraIso());

  // ── mineracao: o que o proprio cliente ja praticou ──────────────────────
  // Nunca derruba a tela: planilha estranha, aba protegida ou zip mal formado
  // custam a sugestao, nao a conciliacao.
  let sugestoes: SugestaoDeRegra[] = [];
  try {
    const historico = await lerHistorico(xlsxBytes, profile);
    sugestoes = minerarRegras(historico, {
      categorias: profile.categories,
      regras: carteira.regras,
      dispensadas: carteira.dispensadas,
    });
  } catch (e) {
    const msg = (e as Error).message;
    log.warn(`[regras] nao consegui ler o historico da planilha para sugerir regras: ${msg}`);
    avisos.push("não consegui ler o histórico da planilha para sugerir regras");
  }

  return { profile, impressao, file, carteira, motivo: escolha.motivo, sugestoes, avisos };
}

/** Todo o historico ja classificado, de todas as abas de lancamento. */
export async function lerHistorico(
  xlsxBytes: Uint8Array,
  profile: WorkbookProfile,
): Promise<ObservacaoHistorica[]> {
  const writer = await XlsxSurgicalWriter.load(xlsxBytes);
  const layout = layoutFromProfile(profile);
  const abas = profile.monthSheets.length > 0 ? profile.monthSheets : await writer.sheetNames();
  const tudo: ObservacaoHistorica[] = [];
  for (const aba of abas) {
    try {
      tudo.push(...(await writer.readCategoryHistory(aba, layout)));
    } catch {
      // aba que nao da para ler nao impede as outras de ensinarem
    }
  }
  return tudo;
}
