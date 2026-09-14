# Fase 2 — Resumo das mudanças

Para revisão rápida antes de apresentar ao cliente. Detalhes técnicos no README
(§3–§6) e no sistema de design em `docs/DESIGN.md`.

## O que mudou e por quê

**1. Motor de extração 100% IA (substitui os parsers determinísticos).**
Removidos `stonePdf`, `pagseguroPdf`, `ofx`, `csv`, `router`, `positional`. Toda
extração agora passa por `src/adapters/ai/aiStatementParser.ts`, atrás da **mesma
port `StatementParser`** — a arquitetura não mudou, só o adapter. OFX/CSV também
vão pela IA (decisão de produto: um caminho de manutenção, generaliza para
qualquer banco). PDF vai como **documento nativo** ao provedor; há fallback de
texto (`pdf.js` empacotado) para provedores sem esse suporte.

**2. A IA extrai, o domínio deduplica.** O prompt (`prompts/extraction.ts`,
versionado) obriga a IA a transcrever **todas** as transações na ordem do
arquivo, sem deduplicar/mesclar/resumir, e a excluir não-transações (`Saldo do
dia`, subtotais). A deduplicação segue determinística no domínio (`ordinalNoDia`),
com `temperature 0` para estabilidade. Reimportar o mesmo arquivo → **0 linhas**.

**3. Tela de Configurações.** Por provedor (OpenAI, Anthropic, Gemini): API key
**mascarada** (mostrar/ocultar), **seletor de modelo**, **Testar conexão** (real,
sem reiniciar o app) e **badge de status**. Chaves guardadas no **Windows
Credential Manager** (nunca em texto puro, nem em logs/erros). Seção Google
Sheets: conectar conta (OAuth PKCE) e vincular a planilha de destino.

**4. Redesign profissional — direção "Verde-cofre / Livro-caixa".** Paleta clara
(sem dark mode), tokens documentados em `docs/DESIGN.md` e aplicados no
`tailwind.config.js`. Tipografia deliberada (Space Grotesk / Public Sans / IBM
Plex Mono, empacotadas offline). Entradas/saídas com **cor + sinal** (nunca só
cor), foco de teclado visível, estados de vazio/erro no tom da interface.
Elemento de assinatura: a "linha de conciliação" (régua dupla de livro-caixa) e a
fita de competência.

**5. Testes reorganizados.** As contagens por banco saíram; entraram testes
determinísticos com **IA mockada** (`tests/aiParser.test.ts`) e um teste de
**integração opcional** (key real + os 3 PDFs), gated por env, fora do `npm test`.
As 358 transações reais do Stone foram congeladas em fixture para manter os testes
do orquestrador (T-ROUTE/T-IDEM/T-BACKUP/T-INDEP). **52 testes passando.**

**6. Sem versão web.** Removidos `demo.html` e `demoEntry.ts`; `index.html` sem
CDN (offline-first). O produto roda por `npm run tauri dev`/`build`.

## Não foi tocado (conforme pedido)

`domain/`, `application/` (`partitionByCompetence`, `deduplicate`,
`writeToSpreadsheet`, `importStatement`), o escritor cirúrgico `xlsxSurgical` e o
**contrato de layout** (cabeçalho linha 12, colunas B..H, nunca A/E/H).

## Pontos que exigem validação na sua máquina

- **Backend Rust** (IA, cofre, Google): escrito e revisado, mas compila só no
  Windows (`npm run tauri dev`). Não há como compilá-lo neste ambiente.
- **Google Sheets**: implementado (OAuth PKCE + escrita B..H), porém depende de
  rede + navegador + um OAuth Client do Google Cloud (tipo *Desktop*). Valide
  antes de confiar a escrita à planilha real; o caminho validado por padrão é o
  **.xlsx local**.
