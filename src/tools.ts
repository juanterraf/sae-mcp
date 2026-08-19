import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  downloadBinary,
  getArchivoUrl,
  getCenters,
  getJurisdictionIdBySlug,
  getJurisdictions,
  getProceedingHistory,
  getTextoPdfUrl,
  matchFuero,
  parseSaeUrl,
  SaeError,
  type Jurisdiction,
  type SaeHistoryResponse,
} from "./sae-client.js";
import { extractPdfTextConOcr, type PdfTextOcr } from "./pdf.js";
// Solo el TIPO (se borra en runtime). El resolver (que arrastra Playwright) se
// carga con import dinámico DENTRO del handler, solo si la tool está habilitada.
// NUNCA importar resolver.js en runtime acá: el bundle "lite" no trae Playwright.
import type { Hit, ResolveOk } from "./resolver.js";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string): TextResult {
  return { content: [{ type: "text", text: t }] };
}
function errorText(t: string): TextResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

function formatHistory(h: SaeHistoryResponse, max: number): string {
  const p = h.proceeding;
  const lines: string[] = [];
  if (p) {
    lines.push(`Carátula: ${p.caratula ?? "—"}`);
    if (p.nro_expediente) lines.push(`Nº expediente: ${p.nro_expediente}`);
    const partes = [
      p.actor ? `Actor: ${p.actor}` : null,
      p.demandado ? `Demandado: ${p.demandado}` : null,
    ].filter(Boolean);
    if (partes.length) lines.push(partes.join(" · "));
    if (p.juzgado?.dscr) lines.push(`Juzgado: ${p.juzgado.dscr}`);
    if (p.tipo_proceso) lines.push(`Tipo de proceso: ${p.tipo_proceso}`);
  } else {
    lines.push("(El SAE no devolvió cabecera del expediente; va el historial de movimientos.)");
  }

  const movs = h.stories.slice(0, max);
  lines.push("", `Movimientos (${h.stories.length} total, ${movs.length} mostrados, más recientes primero):`);
  for (const s of movs) {
    const flags = [
      s.firm ? "firmada" : null,
      s.link || (s.archivos && s.archivos.length > 0) ? "con PDF/adjunto" : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`- #${s.histid} · ${s.fecha ?? "?"} · ${s.dscr}${flags ? ` [${flags}]` : ""}`);
  }
  if (h.stories.length > movs.length) {
    lines.push(`… y ${h.stories.length - movs.length} más (subí maxMovimientos para verlos).`);
  }
  lines.push(
    "",
    "Para LEER el contenido de un movimiento (proveído/sentencia/adjuntos), usá sae_traer_documento con su #histid.",
  );
  return lines.join("\n");
}

function formatResolve(r: ResolveOk, max: number): string {
  const lines: string[] = [
    `Carátula: ${r.caratula}`,
    `procid: ${r.procid} · jurisdiction: ${r.jurisdictionId} (${r.jurisdictionName})`,
    `Fuero: ${r.jurisdictionName} (id ${r.jurisdictionId})`,
  ];
  if (r.juzgado) lines.push(`Juzgado: ${r.juzgado}`);

  const movs = r.stories.slice(0, max);
  lines.push("", `Movimientos (${r.stories.length} total, ${movs.length} mostrados):`);
  for (const s of movs) lines.push(`- ${s.fecha ?? "?"} · ${s.dscr}`);

  if (r.otherMatches && r.otherMatches.length > 0) {
    const resumen = r.otherMatches.map((o) => `${o.fueroName} (${o.count} matches)`).join(", ");
    lines.push(
      "",
      `Ojo: este número también aparece en: ${resumen} — si esperabas una causa de otro fuero, repetí la búsqueda con fuero='...'.`,
    );
  }

  lines.push(
    "",
    `Tip: para futuras consultas SIN captcha usá sae_consultar_causa con procid=${r.procid} y jurisdiction=${r.jurisdictionId}.`,
  );
  return lines.join("\n");
}

