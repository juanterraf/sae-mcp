import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { logInfo, logWarn } from "./logger.js";

const execFileP = promisify(execFile);

// OCR vía binarios del sistema: pdftoppm (poppler-utils) rasteriza el PDF y
// tesseract reconoce el texto. Si no están instalados, ocrPdf devuelve null y
// el caller reporta el PDF como escaneado sin texto (comportamiento previo).
// En el VPS: apt install poppler-utils tesseract-ocr tesseract-ocr-spa

// Tope de páginas a rasterizar: un acta típica tiene 1-5; esto evita que un
// PDF enorme cuelgue la request del MCP.
const MAX_PAGINAS = 15;
// 200 dpi equilibra precisión de tesseract (ideal 300) contra tiempo de CPU
// por página en el VPS.
const DPI = 200;
const TIMEOUT_MS = 60_000;
const CONCURRENCIA = 2;

let disponibilidad: Promise<boolean> | null = null;

async function hayBinario(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args, { timeout: 10_000 });
    return true;
  } catch (err) {
    // Solo ENOENT significa "no instalado"; otros errores (exit code raro de
    // --help, etc.) indican que el binario existe.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function ocrDisponible(): Promise<boolean> {
  if (process.env.SAE_OCR === "0") return Promise.resolve(false);
  disponibilidad ??= (async () => {
    const ok = (await hayBinario("pdftoppm", ["-v"])) && (await hayBinario("tesseract", ["--version"]));
    if (!ok) logWarn("sae.ocr.no_disponible", { hint: "instalar poppler-utils y tesseract-ocr" });
    return ok;
  })();
  return disponibilidad;
}

export type OcrResult = { text: string; paginasOcr: number; truncado: boolean };

// Rasteriza el PDF y corre tesseract página por página. Devuelve null si los
// binarios no están disponibles. Puede tirar si pdftoppm/tesseract fallan.
export async function ocrPdf(buffer: Buffer, totalPaginas: number): Promise<OcrResult | null> {
  if (!(await ocrDisponible())) return null;
  const dir = await mkdtemp(join(tmpdir(), "sae-ocr-"));
  try {
    const pdfPath = join(dir, "doc.pdf");
    await writeFile(pdfPath, buffer);
    await execFileP(
      "pdftoppm",
      ["-r", String(DPI), "-gray", "-png", "-l", String(MAX_PAGINAS), pdfPath, join(dir, "pg")],
      { timeout: TIMEOUT_MS * 2 },
    );
    const paginas = (await readdir(dir)).filter((f) => f.startsWith("pg") && f.endsWith(".png")).sort();
    // Tesseract es mono-hilo y CPU-bound: de a CONCURRENCIA páginas a la vez
    // recorta el tiempo total sin saturar el VPS (2 vCPU).
    const partes: string[] = new Array(paginas.length);
    let siguiente = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCIA, paginas.length) }, async () => {
        while (siguiente < paginas.length) {
          const i = siguiente++;
          partes[i] = await ocrImagen(join(dir, paginas[i]));
        }
      }),
    );
    const text = partes
      .join("\n\n")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    logInfo("sae.ocr.ok", { paginas: paginas.length, chars: text.length });
    return { text, paginasOcr: paginas.length, truncado: totalPaginas > paginas.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Corre tesseract en español; si el idioma spa no está instalado, reintenta con
// el default (eng) antes de rendirse.
async function ocrImagen(path: string): Promise<string> {
  const opts = { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 };
  try {
    const { stdout } = await execFileP("tesseract", [path, "stdout", "-l", "spa"], opts);
    return stdout.trim();
  } catch (err) {
    logWarn("sae.ocr.spa_fallo", { error: err instanceof Error ? err.message : String(err) });
    const { stdout } = await execFileP("tesseract", [path, "stdout"], opts);
    return stdout.trim();
  }
}
