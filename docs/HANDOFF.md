# HANDOFF — Conciliador de Extratos (Fase 2)

> Documento de retomada. Resume tudo que foi feito na Fase 2, o estado atual, os
> problemas em aberto e pistas de diagnóstico. Leia junto de `README.md`,
> `docs/DESIGN.md` e `docs/FASE2-RESUMO.md`.

Data do handoff: 2026-08-15. Projeto: `C:\Users\Ylderlan\Documents\Projetos\conciliador-extratos`.

---

## 1. TL;DR — onde estamos

- **Objetivo da Fase 2:** trocar os parsers determinísticos por **extração via
  IA**, adicionar **tela de Configurações** (API keys + modelo + testar conexão +
  Google Sheets) e **redesenhar** a UI. Desktop-only (Tauri).
- **Feito e verde:** migração para IA (atrás da mesma port `StatementParser`),
  tela de Configurações, cofre de segredos (Windows Credential Manager), redesign
  completo ("Verde-cofre / Livro-caixa"), Google Sheets (código), barra de
  progresso (código). **56 testes determinísticos passando; `tsc` limpo; `vite
  build` OK.**
- **NÃO resolvido (foco da próxima etapa):**
  1. **A barra de loading não apareceu** na tela ao conciliar.
  2. **A estratégia de extração (pipeline por página) não produziu o resultado
     correto.** O gargalo e a causa raiz **ainda não foram identificados**.
- **Decisão pendente:** provavelmente vamos **trocar a abordagem de extração**.
  Ver §6 (hipóteses) e §7 (opções de abordagem).

O que **NÃO** foi tocado (contrato mantido): `domain/`, `application/`
(`partitionByCompetence`, `deduplicate`, `writeToSpreadsheet`, `importStatement`),
o escritor cirúrgico `xlsxSurgical` e o **contrato de layout** (cabeçalho linha
12, colunas B..H, nunca A/E/H).

---

## 2. Arquitetura (o que muda e o que não muda)

Camadas (Clean Architecture) intactas. A extração é um **adapter** por trás da
port `StatementParser` (arquivo bruto → `Transaction[]`). Só o adapter mudou.

```
Extrato (PDF/OFX/CSV/imagem)
  → AiStatementParser (pipeline de IA)         [src/adapters/ai/]
      → TauriAiClient.invoke('ai_complete')     [Rust chama o provedor; key no cofre]
      → valida JSON → Transaction[]
  → partitionByCompetence → deduplicate → backup → xlsxSurgical (B..G) → report/dashboard
                                                     (+ GoogleSheetsTarget, opcional)
```

**Regra de ouro:** a IA **extrai/transcreve**; o **domínio deduplica**
(`ordinalNoDia`). A IA nunca deve deduplicar, mesclar, resumir; e nunca escrever
o SALDO no campo do VALOR da transação.

---

## 3. O que foi implementado (por área)

### 3.1 Motor de IA (TS) — `src/adapters/ai/`
- `aiStatementParser.ts` — implementa `StatementParser`. **Pipeline atual**
  (a rever): (1) **reconhecer** layout num trecho do cabeçalho; (2) **extrair
  por página** (PDF paginado via pdf.js; OFX/CSV em blocos de ~150 linhas;
  imagem = documento nativo); (3) montar `Transaction[]` + **rede de segurança**
  que descarta linhas de saldo. Reporta progresso via `onProgress`.
- `prompts/recognize.ts` — Etapa 1 (instituição, conta, rótulos entrada/saída,
  o que excluir, VALOR × SALDO).
- `prompts/extract.ts` — Etapa 2 (transcreve as transações de UMA página).
- `schema.ts` — validadores `parseRecognitionJson` e
  `parseExtractionTransactions` (erros `bad_schema`, tolera cercas markdown,
  coage números). Transação tem `valor` e `saldoApos` **separados**.
- `providers.ts` — catálogo OpenAI/Anthropic/Gemini (modelos, `supportsDocument`,
  chave do cofre `ai.apikey.<provider>`).
- `tauriAiClient.ts` — chama `ai_complete`/`ai_test_connection` no Rust; traduz
  erros por categoria (`invalid_key`, `rate_limit`, `timeout`, `bad_schema`,
  `network`, `no_key`).

