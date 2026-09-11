/**
 * Ponte fina com o backend Tauri. Usa o global `window.__TAURI__` injetado pelo
 * runtime desktop (sob `npm run tauri dev` / app empacotado), evitando adicionar
 * a dependencia @tauri-apps/api ao bundle web de desenvolvimento. Fora do Tauri
 * (ex.: vite puro), lanca erro claro — o produto e desktop-only.
 */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function isTauri(): boolean {
  const t = (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
  return !!t;
}

function resolveInvoke(): InvokeFn {
  const t = (globalThis as unknown as {
    __TAURI__?: { core?: { invoke?: InvokeFn }; invoke?: InvokeFn };
  }).__TAURI__;
  const fn = t?.core?.invoke ?? t?.invoke;
  if (!fn) {
    throw new Error(
      "Backend nativo indisponivel. Rode o app com 'npm run tauri dev' (nao pelo navegador).",
    );
  }
  return fn;
}

export async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = resolveInvoke();
  return invoke<T>(cmd, args);
}
