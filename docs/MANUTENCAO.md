# Manutenção — Conciliador Automático de Extratos Bancários

Documento de referência para quem vai **manter ou evoluir** o sistema: decisões
de projeto, mapa completo de arquivos e caminhos, pipeline detalhado, estratégia
de testes, roadmap e limitações conhecidas.

Para **instalar e executar**, veja o [README](../README.md).

> **Sobre a numeração.** As seções mantêm os números do README original (§2 a §6)
> porque o texto tem dezenas de referências cruzadas entre elas (`§3.1`, `§3.4`,
> `§3.8`…). A antiga §1 — Início rápido — é a única que não está aqui: ela virou
> o README.

## Índice

- [Decisões que moldaram o sistema](#decisões-que-moldaram-o-sistema)
- [2. Mapa completo de arquivos e caminhos](#2-mapa-completo-de-arquivos-e-caminhos)
- [3. Como o sistema funciona (pipeline)](#3-como-o-sistema-funciona-pipeline)
- [4. Testes](#4-testes)
- [5. Roadmap](#5-roadmap)
- [6. Limitações conhecidas](#6-limitações-conhecidas)

---

## Decisões que moldaram o sistema

Cada bloco abaixo registra um problema real encontrado sobre os arquivos do
cliente e a regra que nasceu dele. Funcionam como resumo executivo das seções 3.x.

> **Um estágio, um prompt.** Cada tarefa da IA tem prompt próprio e schema
> próprio: reconhecer o layout do extrato, transcrever transações, ler a
> estrutura da planilha de destino, entender as listas suspensas, decidir quais
> colunas são calculadas, classificar categorias. Prompts que faziam várias
> coisas ao mesmo tempo degradavam todas elas — o modelo começava a ajustar a
> descrição para caber na categoria que tinha escolhido. Ao acrescentar
> capacidade nova, **crie um estágio novo** em vez de engordar um existente.

> **A linha que o sistema insere tem de nascer igual às que o usuário digitou.**
> Foi o que faltava na v1.0.1: o writer gravava data, descrição e valor e parava
> aí. `Fluxo de Caixa` e `Saldo` são **calculadas** — a linha nova nascia sem a
> fórmula e ficava em branco para sempre; e `Categoria` é **preenchida por
> listagem** — o sistema não sabia que a coluna tinha uma lista, nem que a lista
> exige a grafia literal (`"Salário "`, com o espaço no fim, não é `"Salário"`).
> Ver §3.1 e §3.2.

> **A linha nova entra pela DATA, não pelo fim da lista.** Gravar sempre na
> primeira linha vazia só parece certo enquanto a aba está em ordem crescente —
> ali o fim da lista é mesmo o lugar da data mais recente. Numa aba
> **decrescente** o fim é a data mais ANTIGA, e foi assim que lançamentos de 15 a
> 31 de setembro foram parar embaixo do dia 1º: o padrão tinha sido reconhecido e
> ignorado na hora de escrever. Agora a análise diz se a aba sobe ou desce (aba a
> aba, não só a planilha inteira) e o writer **encaixa** cada lançamento onde a
> data dele pede — no começo, no meio ou no fim. Ver §3.6.

> **Determinístico quando dá para provar; empírico quando não dá.** A IA lê
> layout que ninguém programou — e cobra por isso em latência e variabilidade:
> duas execuções podem discordar. Um extrato cujo formato é conhecido *e que
> traga como conferir a leitura* não precisa disso. O PagBank traz: as linhas
> `Saldo do dia` são um fecho de caixa por data, e a soma dos lançamentos tem de
> explicar exatamente a variação do saldo. Fechou, a leitura está **provada** e
> nenhuma chamada é feita; não fechou, o resultado inteiro é descartado e a IA
> assume. Um parser que erra em silêncio é pior que não ter parser — o erro dele
> parece certeza. Ver §3.4.

> **O mesmo extrato, em quatro arquivos, tem de dar no mesmo lugar.** O cliente
> baixa o mês em CSV, XLS, OFX ou PDF, e até a v1.0.2 só o PDF tinha caminho
> próprio: o CSV e o OFX iam inteiros para a IA — que transcreve por página e
> às vezes **perde lançamento** —, e o `.xls` era pior, porque ele não é um .xls:
> é um **.xlsx com a extensão antiga**, e os bytes do ZIP eram decodificados
> como texto e mandados ao modelo virados em lixo. Os três agora são lidos por
> código, e cada um traz a própria prova: no CSV/planilha, `saldo antes + valor
> − tarifa = saldo depois` em **toda** linha, mais os saldos encadeando de ponta
> a ponta do arquivo — é o encadeamento que prova que **nenhuma linha foi
> pulada**; no OFX, todo registro `<STMTTRN>` declarado tem de virar lançamento,
> sem sobra. Ver §3.7.

> **A linha vazia que o Excel autofecha — e o escritor que perdia linha calado.**
> O Excel grava uma linha sem conteúdo como `<row r="462" ht="13.2"/>`: um
> elemento AUTOFECHADO. Ele existe, então o writer o dava por pronto — mas
> `upsertCellInRow`, para inserir a primeira célula de uma linha, procura
> `</row>`, que ali **não existe**. O `replace` não casava nada e a célula era
> descartada **sem erro nenhum**. Na planilha real, `JULHO` tem linhas de
> verdade até a 454 e autofechadas dali para baixo: gravar 305 lançamentos numa
> aba que já tinha 219 exigia ir até a linha 536, e os 75 que passavam da
> fronteira sumiam. O relatório dizia "305 inseridos" e a planilha recebia 230.
> **É a mesma queixa do cliente — "a planilha ignorou alguns registros" — pelo
> lado da ESCRITA**, e ela só apareceu quando a leitura determinística passou a
> entregar volume suficiente para cruzar a fronteira. Ver T-LINHA-VAZIA.

> **Duas leituras, e a prova decide.** A IA deixou de ser só o plano B: ela roda
> **em paralelo** com o parser determinístico e serve de testemunha. A regra de
> decisão é fixa, e não é "ganha quem trouxer mais lançamentos" — esse critério
> premiaria exatamente o defeito mais caro, o lançamento que o modelo INVENTA.
> **Vence quem tem prova**: leitura determinística que fechou a conferência é
> verificável, a da IA é apenas plausível. Se a IA discordar, a discordância vai
> para o relatório lançamento a lançamento, em vez de mudar o resultado em
> silêncio. E quando a prova já fechou, a testemunha lê só uma **amostra** —
> custo fixo, que não cresce com o tamanho do extrato. Ver §3.8.

> **A tarifa é um lançamento, não um detalhe da linha.** O mesmo extrato conta a
> tarifa de três jeitos: o PDF dá uma linha a ela, o CSV/XLS a põem numa coluna
> da linha da venda, e o OFX já entrega o valor líquido (R$ 25,00 com R$ 0,24 de
> tarifa viram R$ 24,76). Como a planilha do cliente tem `Taxa de cartão` e a
> regra da casa manda toda saída de tarifa para lá, a leitura canônica é a do
> PDF: no CSV e na planilha, cada tarifa cobrada vira uma **saída própria**. No
> OFX não dá — o valor bruto não está no arquivo —, e é por isso que o mesmo mês
> rende 315 lançamentos em PDF/CSV/XLS e 277 em OFX. O relatório avisa. Ver §3.7.

---

## 2. Mapa completo de arquivos e caminhos

> Raiz: `C:\Users\Ylderlan\Documents\Projetos\conciliador-extratos\`

### 2.1 Raiz do projeto

| Caminho | Função |
|---|---|
| `README.md` | Visão geral, instalação e execução. |
| `docs\MANUTENCAO.md` | **Este documento** — decisões de projeto, mapa de arquivos, pipeline, testes, roadmap e limitações. |
| `docs\comparativo-formatos.html` | **Comparação medida dos quatro formatos** sobre os arquivos reais do cliente: lançamentos, tarifa, prova de cada um, custo de IA e a recomendação. Gerada na Fase 2.6. |
| `docs\DESIGN.md` | **Sistema de design** "Verde-cofre / Livro-caixa" (tokens de cor, tipografia, layout, elemento de assinatura). |
| `docs\FASE2-RESUMO.md` | Resumo da migração para o motor de IA. |
| `docs\HANDOFF.md` | Notas de passagem de bastão. |
| `package.json` | Dependências e scripts (`dev`, `build`, `test`, `tauri`). |
| `index.html` | Entrada do app React. |
| `vite.config.ts` | Config do Vite (porta 1420 para o Tauri). |
| `vitest.config.ts` | Config dos testes (Vitest, ambiente node). |
| `tsconfig.json` | Config do TypeScript (strict). |
| `tailwind.config.js` | Tema do TailwindCSS. |
| `postcss.config.js` | Pipeline PostCSS (tailwind + autoprefixer). |
| `.gitignore` | Ignora `node_modules/`, `dist/`, `src-tauri/target/`, `backups/`. |

### 2.2 `src\domain\` — Entidades (regras de negócio puras, sem I/O)

| Caminho | Função |
|---|---|
| `src\domain\money.ts` | `Money` em **centavos inteiros** (nunca float) + parse de `R$ 1.234,56` / `- R$ 24,00`. |
| `src\domain\dateptbr.ts` | Datas pt-BR (`dd/mm/aa`→2026), serial do Excel, faixa de período. |
| `src\domain\dateOrder.ts` | **Ordem das datas e encaixe.** `detectDateOrder` diz se uma sequência sobe, desce ou não tem padrão — com a evidência junto (quantos pares concordaram); `combineDateOrder` soma a evidência de várias abas; `planInsertion` devolve a sequência final com cada lançamento novo no lugar que a data dele pede. Puro, sem I/O. |
| `src\domain\competence.ts` | `Competence` (mês/ano) + resolver `mês → aba` (`7 → JULHO`) + abas de apoio. |
| `src\domain\transaction.ts` | `Transaction` (valor absoluto + direção) e **hash de dedup** com `ordinalNoDia`. |
| `src\domain\normalize.ts` | Normalização de descrição e **chave de contraparte** (tira sufixo societário e o tipo do lançamento) — usada para PAREAR, não para decidir duplicata. |
| `src\domain\sha256.ts` | SHA-256 puro e síncrono (funciona em node e navegador). |
| `src\domain\accountRef.ts` | **Identidade da conta** (instituição + número → `id` estável). Fica no domínio porque o `id` entra no hash de dedup: o parser determinístico e a extração por IA têm de chegar na MESMA conta, senão reimportar o arquivo pelo outro caminho duplicaria tudo. |
| `src\domain\category.ts` | As 37 categorias reais da aba `Categorias` + classe de fluxo (usadas na planilha nova). |
| `src\domain\layout.ts` | **Contrato de layout** da aba (cabeçalho linha 12, colunas B..H, E/H com fórmula) + as colunas de listagem e as calculadas que viajam até o writer. |
| `src\domain\houseRules.ts` | **Regras da casa**: o que o ramo decide sem precisar de julgamento — entrada por Pix/maquininha/antecipação é recebimento de venda; saída de tarifa bancária é taxa de cartão. Determinístico, sempre atrelado à direção e à lista real da planilha. |
| `src\domain\listColumns.ts` | **Colunas preenchidas por listagem** (dropdown): opções na grafia EXATA da planilha, regra de uso por opção, e o casamento tolerante (`matchOption`) que devolve sempre a string do arquivo. |
| `src\domain\formulaColumns.ts` | **Colunas preenchidas por fórmula**: a fórmula-modelo, de que linha veio, e `translateFormula` — a transposição de referências relativas, a mesma semântica de arrastar a fórmula para baixo no Excel. |
| `src\domain\workbookProfile.ts` | **Perfil da planilha de destino**: papel de cada coluna, o que cada uma recebe, estilo das descrições já gravadas, categorias válidas, colunas de listagem e colunas calculadas. Converte-se em `SheetRowLayout` e no bloco de contexto dos prompts. |

### 2.3 `src\application\` — Use Cases (dependem só de *ports*)

| Caminho | Função |
|---|---|
| `src\application\ports.ts` | Interfaces (ports): `StatementParser`, `SpreadsheetTarget`, `LedgerRepository`, `BackupService`, `Clock`, `SecretsStore`, `AiClient`, `AiError`, configs de provedor. |
| `src\application\partitionByCompetence.ts` | Agrupa transações por competência e resolve a aba de destino. |
| `src\application\deduplicate.ts` | Novos × duplicados. Identidade = data + valor + direção + ordem; casa contra o ledger **e contra as linhas que já estão na aba**, por consumo. |
| `src\application\writeToSpreadsheet.ts` | Converte para linhas de planilha (só as colunas graváveis do layout). |
| `src\application\importStatement.ts` | **Orquestrador**: parse → particiona → dedup → backup → escreve local/Sheets → relatório. |
| `src\application\report.ts` | Modelo do relatório de importação (por competência), incluindo as **observações da gravação** (`avisos`). |
| `src\application\dashboard.ts` | Balanço mensal (entradas, saídas, saldo acumulado) — alimenta os gráficos. |

### 2.4 `src\adapters\` — Adaptadores (implementam as ports)

| Caminho | Função |
|---|---|
| `src\adapters\parsers\fileKind.ts` | **Que arquivo é este** — decidido pelos BYTES, nunca pela extensão (o `.xls` da Stone é um .xlsx) — e `decodeText`, que escolhe a codificação pelo CONTEÚDO (o OFX da Stone declara `CHARSET:1252` e vem em UTF-8). |
| `src\adapters\parsers\csvTable.ts` | **CSV/TSV → matriz de texto**: separador detectado fora das aspas, campos entre aspas com vírgula decimal dentro. Não sabe nada de banco. |
| `src\adapters\parsers\xlsxTable.ts` | **Planilha OOXML → matriz de texto**: primeira aba, `sharedStrings` e `inlineStr`, célula posicionada pela REFERÊNCIA (célula ausente não desloca a linha) e serial de data já formatado. |
| `src\adapters\parsers\tabularStatement.ts` | **Parser determinístico do extrato TABULAR** (CSV e planilha): descrição no padrão da planilha (`Pix - NOME`), tarifa como lançamento próprio, e a dupla conferência — aritmética de cada linha e encadeamento dos saldos. Não lança. |
| `src\adapters\parsers\ofxStatement.ts` | **Parser determinístico OFX** 1.x (SGML) e 2.x (XML): conta de `BANKACCTFROM`, `STMTTRN` → lançamento, conferência por CONTAGEM (todo registro declarado vira lançamento, nada sobra) e o aviso do valor já líquido de tarifa. |
| `src\adapters\parsers\arbitrate.ts` | **Arbitragem entre as duas leituras** (§3.8): mede a confiança de cada uma, escolhe (prova vence sempre) e CRUZA os dois conjuntos por data+valor+direção, devolvendo a divergência lançamento a lançamento. Nunca mistura os dois resultados. |
| `src\adapters\parsers\hybrid.ts` | **Roteador de leitura**: identifica o tipo do arquivo pelos bytes, tenta o layout conhecido daquele tipo e só aceita o resultado quando o parser CONFERIU a própria leitura; caso contrário entrega o arquivo à IA. O `.xls` antigo (BIFF/OLE2) para aqui, com a frase que resolve. Traz também o `MemoPageTextExtractor`, que evita renderizar o mesmo PDF duas vezes. |
| `src\adapters\parsers\pagbankPdf.ts` | **Parser determinístico PagBank/PagSeguro**: uma linha por lançamento, sinal negativo = saída, e a **cadeia de `Saldo do dia`** como conferência. Não lança — devolve as transações mais a auditoria e as linhas não lidas, para o roteador decidir. |
| `src\adapters\ai\aiStatementParser.ts` | **Motor de extração via IA** (pipeline) — o caminho empírico, usado quando nenhum layout conhecido se aplica. Reconhece → extrai por página (em paralelo, com retry e subdivisão em truncamento) → agrega com as redes de segurança → mapeia 1:1 para `Transaction`. |
| `src\adapters\ai\workbookProfiler.ts` | **Estágio -1**: monta o perfil da planilha de destino. Determinístico primeiro; só chama IA quando a estrutura foge do conhecido. Expõe também `refineColumnRules` (estágios -1b/-1c). Nunca lança — no pior caso devolve o perfil padrão com aviso. |
| `src\adapters\ai\listColumnAnalyzer.ts` | **Estágio -1b**: regras das colunas por listagem. O uso já gravado na planilha vira regra de graça (`orientacaoFromUsage`); a IA só acrescenta as dicas que os exemplos não dão. Opção fora da lista é descartada. |
| `src\adapters\ai\formulaColumnAnalyzer.ts` | **Estágio -1c**: decide quais colunas calculadas são repetidas em toda linha nova. Coluna acumulada e coluna com fórmula em quase toda linha se resolvem sem IA; só o meio-termo vira chamada. |
| `src\adapters\ai\aiCategorizer.ts` | **Estágio de categorização**: agrupa por descrição, classifica em lotes, valida contra a lista da planilha, **grava a grafia exata da planilha** e nunca derruba a conciliação. |
| `src\adapters\ai\prompts\recognize.ts` | **Prompt 1 — reconhecimento**: identifica instituição, conta e o "guia de leitura" (rótulos entrada/saída, o que excluir, VALOR × SALDO, posição da contraparte). |
| `src\adapters\ai\prompts\extract.ts` | **Prompt 2 — extração**: transcreve as transações de UMA partição por vez, com linhas numeradas e âncora de linha. Recebe o **contrato de destino** para escrever a descrição no padrão da planilha. |
| `src\adapters\ai\prompts\profileWorkbook.ts` | **Prompt 3 — perfil da planilha**: dado o dump da estrutura, diz o papel de cada coluna e o que cada uma recebe. Não extrai nem classifica. |
| `src\adapters\ai\prompts\categorize.ts` | **Prompt 4 — categorização**: dada a lista de categorias reais da planilha (entre aspas, para o espaço no fim ficar visível), escolhe uma por lançamento (ou `null`). |
| `src\adapters\ai\prompts\listColumns.ts` | **Prompt 5 — regras de listagem**: dada uma coluna de dropdown, suas opções e o uso real já gravado, diz QUANDO cada opção se aplica. Não classifica lançamento nenhum. |
| `src\adapters\ai\prompts\formulaColumns.ts` | **Prompt 6 — colunas calculadas**: dada a lista de colunas com fórmula, diz quais devem ser repetidas em toda linha nova e se dependem da linha anterior. Não reescreve fórmula. |
| `src\adapters\ai\schema.ts` | Contratos + validadores das seis etapas (erros `bad_schema`, tolera cercas ```` ```json ````, coage valores) + JSON Schemas para Structured Outputs. |
| `src\adapters\ai\providers.ts` | Catálogo de provedores (OpenAI/Anthropic/Gemini), modelos e chave do cofre. **Invariante:** o modelo padrão tem de existir no catálogo — `assertProvidersConsistent` e `resolveModel` travam a regressão que fazia a tela mostrar um modelo e o app chamar outro (§3.5). |
| `src\adapters\ai\tauriAiClient.ts` | Cliente que chama o backend Rust (`ai_complete`/`ai_test_connection`); a key nunca entra no WebView. |
| `src\adapters\writers\xlsxSurgical.ts` | **Escritor XLSX cirúrgico**: **encaixa a linha nova pela data** (§3.6) sem tocar em fórmulas/merges/dropdown; **repete as fórmulas da coluna na linha nova**; **garante formato de data** na célula que recebe o serial; estende o intervalo do dropdown; lê os lançamentos existentes (fonte de verdade do dedup); poda as fórmulas das linhas vazias **da planilha gerada por nós** (`finalizeGeneratedTemplate`); auto-ajusta larguras; serializa com progresso. |
| `src\adapters\writers\inspectValidations.ts` | **Detecção das colunas por listagem**: lê `<dataValidation type="list">` nas duas formas que o Excel grava (clássica e x14 dentro de `<extLst>`), resolve a origem das opções (intervalo em outra aba ou lista inline) e infere listagem por conteúdo quando não há validação formal. Também estende o `sqref` ao escrever abaixo dele. |
| `src\adapters\writers\inspectFormulas.ts` | **Detecção das colunas calculadas**: resolve fórmula compartilhada (`t="shared" si="N"`), escolhe a fórmula-modelo, separa o caso da primeira linha e consolida o modelo entre abas. |
| `src\adapters\writers\inspectWorkbook.ts` | **Inspeção determinística** do `.xlsx`: abas, linha de cabeçalho, papel provável de cada coluna, formatos, fórmulas, colunas de listagem, categorias, amostras do conteúdo real e a **ordem das datas de cada aba**. Sem IA, sem custo. |
| `src\adapters\writers\numberFormats.ts` | Formatos numéricos do `styles.xml`: decide se um estilo **exibe** data ou dinheiro, e `ensureDateStyle` **garante** um — clonando o estilo herdado com `numFmtId=14` quando ele não serve. É o que impede o usuário ver `46201` no lugar da data. |
| `src\adapters\writers\columnWidths.ts` | Medida de largura por conteúdo e reescrita do elemento `<cols>` (modo "só alarga"). |
| `src\adapters\writers\createWorkbook.ts` | Gera planilha **nova do zero** no padrão Cantina Bom Prato, já com larguras de coluna. Nasce com `E`/`H` pré-preenchidas em todo o range; as das linhas que ficaram vazias são podadas depois de gravar. |
| `src\adapters\writers\xmlCells.ts` | Utilitários de edição cirúrgica de XML (OOXML), incluindo a leitura ÚNICA da data de uma célula (`plainDateFromCell`) e o transporte de uma célula inteira para outra linha (`retargetCell`) — o que permite realocar um lançamento sem reinterpretá-lo. |
| `src\adapters\secrets\tauriSecrets.ts` | `SecretsStore` → Windows Credential Manager (via Rust). |
| `src\adapters\google\tauriGoogle.ts` | Cliente OAuth Google (connect/status/disconnect). |
| `src\adapters\sheets\googleSheetsTarget.ts` | `SpreadsheetTarget` do Google Sheets (só B..H, respeita o contrato de layout). |
| `src\adapters\pdf\pdfText.ts` | Extrator de **texto** de PDF (pdf.js empacotado) — pagina a extração, alimenta o reconhecimento de layout e serve de fallback. Entrega ao pdf.js uma **cópia** dos bytes: `getDocument` transfere o ArrayBuffer para o worker e deixaria o arquivo do usuário desanexado. |
| `src\adapters\tauri\invoke.ts` | Ponte fina com o backend nativo (`window.__TAURI__`). |
| `src\adapters\repo\memoryLedger.ts` | Ledger em memória (no desktop vira SQLite). |
| `src\adapters\backup.ts` | Backup imutável antes de escrever + relógio do sistema. |

### 2.5 `src\ui\` — Frontend React

| Caminho | Função |
|---|---|
| `src\main.tsx` | Bootstrap do React. |
| `src\index.css` | Tailwind base. |
| `src\ui\App.tsx` | Fluxo de telas. |
| `src\ui\store.ts` | Estado global (Zustand). Guarda o **serializador** do xlsx (não os bytes), o estado por partição da extração e a **estratégia de leitura** usada. |
| `src\ui\engine.ts` | Fiação do motor no WebView: perfil → **roteamento de leitura** → extração → categorização → conciliação → auto-ajuste → serialização sob demanda. |
| `src\ui\download.ts` | Entrega do arquivo + hook `useDownload` (estados preparando/concluído/erro e progresso real). |
| `src\ui\components\Dropzone.tsx` | Área de arrastar-e-soltar. |
| `src\ui\components\Dashboard.tsx` | Gráficos (recharts): entradas × saídas e saldo acumulado. |
| `src\ui\components\ui.tsx` | Kit de UI (Button, Card, SectionTitle, StatusBadge, `ProgressBar`, `DownloadButton`…). |
| `src\ui\screens\Onboarding.tsx` | Passos iniciais: status da IA + planilha local + contrato de layout. |
| `src\ui\screens\Main.tsx` | Soltar o extrato + disparo da conciliação, com erros no tom da interface. |
| `src\ui\screens\Report.tsx` | KPIs, **painel “Extrato lido”** (leitura direta × IA, com o motivo da recusa quando houver), **painel do perfil da planilha**, dashboard, tabela por competência e download com progresso. |
| `src\ui\screens\Settings.tsx` | **Configurações**: API keys por provedor (mascarada, modelo, testar conexão, status) + Google Sheets. |
| `src\ui\settings.ts` | Preferências NÃO-secretas persistidas (localStorage). Segredos ficam no cofre. **Saneia na leitura**: preferência apontando para um modelo fora do catálogo volta ao padrão do provedor (§3.5). |

### 2.6 `tests\` — Testes (TDD) e fixtures

| Caminho | Testes | Função |
|---|---|---|
| `tests\domain.test.ts` | 19 | Money/datas/competência/hash/sha256/dedup. |
| `tests\aiParser.test.ts` | 26 | Pipeline de IA: paralelismo, retry, truncamento, âncora de linha e auditoria da cadeia de saldo. |
| `tests\pagbankPdf.test.ts` | 20 | **T-DIRETO**: leitura determinística do extrato real, conferência pela cadeia de saldo (lançamento faltando/duplicado/linha estranha reprovam) e o roteamento determinístico → IA. |
| `tests\tabularStatement.test.ts` | 45 | **T-TIPO / T-TABULAR / T-PADRÃO / T-ROTA**: o tipo do arquivo vindo dos bytes (o `.xls` que é xlsx, o `.xls` antigo recusado, acento em UTF-8 e em 1252), o CSV brasileiro (vírgula decimal entre aspas, `;` do Excel pt-BR), a dupla conferência sobre o extrato real, a tarifa como lançamento próprio, e as cinco maneiras de reprovar (linha faltando, duplicada, valor adulterado, tarifa ignorada, sentido contraditório). |
| `tests\arbitrate.test.ts` | 19 | **T-ARBITRAGEM**: a prova vence mesmo com a IA trazendo mais lançamentos; a divergência nunca é silenciada; sem prova a IA assume; a testemunha que estoura não derruba a leitura provada; o cruzamento ignora a descrição, respeita a contagem, exclui as tarifas derivadas e encolhe a janela da amostra para não dar alarme falso nas pontas. |
| `tests\ofxStatement.test.ts` | 25 | **T-OFX**: as duas gramáticas do formato (1.x com folha aberta, 2.x fechada), a conferência por contagem, o `MEMO` virando `Método - NOME`, o aviso do valor já líquido e as recusas (bloco sem data, `TRNTYPE` contra o sinal, marcação estranha na lista, data fora do período). |
| `tests\pdfBytes.test.ts` | 4 | **T-BYTES**: o pdf.js roda de verdade e o arquivo do usuário sobrevive à leitura (nada de ArrayBuffer desanexado). |
| `tests\dateOrder.test.ts` | 28 | **T-ORDEM / T-ENCAIXE**: identificação do padrão de datas (com empates, com um lançamento fora de ordem, com abas que discordam) e a inserção no começo, no meio e no fim — inclusive sobre a planilha real, onde `MAIO` desce e `JUNHO` sobe. |
| `tests\dateFormat.test.ts` | 13 | **T-FORMATO**: a data gravada aparece como data em qualquer célula, inclusive quando o destino tem estilo Geral; e o estilo criado não duplica a cada execução. |
| `tests\providers.test.ts` | 9 | **T-MODELO**: o modelo escolhido nas Configurações é o modelo chamado; default sempre dentro do catálogo; preferência velha é saneada. |
| `tests\usecases.test.ts` | 12 | T-ROUTE, T-IDEM, T-BACKUP, T-INDEP, T-NOFORMULA. |
| `tests\dedupExisting.test.ts` | 19 | **T-IDEM-BASE** e **T-DATA**: dedup contra as linhas já gravadas, identidade por valor+data+direção e gravação da data no formato da aba. |
| `tests\workbookProfile.test.ts` | 11 | Inspeção determinística, perfil por IA quando diverge, contrato de destino, ordem das datas por aba. |
| `tests\columnWidths.test.ts` | 10 | Medida por conteúdo, `<cols>`, modo "só alarga", preservação (T-PRES). |
| `tests\categorize.test.ts` | 10 | Agrupamento por descrição, validação contra a lista, tolerância a falha. |
| `tests\houseRules.test.ts` | 24 | **T-CASA**: as regras do ramo sobre as descrições reais do cliente, as exceções que as desligam, o critério que autoriza uma regra de saída, e a integração com o categorizador (custo zero, sobrevive à falha do provedor, ganha do modelo). |
| `tests\descriptionStyle.test.ts` | 3 | Os exemplos de descrição vêm da coluna certa e da aba mais recente. |
| `tests\listColumns.test.ts` | 25 | **T-GRAFIA**: opção gravada com a grafia exata da planilha (`"Salário "`). Detecção da validação nas duas formas, resolução do intervalo de origem, inferência por conteúdo, regra deduzida do uso e extensão do `sqref`. |
| `tests\formulaColumns.test.ts` | 32 | **T-FORMULA**: transposição de referências, fórmula compartilhada, modelo que não se generaliza, perpetuação na linha nova e recálculo na abertura. |
| `tests\writer.test.ts` | 8 | **T-PRES**: preserva fórmulas, dropdown e merges. **T-LINHA-VAZIA**: gravar ALÉM da última linha materializada da aba — a linha autofechada é aberta antes de receber célula, e nenhuma linha se perde em silêncio. |
| `tests\createWorkbook.test.ts` | 3 | Planilha nova + round-trip. |
| `tests\arquivosReais.test.ts` | — (gated) | **Conferência ponta a ponta sobre os SEUS arquivos**: aponte `EXTRATOS_DIR` para uma pasta de extratos e cada um é lido pelo roteador de produção, gravado numa cópia da planilha, reaberto e conferido — inclusive a idempotência. Fora do `npm test` porque os arquivos trazem nomes reais. |
| `tests\ai.integration.test.ts` | 3 (skip) | Integração real com o provedor (gated por env). |
| `tests\mocks.ts` | — | Mocks das ports para os use cases. |
| `tests\fixtures\template_bomprato.xlsx` | — | Cópia da planilha real (base de T-PRES e do perfil). |
| `tests\fixtures\stone_transactions.json` | — | As 358 transações reais do Stone, congeladas na migração para IA. |
| `tests\fixtures\pagseguro_lines.json` | — | Linhas do extrato PagSeguro (anonimizado). |
| `tests\fixtures\pagbank_pages.json` | — | Texto por página que o pdf.js produz para um extrato PagBank real de 2 páginas — base do parser determinístico. |
| `tests\fixtures\stone_extrato.csv` | — | Recorte de 16 linhas do extrato Stone real (agosto/2026), nomes trocados e documentos mascarados. **Valores e saldos são os do original**, porque é sobre eles que a conferência roda; o recorte é contíguo para que a corrente feche. Três linhas cobram tarifa → 19 lançamentos. |
| `tests\fixtures\stone_extrato.ofx` | — | As MESMAS 16 movimentações em OFX 1.x, como a Stone entrega: cabeçalho dizendo 1252 com conteúdo em UTF-8, e o valor da maquininha já líquido da tarifa (por isso 16, e não 19). |
| `tests\fixtures\expected_counts.json` | — | Contagens esperadas (asserções-âncora). |

### 2.7 `src-tauri\` — Casca desktop (Rust)

| Caminho | Função |
|---|---|
| `src-tauri\Cargo.toml` | Dependências Rust (tauri v2, plugins, rust_decimal, sha2, zip, rusqlite, windows). |
| `src-tauri\tauri.conf.json` | Config do app (janela, CSP, bundle .msi/.nsis). |
| `src-tauri\build.rs` | Build script do Tauri. |
| `src-tauri\capabilities\default.json` | Permissões (dialog, fs, notification, store). |
| `src-tauri\src\main.rs` | Entrada fina (chama `run()`). |
| `src-tauri\src\lib.rs` | **Wiring + comandos nativos**: ler/gravar arquivo, backup, validar layout, **segredos** (`secret_*`), **IA** (`ai_complete`/`ai_test_connection`), **Google** (`google_*`, `sheets_*`). |
| `src-tauri\src\infra\ai.rs` | **Motor de IA**: chama OpenAI/Anthropic/Gemini (reqwest), lê a key do cofre, mapeia erros por categoria. A key nunca sai do nativo. |
| `src-tauri\src\infra\secrets.rs` | **Cofre de segredos** via Windows Credential Manager (keyring). Sem senha-mestra. |
| `src-tauri\src\infra\google.rs` | **OAuth PKCE** (loopback) + escrita/leitura no Google Sheets. |
| `src-tauri\src\domain\` | Domínio espelhado em Rust (`money.rs`, `competence.rs`, `layout.rs`, `transaction.rs`) com testes. |
| `src-tauri\src\application\ports.rs` | Traits (ports) em Rust. |
| `src-tauri\src\infra\backup.rs` | Backup imutável no disco (`backups\`). |
| `src-tauri\src\infra\xlsx_inspect.rs` | Leitura leve do `.xlsx` (nomes de aba + cabeçalho) para validação. |
| `src-tauri\src\infra\com_excel.rs` | Esqueleto do writer via COM automation do Excel (Windows-only). |

### 2.8 `exemplos\` — Saídas geradas para conferência

| Caminho | Função |
|---|---|
| `exemplos\Fluxo_BomPrato_atualizado.xlsx` | Planilha real após conciliar um CSV multi-mês (JULHO:3, AGOSTO:2). |
| `exemplos\Planilha_nova_padrao_BomPrato.xlsx` | Planilha nova gerada do zero no padrão. |

### 2.9 Caminhos gerados em tempo de execução (não versionados)

| Caminho | Quando aparece |
|---|---|
| `node_modules\` | Após `npm install`. |
| `dist\` | Após `npm run build`. |
| `src-tauri\target\release\bundle\` | Instalador após `npm run tauri build`. |
| `<pasta da planilha>\backups\` | Backup imutável criado antes de cada escrita (T-BACKUP). |

---

## 3. Como o sistema funciona (pipeline)

```
Planilha de destino (.xlsx do usuário, opcional)
   │  ESTÁGIO -1 — PERFIL                      (inspectWorkbook → workbookProfiler)
   │  inspeção local (sem custo): abas, cabeçalho, papel de cada coluna,
   │  fórmulas, colunas de listagem, categorias válidas, estilo das descrições
   │  → só chama IA se a estrutura fugir do conhecido (prompts/profileWorkbook)
   │
   │  ESTÁGIO -1b — REGRAS DE LISTAGEM         (listColumnAnalyzer)
   │  quais colunas têm dropdown, quais opções elas aceitam (grafia EXATA) e
   │  quando cada opção se aplica — o uso já gravado responde de graça; a IA
   │  (prompts/listColumns) só explica o que os exemplos não explicam
   │
   │  ESTÁGIO -1c — COLUNAS CALCULADAS         (formulaColumnAnalyzer)
   │  quais colunas são fórmula e quais têm de ser REPETIDAS em toda linha nova;
   │  acumulada e "fórmula em quase toda linha" se resolvem sem IA, só o
   │  meio-termo vai para o prompt (prompts/formulaColumns)
   │
   │  ESTÁGIO -1d — ORDEM DAS DATAS            (domain/dateOrder, sem IA)
   │  a aba sobe ou desce? conta os pares consecutivos da coluna de data, ABA A
   │  ABA, e guarda a evidência (quantos concordaram). Sem evidência suficiente,
   │  "indefinida" — e o writer volta a empilhar no fim, como antes
   ▼
   perfil → layout de escrita (colunas graváveis + listas + fórmulas)
          + "contrato de destino" para os próximos agentes

Extrato (PDF/CSV/XLS/XLSX/OFX/imagem)
   │  ESTÁGIO 0a — ROTEAR a leitura                    (parsers/hybrid)
   │  QUE arquivo é este? decidido pelos BYTES         (parsers/fileKind)
   │  e depois: este layout é conhecido E conferível?
   │
   ├─ CSV / planilha, com saldo antes e depois  → parsers/tabularStatement, sem IA
   │     `antes + valor − tarifa = depois` em TODA linha + saldos encadeados de
   │     ponta a ponta; tarifa cobrada vira SAÍDA própria; qualquer desvio,
   │     linha ilegível ou sentido que contradiga o sinal, DESCARTA tudo
   │
   ├─ OFX 1.x/2.x                               → parsers/ofxStatement, sem IA
   │     todo `<STMTTRN>` declarado tem de virar lançamento, nada pode sobrar
   │     dentro de `<BANKTRANLIST>` e nenhuma data pode cair fora do período
   │
   ├─ PDF do PagBank, e a leitura se CONFERE    → parsers/pagbankPdf, sem IA
   │     regex linha a linha + cadeia de `Saldo do dia`; se algum dia não fechar,
   │     se sobrar linha ilegível ou houver data fora do período, DESCARTA tudo
   │
   ├─ .xls ANTIGO (BIFF/OLE2)                   → PARA AQUI, com explicação
   │     binário que nem código nem IA leem: "salve como .xlsx" resolve
   │
   └─ NÃO (ou a conferência falhou)         → caminho empírico:
      │  ESTÁGIO 0 — RECONHECER o layout do extrato   (prompts/recognize)
      │  ESTÁGIO 1 — PARTICIONAR localmente (sem IA)
      │  ESTÁGIO 2 — EXTRAIR por página, em paralelo  (prompts/extract + contrato de destino)
      │  ESTÁGIO 3 — AGREGAR + redes de segurança     (âncora de linha, cadeia de saldo)
   │
   │  ESTÁGIO 0b — CONFERIR com a segunda via         (parsers/arbitrate)
   │  a IA relê o arquivo em paralelo — AMOSTRA de 3 blocos quando a prova já
   │  fechou, arquivo inteiro quando não fechou — e as duas leituras são
   │  CRUZADAS por data+valor+direção. A prova vence sempre; a divergência vai
   │  para o relatório. Confirmada pela testemunha, a leitura sobe de
   │  "provada" para "corroborada". A IA que estoura não derruba a prova.
   ▼
   ESTÁGIO 4 — CATEGORIZAR                            (prompts/categorize)
   ├─ REGRAS DA CASA primeiro, sem IA                  (domain/houseRules)
   │    ENTRADA por Pix/maquininha/antecipação → recebimento de venda
   │    SAÍDA de tarifa bancária                → taxa de cartão
   │    (só quando a planilha tem a categoria; a direção sempre manda)
   └─ o que sobra: agrupa por descrição, classifica em lotes contra a lista REAL
      e grava a opção com a GRAFIA da planilha (regras do estágio -1b)
   ▼
particiona por competência (mês/ano da própria transação)  (partitionByCompetence)
   ▼
Por competência:
   ├─ dedup contra o ledger + as linhas JÁ GRAVADAS na aba (fonte de verdade)
   ├─ BACKUP imutável antes de escrever                    (T-BACKUP)
   ├─ ENCAIXA cada linha pela data, na ordem que a aba pratica  (T-ENCAIXE)
   │     começo / meio / fim; os lançamentos abaixo do encaixe descem
   │     (nunca escreve VALOR nas colunas com fórmula, merges ou dropdown)
   │     a célula de data recebe um estilo que EXIBE data, sempre  (T-FORMATO)
   ├─ PERPETUA as fórmulas da coluna na linha nova         (T-FORMULA)
   │     modelo transposto para a linha de destino; nunca sobrescreve fórmula
   ├─ ESTENDE o intervalo do dropdown até a última linha gravada
   └─ registra ledger + relatório (+ observações da gravação)
   ▼
se a planilha foi GERADA por nós: poda as fórmulas das linhas que ficaram vazias
   ▼
auto-ajuste das larguras de coluna (modo "só alarga")
   ▼
marca a pasta para RECALCULAR ao abrir (fullCalcOnLoad)
   ▼
Dashboard mensal + download com progresso real (serialização sob demanda)
```

### 3.1 A coluna Categoria — por que ficava vazia

A coluna `Categoria` não é uma coluna de texto: é uma coluna **preenchida por
listagem**. O `.xlsx` diz isso explicitamente, e o sistema não estava lendo:

```xml
<dataValidation type="list" sqref="D13:D254">
  <formula1>Categorias!$A:$A</formula1>
</dataValidation>
```

Faltavam duas coisas, e as duas foram resolvidas:

**Faltava saber que a coluna tem lista.** Não existia nenhuma etapa que olhasse
a validação de dados. Agora existe (`inspectValidations.ts`), e ela lê as **duas**
formas que o Excel grava: a clássica, com `sqref` no atributo, e a x14 dentro de
`<extLst>` — que é justamente a que o Excel usa quando a lista mora em outra aba.
Resolvido o intervalo, a ligação fica explícita: *a coluna D aceita estes 37
valores, que vêm da aba `Categorias`*. Quando não há validação formal, uma coluna
de texto em que poucos valores se repetem muito também é reconhecida como
listagem — é o que faz o sistema funcionar em planilhas que não são a Cantina Bom Prato.

**Faltava respeitar a grafia.** Havia um `.trim()` na leitura das categorias.
Parece inofensivo e não é: na planilha real duas categorias têm um espaço
sobrando no fim — `"Salário "` e `"Empréstimos "`. Aparadas, elas deixam de ser
o texto que está na aba `Categorias`, e aí:

- o `VLOOKUP` da coluna `Fluxo de Caixa` não encontra nada → a coluna fica vazia
  **mesmo com a categoria correta escolhida**;
- a validação da célula passa a recusar o valor.

Agora a opção viaja da planilha até a célula **byte a byte**. A normalização
(sem acento, sem caixa, sem espaço) existe só para *casar* a resposta do modelo
com a opção real — nunca para decidir o que será gravado. O modelo pode responder
`salario`; o que vai para a célula é `"Salário "`.

O estágio -1b acrescenta a camada de qualidade: em vez de entregar ao
classificador uma lista nua de 37 nomes, entrega a lista **com a regra de uso de
cada opção**, deduzida do que a própria planilha já fez (`Taxa Ifood` só aparece
em saída; `Recebimento de venda` só em entrada) e complementada por um prompt
dedicado. É o que impede o modelo de redefinir o critério a cada lote e mandar a
mesma despesa para categorias diferentes em páginas diferentes do extrato.

### 3.2 As colunas Fluxo de Caixa e Saldo — por que a fórmula "sumia"

Elas não sumiam. **A linha inserida nunca as teve.**

`E` (Fluxo de Caixa) é `VLOOKUP` da categoria na aba `Categorias`; `H` (Saldo) é
o saldo corrente, `H(anterior) + F - G`. Enquanto quem digita é o usuário, o
Excel copia essas fórmulas para baixo sozinho. Quando quem escreve é o writer,
ninguém copia — ele gravava `B`, `C`, `D`, `F`, `G` e parava. A célula ficava
vazia para sempre e a corrente do saldo se interrompia dali para a frente.

Agora o writer **perpetua o padrão da coluna** na linha que ele mesmo criou:

- **Detecta** as colunas calculadas (`inspectFormulas.ts`), resolvendo antes a
  *fórmula compartilhada* — o Excel grava a fórmula uma vez
  (`<f t="shared" ref="H14:H77" si="0">H13+F14-G14</f>`) e nas demais linhas
  deixa só o ponteiro (`<f t="shared" si="0"/>`). Quem lê só o texto de `<f>`
  conclui, erradamente, que as outras linhas não têm fórmula.
- **Transpõe** o modelo para a linha de destino com a mesma semântica de
  arrastar a fórmula para baixo (`translateFormula`): referência relativa anda
  com a linha, referência travada com `$` não anda, texto entre aspas fica
  intacto e nome de função não é confundido com referência (`LOG10(` continua
  `LOG10(`).
- **Nunca sobrescreve** fórmula existente. A da planilha é soberana — é o que
  mantém T-PRES valendo.
- **Grava sem valor em cache** e marca a pasta com `fullCalcOnLoad="1"`,
  descartando `calcChain.xml`. Quem calcula é o Excel, na abertura. Chutar o
  valor seria inventar dado — e os valores em cache das linhas de baixo ficam
  desatualizados assim que uma linha é inserida, então o recálculo é necessário
  de qualquer forma.

Dois cuidados que só apareceram testando contra o arquivo real:

- **A primeira linha de dados é diferente.** Numa coluna acumulada ela não
  aponta para a linha de cima (que é cabeçalho) e sim para a célula do saldo
  inicial: `G7+F13-G13`. Esse modelo **não se generaliza** — arrastado para a
  linha 300 viraria `G294+F300-G300`, um número tirado do meio do cabeçalho. Ele
  fica guardado à parte e só vale quando o destino é, de fato, a primeira linha.
  `isGeneralizable` é a fronteira: uma fórmula só vira modelo da coluna se nunca
  alcançar acima da linha imediatamente anterior.
- **Abas diferentes ensinam coisas diferentes.** Na planilha real, `JULHO` e
  `AGOSTO` têm fórmula até a linha 254; em `JUNHO` a de saldo para na 113; em
  `JANEIRO` não há nenhuma. A aba de destino tem a última palavra, mas quando
  ela não ensina nada vale o modelo consolidado das abas irmãs — senão gravar
  em `JANEIRO` continuaria deixando o saldo em branco.

Por fim, o intervalo do dropdown também é estendido: gravar na linha 260 de uma
aba cuja validação vai até a 254 produzia uma célula com o texto certo e **sem**
a lista suspensa.

Uma coisa o sistema deliberadamente **não** conserta: se a linha imediatamente
acima já estava sem saldo (um lançamento que alguém deixou pela metade), a
fórmula acumulada da linha nova recomeça a soma dali. Mexer numa linha que o
usuário não mandou mexer é exatamente o que o contrato de escrita cirúrgica
proíbe — então o relatório **avisa**, nomeando a aba e a linha.

### 3.3 As regras da casa — o que não precisa ir a julgamento

Há decisões de categoria que não dependem de interpretar o lançamento: elas
seguem do **ramo**. Num comércio que vende no balcão, o dinheiro entra quase
sempre pelo mesmo caminho, e a tarifa que o banco cobra é sempre a mesma linha.
Isso não é palpite — é o que a planilha do cliente já pratica, nas seis abas
preenchidas:

| regra | evidência na planilha |
|---|---|
| ENTRADA por Pix, maquininha, cartão ou antecipação → `Recebimento de venda` | 294 de 296 entradas |
| SAÍDA de tarifa bancária → `Taxa de cartão` | 24 de 24 lançamentos de `Tarifa` |

Enquanto isso ficava só no julgamento do modelo, saía errado de dois jeitos:
lançamento **sem categoria nenhuma** (em dúvida, o modelo devolve `null`, que é
a resposta segura) e lançamento **na categoria errada**. Como a regra é estável e
o dono do negócio a enunciou, ela passou a ser decidida no domínio, antes da
chamada. O modelo continua decidindo tudo o que sobra — e recebe as mesmas
regras no prompt, para não contrariá-las nos casos de fronteira.

#### Quando uma SAÍDA pode virar regra — o critério, não o gosto

A entrada de um comércio é monótona: quase todo dinheiro que entra é venda. A
saída, no geral, **não** tem padrão — e o próprio arquivo prova. Na aba `JUNHO` a
descrição `Pix - NOME` **saindo** aparece como `Motoboys`, `Troco e devolução`,
`Retirada socios`, `Salário ` e `Fornecedor`: cinco categorias, o mesmo texto.

Mas o que quebra ali não é *ser saída* — é a descrição **nomear a contraparte**
em vez da despesa. `Pix - Wanda Lemos` diz por onde o dinheiro saiu e para quem,
e não diz nada sobre o que foi pago. Já `Tarifa bancária` nomeia a **própria
despesa**: não há contraparte para interpretar, o texto já é a resposta.

> **Critério:** uma regra de saída só é legítima quando o gatilho é o **nome da
> despesa**. Gatilho que casa com meio de pagamento, nome de pessoa ou de empresa
> não vira regra de saída — vai para o classificador, que é quem lê contexto bem.

**Quatro travas, e as quatro importam:**

1. **A direção é parte da regra.** O mesmo texto pode ter regra num sentido e
   nenhuma no outro: `Pix - NOME` entrando é venda; saindo, não é nada.
2. **A categoria é sempre a da planilha.** O que a regra devolve é uma string que
   já existe na lista do arquivo, com a grafia dele. Se a planilha do usuário não
   tem nada equivalente, a regra simplesmente não se aplica — é isso que a mantém
   inofensiva em planilhas de outros ramos.
3. **Toda regra tem exceção, e ela é explícita.** Aporte, empréstimo, estorno,
   devolução, reembolso, resgate e transferência entre contas próprias também
   chegam por Pix; `Taxa Ifood` também tem a palavra taxa. Nesses casos a regra
   se cala e quem decide é o classificador.
4. **Não se inventa generalidade.** `tarifa` é regra; `taxa` sozinha não — na
   própria planilha, `taxa são joão vila embratel` está lançada como
   `Investimento`. A regra cobre o que os dados sustentam, e nada além.

**Validação:** as regras foram replayadas sobre os **384 lançamentos reais** já
classificados pelo cliente — 296 entradas e 88 saídas. Decidiram 64 entradas e 23
saídas, com **zero conflitos** contra o que ele havia escolhido. As entradas não
cobertas são das abas antigas, cuja descrição é só o nome da pessoa, sem o
`Pix -` na frente; em `JUNHO`, que já usa a convenção atual, a cobertura das
entradas é de 64 em 64.

Efeito colateral bem-vindo: num extrato de comércio a maioria das linhas é
venda, e cada uma tem um nome diferente — ou seja, elas não se agrupam. Decidir
essas antes corta a maior parte do que iria para o provedor. Um extrato só de
Pix e maquininha **não chega a fazer uma chamada**.

#### O padrão de escrita que alimenta a regra

Para a regra disparar, a descrição gravada precisa dizer `Pix - NOME`. Duas
coisas impediam isso, e as duas foram corrigidas junto:

- **A coluna de exemplos era escolhida por palpite.** Pegávamos "a coluna de
  texto mais preenchida", e nesta planilha isso é a coluna **Data** — que guarda
  `31/05/2026` como texto e tem mais células preenchidas que a descrição. O
  prompt de extração recebia cinco datas como "exemplos de descrição" e não
  aprendia padrão nenhum. Agora a coluna vem do **papel**, não do palpite.
- **A amostra vinha da aba com mais linhas, não da mais recente.** A convenção de
  uma planilha viva muda com o tempo: aqui as abas antigas trazem só o nome da
  pessoa e a última traz `Pix - NOME` / `Maquininha - NOME`. Quem dita o padrão é
  o que o cliente escreve **hoje**.

### 3.4 Leitura determinística — e a prova que a autoriza

O extrato PagBank/PagSeguro não precisa de modelo: cada lançamento ocupa **uma
linha**, no formato `dd/mm/aaaa <descrição> R$ 0,00`, e a saída vem com sinal
negativo. Ler isso com IA é pagar latência e variabilidade por um trabalho que
uma regex faz sem errar.

Só que "uma regex resolve" não basta para confiar. O que autoriza a leitura
direta aqui é o extrato **trazer a própria conferência**: as linhas `Saldo do
dia` são um fecho de caixa por data. Elas não viram lançamento — viram prova. A
soma dos lançamentos de um dia tem de explicar exatamente a diferença entre o
saldo daquele dia e o do dia anterior. Fechando em todos os dias, a extração
está *provadamente* completa: nem um lançamento a mais, nem um a menos — que são
justamente os dois erros que a leitura por IA custa caro para evitar.

O critério de aceitação é deliberadamente severo. A leitura direta só vale se:

- a cadeia de saldo fechou em **todos** os dias conferíveis;
- **nenhuma** linha da tabela ficou sem interpretação;
- nenhuma data caiu **fora do período** declarado no cabeçalho.

Qualquer desvio e o resultado inteiro é descartado — não se costura metade regex
com metade IA. O relatório mostra qual caminho leu o arquivo e, quando a leitura
direta foi recusada, o motivo.

**Limite conhecido:** os lançamentos do **primeiro dia** do extrato não entram na
conferência. O saldo daquele dia é o primeiro elo da corrente e não tem com o
que ser comparado; ele só estabelece o ponto de partida. Do segundo dia em
diante, todo lançamento está coberto.

> **Por que o Stone continua na IA.** Lá a contraparte fica na linha *acima* da
> linha do valor e não há saldo do dia para conferir. Sem uma prova como a do
> PagBank, um parser determinístico seria só um palpite com cara de certeza — e
> é exatamente esse o erro que não queremos.

Uma diferença que vale saber: o parser direto transcreve a descrição **como o
banco escreveu** (`Pix recebido - Bumba Acai`), enquanto a IA a reescreve no
padrão que aprendeu da planilha. Como a descrição entra no hash de dedup,
reimportar pelo outro caminho um extrato que já entrou pode gerar duplicata. A
**conta** é a mesma nos dois caminhos, por construção (`domain/accountRef.ts`).

### 3.5 O modelo escolhido nas Configurações é o modelo chamado

Um `<select>` cujo `value` não corresponde a nenhuma `<option>` não dá erro: o
navegador exibe a **primeira opção**. O padrão do provedor OpenAI era `gpt-4o`,
que não estava na lista de modelos — então a tela mostrava o primeiro modelo do
catálogo enquanto o estado guardava `gpt-4o`. Como o campo já parecia certo,
ninguém disparava `onChange`, nada era salvo, e o backend recebia `gpt-4o`
obedientemente. Em dev funcionava porque o dropdown tinha sido mexido em algum
momento; na build não, porque `localStorage` é por origem e a instalada nasce
limpa.

Três travas, e as três valem:

1. **O padrão do provedor tem de existir no catálogo** — `assertProvidersConsistent`
   é chamado pelos testes e falha se alguém quebrar a regra de novo.
2. **A preferência é saneada na leitura.** Modelo fora do catálogo (gravado por
   uma versão antiga) volta ao padrão e é regravado normalizado — é isso que
   desentala uma instalação que já está no ar.
3. **Tela e chamada leem a mesma fonte.** `aiConfig` é derivado das preferências
   e é o que aparece na badge da tela principal e o que vai para o Rust. Não
   existe caminho em que um diga uma coisa e o outro faça outra.

### 3.6 A ordem das datas — e a inserção por encaixe

O defeito que chegou do cliente: a aba de setembro já tinha os dias **19 a 1**,
nessa ordem (decrescente). Chegaram lançamentos novos de **15 a 31**. O sistema
percebeu que a aba descia — ordenou os novos de 31 para 15 — e então grudou esse
bloco inteiro **embaixo do dia 1º**. Ordenar sem encaixar não conserta nada: a
planilha ficou com 19…1, 31…15.

Eram dois problemas somados, e os dois foram tratados.

**1. O padrão passou a ser identificado por aba, com evidência.**
`domain/dateOrder.ts` olha os pares consecutivos da coluna de data e conta
quantos sobem e quantos descem. Três regras evitam tanto o chute quanto o
falso-negativo:

- **empate não vota.** Uma aba com trinta lançamentos no dia 31 e depois no dia
  30 tem 29 empates e 1 comparação — é essa 1 que informa;
- **exige-se um mínimo de evidência** (3 pares comparáveis) e **75% de
  concordância**. Um lançamento antigo digitado fora de ordem não derruba o
  padrão; uma aba de fato bagunçada não vira ordem nenhuma;
- **sem evidência, `indefinida`** — e aí o writer faz exatamente o que sempre
  fez: empilha no fim, na ordem em que veio. Inventar uma ordem para uma aba que
  não tem seria pior que não ter feature.

A leitura é feita **aba a aba**, e não só para a planilha inteira, porque a
planilha real *não tem uma ordem só*: na `template_bomprato.xlsx`, `MAIO` desce
(31 → 09) e `JUNHO` sobe. Somar tudo daria "indefinida" — verdade sobre o
arquivo, e inútil na hora de escrever. Por isso a hierarquia na hora de gravar é:
**(1)** as datas da própria aba de destino, **(2)** a leitura que a análise fez
daquela aba, **(3)** o costume da planilha inteira (é o que um mês ainda vazio
herda). `resolveSheetDateOrder` implementa essa ordem.

**2. A escrita deixou de ser "próxima linha vazia" e passou a ser encaixe.**
`planInsertion` recebe a sequência que já está na aba e a lista de lançamentos
novos e devolve a sequência final — cada um no lugar que a data dele pede, no
começo, no meio ou no fim. Duas regras fixas:

- a **ordem relativa do que já estava gravado nunca muda**. O usuário digitou
  aquilo; reordenar o trabalho dele não é papel do sistema;
- **empate de data resolve a favor de quem já estava**: o lançamento novo entra
  *depois* do bloco daquela data.

**Como o encaixe acontece dentro do `.xlsx`.** Um arquivo OOXML não tem "inserir
linha": deslocar linhas de verdade significaria renumerar `<row>`, mexer em
merges, no `sqref` da validação, na formatação condicional e em toda fórmula que
aponta para baixo — exatamente o oposto do contrato de escrita cirúrgica. O que
o writer faz é o equivalente seguro: as **células graváveis** (B, C, D, F, G) dos
lançamentos que ficam abaixo do encaixe são **realocadas** para as linhas
seguintes, transportadas byte a byte (`retargetCell`) — valor, tipo e estilo
viajam juntos, nada é reinterpretado no caminho. Nenhuma linha é criada ou
removida dentro do bloco; as fórmulas de `E`/`H`, os merges e o dropdown ficam
onde estão, e cada fórmula continua valendo para a **sua** linha, porque as
referências são relativas à linha em que moram.

Três garantias que sustentam isso:

- **nada acima do ponto de encaixe é tocado.** Quando os lançamentos novos são
  todos mais recentes (o caso comum numa aba crescente), o resultado é
  literalmente o de antes: append puro, sem reescrever a aba;
- **a linha de destino é limpa antes de receber conteúdo.** Sem isso, a categoria
  do lançamento anterior sobreviveria embaixo do novo quando o novo vem sem
  categoria;
- **toda linha que passa a ter dados nasce com as fórmulas da coluna**
  (`perpetuateFormulas`), inclusive a que só recebeu um lançamento realocado —
  ela pode ser uma linha que antes estava vazia e nunca teve fórmula.

O saldo acumulado (`H`) é recalculado pelo Excel na abertura
(`fullCalcOnLoad`): encaixar no meio muda o acumulado de tudo o que está abaixo,
e valor em cache seria valor errado.

O relatório mostra a ordem detectada por aba, e a gravação avisa quando houve
realocação — mover linhas do usuário é o tipo de coisa que ele tem o direito de
saber que aconteceu.

**Limite conhecido:** o encaixe vale para a planilha **.xlsx local**. A escrita no
**Google Sheets** continua sendo append no fim da aba — a API é outra e o
encaixe lá precisa de `batchUpdate` com inserção de linhas.

### 3.7 Os quatro formatos do mesmo extrato

O defeito que chegou do cliente: **a planilha ignorou alguns registros**. O
arquivo importado era o PDF, e o diagnóstico não estava no writer — estava na
leitura. O PDF da Stone não tem caminho determinístico (§3.4), então ele vai
para a IA, que transcreve **por página**: 20 páginas, uma chamada cada, e cada
chamada é uma chance de o modelo pular uma linha. As redes de segurança pegam
lançamento **a mais**; lançamento **a menos** é justamente o que elas não
alcançam.

O mesmo mês, porém, o banco oferece em quatro arquivos — e três deles **se
autoconferem**. Era o caminho barato que estava fechado:

| arquivo | como estava | como está |
|---|---|---|
| PDF | IA (20 chamadas) | IA (20 chamadas) — sem prova, continua empírico |
| CSV | IA (blocos de 150 linhas) | **leitura direta, provada** |
| XLS | IA recebendo **binário virado em lixo** | **leitura direta, provada** |
| OFX | IA (blocos de 150 linhas) | **leitura direta, provada** |

#### O `.xls` que não é um `.xls`

O arquivo que a Stone entrega com extensão `.xls` é, por dentro, um **`.xlsx`**
— um ZIP OOXML. Isso não era um detalhe cosmético: `detectKind` classificava
qualquer coisa que não fosse PDF nem imagem como **texto**, decodificava os
bytes do ZIP como UTF-8 e mandava o resultado — páginas de símbolos — para o
modelo transcrever. Agora o tipo do arquivo vem dos **bytes**
(`parsers/fileKind.ts`), nunca da extensão, e o `.xls` de verdade (BIFF/OLE2) é
**reconhecido para ser recusado** com uma frase que resolve o problema em um
clique, em vez de virar prompt.

A mesma lógica vale para a codificação: o OFX da Stone declara `CHARSET:1252` no
cabeçalho e vem em **UTF-8**. Obedecer ao cabeçalho trocava todo acento por
lixo — `Transferência` virava `TransferÃªncia` — e essa sujeira ia parar na
descrição gravada na planilha. `decodeText` decide pelo conteúdo: UTF-8 em modo
estrito primeiro, Windows-1252 só quando o UTF-8 é impossível.

#### A prova do extrato tabular (CSV e planilha)

É mais forte que a do PagBank, que só fecha uma vez por dia. Cada linha declara
`Saldo antes` e `Saldo depois`, então há **duas conferências independentes**:

1. **A aritmética da linha** — `antes + valor − tarifa = depois`. Valor lido
   errado, sinal trocado ou tarifa ignorada: a linha denuncia sozinha.
2. **O encadeamento** — o `depois` de uma linha é o `antes` da vizinha, do
   começo ao fim do arquivo. É isto que prova que **nenhuma linha foi pulada**:
   um lançamento faltando abre um buraco na corrente, e um lançamento repetido
   também. A corrente é testada nos **dois sentidos**, porque a Stone entrega do
   mais recente para o mais antigo e um arquivo reexportado pode vir ao
   contrário.

Sobre o extrato real de agosto: **277 linhas conferidas, 276 elos, zero
divergências**. E a cobertura é total — diferente do PagBank, aqui até o
primeiro lançamento do arquivo entra na conferência, porque ele traz o próprio
saldo anterior.

O critério de aceitação é o mesmo de sempre, e deliberadamente severo: uma linha
que não fecha, um elo rompido, uma linha ilegível ou um `Movimentação` que
contradiga o sinal do valor **descartam o resultado inteiro** e a IA assume.

#### A prova do OFX é a contagem

O OFX não declara saldo por lançamento — só o `LEDGERBAL` final —, e sem saldo
inicial não há corrente para fechar. Em compensação ele é um formato de troca
entre sistemas: cada lançamento é um registro **delimitado**, e isso permite uma
checagem que nenhum PDF permitiria — **contar**. Exigimos que todo `<STMTTRN>`
do arquivo vire exatamente um lançamento, que nenhum bloco fique sem data ou
valor, que nada sobre dentro de `<BANKTRANLIST>` que o parser não tenha
interpretado, e que nenhuma data caia fora de `DTSTART`/`DTEND`. É a prova que o
formato permite, e ela é honesta sobre o que cobre.

#### A tarifa, e por que os números não batem entre os formatos

O mesmo extrato conta a tarifa de três jeitos, e isso muda a **contagem**:

| formato | movimentações | a tarifa aparece como |
|---|---|---|
| PDF | 315 | linha própria (`Tarifa`, saída) |
| CSV / XLS | 277 linhas → **315 lançamentos** | coluna `Tarifa` na linha da venda |
| OFX | **277** | embutida: R$ 25,00 − R$ 0,24 = R$ 24,76 |

A leitura canônica é a do PDF, e a razão é da planilha, não do arquivo: a aba
`Categorias` tem `Taxa de cartão`, e a regra da casa manda toda saída de tarifa
para lá (§3.3). Uma tarifa escondida numa coluna nunca chegaria a essa
categoria. Por isso o parser tabular emite **dois** lançamentos para a linha que
cobra tarifa: a venda pelo valor cheio e a tarifa como saída.

No OFX isso **não é possível** — o valor bruto simplesmente não está no arquivo.
É limite do formato, não decisão nossa, e o relatório diz isso na cara do
usuário, no painel "Extrato lido". **Consequência prática:** importar o mesmo mês
uma vez pelo CSV e outra pelo OFX gera duplicata, porque R$ 25,00 e R$ 24,76 são
valores diferentes e o dedup casa por data + valor + direção. Escolha um formato
por mês — e, entre eles, prefira CSV, XLS ou PDF, que trazem a tarifa.

#### A descrição saiu do mesmo molde nos três

`Pix - NOME`, `Maquininha - NOME` — o padrão que a planilha viva pratica, e do
qual as regras da casa dependem para decidir sem consultar o modelo (§3.3). Cada
formato usa um vocabulário próprio para a mesma coisa, e o dicionário entre eles
foi conferido **lançamento a lançamento** entre o CSV, o OFX e o PDF do mesmo
extrato — os 277 pareamentos batem, sem sobra:

| CSV/XLS (`Tipo`) | OFX (`MEMO`) | PDF | vira |
|---|---|---|---|
| `Pix` | `… \| Pix` | `Transferência \| Pix` | `Pix` |
| `Transação` | `Pix \| Maquininha` | `Pix \| Maquininha` | `Maquininha` |
| `Recebível de Cartão` | `Maestro/Visa/Elo \| Débito` | idem | `Cartão` |
| `Transferência entre contas Stone` | `Antecipação \| Crédito` | idem | `Antecipação` |

A bandeira do cartão fica de fora de propósito: o que a planilha classifica é o
**meio**, e três bandeiras gerariam três descrições para o mesmo recebimento.
Quando não há contraparte — recebível e antecipação chegam com o campo vazio,
porque quem paga é a adquirente — usamos `Recebimento vendas`, que é
literalmente o que o próprio banco escreve nesses lançamentos no PDF e no OFX.

O resultado é verificável e foi verificado: sobre o extrato real, CSV e XLS
produzem lançamento por lançamento **exatamente** a mesma lista (315), e as 277
linhas não-tarifa do CSV têm **as mesmas descrições** que os 277 lançamentos do
OFX. Sobre esse conjunto, as regras da casa decidem **245 de 315** categorias
sem uma única chamada de IA.

**Limite conhecido:** o PDF da Stone continua na IA. Ele *poderia* sair de lá —
o texto que o pdf.js produz tem colunas em posições fixas e um `SALDO` por
lançamento que encadeia —, mas layout novo só ganha caminho determinístico com
prova medida contra arquivo real, um de cada vez (§5). Enquanto isso, para o
mesmo mês, **o CSV ou o XLS são a importação confiável**.

### 3.8 Duas leituras, e uma escolha defensável

O pedido foi "usar a IA também como fonte de validação, em paralelo, e escolher
o melhor resultado". A parte difícil não é rodar as duas — é definir **melhor**
sem estragar o que já funcionava.

#### Por que "ganha quem trouxer mais lançamentos" seria um erro

É o critério óbvio, e ele premiaria exatamente o defeito que custa mais caro. As
duas vias erram de maneiras opostas:

| via | erra para | como se percebe |
|---|---|---|
| parser determinístico | **a menos** — não reconhece um formato de linha e o pula | a conferência não fecha: a corrente de saldos denuncia |
| IA | **a mais** — repete ou inventa uma linha | nada denuncia: a linha inventada parece legítima |

Um lançamento a mais numa planilha de fluxo de caixa não é um detalhe de
contagem: é dinheiro que nunca existiu, e ele entra em `Recebimento de venda`
como qualquer outro. O único critério que distingue "o parser cegou" de "o
modelo inventou" é a **prova** — e só uma das duas vias tem.

#### A regra de decisão

1. **Determinístico PROVADO vence.** Sempre, inclusive quando a IA trouxe mais
   lançamentos. A prova é verificável: qualquer pessoa refaz a aritmética e
   chega ao mesmo lugar. A leitura da IA é plausível, e plausível não se audita.
2. **Determinístico RECUSADO (ou inexistente) → a IA assume.** É o
   comportamento que sempre existiu, e é o que acontece hoje com o PDF da Stone.
3. **As duas falhando → não há leitura**, e o erro diz por quê.

E uma regra que vale para os três casos: **o resultado nunca é a união dos
dois**. O conjunto entregue vem inteiro de uma das leituras. Unir seria maior e
seria pior — ninguém conseguiria dizer de onde veio cada linha, e a conciliação
deixaria de ser auditável.

#### Então para que serve a segunda leitura?

Porque a prova responde *"esta leitura é internamente consistente?"*, e não
*"o parser enxergou tudo o que está no arquivo?"*. Quase sempre as duas
perguntas têm a mesma resposta — e "quase sempre" é onde moram os defeitos que
chegam do cliente. Duas leituras **independentes** que enxergam o mesmo conjunto
são uma evidência que nenhuma das duas produz sozinha.

Independentes é literal: nenhuma recebe o resultado da outra, nenhuma é
ajustada para concordar. É isso que faz a coincidência valer alguma coisa, em
vez de ser um eco.

Quando a testemunha confirma, a leitura sobe de **provada** para
**corroborada**, e o relatório mostra o selo. Quando discorda, a prova continua
vencendo e a divergência aparece **lançamento a lançamento**, com data, valor,
direção e as duas descrições — para o usuário decidir se olha.

#### O custo, e por que ele é fixo

Mandar a IA reler as 20 páginas de um PDF que o parser já demonstrou é pagar
caro por uma segunda opinião sobre algo que está provado. Então a testemunha lê
uma **AMOSTRA de 3 blocos** — começo, meio e fim, escolhidos de forma
determinística para que duas execuções do mesmo arquivo não discordem por
sorteio. O custo não cresce com o tamanho do extrato: 4 chamadas, seja o extrato
de uma página ou de vinte.

Amostrar só o começo daria uma conferência otimista — o início de um extrato é a
parte mais fácil e a mais parecida com o exemplo do prompt. Daí espalhar.

Sem prova, não há amostra: a IA lê o arquivo inteiro, porque aí ela não é
testemunha, é **a** leitura.

#### O que o cruzamento compara — e o que ele deliberadamente não compara

A chave é `data + direção + valor ao centavo`, a **mesma** identidade que o
dedup usa. A descrição fica de fora de propósito: o nome volta escrito diferente
de uma leitura para a outra — abreviado, com ou sem sufixo societário, reescrito
no padrão da planilha — e compará-lo encheria o painel de divergências falsas,
escondendo as verdadeiras.

Duas coisas mais ficam de fora, e as duas estão ditas no relatório:

- **As tarifas derivadas da coluna.** No CSV e na planilha a tarifa não é uma
  linha: é uma coluna, que o parser transforma em lançamento próprio (§3.7). A
  IA transcreve LINHAS e não tem por que produzir um lançamento que não existe
  como linha — cobrar isso dela geraria uma divergência por tarifa, 175 no
  extrato de quatro meses. Ruído, não sinal.
- **Os dias das pontas da amostra.** Um dia que começa num bloco amostrado e
  termina num bloco não lido apareceria como lançamento faltando. A janela do
  cruzamento é encolhida para excluir o primeiro e o último dia da amostra —
  custa um pouco de cobertura e evita o alarme falso, que é a troca certa: um
  painel que grita sem motivo é um painel que ninguém lê.

#### A testemunha que não apareceu

Provedor fora do ar, chave inválida, modelo devolvendo lixo: nada disso derruba
a conciliação. A leitura por IA vira uma candidata recusada, a leitura provada
segue valendo e o relatório diz que a conferência não pôde ser feita. **Uma
testemunha ausente não invalida uma prova.**

A conferência também pode ser desligada nas Configurações. Desligada, o
resultado é exatamente o mesmo — muda só o que dá para afirmar sobre ele:
"provada" em vez de "corroborada".

### Decisões técnicas centrais

- **Escrita sem quebrar nada:** o escritor localiza a próxima linha vazia
  (≥ `firstDataRow`) e substitui **apenas** as células vazias das colunas
  graváveis. Nunca escreve VALOR em `A` nem nas colunas com fórmula, e nunca
  toca em merges ou no `<extLst>` (dropdown). Nas colunas calculadas ele escreve
  a **fórmula** — a mesma que as linhas de cima já tinham, transposta para a
  linha nova — e só quando a célula não tem fórmula nenhuma. "Proibido escrever
  valor" e "tem de repetir a fórmula" convivem: a célula continua sendo da
  planilha. Verificado por diff de XML **e** reabrindo no Excel/openpyxl.
- **Particionamento por competência:** um arquivo pode conter vários meses (o
  Stone real cobre julho e agosto). Não existe "o mês do arquivo".
- **Dinheiro em centavos inteiros** (nunca `f64`/`number`).
- **Larguras condizentes com o conteúdo:** a planilha nova nasce com larguras
  calibradas; depois de gravar, ambas (nova e a do usuário) passam pelo
  auto-ajuste em modo **só alarga** — o que você já ajustou nunca encolhe, e o
  que não cabe passa a caber. Mexe só no elemento `<cols>`.
- **Download com indicativo:** a serialização do `.xlsx` acontece **no clique**,
  e a porcentagem vem do próprio compactador. Antes o botão era mudo e o
  silêncio parecia travamento.

### Deduplicação — identidade e contagem

Reimportar o mesmo extrato, ou fornecer a planilha já atualizada como base, tem
de inserir **0 linhas**.

**A identidade de um lançamento é `data + valor (ao centavo) + direção + ordem`.
O nome não entra na decisão.** Dois lançamentos do mesmo dia, do mesmo centavo e
no mesmo sentido são o mesmo lançamento. A razão é assimétrica: a chance de dois
pagamentos distintos coincidirem até o centavo, no mesmo dia e no mesmo sentido,
é pequena perto da chance de o nome voltar escrito diferente de uma leitura para
outra — abreviado, com/sem sufixo societário, com/sem o tipo do lançamento, com
erro de OCR. Era o nome que fazia duplicata escapar.

**O que protege contra fusão indevida é a CONTAGEM, não o nome.** Cada linha
existente absorve no máximo **um** lançamento:

- Aba com 2 Pix de R$ 25,00 em 04/08 + extrato com 3 → *2 duplicados + 1 novo*.
- Aba com a venda da Maria (R$ 25,00, 04/08); extrato traz Maria **e** Ana, as
  duas de R$ 25,00 no mesmo dia → *1 duplicado + 1 novo*. A segunda venda **não
  some**, porque sobrou lançamento sem slot livre — independentemente de quem é
  quem.

O nome ainda é usado para **escolher** qual slot consumir (casa primeiro o de
descrição igual), o que mantém o pareamento correto quando extrato e planilha
estão em ordens diferentes.

> **Ponto cego conhecido, e é por isso que ele é exibido.** Se a aba tiver um
> lançamento de R$ 25,00 em 04/08 que **não está neste extrato** — digitado à
> mão, ou vindo de outra conta — e o extrato trouxer outro de R$ 25,00 em 04/08,
> o novo é absorvido pelo antigo. Esses casos voltam em
> `duplicadosNomeDivergente` e aparecem em destaque no relatório, com as duas
> descrições lado a lado. A regra decide sozinha, mas não decide às escondidas.

### A coluna Data — dois cuidados que já custaram bug

Na planilha real as datas estão gravadas como **texto** `dd/mm/aaaa` (`t="s"`),
não como serial do Excel. Isso quebra os dois sentidos se ignorado:

- **Na leitura:** tratar o `<v>` de uma célula de texto como número lê o *índice
  da sharedString* — o índice 120 vira `29/04/1900`, e o dedup nunca casa.
  `readCellDate`/`toCents` checam o tipo da célula antes de converter.
- **Na escrita:** gravar o serial `46201` numa célula sem formato de data faz o
  usuário ler `46201` na tela e concluir, com razão, que o sistema salvou a data
  errada. Pior nas abas que ele já usou: ali a primeira linha livre muitas vezes
  **não tem a célula B**, ou tem uma com estilo Geral herdado de uma colagem.

`analyzeSheetConventions` cuida da convenção: olha as linhas que já estão na aba
e decide (a) o **estilo herdado** de cada coluna gravável, para células que não
existem na linha de destino, e (b) se a data vai como **texto ou serial**,
seguindo o que a aba já pratica — se as linhas existentes guardam texto, a linha
nova sai em texto, porque as fórmulas do usuário contam com isso.

O formato de exibição, porém, **não é mais deduzido: é garantido**. Herdar o
estilo da coluna funcionava até a célula de destino ter estilo próprio sem
formato de data — e era assim que `46201, 46200, 46199` chegavam à tela do
cliente. Agora, antes de gravar o serial, o writer resolve um estilo que *com
certeza* exibe data: reusa o herdado quando ele já serve e, quando não serve,
**clona** aquele `<xf>` com `numFmtId=14`, preservando fonte, borda,
preenchimento e alinhamento. O clone é acrescentado ao fim de `cellXfs` —
nenhum estilo existente é alterado, então nenhuma outra célula muda de aparência
e T-PRES continua valendo. Clones idênticos são reaproveitados; rodar dez vezes
não incha o arquivo. Se a planilha não tiver `cellXfs` onde registrar o estilo,
a data vai como texto, que exibe certo em qualquer caso.

Não remova essas checagens.

> Isso vale para gravações **novas**. Linhas escritas por versões anteriores
> continuam sem formato — ali é selecionar a coluna no Excel e aplicar formato de
> data uma vez.

### Decisões da Fase 2 (IA + segurança)

- **Determinístico antes de empírico — mas só com prova.** Layout conhecido cuja
  leitura possa ser CONFERIDA é lido por código, sem chamada nenhuma. Sem
  conferência não há leitura direta: preferimos o custo da IA à falsa certeza de
  um parser que erra calado (§3.4).
- **O resultado vem inteiro de um caminho só.** Determinístico ou IA, nunca
  costurado entre os dois. Meia leitura de cada lado seria impossível de auditar.
- **Um estágio, um prompt.** Reconhecer, extrair, perfilar, ler as listas,
  decidir as colunas calculadas e categorizar são seis prompts distintos, com
  schemas distintos. Misturar transcrição com classificação degrada as duas: o
  modelo passa a ajustar a descrição para caber na categoria que escolheu. As
  regras de listagem ficaram separadas da categorização pelo mesmo motivo: uma
  pergunta é sobre a PLANILHA ("o que esta lista significa nesta empresa?") e
  vale para o arquivo inteiro, uma vez só; a outra é sobre o LANÇAMENTO ("qual
  destas opções é esta compra?") e vale por linha.
- **A grafia da planilha é soberana.** O que vai para uma célula de listagem é
  sempre a string que já está no arquivo, nunca a que o modelo digitou. A
  normalização serve só para casar as duas. Um `.trim()` bem-intencionado nessa
  fronteira foi o que deixou a coluna `Fluxo de Caixa` vazia (§3.1).
- **A linha inserida nasce completa.** Campos digitados e campos calculados. Não
  existe "essa fórmula o usuário arrasta depois" — se a coluna é calculada em
  toda linha de dados, a linha nova também é (§3.2).
- **O que o ramo já decide não vai a julgamento.** Regra estável e enunciada pelo
  dono do negócio vira código determinístico, não instrução de prompt (§3.3). O
  modelo é ótimo no que exige leitura; é caro e instável no que já é regra. As
  regras da casa também vão no prompt, mas como contexto — quem decide é o
  domínio.
- **Regra de saída só quando a descrição nomeia a despesa.** `Tarifa bancária`
  vira regra; `Pix - NOME` saindo, não — ali a descrição nomeia a contraparte e
  não diz o que foi pago (§3.3). É o critério que separa o que é regra do que é
  leitura de contexto.
- **Toda regra da casa nasce com evidência e com exceção.** As duas que existem
  hoje foram medidas contra os 384 lançamentos que o cliente já classificou (zero
  conflitos), e nenhuma dispara sem checar a direção e sem que a categoria exista
  na lista da planilha. Ao acrescentar uma regra nova, **meça antes** — `taxa`
  parecia tão óbvia quanto `tarifa` e teria classificado errado.
- **Pipeline "dividir para conquistar".** A extração é por página, com poucas
  transações por chamada — sem truncamento, mais precisa —, em paralelo com
  retry por partição e falha isolada.
- **VALOR ≠ SALDO.** O prompt separa os dois explicitamente: `valor` é a
  transação, `saldoApos` é só informativo. A **direção** vem do rótulo do
  extrato, nunca do sinal do saldo.
- **A IA extrai, o domínio deduplica.** A IA transcreve **toda** transação na
  ordem, sem deduplicar/mesclar/resumir; a deduplicação é 100% determinística.
  `temperature 0` estabiliza a saída.
- **A IA classifica, a planilha manda.** A lista de categorias vem da aba
  `Categorias` do arquivo do usuário, não do código. Resposta fora da lista é
  descartada — coluna vazia é melhor que categoria errada, porque a célula tem
  dropdown e um valor inválido quebra a validação.
- **Determinístico antes de IA.** O perfil da planilha só gasta uma chamada
  quando a inspeção local não conclui. Na planilha de sempre, custo zero.
- **CSV, planilha e OFX saíram da IA — porque passaram a se autoconferir.** A
  regra não mudou: um layout só ganha caminho determinístico quando **se
  autoconfere**. O que mudou foi a leitura do arquivo. Uma vez que o CSV traz
  `Saldo antes`/`Saldo depois` e o OFX delimita cada lançamento, a prova existe
  — e nesses três a IA passou a ser o *fallback*, não o padrão (§3.7). No PDF de
  layout novo e no extrato escaneado ela continua sendo o padrão, não o fallback
  envergonhado.
- **A prova decide; a IA testemunha.** As duas vias rodam juntas, mas não
  disputam em pé de igualdade: leitura determinística que fechou a conferência
  vence, inclusive quando a IA traz mais lançamentos (§3.8). "Ganha o maior"
  premiaria a linha inventada, que é o erro sem conserto num fluxo de caixa.
- **A discordância aparece; ela não corrige.** Quando as duas leituras divergem,
  a divergência vai para o relatório lançamento a lançamento e o resultado não
  muda. Aplicar em silêncio o que a testemunha viu seria trocar um erro
  auditável por um erro invisível.
- **O resultado vem inteiro de uma leitura só — agora com mais motivo.** Unir os
  dois conjuntos nunca perderia lançamento e destruiria a auditabilidade: não
  haveria como apontar um arquivo, um parser e uma regra para cada linha que foi
  parar na planilha.
- **Conferir tem custo fixo.** A testemunha lê uma amostra de 3 blocos quando a
  prova já fechou — 4 chamadas, seja o extrato de uma página ou de vinte. O que
  não escala não entra no caminho de todo dia.
- **O tipo do arquivo vem dos bytes; a codificação, do conteúdo.** Extensão e
  cabeçalho mentem, e os dois mentiram no arquivo real: o `.xls` da Stone é um
  .xlsx, e o OFX dela declara `CHARSET:1252` e vem em UTF-8. Confiar no que o
  arquivo *diz* de si mandava um ZIP para o modelo como se fosse texto e trocava
  todo acento por lixo. Confiar no que ele *é* resolve os dois (§3.7).
- **A tarifa é lançamento, não coluna.** Onde o arquivo a esconde numa coluna,
  nós a emitimos como saída própria — senão ela nunca chegaria a `Taxa de
  cartão`, que é onde a regra da casa a coloca. Onde o arquivo já a embutiu no
  valor (OFX), não inventamos o bruto: avisamos.
- **O arquivo do usuário sobrevive à leitura.** `pdfjs.getDocument({ data })`
  TRANSFERE o ArrayBuffer para o worker e deixa quem chamou com um buffer
  desanexado. Entregamos uma **cópia** ao pdf.js — sem isso, ler a assinatura do
  arquivo depois da extração, mandá-lo como documento nativo para a IA ou
  simplesmente conciliar o mesmo arquivo duas vezes estoura com
  `Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer`.
- **Fórmula só onde há dado.** A planilha que geramos nasce com `E`/`H`
  pré-preenchidas em todo o range; depois de gravar, as das linhas vazias são
  podadas — senão o saldo se arrasta por centenas de linhas em branco. Só na
  NOSSA planilha: no arquivo do usuário, T-PRES proíbe o toque.
- **Segredos nunca em texto puro.** API keys e tokens Google vão para o **Windows
  Credential Manager** (via `keyring`), no backend Rust. A UI só grava, consulta
  presença e apaga — a chave nunca entra no WebView, em logs ou em erros.
- **Chamadas de IA rodam no Rust** (reqwest nativo), evitando CORS e mantendo a
  chave fora do WebView.

---

## 4. Testes

```powershell
cd C:\Users\Ylderlan\Documents\Projetos\conciliador-extratos
npm test        # 495 testes determinísticos (IA mockada) — sem custo de API
```

Teste de **integração opcional** (key real + os 3 PDFs de calibração), fora do
`npm test` — validação manual antes de release, não roda em CI:

```powershell
$env:AI_INTEGRATION="1"; $env:OPENAI_API_KEY="sk-..."
$env:STONE_PDF_A="C:\...\extrato-80F8...pdf"
$env:STONE_PDF_B="C:\...\extrato-7A9B...pdf"
$env:PAGSEGURO_PDF="C:\...\15-07-2026_14-08-2026.pdf"
npx vitest run tests/ai.integration.test.ts
```

> O extrato PagBank **não precisa** desse teste para ser validado: ele é lido por
> `tests\pagbankPdf.test.ts`, que roda no `npm test`, de graça e sem rede.

Testes-âncora: **T-PRES** (preservação de fórmulas/dropdown/merges), **T-ROUTE**
(julho→JULHO, agosto→AGOSTO), **T-IDEM** (idempotência pelo ledger),
**T-IDEM-BASE** (idempotência contra a planilha já atualizada), **T-NOFORMULA**
(nunca escreve VALOR nas colunas de fórmula), **T-FORMULA** (a linha nova nasce
com a fórmula da coluna, transposta), **T-ORDEM** (a ordem das datas da aba é
identificada com evidência, e "bagunçada" continua sendo "indefinida"),
**T-ENCAIXE** (a linha nova entra pela data — começo, meio ou fim — e a ordem
relativa do que já estava gravado não muda), **T-GRAFIA** (a opção gravada é literalmente
a da planilha, com espaço sobrando e tudo), **T-CASA** (as regras do ramo, com
direção, critério e exceções), **T-DIRETO** (a leitura determinística só é aceita
quando a cadeia de saldo fecha), **T-TABULAR** (o CSV/planilha só é aceito quando
toda linha fecha a própria conta E os saldos encadeiam de ponta a ponta — linha
faltando, duplicada, valor adulterado ou tarifa ignorada reprovam), **T-OFX**
(todo registro declarado vira lançamento, nada sobra na lista, nada fora do
período), **T-TIPO** (o tipo do arquivo vem dos bytes: o `.xls` que é xlsx é lido,
o `.xls` de verdade é recusado com explicação, e o acento sobrevive tanto em
UTF-8 quanto em 1252), **T-PADRÃO** (os três formatos escrevem a MESMA descrição,
no padrão da planilha, e é ela que faz a regra da casa disparar), **T-ROTA**
(cada formato vai para o seu parser, e a recusa carrega o motivo até o
relatório), **T-FORMATO** (a data gravada aparece como data,
mesmo em célula com estilo Geral), **T-MODELO** (o modelo das Configurações é o
que vai para o provedor), **T-BYTES** (o arquivo do usuário sobrevive à extração
de texto), **T-LINHA-VAZIA** (gravar além da última linha materializada da aba não perde lançamento: a linha autofechada é aberta antes de receber célula), **T-BACKUP**, **T-INDEP**, **T-MONEY**.

Validação manual feita nesta fase, sobre os arquivos reais: gravar em `JUNHO`
(cujas linhas livres não tinham fórmula) e reabrir o arquivo com recálculo
forçado. `Categoria` = `"Salário "` → `Fluxo de Caixa` = `DESPESAS FIXAS`, e o
`Saldo` encadeando linha a linha.

Validação feita sobre os **quatro arquivos do mesmo mês** (agosto/2026) que o
cliente enviou — fora do `npm test`, porque os arquivos trazem nomes reais:

- **CSV**: 315 lançamentos, 277 linhas conferidas, 276 elos de saldo, **zero**
  divergências, **zero** chamadas de IA.
- **XLS**: lançamento por lançamento, **exatamente a mesma lista** do CSV —
  mesma data, mesmo valor, mesma direção, mesma descrição.
- **OFX**: 277 de 277 registros declarados, nada sobrando; a soma líquida
  (R$ 552,73) bate com a variação do saldo declarado no extrato (R$ 870,04 −
  R$ 317,31), e as descrições são **as mesmas** das 277 linhas não-tarifa do CSV.
- **PDF**: continua na IA, como esperado — nenhum parser determinístico o
  reivindica.
- Sobre esse conjunto, as **regras da casa** decidem 245 das 315 categorias sem
  uma única chamada de IA.

Repetida na Fase 2.6 sobre o lote maior que o cliente enviou depois — **quatro
meses**, 09/05 a 31/08/2026, 1.115 linhas:

| arquivo | lançamentos | prova | chamadas de IA | tempo |
|---|---|---|---|---|
| CSV (321 KB) | **1.290** (1.115 + 175 tarifas) | 1.115 linhas conferidas, 1.114 elos, 0 divergências | 0 | 45 ms |
| XLS (117 KB) | **1.290** — lista idêntica à do CSV, inclusive as descrições | idem | 0 | 102 ms |
| OFX (287 KB) | **1.115** (tarifa embutida no valor) | 1.115 de 1.115 declarados, nada sobrando | 0 | 15 ms |
| PDF (1,2 MB, 20 págs) | — só agosto, e por IA | nenhuma | ~21 | ~1 min |

Três fechamentos independentes que valem mais que as contagens isoladas:

- o extrato **começa em R$ 0,00** (09/05) e termina em **R$ 870,04** (31/08), e
  a soma líquida de tudo o que foi lido dá exatamente R$ 870,04 — a corrente
  fecha de ponta a ponta, não só linha a linha;
- CSV e OFX chegam ao **mesmo líquido** e às **mesmas descrições** nas 1.115
  movimentações, apesar de serem formatos e parsers diferentes;
- o recorte de **agosto** do CSV dá **315 lançamentos (38 tarifas)** — o mesmo
  número que o protótipo de parser determinístico de PDF encontra no PDF de
  agosto, que é outro arquivo, de outro exportador, lido por outro método.

Conferência PONTA A PONTA dos sete arquivos — leitura, gravação na planilha
real, reabertura do `.xlsx` e reimportação:

| verificação | resultado |
|---|---|
| leitura dos 7 arquivos | 6 lidos direto e provados; o PDF vai para a IA, como esperado |
| gravação na planilha real | 0 inconsistências; o `.xlsx` reabre em todos os casos |
| roteamento por competência | MAIO, JUNHO, JULHO e AGOSTO, sem lançamento órfão |
| dedup contra a aba já preenchida | 384 duplicados reconhecidos no CSV de 4 meses |
| **idempotência** | reimportar o mesmo arquivo insere **0** |
| T-BYTES | os bytes do usuário sobrevivem a duas leituras seguidas |

Foi essa conferência que expôs o **T-LINHA-VAZIA**: antes da correção, a
segunda importação do CSV de quatro meses reinseria 38 lançamentos, porque 75
linhas da primeira passada nunca chegaram ao arquivo. O teste está travado, e o
`tests\arquivosReais.test.ts` repete a conferência inteira sobre qualquer pasta
de extratos (`$env:EXTRATOS_DIR`).

O comparativo completo, com a recomendação de qual formato usar, está em
`docs\comparativo-formatos.html`.

---

## 5. Roadmap

- **Parser determinístico para o PDF da Stone** — o próximo candidato, e agora
  com prova à vista: o texto que o pdf.js entrega tem as colunas em posições
  fixas (`DATA`/`TIPO`/`DESCRIÇÃO`/`VALOR`/`SALDO`/`CONTRAPARTE`, cujo x sai do
  próprio cabeçalho) e cada lançamento traz o `SALDO` depois dele, que encadeia
  de ponta a ponta — inclusive nas tarifas, que compartilham o saldo da venda a
  que pertencem. Fechando a corrente, o PDF sai da IA e passa a valer a mesma
  garantia do CSV. Regra de sempre: **um layout de cada vez, e só com
  conferência medida contra arquivo real** (§3.4, §3.7).
- Passe de correção nas linhas **já gravadas** por versões anteriores, aplicando
  formato de data às células que saíram como número cru.
- Alinhar a descrição do parser do **PagBank** ao padrão que a planilha pratica,
  como já foi feito no CSV/planilha/OFX (§3.7) — hoje ele ainda transcreve o
  texto do banco, e por isso os dois caminhos de leitura produzem hashes de
  dedup diferentes (§3.4).
- Portar a validação do contrato de layout no Rust (`validate_layout_contract`)
  para consumir o **perfil** em vez da linha 12 fixa.
- Painel no relatório mostrando as colunas de listagem e as calculadas que o
  perfil encontrou — hoje elas só aparecem quando geram aviso.
- Levar o **encaixe por data** para o Google Sheets (hoje append no fim, §3.6).
- Deixar as **regras da casa** configuráveis pelo usuário na interface, em vez de
  fixas no código: hoje acrescentar uma regra exige editar `domain/houseRules.ts`.
- Ledger persistente (SQLite) no desktop, hoje em memória por execução.
- Writer COM do Excel em Rust; recorrência via Agendador de Tarefas do Windows.

---

## 6. Limitações conhecidas

- O binário Windows final deve ser compilado na máquina do usuário
  (`npm run tauri build`).
- **O `validate_layout_contract` (Rust) ainda assume o layout Cantina Bom Prato**
  (12 abas de mês, cabeçalho na linha 12). A adaptabilidade a outras planilhas
  vive no lado TypeScript, no perfil.
- **Google Sheets** está implementado (OAuth PKCE + escrita B..H), mas depende de
  rede + navegador + conta Google; **valide on-device** antes de confiar a
  escrita à planilha real (exige um OAuth Client do Google Cloud, tipo *Desktop*).
  O caminho validado por padrão é a planilha **.xlsx local**. A escrita no
  Sheets também **não faz encaixe por data** — acrescenta no fim da aba (§3.6).
- Extração por IA tem custo por chamada e não-determinismo inerente;
  `temperature 0`, as redes de segurança e o dedup mitigam, mas a conferência do
  relatório antes de salvar continua recomendada.
- O **ledger é por execução** (memória): a idempotência entre sessões vem da
  leitura da aba real, não do histórico local.
- A fixture `template_bomprato.xlsx` é uma cópia da planilha real do cliente,
  usada apenas para os testes de preservação e de perfil (uso local).
- **As fórmulas repetidas vão sem valor em cache.** O arquivo é marcado com
  `fullCalcOnLoad="1"`, e o Excel recalcula ao abrir. Ferramentas que leem o
  `.xlsx` sem calcular (openpyxl com `data_only=True`, alguns visualizadores,
  o LibreOffice com "recalcular ao carregar" desligado) mostram a célula vazia
  até o arquivo passar uma vez pelo Excel. Não é dado perdido, é dado ainda não
  calculado.
- **O saldo não é remendado.** Se a linha imediatamente acima da primeira que
  gravamos já estava sem saldo, a corrente recomeça ali. Isso é sinalizado nas
  *Observações sobre a gravação* do relatório, mas a correção é manual — mexer
  numa linha que o usuário não mandou mexer é o que o contrato de escrita
  cirúrgica proíbe.
- **O PDF da Stone continua na IA** — e é ele que o cliente vinha usando quando
  relatou que "a planilha ignorou alguns registros" (§3.7). Enquanto não houver
  parser com prova para esse layout, **importe o mês pelo CSV ou pelo XLS**: são
  o mesmo extrato, lidos por código e conferidos linha a linha. Imagem e PDF
  escaneado também seguem na IA, e ali ela é o caminho certo, não uma exceção.
- **O `.xls` ANTIGO (BIFF/OLE2) não é lido.** O que a Stone chama de `.xls` é um
  .xlsx e funciona; um `.xls` de verdade (salvo pelo Excel 97-2003) é
  reconhecido e **recusado com explicação** — abrir e salvar como `.xlsx`, ou
  baixar em CSV/OFX/PDF, resolve. Suportá-lo exigiria uma biblioteca inteira só
  para ele, e todo banco que ainda o oferece oferece também CSV ou OFX.
- **O OFX entrega o valor já líquido da tarifa** e não permite reconstruir o
  bruto: o mesmo mês rende 315 lançamentos em PDF/CSV/XLS e **277** em OFX.
  Importar o mesmo mês por dois formatos diferentes gera duplicata, porque
  R$ 25,00 e R$ 24,76 são valores distintos para o dedup. Escolha um formato por
  mês — de preferência um que traga a tarifa (§3.7).
- **A leitura direta do extrato tabular exige `Saldo antes` e `Saldo depois`.**
  Um CSV que traga só data, descrição e valor não tem como ser conferido, e por
  isso vai para a IA — de propósito. A prova é o que autoriza o parser; sem ela
  seria só um palpite com cara de certeza.
- **A conferência por IA é por AMOSTRA quando a prova já fechou** (§3.8). Ela
  responde "as duas leituras enxergam a mesma coisa nesta faixa?", não "o
  arquivo inteiro está correto" — isso quem responde é a prova. Uma divergência
  fora da janela amostrada não seria vista, e o relatório diz qual foi a janela.
- **O cruzamento não compara descrições nem tarifas derivadas.** A descrição
  muda de uma leitura para a outra por natureza, e a tarifa do CSV/planilha não
  existe como linha no arquivo. Os dois ficam de fora para o painel mostrar
  sinal em vez de ruído — e as ressalvas aparecem junto (§3.8).
- **A IA nunca corrige a leitura provada.** Se ela vir um lançamento que o
  parser não viu, isso aparece como divergência e para por aí. Tratar a
  discordância como correção automática abriria a porta para o lançamento que o
  modelo inventou entrar na planilha sem nada que o barrasse.
- **O primeiro dia do extrato não entra na conferência de saldo.** O saldo dele é
  o primeiro elo da corrente e não tem com o que ser comparado (§3.4).
- **Os dois caminhos de leitura escrevem a descrição de jeitos diferentes.** O
  parser direto transcreve o texto do banco; a IA o reescreve no padrão da
  planilha. Reimportar pelo outro caminho um extrato que já entrou pode gerar
  duplicata — a conta, essa sim, é idêntica nos dois.
- **O formato de data é garantido só para gravações novas.** As linhas escritas
  por versões anteriores continuam sem formato até alguém aplicá-lo no Excel.
- **Só perpetuamos o que a planilha já pratica.** Uma coluna cuja única fórmula
  seja a da primeira linha (o saldo inicial, que aponta para o cabeçalho) não
  ganha modelo geral: preferimos a célula vazia a uma fórmula transposta de um
  modelo que não se generaliza.