// Formatea el caso ambiguo: varios expedientes para el mismo número.
function formatAmbiguous(
  number: string,
  candidates: Hit[],
  truncated: boolean | undefined,
  failed: { id: number; name: string; reason: string }[],
  notTried: string[],
): string {
  const lines: string[] = [`El número ${number} existe en más de un expediente. Candidatos:`];
  for (const c of candidates) {
    lines.push(
      `- [${c.jurisdictionName}] ${c.caratula} · ${c.juzgado ?? "—"} · nro ${c.nroExpediente || "?"} · procid ${c.procid} · jurisdiction ${c.jurisdictionId}`,
    );
  }
  if (truncated) {
    lines.push(`… (lista recortada — hay más de ${candidates.length} candidatos).`);
  }
  lines.push(
    "",
    "Para abrir uno: sae_consultar_causa con procid + jurisdiction (sin captcha). Para restringir: repetí sae_buscar_por_numero con fuero='<nombre>'.",
  );
  if (failed.length > 0) {
    lines.push(
      "",
      `No se pudo buscar en: ${failed.map((f) => `${f.name} (${f.reason})`).join(", ")}.`,
    );
  }
  if (notTried.length > 0) {
    lines.push(`Quedaron sin probar: ${notTried.join(", ")}.`);
  }
  return lines.join("\n");
}

// Formatea el caso sin resultados.
function formatNotFound(
  number: string,
  centro: number,
  searched: string[],
  failed: { id: number; name: string; reason: string }[],
  notTried: string[],
): string {
  const parts: string[] = [
    `Buscado sin resultados en: ${searched.join(", ") || "(ninguno)"}. `,
  ];
  if (failed.length > 0) {
    parts.push(`No se pudo buscar en: ${failed.map((f) => `${f.name} (${f.reason})`).join(", ")}. `);
  }
  if (notTried.length > 0) {
    parts.push(`Quedaron sin probar: ${notTried.join(", ")}. `);
  }
  parts.push(
    `Probá con otro centro (≠ ${centro}), o pasá la URL del expediente a sae_consultar_causa ` +
      "(ej: https://consultaexpedientes.justucuman.gov.ar/<fuero>/expediente/<procid>/historia).",
  );
  return parts.join("");
}

// Texto de la lista de fueros de un centro, para mensajes de error de fuero.
function fuerosDisponiblesTexto(jur: Jurisdiction[]): string {
  return jur
    .filter((j) => j.is_public !== 0)
    .map((j) => `${j.name} (slug: ${j.slug}, id ${j.id})`)
    .join("; ");
}

// Resuelve la referencia a una causa: URL del portal, o procid + jurisdiction.
async function resolveCausaRef(input: {
  url?: string;
  procid?: string;
  jurisdiction?: string;
}): Promise<{ pid: string; jid: string } | { error: string }> {
  let pid = input.procid;
  let jid = input.jurisdiction;
  if (input.url) {
    const parsed = parseSaeUrl(input.url);
    if (!parsed) {
      return { error: "No pude parsear esa URL del SAE (debe contener /expediente/<procid>/)." };
    }
    pid = parsed.procid;
    const resolved = await getJurisdictionIdBySlug(parsed.jurisdictionSlug);
    if (!resolved) {
      return { error: `No pude resolver la jurisdicción "${parsed.jurisdictionSlug}" de la URL.` };
    }
    jid = resolved;
  }
  if (!pid || !jid) return { error: "Necesito una URL del SAE, o bien procid + jurisdiction." };
  return { pid, jid };
}

// Baja un adjunto y extrae su texto. El portal a veces espera el `nombre` tal
// cual y a veces `nombre.extension`; probamos ambas variantes.
async function fetchArchivoText(
  pid: string,
  jid: string,
  histid: number,
  archivo: { nombre: string; extension: string },
): Promise<PdfTextOcr | null> {
  for (const filename of [archivo.nombre, `${archivo.nombre}.${archivo.extension}`]) {
    try {
      const u = await getArchivoUrl({ procid: pid, jurisdictionId: jid, histid, filename });
      if (!u) continue;
      const { buffer } = await downloadBinary(u);
      return await extractPdfTextConOcr(buffer);
    } catch {
      // probar la siguiente variante de nombre
    }
  }
  return null;
}

const SIN_TEXTO_SIN_OCR =
  "(sin texto extraíble — PDF escaneado y este servidor no tiene OCR instalado: faltan poppler-utils y/o tesseract-ocr)";
const SIN_TEXTO_OCR_FALLO =
  "(sin texto extraíble — PDF escaneado; el OCR corrió pero no pudo reconocer texto)";

// Arma el título y el cuerpo de una parte (proveído o adjunto) según cómo se
// obtuvo el texto (digital, OCR, o nada).
function renderParte(r: PdfTextOcr): { sufijo: string; cuerpo: string } {
  if (r.ocr === "usado") {
    const notas = ["texto reconocido por OCR de un PDF escaneado — puede contener errores"];
    if (r.ocrTruncado) notas.push("por su extensión, el OCR cubrió solo las primeras páginas");
    return { sufijo: ", OCR", cuerpo: `[${notas.join("; ")}]\n${r.text}` };
  }
  if (r.text) return { sufijo: "", cuerpo: r.text };
  return { sufijo: "", cuerpo: r.ocr === "no_disponible" ? SIN_TEXTO_SIN_OCR : SIN_TEXTO_OCR_FALLO };
}

