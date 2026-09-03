import { sha256Hex } from "./sha256";
import { optionKey } from "./listColumns";
import { UserRule, nomeKey, problemasDaRegra } from "./userRules";
import { FlowDirection } from "./houseRules";

/**
 * CARTEIRA DE REGRAS — onde as regras do usuario moram, e de quem elas sao.
 *
 * Uma regra so vale para UMA planilha. "Paulo Valente e salario" e verdade
 * na Cantina Bom Prato e nao quer dizer nada no proximo cliente. Guardar tudo num balde
 * unico faria a regra de um cliente decidir o lancamento de outro — o erro mais
 * caro que esta feature pode cometer, porque acontece calado.
 *
 * Entao: uma CARTEIRA por planilha, e a planilha se identifica sozinha.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMO A PLANILHA E RECONHECIDA — e por que nao e por nome de arquivo.
 *
 * O arquivo troca de nome o tempo todo ("... - atualizado.xlsx"), entao o nome
 * nao serve. A IMPRESSAO e um hash da ESTRUTURA: abas, cabecalhos e a lista de
 * categorias. Isso identifica bem e nao muda quando o cliente lanca uma linha.
 *
 * Mas muda quando ele acrescenta uma categoria — e ai a carteira ficaria orfa,
 * do nada, sem ninguem entender por que as regras "sumiram". Por isso a carteira
 * guarda uma LISTA de impressoes, nao uma so: quando o usuario confirma que
 * aquela e a carteira daquela planilha, a impressao nova entra na lista. E o
 * mesmo mecanismo dos aliases do agente de identidade — o sistema aprende a
 * reconhecer, em vez de exigir que nada nunca mude.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ESTE ARQUIVO E DOMINIO. Nao le disco, nao chama Tauri, nao gera id nem le o
 * relogio: quem muta recebe `agora` e `id` de fora, como o resto do projeto ja
 * faz com a porta `Clock`. Assim o teste e determinista e o arquivo continua
 * puro.
 */

/** Versao do formato em disco. Subir isto exige tratar a migracao em `sanitizeRulesFile`. */
export const RULES_FILE_VERSION = 1;

/** Uma sugestao de regra que o usuario mandou ignorar — nao volta a incomodar. */
export type ChaveSugestao = string;

export interface RuleSet {
  id: string;
  /** nome que o usuario le na tela ("Cantina Bom Prato"). */
  nome: string;
  /** impressoes ja reconhecidas desta planilha (a estrutura muda com o tempo). */
  impressoes: string[];
  regras: UserRule[];
  /** sugestoes dispensadas pelo usuario (chave de sugestao). */
  dispensadas: ChaveSugestao[];
  atualizadoEm: string;
}

export interface RulesFile {
  versao: number;
  carteiras: RuleSet[];
  /** ultima carteira usada — o palpite quando a impressao nao bate. */
  ultimaCarteiraId: string | null;
}

export function arquivoVazio(): RulesFile {
  return { versao: RULES_FILE_VERSION, carteiras: [], ultimaCarteiraId: null };
}

