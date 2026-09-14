import { useState } from "react";
import { Button, Card } from "./ui";
import { RuleSet, chaveSugestao, dispensarSugestao, removerRegra, salvarRegra } from "../../domain/ruleSet";
import { SugestaoDeRegra, regraDaSugestao, tituloDe } from "../../domain/ruleMining";
import { UserRule, problemasDaRegra } from "../../domain/userRules";
import { MotivoEscolha } from "../../domain/ruleSet";
import { optionKey } from "../../domain/listColumns";
import { agoraIso, novoId } from "../ids";

/**
 * O PAINEL DE REGRAS — o acordeao que aparece na tela do extrato, depois que a
 * planilha foi lida e antes de conciliar.
 *
 * Duas listas, e a diferenca entre elas e proposital:
 *
 *  - REGRAS DEFINIDAS fica ABERTA. E o que o dono ensinou, e ele tem de bater o
 *    olho nisso a cada conciliacao. E o que impede a regra de envelhecer: a
 *    funcionaria que saiu da empresa aparece ali, na frente dele, todo mes.
 *  - PADROES OBSERVADOS fica FECHADA. Sao coisas que NINGUEM pediu — o sistema
 *    achou no historico dele. Sugestao que se impoe vira ruido; sugestao que
 *    espera ser aberta vira ajuda.
 *
 * Nada aqui decide nada: converter uma sugestao em regra e um clique DELE.
 */

export interface RulesPanelProps {
  carteira: RuleSet;
  sugestoes: SugestaoDeRegra[];
  /** categorias validas da planilha, na grafia exata. */
  categorias: string[];
  /** como a carteira foi escolhida — "ultima" e palpite e precisa aparecer. */
  motivo: MotivoEscolha;
  onChange: (carteira: RuleSet) => void;
  onSalvar: () => void;
  salvando?: boolean;
  salvo?: boolean;
  erro?: string | null;
}

const SETA = (aberto: boolean) => (aberto ? "▾" : "▸");