### 3.2 Cofre + Google + PDF + bridge (TS)
- `src/adapters/secrets/tauriSecrets.ts` — `SecretsStore` → Rust.
- `src/adapters/google/tauriGoogle.ts` — connect/status/disconnect.
- `src/adapters/sheets/googleSheetsTarget.ts` — `SpreadsheetTarget` do Sheets
  (só B..H; `sheetIdFromLink`).
- `src/adapters/pdf/pdfText.ts` — `PdfjsTextExtractor` (bundled) com
  `extractPages()` (texto por página).
- `src/adapters/tauri/invoke.ts` — ponte `window.__TAURI__`.

### 3.3 Backend nativo (Rust) — `src-tauri/src/`
- `infra/ai.rs` — chama OpenAI/Anthropic/Gemini (reqwest), lê key do cofre,
  mapeia erros. **OpenAI:** chat completions, `response_format:{type:"json_object"}`,
  `temperature:0`, `max_tokens: 8192` (ping usa 16). PDF vai como
  `{type:"file", file:{file_data:"data:...base64"}}`; imagem como `image_url`.
- `infra/secrets.rs` — Windows Credential Manager via `keyring`.
- `infra/google.rs` — OAuth PKCE (loopback `tiny_http`), refresh, `sheets_append_rows`,
  `sheets_read_existing`.
- `lib.rs` — registra os comandos: `secret_set/has/delete`, `ai_complete`,
  `ai_test_connection`, `google_connect/status/disconnect`, `sheets_append_rows`,
  `sheets_read_existing` (+ os antigos: read/write file, backup, validate_layout).
- `Cargo.toml` — add `reqwest` (sempre, rustls), `keyring` (windows-native),
  `tiny_http`, `urlencoding`; removidos `tauri-plugin-stronghold` e `oauth2`.

### 3.4 UI (TS/React) — redesign "Verde-cofre" + Configurações + progresso
- Tokens em `tailwind.config.js`, base em `src/index.css`, doc em `docs/DESIGN.md`.
  Fontes empacotadas (`@fontsource/*`): Space Grotesk / Public Sans / IBM Plex Mono.
