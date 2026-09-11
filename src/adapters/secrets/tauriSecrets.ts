import { SecretsStore } from "../../application/ports";
import { invokeTauri } from "../tauri/invoke";

/**
 * SecretsStore desktop — delega ao Stronghold (armazenamento seguro criptografado)
 * via comandos Rust. A UI so grava/consulta-presenca/apaga; o valor da key
 * jamais retorna ao WebView.
 */
export class TauriSecretsStore implements SecretsStore {
  async setSecret(key: string, value: string): Promise<void> {
    await invokeTauri<void>("secret_set", { key, value });
  }
  async hasSecret(key: string): Promise<boolean> {
    return invokeTauri<boolean>("secret_has", { key });
  }
  async deleteSecret(key: string): Promise<void> {
    await invokeTauri<void>("secret_delete", { key });
  }
}