export function registerTools(server: McpServer) {
  // --- Tool 1: consultar por URL o procid+jurisdiction (sin captcha) ---
  server.registerTool(
    "sae_consultar_causa",
    {
      title: "Consultar causa del SAE (Tucumán)",
      description:
        "Trae carátula, partes, juzgado y movimientos (actuaciones) de un expediente del SAE de Tucumán. " +
        "Pasá la URL del expediente en el portal del SAE, o procid + jurisdiction si ya los conocés. " +
        "NO requiere captcha y es confiable en cualquier entorno (local o remoto).",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "URL del expediente en el portal del SAE, ej: https://consultaexpedientes.justucuman.gov.ar/<fuero>/expediente/<procid>/historia",
          ),
        procid: z.string().optional().describe("ID del expediente (procid), si no pasás URL"),
        jurisdiction: z
          .string()
          .optional()
          .describe("ID numérico de la jurisdicción/fuero, si no pasás URL"),
        maxMovimientos: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cuántos movimientos mostrar (default 25, más recientes primero)"),
      },
    },
    async ({ url, procid, jurisdiction, maxMovimientos }) => {
      try {
        let pid = procid;
        let jid = jurisdiction;
        if (url) {
          const parsed = parseSaeUrl(url);
          if (!parsed) {
            return errorText(
              "No pude parsear esa URL. Tiene que ser del portal justucuman.gov.ar y contener /expediente/<procid>/.",
            );
          }
          pid = parsed.procid;
          jid = (await getJurisdictionIdBySlug(parsed.jurisdictionSlug)) ?? undefined;
          if (!jid) {
            return errorText(
              `No pude resolver la jurisdicción "${parsed.jurisdictionSlug}" de la URL.`,
            );
          }
        }
        if (!pid || !jid) {
          return errorText("Necesito una URL del SAE, o bien procid + jurisdiction.");
        }
        const hist = await getProceedingHistory({ procid: pid, jurisdictionId: jid });
        if (!hist.proceeding && hist.stories.length === 0) {
          return errorText(
            `El SAE no devolvió datos para procid=${pid}, jurisdiction=${jid}. Revisá que sean correctos.`,
          );
        }
        return text(formatHistory(hist, maxMovimientos ?? 25));
      } catch (err) {
        const msg = err instanceof SaeError ? err.message : err instanceof Error ? err.message : String(err);
        return errorText(`Error consultando el SAE: ${msg}`);
      }
    },
  );

  // --- Tool: traer el TEXTO de un movimiento (proveído + adjuntos) ---
  // Captcha-free (usa /history/text/download y /history/file). Extrae texto
  // digital con pdf-parse; si el PDF es un escaneo (actas de oficiales de
  // justicia, cédulas diligenciadas), cae a OCR con tesseract (ver ocr.ts).
  server.registerTool(
    "sae_traer_documento",
    {
      title: "Traer el texto de un movimiento del SAE",
      description:
        "Dado un expediente (URL o procid+jurisdiction) y el #histid de un movimiento " +
        "(lo lista sae_consultar_causa), baja el proveído y/o los adjuntos PDF de ese movimiento " +
        "y devuelve su TEXTO para leer, resumir o analizar. Extrae texto digital y, si el PDF está " +
        "escaneado (actas, cédulas diligenciadas), aplica OCR automáticamente. " +
        "NO usa captcha — anda en cualquier entorno.",
      inputSchema: {
        url: z.string().url().optional().describe("URL del expediente en el portal del SAE"),
        procid: z.string().optional().describe("procid, si no pasás URL"),
        jurisdiction: z.string().optional().describe("ID de jurisdicción, si no pasás URL"),
        histid: z
          .number()
          .int()
          .describe("ID del movimiento (#histid de la lista de sae_consultar_causa)"),
        incluirAdjuntos: z
          .boolean()
          .optional()
          .describe("Incluir los PDF adjuntos del movimiento (default true)"),
        maxCaracteres: z
          .number()
          .int()
          .min(1000)
          .max(120000)
          .optional()
          .describe("Tope de texto a devolver (default 40000)"),
      },
    },
    async ({ url, procid, jurisdiction, histid, incluirAdjuntos, maxCaracteres }) => {
      try {
        const ref = await resolveCausaRef({ url, procid, jurisdiction });
        if ("error" in ref) return errorText(ref.error);
        const { pid, jid } = ref;

        const hist = await getProceedingHistory({ procid: pid, jurisdictionId: jid });
        const story = hist.stories.find((s) => s.histid === histid);
        if (!story) {
          const ids = hist.stories.slice(0, 30).map((s) => `#${s.histid}`).join(", ");
          return errorText(
            `No encontré el movimiento #${histid} en este expediente. Disponibles: ${ids || "(ninguno)"}.`,
          );
        }

        const cap = maxCaracteres ?? 40000;
        const partes: string[] = [];
        let total = 0;
        const pushParte = (titulo: string, contenido: string) => {
          const restante = cap - total;
          if (restante <= 0) return;
          const recortado =
            contenido.length > restante ? `${contenido.slice(0, restante)}\n…[texto recortado]` : contenido;
          partes.push(`### ${titulo}\n${recortado}`);
          total += recortado.length;
        };

        // 1) Proveído (texto de la resolución/decreto), si el movimiento lo tiene.
        if (story.link) {
          try {
            const u = await getTextoPdfUrl({ procid: pid, jurisdictionId: jid, histid });
            if (u) {
              const { buffer } = await downloadBinary(u);
              const r = await extractPdfTextConOcr(buffer);
              const { sufijo, cuerpo } = renderParte(r);
              pushParte(`Proveído (${r.pages} pág${sufijo})`, cuerpo);
            }
          } catch (e) {
            partes.push(`### Proveído\n(no se pudo traer: ${e instanceof Error ? e.message : String(e)})`);
          }
        }

        // 2) Adjuntos PDF del movimiento.
        if (incluirAdjuntos ?? true) {
          for (const a of Array.isArray(story.archivos) ? story.archivos : []) {
            if ((a.extension ?? "").toLowerCase() !== "pdf") {
              partes.push(`### Adjunto ${a.nombre} (.${a.extension})\n(formato no-PDF, omitido)`);
              continue;
            }
            const r = await fetchArchivoText(pid, jid, histid, a);
            if (!r) {
              partes.push(`### Adjunto ${a.nombre}\n(no se pudo descargar)`);
              continue;
            }
            const { sufijo, cuerpo } = renderParte(r);
            pushParte(`Adjunto ${a.nombre} (${r.pages} pág${sufijo})`, cuerpo);
          }
        }

        if (partes.length === 0) {
          return errorText(
            `El movimiento #${histid} (${story.dscr}) no tiene proveído ni adjuntos PDF para traer.`,
          );
        }

        const header = `Expediente procid=${pid} jurisdiction=${jid} · Movimiento #${histid} · ${story.fecha ?? "?"} · ${story.dscr}`;
        return text([header, "", ...partes].join("\n\n"));
      } catch (err) {
        const msg = err instanceof SaeError ? err.message : err instanceof Error ? err.message : String(err);
        return errorText(`Error trayendo el documento del SAE: ${msg}`);
      }
    },
  );

  // --- Tool: listar fueros y centros (sin captcha ni Playwright) ---
  // SIEMPRE registrada — va ANTES del env-gate porque no usa captcha ni navegador
  // (solo GET /jurisdictions y GET /centers). NO importa resolver.js.
  server.registerTool(
    "sae_listar_fueros",
    {
      title: "Listar fueros y centros del SAE (Tucumán)",
      description:
        "Lista los fueros (jurisdicciones) públicos de un centro judicial del SAE de Tucumán, con su id, nombre y slug, " +
        "más los centros disponibles. Útil para saber qué pasar como 'fuero' o 'jurisdiction' en sae_buscar_por_numero. " +
        "NO usa captcha — anda en cualquier entorno.",
      inputSchema: {
        centro: z
          .number()
          .int()
          .optional()
          .describe("ID del centro judicial (default 1 = Capital)"),
      },
    },
    async ({ centro }) => {
      try {
        const centerId = centro ?? 1;
        const [jurs, centers] = await Promise.all([getJurisdictions(centerId), getCenters()]);
        const publicos = jurs.filter((j) => j.is_public !== 0);
        const lines: string[] = [`Fueros públicos del centro ${centerId}:`];
        if (publicos.length === 0) {
          lines.push("(ninguno — ¿centro inexistente?)");
        } else {
          for (const j of publicos) {
            lines.push(`- ${j.id} · ${j.name} — ${j.description} (slug: ${j.slug})`);
          }
        }
        lines.push("", "Centros disponibles:");
        for (const c of centers) {
          lines.push(`- ${c.id} · ${c.name}${c.description ? ` — ${c.description}` : ""}`);
        }
        lines.push(
          "",
          "La numeración de expedientes se reinicia por fuero: el mismo N/AA existe en varios fueros a la vez.",
        );
        return text(lines.join("\n"));
      } catch (err) {
        const msg = err instanceof SaeError ? err.message : err instanceof Error ? err.message : String(err);
        return errorText(`Error listando fueros del SAE: ${msg}`);
      }
    },
  );

  // --- Tool 2: buscar por número (usa navegador + reCAPTCHA; confiable en LOCAL) ---
  // OPT-IN: solo se registra si SAE_BUSCAR_POR_NUMERO=1. Así el bundle "lite"
  // (sin Chromium) no la expone, pero el código queda intacto para el "full" /
  // el server remoto: basta setear la env var. El resolver (Playwright) se carga
  // con import dinámico recién cuando la tool se invoca.
  if (process.env.SAE_BUSCAR_POR_NUMERO !== "1") return;

  server.registerTool(
    "sae_buscar_por_numero",
    {
      title: "Buscar causa del SAE por número",
      description:
        "Busca un expediente por su número (formato N/AA, ej '7482/23'; también acepta '7482-2023') en los fueros de un centro judicial. " +
        "OJO: la numeración se REINICIA POR FUERO — el mismo N/AA existe a la vez en apremios, contencioso, civil, etc. " +
        "Si sabés el fuero, pasá 'fuero' (ej 'contencioso administrativo' o 'apremios') para buscar SOLO ahí. " +
        "Sin fuero, se barren TODOS los fueros del centro; si hay homónimos te devuelve la lista de candidatos para desambiguar. " +
        "Para ver los fueros disponibles, usá sae_listar_fueros. " +
        "Usa un navegador headless + reCAPTCHA, así que es CONFIABLE corriendo LOCAL (Claude Desktop/Cowork, IP residencial) y puede fallar desde un datacenter. " +
        "Devuelve procid + jurisdiction + carátula + movimientos. Requiere Chromium instalado (npx playwright install chromium).",
      inputSchema: {
        numero: z.string().describe("Número de expediente, ej '7482/23' o '7482-2023'"),
        centro: z
          .number()
          .int()
          .optional()
          .describe("ID del centro judicial (default 1 = Capital)"),
        fuero: z
          .string()
          .optional()
          .describe(
            "Nombre o slug del fuero donde buscar, ej 'contencioso administrativo' o 'apremios'. Restringe la búsqueda SOLO a ese fuero.",
          ),
        jurisdiction: z
          .number()
          .int()
          .optional()
          .describe("ID numérico de fuero. Restringe la búsqueda SOLO a ese fuero. Gana sobre 'fuero' si pasás ambos."),
        maxMovimientos: z.number().int().min(1).max(200).optional().describe("Default 25"),
      },
    },
    async ({ numero, centro, fuero, jurisdiction, maxMovimientos }) => {
      try {
        const centerId = centro ?? 1;
        // Resolver 'fuero' (string) a jurisdiction numérico. Si vienen ambos,
        // gana el jurisdiction numérico.
        let jurisdictionId = jurisdiction;
        if (jurisdictionId === undefined && fuero) {
          const jurs = await getJurisdictions(centerId);
          // Matchear solo contra fueros públicos: un fuero no público (ej.
          // Familia) debe dar "no reconocido" acá, no un error del resolver.
          const matched = matchFuero(jurs.filter((j) => j.is_public !== 0), fuero);
          if (!matched) {
            return errorText(
              `No reconocí el fuero "${fuero}" en el centro ${centerId}. ` +
                `Fueros disponibles: ${fuerosDisponiblesTexto(jurs)}. ` +
                "También podés ver la lista con sae_listar_fueros.",
            );
          }
          jurisdictionId = matched.id;
        }

        // Carga diferida: Playwright solo entra en juego cuando esta tool corre.
        const { resolveCaso } = await import("./resolver.js");
        const r = await resolveCaso({
          number: numero,
          centerId,
          jurisdictionId,
        });
        if (r.status === "ok") return text(formatResolve(r, maxMovimientos ?? 25));
        if (r.status === "ambiguous") {
          return text(
            formatAmbiguous(r.number, r.candidates, r.truncated, r.failed, r.notTried),
          );
        }
        if (r.status === "not_found") {
          return errorText(
            formatNotFound(r.number, centerId, r.searched, r.failed, r.notTried),
          );
        }
        return errorText(r.message);
      } catch (err) {
        return errorText(
          `Error buscando en el SAE: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
