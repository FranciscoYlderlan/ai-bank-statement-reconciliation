import { invokeTauri } from "../tauri/invoke";

/** Cliente da integracao Google (OAuth + status), falando com o backend Rust. */
export interface GoogleAccount {
  email: string;
}
export interface GoogleStatus {
  connected: boolean;
  email: string | null;
}

export const googleClient = {
  /** Abre o navegador para o consentimento OAuth PKCE; resolve com o email. */
  connect(clientId: string, clientSecret?: string): Promise<GoogleAccount> {
    return invokeTauri<GoogleAccount>("google_connect", {
      clientId,
      clientSecret: clientSecret ?? null,
    });
  },
  status(): Promise<GoogleStatus> {
    return invokeTauri<GoogleStatus>("google_status");
  },
  disconnect(): Promise<void> {
    return invokeTauri<void>("google_disconnect");
  },
};