export function RulesPanel(props: RulesPanelProps) {
  const { carteira, sugestoes, categorias, motivo } = props;
  const [abertoRegras, setAbertoRegras] = useState(true);
  const [abertoSugestoes, setAbertoSugestoes] = useState(false);
  const [novaAberta, setNovaAberta] = useState(false);

  const agora = () => agoraIso();
  const ativas = carteira.regras.filter((r) => r.ativo).length;

  function trocar(c: RuleSet) {
    props.onChange(c);
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-sm font-semibold">Regras desta planilha</span>
        <span className="text-xs text-ink-soft">
          {carteira.nome} · {ativas} {ativas === 1 ? "regra ativa" : "regras ativas"}
        </span>
      </div>

      {motivo === "ultima" && (
        <p className="mt-2 rounded-md border border-saida/30 bg-saida-soft/40 p-2.5 text-xs text-ink">
          Não reconheci esta planilha, então abri a última carteira usada
          (<b>{carteira.nome}</b>). Se não for essa, desligue as regras antes de conciliar — regra de
          outro cliente na planilha errada é o pior que pode acontecer aqui.
        </p>
      )}
      {motivo === "nova" && (
        <p className="mt-2 text-xs text-ink-soft">
          Primeira vez com esta planilha: a carteira nasce vazia. O que você cadastrar aqui vale só
          para ela.
        </p>
      )}

      {/* ── Regras definidas — sempre aberta ─────────────────────────────── */}
      <button
        type="button"
        className="mt-3 flex w-full items-center gap-2 text-left text-sm font-semibold text-cofre"
        onClick={() => setAbertoRegras((v) => !v)}
      >
        <span>{SETA(abertoRegras)}</span>
        Regras definidas ({carteira.regras.length})
      </button>

      {abertoRegras && (
        <div className="mt-2 space-y-1.5">
          {carteira.regras.length === 0 && (
            <p className="text-xs text-ink-soft">
              Nenhuma ainda. Uma regra é você me ensinar o que só você sabe: “sempre que sair para a
              Paulo Valente, é salário”.
            </p>
          )}

          {carteira.regras.map((r) => (
            <LinhaRegra
              key={r.id}
              regra={r}
              categorias={categorias}
              onToggle={() => trocar(salvarRegra(carteira, { ...r, ativo: !r.ativo }, agora()))}
              onRemover={() => trocar(removerRegra(carteira, r.id, agora()))}
            />
          ))}

          {novaAberta ? (
            <FormularioRegra
              categorias={categorias}
              onCancelar={() => setNovaAberta(false)}
              onCriar={(r) => {
                trocar(salvarRegra(carteira, r, agora()));
                setNovaAberta(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="text-xs font-semibold text-cofre"
              onClick={() => setNovaAberta(true)}
            >
              + adicionar regra
            </button>
          )}
        </div>
      )}

      {/* ── Padrões observados — colapsada ───────────────────────────────── */}
      {sugestoes.length > 0 && (
        <>
          <button
            type="button"
            className="mt-4 flex w-full items-center gap-2 text-left text-sm font-semibold text-ink-soft"
            onClick={() => setAbertoSugestoes((v) => !v)}
          >
            <span>{SETA(abertoSugestoes)}</span>
            Padrões observados ({sugestoes.length})
          </button>

          {abertoSugestoes && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-ink-soft">
                Achei isto no histórico da sua própria planilha. Não são regras — só viram regra se
                você mandar.
              </p>
              {sugestoes.map((s) => (
                <LinhaSugestao
                  key={s.chave}
                  sugestao={s}
                  onAceitar={() =>
                    trocar(salvarRegra(carteira, regraDaSugestao(s, novoId("regra")), agora()))
                  }
                  onIgnorar={() => trocar(dispensarSugestao(carteira, s.chave, agora()))}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-xs text-ink-soft">
          {props.erro
            ? <span className="text-saida">{props.erro}</span>
            : props.salvo
              ? "Regras salvas."
              : "As regras valem já nesta conciliação."}
        </span>
        <Button variant="subtle" onClick={props.onSalvar} disabled={props.salvando}>
          {props.salvando ? "Salvando…" : "Salvar regras"}
        </Button>
      </div>
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function Direcao({ d }: { d: "entrada" | "saida" }) {
  return (
    <span
      className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase ${
        d === "entrada" ? "bg-entrada-soft text-entrada" : "bg-saida-soft text-saida"
      }`}
    >
      {d}
    </span>
  );
}

function condicaoTexto(r: UserRule): string {
  const partes: string[] = [];
  if (r.quando.nome) partes.push(tituloDe(r.quando.nome));
  if (r.quando.contem?.length) partes.push(`contém “${r.quando.contem.join("” e “")}”`);
  if (r.quando.valorCents) {
    const f = (c?: number) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
    const { min, max } = r.quando.valorCents;
    partes.push(
      min != null && max != null
        ? `entre R$ ${f(min)} e R$ ${f(max)}`
        : min != null
          ? `a partir de R$ ${f(min)}`
          : `até R$ ${f(max)}`,
    );
  }
  return partes.join(" · ");
}

function LinhaRegra(props: {
  regra: UserRule;
  categorias: string[];
  onToggle: () => void;
  onRemover: () => void;
}) {
  const { regra } = props;
  const naPlanilha = props.categorias.find(
    (c) => optionKey(c) === optionKey(regra.categoriaChave),
  );
  const problemas = problemasDaRegra(regra);

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-md border border-line p-2.5 text-xs ${
        regra.ativo ? "" : "opacity-50"
      }`}
    >
      <Direcao d={regra.direcao} />
      <span className="text-ink">{condicaoTexto(regra)}</span>
      <span className="text-ink-soft">→</span>
      <span className="font-mono text-ink">{naPlanilha ?? regra.categoriaChave}</span>
      {regra.origem === "minerada" && (
        <span className="text-[10px] text-ink-soft">(do seu histórico)</span>
      )}
      {!naPlanilha && (
        <span className="text-[10px] text-saida">
          esta planilha não tem essa categoria — a regra não se aplica aqui
        </span>
      )}
      {problemas.length > 0 && <span className="text-[10px] text-saida">{problemas[0]}</span>}
      <span className="ml-auto flex items-center gap-2">
        <button type="button" className="font-semibold text-cofre" onClick={props.onToggle}>
          {regra.ativo ? "desligar" : "ligar"}
        </button>
        <button type="button" className="text-ink-soft" onClick={props.onRemover}>
          excluir
        </button>
      </span>
    </div>
  );
}

function LinhaSugestao(props: {
  sugestao: SugestaoDeRegra;
  onAceitar: () => void;
  onIgnorar: () => void;
}) {
  const s = props.sugestao;
  return (
    <div className="rounded-md border border-line bg-surface-muted p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Direcao d={s.direcao} />
        <span className="text-ink">{tituloDe(s.nome)}</span>
        <span className="text-ink-soft">→</span>
        <span className="font-mono text-ink">{s.categoria}</span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className="font-semibold text-cofre" onClick={props.onAceitar}>
            virar regra
          </button>
          <button type="button" className="text-ink-soft" onClick={props.onIgnorar}>
            ignorar
          </button>
        </span>
      </div>
      <p className="mt-1 text-[11px] text-ink-soft">
        {s.ocorrencias} lançamentos, sempre nessa categoria
        {s.abas.length > 0 && <> · {s.abas.join(", ")}</>}
        {s.exemplos[0] && <> · ex.: “{s.exemplos[0]}”</>}
      </p>
      {s.contrariaCasa && (
        <p className="mt-1 text-[11px] text-saida">
          sem esta regra, o sistema classificaria como “{s.contrariaCasa}”
        </p>
      )}
    </div>
  );
}

function FormularioRegra(props: {
  categorias: string[];
  onCriar: (r: UserRule) => void;
  onCancelar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [categoria, setCategoria] = useState(props.categorias[0] ?? "");

  const candidata: UserRule = {
    id: "previa",
    ativo: true,
    rotulo: `${categoria.trim()} – ${nome.trim()}`,
    direcao,
    quando: { nome: nome.trim() },
    categoriaChave: optionKey(categoria),
    origem: "manual",
  };
  const problemas = nome.trim() ? problemasDaRegra(candidata) : [];
  const pode = nome.trim().length > 0 && categoria.length > 0 && problemas.length === 0;

  return (
    <div className="space-y-2 rounded-md border border-line p-2.5">
      <div className="flex flex-wrap gap-2">
        <select
          className="rounded-md border border-line bg-surface p-1.5 text-xs"
          value={direcao}
          onChange={(e) => setDirecao(e.target.value as "entrada" | "saida")}
        >
          <option value="saida">Quando SAIR para</option>
          <option value="entrada">Quando ENTRAR de</option>
        </select>
        <input
          className="min-w-[14rem] flex-1 rounded-md border border-line bg-surface p-1.5 text-xs"
          placeholder="nome da pessoa ou empresa (ex.: Paulo Valente)"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
        />
        <select
          className="rounded-md border border-line bg-surface p-1.5 text-xs"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
        >
          {props.categorias.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {problemas.length > 0 && <p className="text-[11px] text-saida">{problemas[0]}</p>}
      <div className="flex gap-2">
        <Button
          variant="subtle"
          disabled={!pode}
          onClick={() => props.onCriar({ ...candidata, id: novoId("regra") })}
        >
          Criar regra
        </Button>
        <button type="button" className="text-xs text-ink-soft" onClick={props.onCancelar}>
          cancelar
        </button>
      </div>
    </div>
  );
}
