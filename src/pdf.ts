import { createRequire } from "node:module";

import { logError } from "./logger.js";
import { ocrPdf } from "./ocr.js";

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

// Por debajo de esta densidad de texto digital por página asumimos que el PDF
// es un escaneo (las actas de oficiales de justicia suelen venir así).
const UMBRAL_CHARS_POR_PAGINA = 40;

export type PdfTextOcr = PdfText & {
  // "no": texto digital normal · "usado": el texto salió del OCR ·
  // "no_disponible": parecía escaneado pero faltan los binarios de OCR ·
  // "fallo": el OCR corrió pero no reconoció texto (o tiró error)
  ocr: "no" | "usado" | "no_disponible" | "fallo";
  ocrTruncado?: boolean;
};

// Extracción con fallback: primero texto digital; si viene vacío o casi vacío
// (escaneo), intenta OCR con tesseract. Nunca tira por el OCR: degrada al
// texto digital que haya.
export async function extractPdfTextConOcr(buffer: Buffer): Promise<PdfTextOcr> {
  const digital = await extractPdfText(buffer);
  const densidad = digital.text.replace(/\s+/gu, "").length;
  if (densidad >= UMBRAL_CHARS_POR_PAGINA * Math.max(digital.pages, 1)) {
    return { ...digital, ocr: "no" };
  }
  try {
    const r = await ocrPdf(buffer, digital.pages);
    if (r === null) return { ...digital, ocr: "no_disponible" };
    if (r.text.replace(/\s+/gu, "").length <= densidad) {
      return { ...digital, ocr: "fallo" };
    }
    return { text: r.text, pages: digital.pages, ocr: "usado", ocrTruncado: r.truncado };
  } catch (err) {
    logError("sae.ocr.error", err);
    return { ...digital, ocr: "fallo" };
  }
}
