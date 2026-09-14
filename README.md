# Conciliador Automático de Extratos Bancários

Aplicação desktop (**Tauri v2 + React + TypeScript + Rust**) que automatiza a
conciliação mensal de extratos bancários com a planilha de fluxo de caixa,
**preservando fórmulas, células mescladas, dropdowns e dashboard**, e roteando
cada transação para a aba do seu mês.

Você solta a planilha e o extrato; o sistema lê os lançamentos, descarta os que
já estão gravados, classifica cada um pelas categorias da própria planilha e
insere as linhas novas **na posição que a data pede** — com as fórmulas das
colunas calculadas já preenchidas, exatamente como se tivessem sido digitadas.

Os quatro formatos que o banco oferece são lidos por código, sem custo de IA:
**CSV, planilha (.xls/.xlsx), OFX** e o **PDF do PagBank**. O que fugir disso vai
para a IA. Quando as duas leituras rodam juntas, **quem tem prova vence** — e a
divergência aparece no relatório em vez de mudar o resultado em silêncio.

| | |
|---|---|
| **Plataforma** | Windows 10/11 — **desktop apenas**, não há versão web |
| **Versão** | v1.0.6 (Fase 2.6) |
| **Testes** | 495 determinísticos, sem custo de API (+ 3 de integração opcionais) |

---

## Pré-requisitos

- **Rust** (stable)
- **Node 18+**
- **WebView2** — já vem no Windows 10/11
- Uma **API key** de provedor de IA (ex.: OpenAI) para os extratos em formato desconhecido

## Instalação

```powershell
cd C:\Users\Ylderlan\Documents\Projetos\conciliador-extratos
npm install
```

## Como executar

```powershell
npm run tauri dev      # desenvolvimento, com janela nativa
npm run tauri build    # instalador em src-tauri\target\release\bundle\
```

> `npm run dev` (Vite em `localhost:1420`) é **só o ambiente de desenvolvimento
> do Tauri**, não um produto separado. As chamadas de IA e o cofre de segredos
> dependem do backend nativo — rode via `npm run tauri dev`, não pelo navegador.

## Primeiro uso

1. Abra o app e clique na **engrenagem** (Configurações)
2. Cole sua **API key**, escolha o **modelo** e clique em **Testar conexão**
3. Volte para a tela principal
4. Solte sua planilha `.xlsx` de destino (opcional) e depois o extrato
5. Clique em **Conciliar**

O relatório final mostra, por competência, quantos lançamentos entraram, quantos
eram duplicados e quais avisos a gravação produziu.

## Testes

```powershell
npm test        # 495 testes determinísticos (IA mockada), sem custo de API
```

O teste de integração com API key real fica fora do `npm test` — instruções em
[`docs/MANUTENCAO.md` §4](docs/MANUTENCAO.md#4-testes).

---

## Estrutura

```
src/
  domain/        entidades e regras puras, sem I/O (Money, Transaction, regras da casa)
  application/   casos de uso, dependem só de ports (import, dedup, relatório)
  adapters/      parsers, IA, escrita XLSX, Google Sheets, ponte Tauri
  ui/            frontend React (telas, componentes, store)
src-tauri/       casca desktop em Rust (COM do Excel, cofre de segredos, IA)
tests/           495 testes + fixtures de arquivos reais
docs/            documentação de manutenção e design
exemplos/        saídas geradas para conferência
```

Clean Architecture: `domain` não conhece ninguém, `application` conhece só as
interfaces (*ports*), `adapters` implementa essas interfaces.

## Limitações que afetam o uso

- O binário Windows final precisa ser compilado na máquina do usuário (`npm run tauri build`)
- **OFX rende menos lançamentos que os demais formatos** no mesmo mês (277 × 315),
  porque o arquivo já traz o valor líquido de tarifa e a tarifa não pode virar
  lançamento próprio — o relatório avisa
- **Google Sheets** está implementado, mas depende de rede, navegador e um OAuth
  Client do Google Cloud (tipo *Desktop*); valide on-device antes de confiar a
  escrita à planilha real
- **Reimportar o mesmo extrato por um caminho de leitura diferente** (parser
  direto × IA) pode gerar duplicata, porque a descrição gravada muda entre os dois
- O formato de data é garantido só para gravações novas; linhas escritas por
  versões anteriores continuam sem formato

A lista completa está em [`docs/MANUTENCAO.md` §6](docs/MANUTENCAO.md#6-limitações-conhecidas).

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/MANUTENCAO.md`](docs/MANUTENCAO.md) | **Referência de manutenção**: decisões de projeto, mapa completo de arquivos, pipeline detalhado, testes, roadmap e limitações |
| [`docs/comparativo-formatos.html`](docs/comparativo-formatos.html) | Comparação medida dos quatro formatos sobre os arquivos reais do cliente, com recomendação de qual usar |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Sistema de design "Verde-cofre / Livro-caixa" |
| [`docs/FASE2-RESUMO.md`](docs/FASE2-RESUMO.md) | Resumo da migração para o motor de IA |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Notas de passagem de bastão |