- `src/ui/components/ui.tsx` — kit (Button, Card, SectionTitle c/ "régua de
  conciliação", StatusBadge, EmptyState, DirectionSign).
- Telas: `App.tsx` (header + engrenagem), `screens/Onboarding.tsx`,
  `screens/Main.tsx` (dropzone + erros no tom + **barra de progresso**),
  `screens/Report.tsx`, `screens/Settings.tsx` (**novo**: keys/modelo/testar/Google),
  `components/Dropzone.tsx`, `components/Dashboard.tsx`.
- `src/ui/store.ts` (Zustand) + `src/ui/settings.ts` (prefs NÃO-secretas em
  localStorage; segredos só no cofre). Progresso: `progress` (0..1) +
  `progressLabel`, `setProgress(value,label)`.
- `src/ui/engine.ts` — fia o `AiStatementParser` + `TauriAiClient` +
  `PdfjsTextExtractor`; repassa `onProgress` com rótulos de fase; grava local
  (xlsx) e, se houver `googleSheetId`, também no Sheets.

### 3.5 Removido
- Parsers determinísticos: `stonePdf`, `pagseguroPdf`, `ofx`, `csv`, `router`,
  `positional` (e a pasta `adapters/parsers/`). `pdfWords.ts` virou
  `adapters/pdf/pdfText.ts`.
- Web: `demo.html`, `demoEntry.ts`; `index.html` sem CDN.
- Testes: `parsers.test.ts`, `pdfjs_e2e.test.ts`.

---

## 4. Testes (estado atual)

`npm test` → **56 passam, 3 skipped** (integração), 0 falhas. `tsc --noEmit`
limpo. `vite build` OK.

- `tests/aiParser.test.ts` — pipeline com IA **mockada** (mock responde diferente
  p/ reconhecer vs extrair): mapeamento, VALOR×SALDO, direção, dedup, paginação,
  filtro anti-saldo, erros `bad_schema`.
- `tests/ai.integration.test.ts` — **opcional/manual** (env `AI_INTEGRATION` +
  `OPENAI_API_KEY` + caminhos dos 3 PDFs). Roda o pipeline real contra OpenAI.
  **Ainda não rodado com sucesso confirmado** — ver §6.
- `tests/usecases.test.ts` — orquestrador/domínio, usa fixture congelado
  `tests/fixtures/stone_transactions.json` (358 tx reais). Intactos.
- `domain.test.ts`, `writer.test.ts`, `createWorkbook.test.ts` — intactos.

> **Nota de ambiente:** rodar `npm install` / vitest **direto na pasta do projeto
> montada** corrompeu o `node_modules` algumas vezes (FS de rede). No dev do
> agente, usei uma cópia em disco local (`/tmp`) com `src`/`tests` symlinkados.
> Na máquina Windows do usuário isso não ocorre; se der ruído, `Remove-Item -Recurse
> -Force node_modules; Remove-Item package-lock.json; npm cache clean --force; npm install`.

---

## 5. Como rodar

```powershell
cd C:\Users\Ylderlan\Documents\Projetos\conciliador-extratos
npm install
npm test                 # 56 passed | 3 skipped
npm run tauri dev        # 1ª vez compila o Rust (minutos)
npm run tauri build      # instalador .msi/.nsis
```

No app: engrenagem → OpenAI → cola API key → **Salvar chave** → **Testar
conexão** → volta → solta um extrato → **Conciliar**.

### Percalços já resolvidos (para não repetir)
- Faltava `@tauri-apps/cli` no `package.json` → **adicionado**.
- `tauri-build` exigia `src-tauri/icons/icon.ico` → **gerado** (brasão livro-caixa,
  + PNGs 32/128/256).
- `window.__TAURI__` indisponível → **`app.withGlobalTauri: true`** no
  `tauri.conf.json`.

---

## 6. PROBLEMAS EM ABERTO (o foco agora)

### 6.1 A barra de loading não apareceu
Implementação: `Main.tsx` renderiza `{running && <barra/>}`; `store.progress`
(0..1) + `progressLabel`; `engine.reconcile` chama `onProgress(value,label)` e o
`AiStatementParser` dispara `onProgress` no reconhecimento e a cada página.

Hipóteses a investigar (em ordem de probabilidade):
1. **Bundle desatualizado / HMR não recarregou.** Confirmar que a janela pegou o
   código novo (hard refresh; ou reiniciar `npm run tauri dev`). Um `console.log`
   em `run()` confirma se o código novo está rodando.
2. **A conciliação falhou cedo** (ex.: erro na 1ª chamada), então `running` volta
   a `false` no `catch` e a barra some antes de ser vista. Ver o toast/estado de
   erro em `Main.tsx` (`friendlyError`). Checar `progressLabel` inicial "Iniciando…".
3. **Re-render não ocorreu entre `await`s.** Improvável com Zustand, mas vale
   logar `progress` a cada `setProgress`. Verificar se `setProgress` está sendo
   chamado (breakpoint/console no callback do `engine`).
4. **Exceção síncrona antes do 1º `await`** (ex.: `PdfjsTextExtractor` falha ao
   carregar o worker no WebView). Aí `running=true` foi setado mas a UI pode ter
   ido direto ao `catch`. Ver console da WebView (DevTools do Tauri).

### 6.2 A estratégia de extração (pipeline por página) não rende o resultado certo
Sintoma relatado: "não funcionou da maneira correta". **Causa raiz ainda não
identificada.** Levantar dados concretos antes de trocar de abordagem:

- **O que exatamente está errado?** (a) erro `bad_schema`/timeout, (b) faltam
  transações, (c) sobram (saldo virou transação), (d) valores/direção trocados,
  (e) muito lento. Cada um aponta para uma causa diferente.
- **Ver a resposta crua do modelo.** Hoje o texto do provedor é validado no TS,
  mas não é logado. Sugestão de diagnóstico: logar (temporariamente) o
  `rawResponse` de `ai_complete` e o texto de cada página no console/StdOut do
  Rust, para ver o que o modelo devolve por página.
- **Qualidade do texto por página (pdf.js).** O Stone tem a **contraparte numa
  linha acima** da linha de valor; o `PdfjsTextExtractor.extractPages` agrupa por
  Y e junta por X. Se o agrupamento ficar ruim, o texto que vai pro modelo fica
  embaralhado → extração ruim. **Verificar o texto por página** dumpando
  `extractPages()` num arquivo e conferindo à mão.
- **`response_format: json_object` no OpenAy + `max_tokens 8192` por página**
  deveria evitar truncamento; confirmar que cada página cabe. Se uma página tiver
  muitas transações, ainda pode truncar — considerar lote menor.
- **Reconhecimento sobre `document` (PDF nativo) vs texto.** Quando há `pdfText`,
  o pipeline **não** usa documento nativo (usa texto). Sem `pdfText`, manda o PDF
  inteiro como documento em cada chamada (caro e sem paginação real). Conferir
  qual caminho está sendo tomado.
- **Custo/latência:** 1 reconhecimento + 1 chamada por página. Stone de 23 págs =
  ~24 chamadas → lento. Pode dar sensação de "travado".

### 6.3 Riscos que NÃO foram compilados/validados aqui
- **Todo o Rust** só compila no Windows; não consegui compilar no ambiente do
  agente. Se `npm run tauri dev` acusar erro de compilação, é aqui.
- **Google Sheets** (OAuth + escrita) nunca foi exercitado de verdade.

---

## 7. Opções de abordagem para a extração (a decidir)

Para quando for repensar a estratégia — trade-offs:

1. **Documento nativo, 1 chamada, saída estruturada forte.** Voltar a mandar o
   PDF inteiro como documento e usar **Structured Outputs** do OpenAI
   (`response_format: json_schema`, `strict:true`) — garante o schema e reduz
   `bad_schema`. Risco: truncamento em extratos grandes (muitas transações num
   JSON só) e custo de tokens do doc. Exige alterar `ai.rs` (schema por chamada).
2. **Paginação nativa real.** Dividir o PDF em páginas (no Rust, via um splitter)
   e mandar **cada página como documento nativo** — junta a força da visão com o
   anti-truncamento. Mais trabalho no Rust.
3. **Texto por página + prompt afiado (atual).** Barato e sem truncamento, mas
   depende da qualidade do texto do pdf.js (ver 6.2). Pode melhorar a
   reconstrução de linhas (ordenar/mesclar contraparte+valor) antes de mandar.
4. **Lotes de N páginas** por chamada (meio-termo de custo/latência) com saída
   estruturada.
5. **Híbrido determinístico+IA** (fora do escopo pedido, mas possível): usar IA
   só quando o layout não é reconhecido.

Recomendação para começar o diagnóstico: **logar a resposta crua por página** e
**dumpar o texto de `extractPages()`** de um dos 3 PDFs reais — isso quase certamente
revela se o problema é (a) o texto de entrada ruim, (b) o modelo ignorando o
schema, ou (c) truncamento.

---

## 8. Arquivos-chave (mapa rápido)

Novos (TS): `adapters/ai/{aiStatementParser,schema,providers,tauriAiClient}.ts`,
`adapters/ai/prompts/{recognize,extract}.ts`, `adapters/secrets/tauriSecrets.ts`,
`adapters/google/tauriGoogle.ts`, `adapters/sheets/googleSheetsTarget.ts`,
`adapters/pdf/pdfText.ts`, `adapters/tauri/invoke.ts`, `ui/screens/Settings.tsx`,
`ui/components/ui.tsx`, `ui/settings.ts`.

Novos (Rust): `src-tauri/src/infra/{ai,secrets,google}.rs`.

Alterados: `application/ports.ts` (+SecretsStore/AiClient/AiError/configs),
`ui/{App,store,engine}.tsx/ts`, `ui/screens/{Onboarding,Main,Report}.tsx`,
`ui/components/{Dropzone,Dashboard}.tsx`, `tailwind.config.js`, `index.css`,
`index.html`, `main.tsx`, `package.json`, `tsconfig.json`,
`src-tauri/{Cargo.toml,tauri.conf.json,src/lib.rs,src/infra/mod.rs}`, `README.md`.

Docs: `docs/DESIGN.md`, `docs/FASE2-RESUMO.md`, este `docs/HANDOFF.md`.

Removidos: `src/adapters/parsers/*`, `demo.html`, `src/ui/demoEntry.ts`,
`tests/parsers.test.ts`, `tests/pdfjs_e2e.test.ts`.

---

## 9. Próximos passos sugeridos (ordem)
1. Reproduzir e **capturar dados concretos** do que está errado (§6.2): logar
   resposta crua por página + dump do texto do pdf.js.
2. Consertar a **visibilidade da barra** (§6.1) — provável recarregar bundle /
   erro precoce; confirmar com um `console.log`.
3. Com os dados em mãos, **escolher a abordagem de extração** (§7).
4. Validar o **Rust** compilando (`npm run tauri dev`) e testar `ai_complete`
   real; depois Google Sheets com planilha de teste.
