import { unescapeXml } from "./xmlCells";

/**
 * Formatos numericos do `styles.xml` (OOXML) — o que decide se uma celula
 * APARECE como data, como dinheiro ou como numero cru.
 *
 * Isso importa porque gravar o numero certo nao basta: o serial 46169 e a data
 * 27/05/2026 sao o MESMO valor, e o que diferencia os dois na tela e o
 * `numFmtId` do estilo da celula. Numa celula sem formato de data, o usuario le
 * "46169" e conclui, com razao, que o sistema gravou a data errada.
 */

/** Um estilo de celula (`cellXfs`) reduzido ao que interessa aqui. */
export interface StyleFormat {
  numFmtId: number;
  /** codigo de formato ("dd/mm/yyyy", "R$ #,##0.00"), vazio quando builtin sem codigo. */
  code: string;
}

/** IDs builtin de data/hora do OOXML (o arquivo nao traz o formatCode deles). */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57, 58]);
/** IDs builtin de moeda/contabil. */
const BUILTIN_MONEY_IDS = new Set([5, 6, 7, 8, 42, 43, 44]);

/** Bloco `<cellXfs>` inteiro (ou string vazia se o arquivo nao tiver). */
function cellXfsBlock(stylesXml: string): string {
  return stylesXml.match(/<cellXfs[^>]*>[\s\S]*?<\/cellXfs>/)?.[0] ?? "";
}

/**
 * Elementos `<xf>` de `cellXfs`, NA ORDEM — inclusive os que trazem filhos
 * (`<alignment/>`, `<protection/>`) e os que omitem `numFmtId`.
 *
 * A ordem e a identidade: `s="7"` significa "o 8o <xf> desta lista". Pular um
 * elemento na leitura desloca TODOS os indices seguintes, e a celula passa a
 * ser avaliada com o formato de outra — foi por ai que uma coluna de data
 * acabou classificada como "sem formato de data".
 */
function cellXfElements(block: string): string[] {
  return [...block.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
}

/** Le `cellXfs` e devolve o formato de cada indice de estilo (`s="N"`). */
export function buildStyleFormats(stylesXml: string): StyleFormat[] {
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*?\/>/g)) {
    const id = Number(m[0].match(/numFmtId="(\d+)"/)?.[1]);
    const code = m[0].match(/formatCode="([^"]*)"/)?.[1];
    if (Number.isFinite(id) && code !== undefined) custom.set(id, unescapeXml(code));
  }
  return cellXfElements(cellXfsBlock(stylesXml)).map((xf) => {
    // `numFmtId` e OPCIONAL no OOXML; ausente significa 0 (Geral).
    const numFmtId = Number(xf.match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    return { numFmtId, code: custom.get(numFmtId) ?? "" };
  });
}

/** O formato faz a celula ser exibida como DATA? */
export function isDateFormat(f: StyleFormat | undefined): boolean {
  if (!f) return false;
  if (BUILTIN_DATE_IDS.has(f.numFmtId)) return true;
  if (!f.code) return false;
  // remove literais entre aspas e escapes antes de procurar marcadores de data
  const code = f.code.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  if (/r\$/i.test(code)) return false;
  return /(dd?|yy|mmm)/i.test(code) && /[dy]/i.test(code);
}

/** O formato faz a celula ser exibida como DINHEIRO? */
export function isMoneyFormat(f: StyleFormat | undefined): boolean {
  if (!f) return false;
  if (BUILTIN_MONEY_IDS.has(f.numFmtId)) return true;
  if (!f.code) return false;
  return /r\$|\$|#,##0/i.test(f.code);
}

/** Classificacao usada pela inspecao da planilha. */
export function formatKind(f: StyleFormat | undefined): "date" | "money" | null {
  if (isDateFormat(f)) return "date";
  if (isMoneyFormat(f)) return "money";
  return null;
}

/** `numFmtId` builtin de data curta — "dd/mm/yyyy" na configuracao pt-BR. */
export const DATE_NUMFMT_ID = 14;

