import { RulesRepository, RulesRepositoryLoad } from "../../application/ports";
import {
  RulesFile,
  arquivoVazio,
  sanitizeRulesFile,
  serializeRulesFile,
} from "../../domain/ruleSet";

/**
 * Persistencia das carteiras de regras.
 *
 * O adapter nao sabe ONDE o texto e guardado — so que ha um lugar que le e
 * grava texto por nome. Isso deixa tres coisas de graca:
 *
 *  - o teste roda com `MemoryTextStore`, sem Tauri, sem disco, sem mock de I/O;
 *  - o app funciona fora do Tauri (`npm run dev` no navegador) caindo no
 *    localStorage, entao a tela de Regras pode ser desenvolvida antes de o
 *    backend nativo estar compilado;
 *  - trocar o lugar depois (SQLite junto com o ledger, por exemplo) nao mexe em
 *    nada acima daqui.
 */
export interface TextStore {
  /** `null` quando ainda nao existe — nao e erro, e a primeira vez. */
  read(nome: string): Promise<string | null>;
  write(nome: string, conteudo: string): Promise<void>;
}

/** Nome do arquivo no diretorio de dados do app. */
export const RULES_FILE_NAME = "regras.v1.json";

export class MemoryTextStore implements TextStore {
  private readonly dados = new Map<string, string>();
  constructor(inicial?: Record<string, string>) {
    for (const [k, v] of Object.entries(inicial ?? {})) this.dados.set(k, v);
  }
  async read(nome: string): Promise<string | null> {
    return this.dados.get(nome) ?? null;
  }
  async write(nome: string, conteudo: string): Promise<void> {
    this.dados.set(nome, conteudo);
  }
  /** so para teste: o que ficou gravado. */
  bruto(nome: string): string | null {
    return this.dados.get(nome) ?? null;
  }
}

export class FileRulesRepository implements RulesRepository {
  constructor(
    private readonly store: TextStore,
    private readonly nome: string = RULES_FILE_NAME,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {}

  /**
   * Le e saneia. NUNCA lanca — nem quando o arquivo esta corrompido, nem quando
   * o proprio armazenamento falha. Regra que nao carrega e regra que nao
   * decide, e o app segue; derrubar a tela por causa de um JSON quebrado seria
   * trocar um problema pequeno por um grande.
   */
  async load(): Promise<RulesRepositoryLoad> {
    let cru: string | null;
    try {
      cru = await this.store.read(this.nome);
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(`[regras] falha ao ler ${this.nome}: ${msg}`);
      return { file: arquivoVazio(), avisos: [`nao consegui ler o arquivo de regras (${msg})`] };
    }
    if (cru == null || cru.trim() === "") return { file: arquivoVazio(), avisos: [] };

    let bruto: unknown;
    try {
      bruto = JSON.parse(cru);
    } catch {
      this.logger.warn(`[regras] ${this.nome} nao e JSON valido; comecando vazio.`);
      return {
        file: arquivoVazio(),
        avisos: [
          "o arquivo de regras esta ilegivel e foi ignorado — o arquivo antigo continua no disco",
        ],
      };
    }
    return sanitizeRulesFile(bruto);
  }

  /**
   * Grava. Aqui PODE lancar: o usuario clicou em salvar e precisa saber se a
   * regra que ele acabou de cadastrar sobreviveu.
   */
  async save(file: RulesFile): Promise<void> {
    await this.store.write(this.nome, serializeRulesFile(file));
  }
}
