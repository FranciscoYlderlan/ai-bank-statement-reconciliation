import { useStore } from "../store";
import { Dashboard } from "../components/Dashboard";
import { formatCents } from "../engine";
import { useDownload } from "../download";
import { toBr } from "../../domain/dateptbr";
import { describeDateOrder } from "../../domain/dateOrder";
import { WorkbookProfile } from "../../domain/workbookProfile";
import { Button, Card, SectionTitle, DirectionSign, DownloadButton } from "../components/ui";

/**
 * A ordem das datas ABA A ABA. Mostrar so a da planilha inteira esconderia o
 * que mais importa: numa planilha real MAIO pode descer e JUNHO subir, e e a
 * aba de destino que decide onde o lancamento novo entra.
 */
function ordemPorAba(profile: WorkbookProfile): string[] {
  return Object.entries(profile.dateOrderBySheet ?? {})
    .filter(([, e]) => e.conclusiva)
    .map(([aba, e]) => `${aba}: ${e.ordem}`);
}

/**
 * A PROVA que autorizou a leitura direta, em uma frase.
 *
 * O painel diz qual parser leu o arquivo; esta frase diz por que dava para
 * confiar nele. Cada formato prova de um jeito diferente, e mostrar a prova
 * errada seria pior que nao mostrar nenhuma — foi o que acontecia enquanto o
 * texto falava em "saldo do dia" para qualquer leitura direta.
 */
function provaDaLeitura(parserId: string): string {
  switch (parserId) {
    case "pagbank-pdf":
      return "as linhas foram lidas direto do PDF e conferidas contra o saldo do dia";
    case "tabular-saldo":
      return (
        "cada linha foi conferida pela própria conta (saldo antes + valor − tarifa = saldo depois) " +
        "e os saldos encadeiam do começo ao fim do arquivo, o que prova que nenhum lançamento ficou de fora"
      );
    case "ofx":
      return "todos os registros declarados no arquivo viraram lançamento, sem sobra e dentro do período do extrato";
    default:
      return "as linhas foram lidas direto do arquivo e conferidas";
  }
}

/**
 * O SELO de confianca da leitura, em uma palavra.
 *
 * "Provada" e "corroborada" nao sao sinonimos e a diferenca importa: provada e
 * a leitura direta que fechou a propria conferencia; corroborada e a mesma
 * leitura DEPOIS de uma segunda via independente ter chegado ao mesmo conjunto.
 * Quem le o relatorio precisa poder distinguir as duas sem abrir o painel.
 */
function selo(nivel?: string): { texto: string; classe: string } {
  switch (nivel) {
    case "corroborada":
      return { texto: "leitura corroborada", classe: "bg-entrada-soft text-entrada" };
    case "provada":
      return { texto: "leitura provada", classe: "bg-cofre-soft text-cofre" };
    case "empirica":
      return { texto: "leitura por IA", classe: "bg-surface-muted text-ink-soft" };
    default:
      return { texto: "leitura por IA", classe: "bg-surface-muted text-ink-soft" };
  }
}

