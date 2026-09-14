# Sistema de Design — Conciliador (Cantina Bom Prato)

Direção **"Verde-cofre / Livro-caixa"**. Produto financeiro desktop (Windows,
janela nativa). Paleta clara, sem dark mode. O objetivo é transmitir **cuidado e
confiança** — não um boilerplate Tailwind, não o "creme + serifada + terracota"
que denuncia design gerado por IA, nem o índigo/violeta fintech genérico.

## Cor (tokens)

| Token | Hex | Uso |
|---|---|---|
| `bg` | `#F4F6F8` | Fundo da janela (névoa fria, não branco puro nem creme) |
| `surface` | `#FFFFFF` | Cartões, painéis, tabelas |
| `surface.muted` | `#EAEEF2` | Faixas, cabeçalhos de tabela, campos |
| `ink` | `#1B2A33` | Texto primário (petróleo escuro) |
| `ink.soft` | `#5A6B75` | Texto secundário, legendas |
| `line` | `#D8E0E6` | Bordas e divisores |
| `cofre` | `#0E7C66` | **Accent / ação** (verde-cofre). Remete a dinheiro e confiança sem verde neon |
| `cofre.strong` | `#0B6353` | Hover/pressionado da ação |
| `cofre.soft` | `#E6F1EE` | Fundo de destaque do accent |
| `entrada` | `#1E9E6A` | **Entrada/crédito** (positivo) |
| `entrada.soft` | `#E6F4EC` | Fundo/badge de entrada |
| `saida` | `#C0392B` | **Saída/débito** (negativo, vermelho-tijolo sóbrio) |
| `saida.soft` | `#FBEBE8` | Fundo/badge de saída |

Em app de dinheiro, **entrada e saída precisam de leitura visual imediata** —
por isso nunca dependem só de cor: sempre acompanham um sinal/ícone
(`↑`/`+` para entrada, `↓`/`−` para saída). Contraste mínimo AA.

## Tipografia (par deliberado — não "Inter em tudo")

- **Space Grotesk** — títulos, KPIs e números de destaque. Tem números
  tabulares de caráter técnico, que combina com um produto de conciliação.
- **Public Sans** — corpo, formulários e tabelas. Legível, sóbria, de origem
  institucional (US Web Design System) — reforça o tom "software sério".
- **IBM Plex Mono** — valores monetários em tabelas/relatório, onde o
  alinhamento por dígito (tabular) ajuda a bater números como num livro-caixa.

Fontes **empacotadas** (`@fontsource/*`) — offline-first, sem CDN.

## Layout (um conceito por tela)

- **Onboarding** — coluna única, passos numerados em "carimbos" de conciliação;
  foco em conectar IA + planilha e validar o contrato de layout.
- **Main / Importar** — área generosa de soltar o extrato ao centro, com o
  destino (planilha) e o provedor de IA visíveis logo abaixo. Ação primária
  "Conciliar" em destaque.
- **Relatório** — KPIs no topo (mono/tabular), dashboard, e tabela por
  competência com entradas/saídas separadas por cor+sinal.
- **Configurações** — duas seções: provedores de IA (key mascarada, modelo,
  testar conexão, badge de status) e Google Sheets (conta + planilha).
- **Header fixo** com o brasão do app e o acesso às Configurações (engrenagem).

## Elemento de assinatura

A **"linha de conciliação"**: uma régua dupla fina (2px cofre + 1px linha) sob
os títulos de seção, citando o fechamento de um livro-caixa. Acompanha a **fita
de competência** — uma etiqueta do mês (ex.: `JULHO 2026`) com um ponto cofre,
marcando a que aba/mês cada bloco pertence. É o detalhe que amarra a identidade
ao domínio (competência mensal / fechamento), não decoração aleatória.

## Autocrítica (o que mudou para não ser "default de IA")

- **Verde escolhido é `#0E7C66` (cofre), não o `emerald-500`/`green-500` do
  Tailwind** — um verde mais fechado, de cofre/contabilidade, justificado pelo
  domínio (dinheiro + confiança), e não o verde-menta de dashboard genérico.
- **Nada de cartões `rounded-xl shadow-md` iguais em tudo**: hierarquia real —
  superfícies chapadas com borda `line` para conteúdo, sombra suave (`card`)
  só onde há elevação, e a régua de conciliação para separar seções.
- **Fundo é névoa fria `#F4F6F8`, não creme** — evita o "tell" creme+terracota.
- **Três famílias tipográficas com papéis distintos** (display/corpo/mono), em
  vez de uma fonte única — os números têm tratamento tabular proposital.
