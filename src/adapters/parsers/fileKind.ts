/**
 * QUE ARQUIVO E ESTE — e como transforma-lo em texto.
 *
 * O roteador de leitura (parsers/hybrid) e o pipeline de IA precisam responder
 * a mesma pergunta antes de qualquer outra coisa: o usuario soltou um PDF, uma
 * planilha, um OFX ou um CSV? A resposta tem de vir dos BYTES, nao do nome do
 * arquivo — e por dois motivos concretos, os dois vistos em arquivo real:
 *
 *  - o extrato que a Stone chama de `.xls` NAO e um .xls. E um .xlsx (OOXML,
 *    um ZIP) com a extensao antiga. Quem confia na extensao tenta ler BIFF e
 *    falha; quem confia nos bytes ve o `PK\x03\x04` e acerta.
 *  - o OFX da Stone declara `CHARSET:1252` no cabecalho e vem, de fato, em
 *    UTF-8. Quem obedece ao cabecalho troca todo acento por lixo — "Transferência"
 *    vira "TransferÃªncia" —, e a descricao gravada na planilha sai suja.
 *
 * Por isso a deteccao aqui e sempre por conteudo, com a extensao servindo no
 * maximo de desempate. `decodeText` faz o mesmo com a codificacao: tenta UTF-8
 * em modo ESTRITO e so cai para Windows-1252 quando o UTF-8 e impossivel.
 */

/**
 * As familias de arquivo que o sistema sabe distinguir.
 *
 * `xls-legacy` existe separado de `spreadsheet` de proposito: e o formato BIFF
 * antigo (OLE2), que nao da para ler sem uma biblioteca inteira so para ele.
 * Reconhece-lo permite explicar o problema ao usuario em uma frase — "salve
 * como .xlsx" — em vez de entregar bytes binarios para a IA transcrever.
 */
export type StatementFileKind =
  | "pdf"
  | "spreadsheet" // OOXML (.xlsx, e o ".xls" que na verdade e xlsx)
  | "xls-legacy" // BIFF/OLE2 — nao suportado, mas reconhecido
  | "ofx"
  | "image"
  | "text"; // CSV, TSV e qualquer texto

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** Le os primeiros bytes como ASCII, para procurar assinaturas textuais. */
function asciiHead(bytes: Uint8Array, len: number): string {
  const n = Math.min(len, bytes.length);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function extensionOf(fileName: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * De que familia e este arquivo? Decide pelos BYTES; o nome do arquivo so
 * entra onde os bytes sao ambiguos (um ZIP que nao anuncia ser planilha).
 */
export function sniffFileKind(bytes: Uint8Array, fileName = ""): StatementFileKind {
  if (bytes.byteLength === 0) return "text";

  if (asciiHead(bytes, 5).startsWith("%PDF")) return "pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image";
  // OLE2 Compound File: .xls antigo, .doc, .ppt
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return "xls-legacy";

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // ZIP. Uma planilha OOXML sempre carrega entradas sob "xl/"; o nome delas
    // aparece em texto puro no proprio ZIP, entao basta olhar. A extensao
    // decide o empate quando o cabecalho local nao mostra nada (arquivo
    // grande, com o diretorio central longe do inicio).
    const head = asciiHead(bytes, 4096);
    if (head.includes("xl/")) return "spreadsheet";
    const ext = extensionOf(fileName);
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") return "spreadsheet";
    return "text";
  }

  // OFX: a versao 1.x abre com o cabecalho SGML "OFXHEADER:"; a 2.x e XML e
  // traz a tag <OFX> logo depois do prologo. Ambas cabem nos primeiros KB.
  const head = asciiHead(bytes, 2048).toUpperCase();
  if (head.includes("OFXHEADER") || head.includes("<OFX>")) return "ofx";

  return "text";
}

/**
 * Bytes → texto, decidindo a codificacao pelo CONTEUDO.
 *
 * A ordem importa: BOM manda em qualquer caso; sem BOM, UTF-8 e testado em
 * modo estrito (`fatal`), o que so passa quando a sequencia e de fato UTF-8
 * valida; falhando, Windows-1252, que e o que os bancos brasileiros usam
 * quando nao usam UTF-8. Nenhum cabecalho de arquivo e consultado — o OFX da
 * Stone anuncia 1252 e entrega UTF-8, e obedece-lo estragaria todo acento.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
