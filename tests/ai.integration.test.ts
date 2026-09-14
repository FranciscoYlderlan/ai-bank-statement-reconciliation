import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  AiClient,
  AiExtractionRequest,
} from "../src/application/ports";
import {
  AiStatementParser,
  PageTextExtractor,
} from "../src/adapters/ai/aiStatementParser";
import { competenceOf, competenceKey } from "../src/domain/competence";

/**
 * TESTE DE INTEGRACAO — OPCIONAL, NAO roda em `npm test` por padrao (custo +
 * nao-determinismo). Roda o PIPELINE REAL (`AiStatementParser`) contra os PDFs
 * de calibracao, com a API OpenAI de verdade — mesma logica de producao.
 *
 * PowerShell:
 *   $env:AI_INTEGRATION="1"; $env:OPENAI_API_KEY="sk-..."; $env:OPENAI_MODEL="gpt-4o"
 *   $env:STONE_PDF_A="C:\...\extrato-80F8...pdf"
 *   $env:STONE_PDF_B="C:\...\extrato-7A9B...pdf"
 *   $env:PAGSEGURO_PDF="C:\...\15-07-2026_14-08-2026.pdf"
 *   npx vitest run tests/ai.integration.test.ts
 */

const enabled = !!process.env.AI_INTEGRATION && !!process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o";

/** Cliente OpenAI para node (fetch) — implementa a mesma port AiClient. */
class OpenAiNodeClient implements AiClient {
  async complete(req: AiExtractionRequest): Promise<string> {
    const content: unknown[] = [{ type: "text", text: req.userPrompt }];
    if (req.document) {
      content.push({
        type: "file",
        file: { filename: req.document.fileName, file_data: `data:${req.document.mime};base64,${req.document.base64}` },
      });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as any;
    return json.choices?.[0]?.message?.content ?? "";
  }
  async testConnection() {
    return { ok: true, message: "ok" };
  }
}

/** Extrai texto por pagina via pdf.js (node/legacy). */
class NodePdfPages implements PageTextExtractor {
  async extractPages(bytes: Uint8Array): Promise<string[]> {
    const doc = await (pdfjs as any).getDocument({ data: bytes, useSystemFonts: true }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const byY = new Map<number, { x: number; s: string }[]>();
      for (const it of content.items as any[]) {
        if (!it.str?.trim()) continue;
        const y = Math.round(it.transform[5]);
        const arr = byY.get(y) ?? [];
        arr.push({ x: it.transform[4], s: it.str });
        byY.set(y, arr);
      }
      const lines = [...byY.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((z) => z.s).join(" "));
      pages.push(lines.join("\n"));
    }
    return pages;
  }
}

function makeParser() {
  return new AiStatementParser({
    client: new OpenAiNodeClient(),
    resolveConfig: () => ({ provider: "openai", model, supportsDocument: true }),
    pdfText: new NodePdfPages(),
  });
}

describe.skipIf(!enabled)("Integracao IA — pipeline real sobre extratos de calibracao", () => {
  const cases = [
    { env: "STONE_PDF_A", label: "Stone (mai/2026)", min: 100 },
    { env: "STONE_PDF_B", label: "Stone (jul-ago/2026)", min: 100 },
    { env: "PAGSEGURO_PDF", label: "PagSeguro", min: 15 },
  ];

  for (const c of cases) {
    const path = process.env[c.env];
    it.skipIf(!path || !existsSync(path!))(
      `extrai ${c.label} sem linhas de saldo e com dados validos`,
      async () => {
        const bytes = new Uint8Array(readFileSync(path!));
        const txs = await makeParser().parse({ fileName: `${c.label}.pdf`, bytes });

        expect(txs.length).toBeGreaterThanOrEqual(c.min);
        // saldo nunca virou transacao
        expect(txs.every((t) => !/saldo/i.test(t.description))).toBe(true);
        // valores positivos, direcao valida
        expect(txs.every((t) => t.amount.cents >= 0)).toBe(true);
        expect(txs.every((t) => t.direction === "credit" || t.direction === "debit")).toBe(true);
        // ha entradas E saidas (o modelo nao colapsou tudo numa direcao)
        expect(txs.some((t) => t.direction === "credit")).toBe(true);
        expect(txs.some((t) => t.direction === "debit")).toBe(true);
        // competencias coerentes
        const comps = new Set(txs.map((t) => competenceKey(competenceOf(t.date))));
        expect(comps.size).toBeGreaterThanOrEqual(1);
      },
      180_000,
    );
  }
});