export interface EnsureDateStyleResult {
  /** styles.xml resultante (igual ao de entrada quando nada mudou). */
  stylesXml: string;
  /** indice de estilo GARANTIDAMENTE com formato de data. */
  index: number;
  /** true se um novo `<xf>` precisou ser acrescentado. */
  changed: boolean;
}

/**
 * Devolve um indice de estilo que EXIBE data, partindo do estilo herdado.
 *
 * Esta e a diferenca entre supor e garantir. O valor de uma data no Excel e um
 * numero (46201 = 20/08/2026); o que faz o usuario ler uma data e o `numFmtId`
 * do estilo da celula. Herdar o estilo da coluna funciona ate a celula de
 * destino ter estilo proprio SEM formato de data — e ai o serial aparece cru.
 *
 * Se o estilo herdado ja exibe data, ele e usado tal como esta. Se nao, o `<xf>`
 * base e CLONADO com `numFmtId=14`, preservando fonte, borda, preenchimento e
 * alinhamento: a celula continua com a cara da coluna, so passa a mostrar data.
 * O clone e ACRESCENTADO ao fim de `cellXfs` — nenhum estilo existente e
 * alterado, entao nenhuma outra celula da planilha muda de aparencia.
 */
export function ensureDateStyle(
  stylesXml: string,
  baseIndex: number | null,
): EnsureDateStyleResult {
  const block = cellXfsBlock(stylesXml);
  const elements = cellXfElements(block);
  const formats = buildStyleFormats(stylesXml);

  const baseValido =
    baseIndex != null && Number.isInteger(baseIndex) && baseIndex >= 0 && baseIndex < elements.length;
  if (baseValido && isDateFormat(formats[baseIndex as number])) {
    return { stylesXml, index: baseIndex as number, changed: false };
  }
  if (!block) {
    // Sem cellXfs nao ha o que clonar nem onde inserir: devolve o que veio e
    // deixa o chamador decidir (na pratica ele grava a data como texto).
    return { stylesXml, index: baseIndex ?? 0, changed: false };
  }

  const base = baseValido
    ? (elements[baseIndex as number] as string)
    : '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
  const clone = withDateFormat(base);

  // Ja existe um estilo identico? Reaproveita — rodar a conciliacao dez vezes
  // nao pode inchar o styles.xml com dez copias do mesmo <xf>.
  const igual = elements.findIndex((el) => el === clone);
  if (igual !== -1) return { stylesXml, index: igual, changed: false };

  const novoBlock = block.replace(/<\/cellXfs>$/, `${clone}</cellXfs>`);
  const comCount = novoBlock.replace(/(<cellXfs[^>]*?)count="\d+"/, (_m, head) =>
    `${head}count="${elements.length + 1}"`,
  );
  return {
    stylesXml: stylesXml.replace(block, comCount),
    index: elements.length,
    changed: true,
  };
}

/** Copia um `<xf>` trocando o formato numerico pelo de data curta. */
function withDateFormat(xf: string): string {
  let out = xf;
  out = /numFmtId="\d+"/.test(out)
    ? out.replace(/numFmtId="\d+"/, `numFmtId="${DATE_NUMFMT_ID}"`)
    : out.replace(/<xf\b/, `<xf numFmtId="${DATE_NUMFMT_ID}"`);
  if (!/applyNumberFormat="1"/.test(out)) {
    out = out.replace(/<xf\b([^>]*?)(\/?)>/, (_m, attrs: string, close: string) =>
      `<xf${attrs} applyNumberFormat="1"${close}>`,
    );
  }
  return out;
}

/** Codigo legivel do formato (para o dump da inspecao). */
export function formatCode(f: StyleFormat | undefined): string {
  if (!f) return "";
  if (f.code) return f.code;
  if (BUILTIN_DATE_IDS.has(f.numFmtId)) return "dd/mm/yyyy";
  if (BUILTIN_MONEY_IDS.has(f.numFmtId)) return "R$ #,##0.00";
  return "";
}
