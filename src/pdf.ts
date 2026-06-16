import { createRequire } from "node:module";

// pdf-parse es CommonJS y su `index.js` corre un "debug mode" al importarse
// (intenta leer un PDF de prueba y crashea en ESM). Importamos el módulo interno
// `pdf-parse/lib/pdf-parse.js` vía createRequire para esquivar ese wrapper y, de
// paso, tiparlo (el paquete no trae tipos).
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  buf: Buffer,
  opts?: Record<string, unknown>,
) => Promise<{ text: string; numpages: number }>;

export type PdfText = { text: string; pages: number };

// Extrae el texto digital de un PDF. NO hace OCR: si el PDF es una imagen
// escaneada, `text` viene vacío o casi vacío (el caller lo reporta como tal).
export async function extractPdfText(buffer: Buffer): Promise<PdfText> {
  const data = await pdfParse(buffer);
  const text = (data.text ?? "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { text, pages: data.numpages ?? 0 };
}
