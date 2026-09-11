import { TextStore } from "../repo/rulesRepository";
import { invokeTauri, isTauri } from "./invoke";

/**
 * Onde as regras ficam no desktop: um arquivo no diretorio de dados do app,
 * gravado pelo backend nativo (`store_read` / `store_write`).
 *
 * Por que nao localStorage, que seria uma linha: localStorage e por ORIGEM. A
 * §3.5 ja custou caro por isso — em dev funcionava, na build instalada nascia
 * limpo. Regra de negocio do cliente nao pode evaporar numa reinstalacao. Um
 * arquivo tambem pode ser copiado, versionado e mandado por WhatsApp, que e
 * como o suporte de verdade acontece aqui.
 *
 * A escrita e ATOMICA no lado Rust (grava `.tmp` e renomeia): uma queda de luz
 * no meio do salvamento nao pode deixar um JSON pela metade — seria perder a
 * carteira inteira para gravar uma regra.
 */
export class TauriTextStore implements TextStore {
  async read(nome: string): Promise<string | null> {
    return invokeTauri<string | null>("store_read", { nome });
  }
  async write(nome: string, conteudo: string): Promise<void> {
    await invokeTauri<void>("store_write", { nome, conteudo });
  }
}

/**
 * Fallback para quando NAO ha backend nativo (`npm run dev` no navegador puro).
 * Serve para desenvolver a tela de Regras sem subir o Tauri; nao e o caminho de
 * producao, e por isso avisa no console em vez de fingir que esta tudo igual.
 */
export class LocalStorageTextStore implements TextStore {
  private readonly prefixo = "conciliador.arquivo.";
  async read(nome: string): Promise<string | null> {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(this.prefixo + nome);
  }
  async write(nome: string, conteudo: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.prefixo + nome, conteudo);
  }
}

/** O armazenamento certo para o ambiente em que o app esta rodando. */
export function createTextStore(logger: Pick<Console, "warn"> = console): TextStore {
  if (isTauri()) return new TauriTextStore();
  logger.warn(
    "[regras] backend nativo indisponivel — as regras vao para o storage do navegador, " +
      "que e por origem e some na build instalada. Rode com 'npm run tauri dev'.",
  );
  return new LocalStorageTextStore();
}