export function carteiraVazia(id: string, nome: string, agora: string): RuleSet {
  return { id, nome, impressoes: [], regras: [], dispensadas: [], atualizadoEm: agora };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Impressao da planilha
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * O minimo que uma planilha precisa expor para ser reconhecida. `WorkbookProfile`
 * satisfaz isto estruturalmente — o dominio nao precisa importar o perfil
 * inteiro so para tirar um hash.
 */
export interface ImpressaoFonte {
  sheetNames: string[];
  columns: { letter: string; header: string }[];
  categories: string[];
}

/**
 * Hash estavel da ESTRUTURA da planilha.
 *
 * Entram: nomes das abas, os cabecalhos por coluna e a lista de categorias —
 * tudo normalizado e ordenado, para que reordenar aba ou trocar acento nao
 * produza uma planilha "nova". NAO entram: numero de linhas, valores, nome do
 * arquivo. Lancar no extrato nao pode mudar a identidade da planilha.
 */
export function impressaoDaPlanilha(fonte: ImpressaoFonte): string {
  const abas = [...fonte.sheetNames].map(optionKey).filter(Boolean).sort();
  const cabecalhos = [...fonte.columns]
    .map((c) => `${c.letter.toUpperCase()}=${optionKey(c.header)}`)
    .sort();
  const cats = [...fonte.categories].map(optionKey).filter(Boolean).sort();
  return sha256Hex([abas.join("|"), cabecalhos.join("|"), cats.join("|")].join("\n"));
}

export type MotivoEscolha =
  /** a impressao desta planilha ja estava na carteira: certeza. */
  | "impressao"
  /** nao bateu; oferecemos a ultima usada para o usuario confirmar. */
  | "ultima"
  /** primeira vez: carteira nova. */
  | "nova";

export interface EscolhaCarteira {
  carteira: RuleSet | null;
  motivo: MotivoEscolha;
}

/**
 * Qual carteira usar para esta planilha.
 *
 * Quando a impressao bate, e certeza e nada precisa ser perguntado. Quando nao
 * bate, NAO adivinhamos: devolvemos a ultima usada com motivo `"ultima"`, e a
 * tela mostra qual carteira esta valendo, com um seletor ao lado. Aplicar regra
 * de outro cliente calado seria o pior desfecho possivel desta feature.
 */
export function escolherCarteira(file: RulesFile, impressao: string): EscolhaCarteira {
  const porImpressao = file.carteiras.find((c) => c.impressoes.includes(impressao));
  if (porImpressao) return { carteira: porImpressao, motivo: "impressao" };

  const ultima = file.carteiras.find((c) => c.id === file.ultimaCarteiraId);
  if (ultima) return { carteira: ultima, motivo: "ultima" };

  return { carteira: null, motivo: "nova" };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Mutacoes — sempre imutaveis, sempre devolvendo um arquivo novo
 * ────────────────────────────────────────────────────────────────────────── */

function tocar(c: RuleSet, agora: string): RuleSet {
  return { ...c, atualizadoEm: agora };
}

function trocarCarteira(file: RulesFile, nova: RuleSet): RulesFile {
  const existe = file.carteiras.some((c) => c.id === nova.id);
  return {
    ...file,
    carteiras: existe
      ? file.carteiras.map((c) => (c.id === nova.id ? nova : c))
      : [...file.carteiras, nova],
  };
}

export function carteiraPorId(file: RulesFile, id: string | null): RuleSet | null {
  if (!id) return null;
  return file.carteiras.find((c) => c.id === id) ?? null;
}

/** Marca a carteira como a que esta em uso e registra a impressao desta planilha. */
export function usarCarteira(
  file: RulesFile,
  carteira: RuleSet,
  impressao: string,
  agora: string,
): RulesFile {
  const impressoes = carteira.impressoes.includes(impressao)
    ? carteira.impressoes
    : [...carteira.impressoes, impressao];
  const nova = tocar({ ...carteira, impressoes }, agora);
  return { ...trocarCarteira(file, nova), ultimaCarteiraId: nova.id };
}

/** Acrescenta ou substitui uma regra (pelo `id`), preservando a ordem. */
export function salvarRegra(carteira: RuleSet, regra: UserRule, agora: string): RuleSet {
  const existe = carteira.regras.some((r) => r.id === regra.id);
  return tocar(
    {
      ...carteira,
      regras: existe
        ? carteira.regras.map((r) => (r.id === regra.id ? regra : r))
        : [...carteira.regras, regra],
    },
    agora,
  );
}

export function removerRegra(carteira: RuleSet, regraId: string, agora: string): RuleSet {
  return tocar({ ...carteira, regras: carteira.regras.filter((r) => r.id !== regraId) }, agora);
}

/**
 * A chave de uma sugestao — direcao + nome, normalizados. E ela que entra em
 * `dispensadas`, entao "ignorar" vale para a pessoa, nao para a descricao
 * exata daquele lancamento.
 */
export function chaveSugestao(direcao: FlowDirection, descricaoOuNome: string): ChaveSugestao {
  return `${direcao}|${nomeKey(descricaoOuNome)}`;
}

export function dispensarSugestao(
  carteira: RuleSet,
  chave: ChaveSugestao,
  agora: string,
): RuleSet {
  if (carteira.dispensadas.includes(chave)) return carteira;
  return tocar({ ...carteira, dispensadas: [...carteira.dispensadas, chave] }, agora);
}

export function foiDispensada(carteira: RuleSet, chave: ChaveSugestao): boolean {
  return carteira.dispensadas.includes(chave);
}

/** As regras que valem agora: ativas e sem problema de validacao (trava 6). */
export function regrasAtivas(carteira: RuleSet | null): UserRule[] {
  if (!carteira) return [];
  return carteira.regras.filter((r) => r.ativo && problemasDaRegra(r).length === 0);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Leitura do disco — desconfiada por profissao
 *
 * O arquivo pode vir de uma versao antiga, ter sido editado a mao, ter vindo
 * pela importacao de outro computador ou simplesmente estar corrompido. Nada
 * disso pode derrubar o app: `sanitizeRulesFile` NUNCA lanca, descarta o que
 * nao entende e devolve a lista do que descartou, para a tela poder avisar.
 *
 * E a mesma postura de `sanitizeSettings` (§3.5): preferencia velha nao trava
 * a instalacao, e saneada.
 * ────────────────────────────────────────────────────────────────────────── */

export interface LeituraRulesFile {
  file: RulesFile;
  avisos: string[];
}

function texto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function listaDeTexto(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function saneiaRegra(bruta: unknown, avisos: string[], ondeIndice: number): UserRule | null {
  if (!bruta || typeof bruta !== "object") {
    avisos.push(`regra #${ondeIndice + 1} ignorada: formato irreconhecivel`);
    return null;
  }
  const r = bruta as Record<string, unknown>;
  const quandoBruto = (r.quando ?? {}) as Record<string, unknown>;
  const faixaBruta = quandoBruto.valorCents as Record<string, unknown> | undefined;

  const faixa =
    faixaBruta && typeof faixaBruta === "object"
      ? {
          ...(typeof faixaBruta.min === "number" ? { min: faixaBruta.min } : {}),
          ...(typeof faixaBruta.max === "number" ? { max: faixaBruta.max } : {}),
        }
      : undefined;

  const direcao = texto(r.direcao);
  const regra: UserRule = {
    id: texto(r.id),
    ativo: r.ativo !== false, // ausente = ligada
    rotulo: texto(r.rotulo) || texto(r.id),
    direcao: (direcao === "entrada" || direcao === "saida" ? direcao : "saida") as FlowDirection,
    quando: {
      ...(texto(quandoBruto.nome) ? { nome: texto(quandoBruto.nome) } : {}),
      ...(listaDeTexto(quandoBruto.contem).length
        ? { contem: listaDeTexto(quandoBruto.contem) }
        : {}),
      ...(faixa && (faixa.min != null || faixa.max != null) ? { valorCents: faixa } : {}),
    },
    ...(listaDeTexto(r.excecoes).length ? { excecoes: listaDeTexto(r.excecoes) } : {}),
    categoriaChave: texto(r.categoriaChave),
    ...(texto(r.contaId) ? { contaId: texto(r.contaId) } : {}),
    ...(listaDeTexto(r.aliasesSim).length ? { aliasesSim: listaDeTexto(r.aliasesSim) } : {}),
    ...(listaDeTexto(r.aliasesNao).length ? { aliasesNao: listaDeTexto(r.aliasesNao) } : {}),
    ...(typeof r.prioridade === "number" ? { prioridade: r.prioridade } : {}),
    origem:
      r.origem === "aprendida" || r.origem === "minerada" || r.origem === "manual"
        ? r.origem
        : "manual",
  };

  if (direcao && direcao !== "entrada" && direcao !== "saida") {
    avisos.push(`regra "${regra.rotulo}" tinha direcao invalida ("${direcao}")`);
  }

  const problemas = problemasDaRegra(regra);
  if (problemas.length > 0) {
    avisos.push(`regra "${regra.rotulo || "sem nome"}" descartada: ${problemas.join("; ")}`);
    return null;
  }
  return regra;
}

/**
 * Le um `RulesFile` de um valor qualquer (tipicamente `JSON.parse` do disco).
 * Nunca lanca. O que nao passa vira aviso, nao excecao.
 */
export function sanitizeRulesFile(bruto: unknown): LeituraRulesFile {
  const avisos: string[] = [];
  if (!bruto || typeof bruto !== "object") {
    return { file: arquivoVazio(), avisos: ["arquivo de regras vazio ou ilegivel"] };
  }
  const f = bruto as Record<string, unknown>;

  const versao = typeof f.versao === "number" ? f.versao : 0;
  if (versao > RULES_FILE_VERSION) {
    avisos.push(
      `o arquivo de regras foi gravado por uma versao mais nova do app (v${versao}); ` +
        `o que este app nao entender sera ignorado`,
    );
  }

  const idsVistos = new Set<string>();
  const carteiras: RuleSet[] = [];
  const brutas = Array.isArray(f.carteiras) ? f.carteiras : [];

  brutas.forEach((cb, i) => {
    if (!cb || typeof cb !== "object") {
      avisos.push(`carteira #${i + 1} ignorada: formato irreconhecivel`);
      return;
    }
    const c = cb as Record<string, unknown>;
    const id = texto(c.id);
    if (!id) {
      avisos.push(`carteira #${i + 1} ignorada: sem identificador`);
      return;
    }
    if (idsVistos.has(id)) {
      avisos.push(`carteira duplicada ignorada (id "${id}")`);
      return;
    }
    idsVistos.add(id);

    const regrasVistas = new Set<string>();
    const regras: UserRule[] = [];
    const rb = Array.isArray(c.regras) ? c.regras : [];
    rb.forEach((x, j) => {
      const regra = saneiaRegra(x, avisos, j);
      if (!regra) return;
      if (regrasVistas.has(regra.id)) {
        avisos.push(`regra duplicada ignorada (id "${regra.id}")`);
        return;
      }
      regrasVistas.add(regra.id);
      regras.push(regra);
    });

    carteiras.push({
      id,
      nome: texto(c.nome) || id,
      impressoes: listaDeTexto(c.impressoes),
      regras,
      dispensadas: listaDeTexto(c.dispensadas),
      atualizadoEm: texto(c.atualizadoEm),
    });
  });

  const ultima = texto(f.ultimaCarteiraId);
  return {
    file: {
      versao: RULES_FILE_VERSION,
      carteiras,
      ultimaCarteiraId: carteiras.some((c) => c.id === ultima) ? ultima : null,
    },
    avisos,
  };
}

/** Serializa para o disco. Indentado de proposito: o arquivo e para ser lido. */
export function serializeRulesFile(file: RulesFile): string {
  return JSON.stringify({ ...file, versao: RULES_FILE_VERSION }, null, 2);
}