export function Report() {
  const {
    report,
    dashboard,
    serialize,
    parsedCount,
    categorizedCount,
    profile,
    strategy,
    xlsxName,
    setScreen,
    auditoriaCategoria,
    resumoCategoria,
    avisosCategoria,
  } = useStore();
  const dl = useDownload();
  if (!report || !dashboard) return null;

  const outName =
    (xlsxName || "Fluxo de Caixa").replace(/\.xlsx$/i, "") + " - atualizado.xlsx";

  const t = report.totals;
  const kpis = [
    { n: parsedCount, l: "Transações lidas", tone: "" },
    { n: t.novos, l: "Novos inseridos", tone: "text-entrada" },
    { n: t.duplicados, l: "Duplicados ignorados", tone: "text-ink-soft" },
    { n: t.inconsistencias, l: "Inconsistências", tone: t.inconsistencias ? "text-saida" : "text-ink-soft" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <span className="competence-tag">Relatório</span>
          <h2 className="font-display text-2xl font-bold tracking-tight">Resultado da conciliação</h2>
        </div>
        <Button variant="subtle" onClick={() => setScreen("main")}>
          ← Novo extrato
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.l} className="p-4">
            <div className={`font-mono text-2xl font-bold ${k.tone}`}>{k.n}</div>
            <div className="mt-0.5 text-xs text-ink-soft">{k.l}</div>
          </Card>
        ))}
      </div>

      {/* NOME DIVERGENTE — recolhido por padrão, e com a lista rolando dentro.
          Num extrato de quatro meses isto passa de cem linhas: aberto, empurrava
          o dashboard e a tabela por competência para fora da tela, e o painel
          que existe para CHAMAR ATENÇÃO virava o que o usuário rola para pular.
          O aviso e a contagem continuam à vista; o detalhe abre em um clique. */}
      {t.duplicadosNomeDivergente > 0 && (
        <Card className="border-saida/30 bg-saida-soft/40 p-4">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-start gap-2 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cofre">
              <span
                aria-hidden
                className="mt-0.5 shrink-0 text-ink-soft transition-transform group-open:rotate-90"
              >
                ▸
              </span>
              <span>
                <span className="font-display text-sm font-semibold text-ink">
                  {t.duplicadosNomeDivergente}{" "}
                  {t.duplicadosNomeDivergente === 1 ? "lançamento foi" : "lançamentos foram"} tratado
                  {t.duplicadosNomeDivergente === 1 ? "" : "s"} como duplicado por data e valor, mas
                  o nome não bateu
                </span>
                <span className="mt-0.5 block text-xs text-ink-soft">
                  {t.duplicadosNomeDivergente === 1 ? "Ver o lançamento" : "Ver os lançamentos"} ·
                  nenhum deles foi inserido
                </span>
              </span>
            </summary>

            <p className="ml-6 mt-2 text-xs text-ink-soft">
              A identidade de um lançamento é data + valor + direção. Estes casaram nisso tudo com
              uma linha que já estava na planilha, e por isso <b>não foram inseridos</b> — mas as
              descrições são diferentes. Confira se é a mesma transação lida de outro jeito ou dois
              pagamentos distintos de mesmo valor no mesmo dia.
            </p>

            <div className="ml-6 mt-2 max-h-72 overflow-y-auto rounded-card border border-saida/20 bg-surface/70 p-2">
              <ul className="space-y-1 text-xs">
                {report.competences.flatMap((c) =>
                  c.duplicadosNomeDivergente.map((m, i) => (
                    <li key={`${c.competenceKey}-${i}`} className="flex flex-wrap gap-x-2">
                      <span className="competence-tag">{c.targetSheet}</span>
                      <span className="font-mono text-ink-soft">{toBr(m.tx.date)}</span>
                      <span className="font-mono">{formatCents(m.tx.amount.cents)}</span>
                      <span className="text-ink">no extrato: “{m.tx.description}”</span>
                      <span className="text-ink-soft">· na planilha: “{m.naPlanilha}”</span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          </details>
        </Card>
      )}

      {strategy && (
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-display text-sm font-semibold">Extrato lido</span>
            <span className={`rounded-pill px-2 py-0.5 text-xs font-semibold ${selo(strategy.nivel).classe}`}>
              {selo(strategy.nivel).texto}
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {strategy.kind === "deterministic" ? (
              <>
                <b className="text-ink">{strategy.label}</b>: {provaDaLeitura(strategy.parserId)} — o
                mesmo arquivo produz sempre o mesmo resultado.
              </>
            ) : strategy.reason ? (
              <>
                A leitura direta foi tentada e recusada ({strategy.reason}), então a IA leu o
                arquivo.
              </>
            ) : (
              <>Não há leitura direta para este layout, então a IA leu o arquivo.</>
            )}
          </p>
          {strategy.evidencia && strategy.evidencia.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-ink-soft">
              {strategy.evidencia.map((e, i) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden className="text-entrada">✓</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
          {strategy.avisos && strategy.avisos.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-ink-soft">
              {strategy.avisos.map((a, i) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden>•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          )}

          {/* A SEGUNDA leitura. Ela nao decidiu nada — a prova decidiu —, mas o
              que ela viu e informacao, e esconder informacao de conferencia e
              justamente o que faz o usuario desconfiar do sistema inteiro. */}
          {strategy.testemunha && (
            <div className="mt-3 rounded-card border border-line bg-surface-muted/40 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-ink">
                  Segunda leitura · {strategy.testemunha.label}
                </span>
                <span className="text-xs text-ink-soft">
                  {strategy.testemunha.recusa
                    ? "não pôde ser feita"
                    : `${strategy.testemunha.lancamentos} lançamentos · ${strategy.testemunha.chamadas} chamada(s)` +
                      (strategy.testemunha.amostra
                        ? ` · amostra de ${strategy.testemunha.amostra.blocos} de ${strategy.testemunha.amostra.deTotal} blocos`
                        : "")}
                </span>
              </div>
              {strategy.testemunha.recusa ? (
                <p className="mt-1 text-xs text-ink-soft">
                  {strategy.testemunha.recusa} — a leitura provada não depende dela e segue
                  valendo.
                </p>
              ) : (
                <>
                  {strategy.cruzamento && strategy.cruzamento.cobertura !== "nenhuma" && (
                    <p className="mt-1 text-xs text-ink-soft">
                      <b className="text-ink">{strategy.cruzamento.emComum}</b> lançamentos
                      enxergados igual pelas duas leituras
                      {strategy.cruzamento.janela
                        ? ` (entre ${strategy.cruzamento.janela.de} e ${strategy.cruzamento.janela.ate})`
                        : ""}
                      {strategy.cruzamento.soNaEscolhida + strategy.cruzamento.soNaTestemunha === 0
                        ? " · nenhuma divergência."
                        : ` · ${strategy.cruzamento.soNaEscolhida} só na leitura direta, ${strategy.cruzamento.soNaTestemunha} só na IA.`}
                    </p>
                  )}
                  {strategy.cruzamento?.divergencias.length ? (
                    <details className="group mt-2">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cofre">
                        <span aria-hidden className="text-ink-soft transition-transform group-open:rotate-90">
                          ▸
                        </span>
                        Ver as {strategy.cruzamento.divergencias.length} divergências
                      </summary>
                      <div className="mt-2 max-h-60 overflow-y-auto rounded-card border border-line bg-surface p-2">
                        <ul className="space-y-1 text-xs">
                          {strategy.cruzamento.divergencias.map((d, i) => (
                            <li key={i} className="flex flex-wrap gap-x-2">
                              <span className="competence-tag">
                                {d.lado === "so-na-escolhida" ? "só direta" : "só IA"}
                              </span>
                              <span className="font-mono text-ink-soft">{d.data}</span>
                              <span className="font-mono">{d.valor}</span>
                              <span className="text-ink-soft">{d.direcao}</span>
                              <span className="text-ink">“{d.descricao}”</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  ) : null}
                  {strategy.cruzamento?.ressalvas.map((r, i) => (
                    <p key={i} className="mt-1 text-xs text-ink-soft">
                      {r}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {profile && (
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-display text-sm font-semibold">Planilha de destino</span>
            <span className="text-xs text-ink-soft">
              estrutura lida{" "}
              {profile.source === "deterministico"
                ? "diretamente do arquivo"
                : profile.source === "ia"
                  ? "com apoio da IA (layout fora do padrão)"
                  : "pelo layout padrão"}
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            Colunas mapeadas:{" "}
            {profile.columns
              .filter((c) => c.role !== "ignorar")
              .map((c) => `${c.letter}=${c.role}`)
              .join(" · ")}
            {profile.categories.length > 0 && (
              <>
                {" "}
                · <b className="text-ink">{categorizedCount}</b> de {parsedCount} lançamentos
                receberam categoria da própria planilha
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            Ordem das datas:{" "}
            <b className="text-ink">
              {ordemPorAba(profile).length > 0
                ? ordemPorAba(profile).join(" · ")
                : describeDateOrder(profile.dateOrder)}
            </b>
            {" — "}os lançamentos novos são encaixados pela data, e não empilhados no fim.
          </p>
          {profile.warnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-saida">
              {profile.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {resumoCategoria && (
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-display text-sm font-semibold">Como a categoria foi decidida</span>
            <span className="text-xs text-ink-soft">
              {resumoCategoria.chamadasIdentidade > 0
                ? `${resumoCategoria.chamadasIdentidade} conferência${
                    resumoCategoria.chamadasIdentidade === 1 ? "" : "s"
                  } de identidade`
                : "nenhuma conferência de identidade foi necessária"}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            {[
              { n: resumoCategoria.porRegraDoUsuario, l: "Pelas suas regras", tone: "text-entrada" },
              { n: resumoCategoria.porRegraDaCasa, l: "Pelas regras da casa", tone: "" },
              { n: resumoCategoria.porIa, l: "Pelo classificador", tone: "" },
              {
                n: resumoCategoria.semCategoria,
                l: "Sem categoria",
                tone: resumoCategoria.semCategoria ? "text-saida" : "text-ink-soft",
              },
            ].map((k) => (
              <div key={k.l} className="rounded-md bg-surface-muted p-2.5">
                <div className={`font-mono text-lg font-bold ${k.tone}`}>{k.n}</div>
                <div className="text-xs text-ink-soft">{k.l}</div>
              </div>
            ))}
          </div>

          {resumoCategoria.porAgente > 0 && (
            <p className="mt-2 text-xs text-ink-soft">
              <b className="text-ink">{resumoCategoria.porAgente}</b>{" "}
              {resumoCategoria.porAgente === 1 ? "lançamento teve" : "lançamentos tiveram"} o nome
              conferido antes de a regra valer — o nome no extrato não estava escrito igual ao
              cadastrado.
              {resumoCategoria.identidadesRecusadas > 0 && (
                <>
                  {" "}
                  Outros <b className="text-ink">{resumoCategoria.identidadesRecusadas}</b> nome
                  {resumoCategoria.identidadesRecusadas === 1 ? " foi" : "s foram"} recusado
                  {resumoCategoria.identidadesRecusadas === 1 ? "" : "s"}: pareciam, mas não eram a
                  mesma pessoa.
                </>
              )}
            </p>
          )}

          {auditoriaCategoria.some((a) => a.contrariouCasa) && (
            <div className="mt-3 rounded-md border border-saida/30 bg-saida-soft/40 p-3">
              <p className="text-xs font-semibold text-ink">
                Suas regras contrariaram a regra da casa
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                A sua regra ganhou — quem conhece o negócio é você. Está aqui só para você conferir
                que é isso mesmo.
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {auditoriaCategoria
                  .filter((a) => a.contrariouCasa)
                  .slice(0, 20)
                  .map((a) => (
                    <li key={a.indice} className="flex flex-wrap gap-x-2">
                      <span className="text-ink">“{a.descricao}”</span>
                      <span className="font-mono text-ink-soft">
                        {a.porQuem} → {a.categoria}
                      </span>
                      <span className="text-ink-soft">· a casa diria: {a.contrariouCasa}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {auditoriaCategoria.some((a) => a.conflitos?.length) && (
            <div className="mt-3 rounded-md border border-saida/30 bg-saida-soft/40 p-3">
              <p className="text-xs font-semibold text-ink">Duas regras suas disputaram o mesmo lançamento</p>
              <p className="mt-1 text-xs text-ink-soft">
                Valeu a mais específica. Se não for o que você quer, ajuste ou desligue uma delas.
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {auditoriaCategoria
                  .filter((a) => a.conflitos?.length)
                  .slice(0, 20)
                  .map((a) => (
                    <li key={a.indice} className="flex flex-wrap gap-x-2">
                      <span className="text-ink">“{a.descricao}”</span>
                      <span className="font-mono text-ink-soft">
                        valeu {a.porQuem} → {a.categoria}
                      </span>
                      <span className="text-ink-soft">· também casaram: {a.conflitos?.join(", ")}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {avisosCategoria.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-saida">
              {avisosCategoria.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="space-y-3">
        <SectionTitle hint="entradas × saídas e saldo acumulado">Panorama</SectionTitle>
        <Dashboard data={dashboard} />
      </div>

      <div className="space-y-3">
        <SectionTitle>Por competência</SectionTitle>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-soft">
                <th className="p-3 font-semibold">Competência</th>
                <th className="p-3 font-semibold">Aba</th>
                <th className="p-3 font-semibold">Novos</th>
                <th className="p-3 font-semibold">Dup.</th>
                <th className="p-3 font-semibold">Inconsist.</th>
                <th className="p-3 text-right font-semibold">Entradas</th>
                <th className="p-3 text-right font-semibold">Saídas</th>
                <th className="p-3 font-semibold">Gravado</th>
              </tr>
            </thead>
            <tbody>
              {report.competences.map((c) => (
                <tr key={c.competenceKey} className="border-t border-line">
                  <td className="p-3">{c.competenceKey}</td>
                  <td className="p-3 font-display font-semibold">{c.targetSheet}</td>
                  <td className="p-3 font-mono text-entrada">{c.novos.length}</td>
                  <td className="p-3 font-mono text-ink-soft">{c.duplicados}</td>
                  <td className={`p-3 font-mono ${c.inconsistencias.length ? "text-saida" : "text-ink-soft"}`}>
                    {c.inconsistencias.length}
                  </td>
                  <td className="p-3 text-right font-mono text-entrada">{formatCents(c.totalEntradaCents)}</td>
                  <td className="p-3 text-right font-mono text-saida">{formatCents(c.totalSaidaCents)}</td>
                  <td className="p-3">
                    {c.writtenToLocal ? (
                      <span className="rounded-pill bg-entrada-soft px-2 py-0.5 text-xs font-semibold text-entrada">ok</span>
                    ) : (
                      <span className="rounded-pill bg-saida-soft px-2 py-0.5 text-xs font-semibold text-saida">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {report.competences.some((c) => c.avisos.length > 0) && (
          <Card className="p-4">
            <p className="text-sm font-semibold text-ink">Observações sobre a gravação</p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-saida">
              {report.competences.flatMap((c) =>
                c.avisos.map((a, i) => <li key={`${c.competenceKey}-${i}`}>{a}</li>),
              )}
            </ul>
          </Card>
        )}

        {report.competences.map((c) => (
          <details key={c.competenceKey} className="group">
            <summary className="flex cursor-pointer items-center gap-2 text-sm text-cofre">
              <span className="competence-tag">{c.targetSheet}</span>
              {c.novos.length} novos lançamentos
            </summary>
            <Card className="mt-2 overflow-hidden">
              <table className="w-full text-sm">
                <tbody>
                  {c.novos.slice(0, 300).map((tx, i) => (
                    <tr key={i} className="border-t border-line first:border-t-0">
                      <td className="w-24 p-2.5 font-mono text-xs text-ink-soft">{toBr(tx.date)}</td>
                      <td className="p-2.5">{tx.description}</td>
                      <td className="w-32 p-2.5 text-right font-mono">
                        <span className="inline-flex items-center gap-1.5">
                          <DirectionSign direction={tx.direction} />
                          <span className={tx.direction === "credit" ? "text-entrada" : "text-saida"}>
                            {formatCents(tx.amount.cents)}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </details>
        ))}
      </div>

      <Card className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="text-xs text-ink-soft">
          Backup imutável antes da escrita: <span className="font-mono">{report.backupPath || "—"}</span>
        </div>
        <DownloadButton
          variant="primary"
          label="⬇ Baixar planilha atualizada (.xlsx)"
          fileName={outName}
          state={dl}
          hint="O arquivo é montado na hora — a barra mostra o andamento."
          onStart={() => {
            if (!serialize) return;
            void dl.start(outName, (onProgress) => serialize(onProgress));
          }}
        />
      </Card>
    </div>
  );
}
