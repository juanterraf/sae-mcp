// Cliente HTTP de la API del SAE Tucumán. Portado tal cual desde el CRM bufete
// (src/lib/sae/client.ts), sin el pragma "server-only" de Next: acá corre en Node
// plano. Es standalone — solo usa fetch/Buffer/URL globales de Node 20+.
//
// Endpoints conocidos:
//   GET  /jurisdictions/slug?slug={slug}
//   GET  /proceedings?jurisdiction&number&actor&accused&page&captcha   (REQUIERE captcha)
//   GET  /proceedings/history?proceeding&jurisdiction                  (sin auth ni captcha)
//   POST /proceedings/history/text/download                            (sin auth)
//   POST /proceedings/history/file                                     (sin auth)
//
// La búsqueda inicial (/proceedings) requiere captcha → ver resolver.ts. El
// historial (/proceedings/history) NO requiere captcha: dado procid + jurisdiction
// se consulta directo.

const BASE_URL = "https://conexpbe.justucuman.gov.ar/api";
const DEFAULT_TIMEOUT_MS = 30_000;

export type SaeHistoria = {
  histid: number;
  fecha: string; // "DD/MM/YYYY"
  fechaFirma?: string | null;
  dscr: string;
  texto?: string | null;
  firm?: boolean;
  link?: boolean | string;
  archivos?: Array<{ nombre: string; extension: string }> | null;
  vinculos?: Array<unknown> | null;
};

export type SaeProceeding = {
  procid: number | string;
  nro_expediente?: string;
  caratula?: string;
  actor?: string;
  demandado?: string;
  juzgado?: { dscr?: string };
  tipo_proceso?: string;
  jurisdiction_id?: string | number;
};

export type SaeHistoryResponse = {
  proceeding: SaeProceeding | null;
  stories: SaeHistoria[];
};

// Centros judiciales y fueros (jurisdicciones). Estos tipos viven acá (no en
// resolver.ts) para que el bundle "lite" sin Playwright pueda usarlos: la tool
// sae_listar_fueros y el matcheo de fuero por nombre no necesitan navegador.
// resolver.ts los re-importa desde acá.
export type Center = { id: number; name: string; description: string };

export type Jurisdiction = {
  id: number;
  name: string;
  description: string;
  slug: string;
  is_public?: number;
  /** Juzgados/unidades del fuero (no siempre presente). */
  units?: Array<unknown>;
};

export class SaeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaeError";
  }
}

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [800, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Transitorio = vale la pena reintentar: errores de red/timeout (errores crudos,
// no SaeError) o 5xx del portal. NO reintentamos 4xx ni `success=false`.
function isTransientError(err: unknown): boolean {
  if (err instanceof SaeError) return err.status !== undefined && err.status >= 500;
  return true;
}

async function fetchJsonOnce(url: string, init: RequestInit): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new SaeError(`SAE HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    // El SAE envuelve la respuesta como { success, data, message }.
    if (json && typeof json === "object" && "success" in json && "data" in json) {
      const envelope = json as { success: boolean; data: unknown; message?: string };
      if (!envelope.success) {
        throw new SaeError(envelope.message ?? "Respuesta SAE con success=false");
      }
      return envelope.data;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchJsonOnce(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 2000);
        continue;
      }
      break;
    }
  }
  if (lastErr instanceof SaeError) throw lastErr;
  throw new SaeError(
    lastErr instanceof Error ? lastErr.message : "Error desconocido",
    undefined,
    lastErr,
  );
}

function buildUrl(
  path: string,
  params?: Record<string, string | number | null | undefined>,
): string {
  const u = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== "") {
        u.searchParams.set(k, String(v));
      }
    }
  }
  return u.toString();
}

// GET /proceedings/history?proceeding=X&jurisdiction=Y — cabecera + actuaciones
// (la más reciente primero). Sin captcha ni auth.
export async function getProceedingHistory(opts: {
  procid: string;
  jurisdictionId: string;
}): Promise<SaeHistoryResponse> {
  const data = await fetchJson(
    buildUrl("/proceedings/history", {
      proceeding: opts.procid,
      jurisdiction: opts.jurisdictionId,
    }),
  );

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Partial<SaeHistoryResponse>;
    return {
      proceeding: obj.proceeding ?? null,
      stories: Array.isArray(obj.stories) ? obj.stories : [],
    };
  }
  if (Array.isArray(data)) {
    return { proceeding: null, stories: data as SaeHistoria[] };
  }
  return { proceeding: null, stories: [] };
}

// POST /proceedings/history/text/download — URL del PDF del proveído.
export async function getTextoPdfUrl(opts: {
  procid: string;
  jurisdictionId: string;
  histid: number;
}): Promise<string | null> {
  const data = await fetchJson(buildUrl("/proceedings/history/text/download"), {
    method: "POST",
    body: JSON.stringify({
      proceeding: String(opts.procid),
      jurisdiction: String(opts.jurisdictionId),
      history: String(opts.histid),
    }),
  });
  return extractUrl(data);
}

// POST /proceedings/history/file — URL de un archivo adjunto. `file` va base64.
export async function getArchivoUrl(opts: {
  procid: string;
  jurisdictionId: string;
  histid: number;
  filename: string;
}): Promise<string | null> {
  const data = await fetchJson(buildUrl("/proceedings/history/file"), {
    method: "POST",
    body: JSON.stringify({
      proceeding: String(opts.procid),
      jurisdiction: String(opts.jurisdictionId),
      history: String(opts.histid),
      file: Buffer.from(opts.filename, "utf8").toString("base64"),
    }),
  });
  return extractUrl(data);
}

function extractUrl(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as { url?: string; data?: string };
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.data === "string") return obj.data;
  }
  return null;
}

// Anti-SSRF para las URLs de descarga que devuelve el SAE.
export function isPrivateOrLoopbackHostname(hostnameRaw: string): boolean {
  const hostname = hostnameRaw.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "ip6-localhost" || hostname === "ip6-loopback") return true;

  if (hostname.includes(":")) {
    if (hostname === "::1" || hostname === "::") return true;
    const mapped = hostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u);
    if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
    if (/^f[cd]/u.test(hostname)) return true;
    if (/^fe[89ab]/u.test(hostname)) return true;
    return false;
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)) {
    return isPrivateIpv4(hostname);
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function assertSafeSaeDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SaeError(`URL de descarga inválida: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SaeError(`Esquema de descarga no permitido: ${parsed.protocol}`);
  }
  if (isPrivateOrLoopbackHostname(parsed.hostname)) {
    throw new SaeError(`URL de descarga apunta a un host interno: ${parsed.hostname}`);
  }
  return parsed;
}

export async function downloadBinary(url: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  assertSafeSaeDownloadUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new SaeError(`SAE download HTTP ${res.status}`, res.status);
    }
    const ab = await res.arrayBuffer();
    return {
      buffer: Buffer.from(ab),
      contentType: res.headers.get("content-type") ?? "application/pdf",
    };
  } catch (err) {
    if (err instanceof SaeError) throw err;
    throw new SaeError(err instanceof Error ? err.message : "Error descargando", undefined, err);
  } finally {
    clearTimeout(timer);
  }
}

// El buscador del SAE matchea el número en formato "N/AA" (año de DOS dígitos).
// Normaliza separadores y año a 2 dígitos. El backend matchea por PREFIJO, así
// que el sufijo de incidente (-D1, -A7, …) se PRESERVA si viene.
//
// Mapeos EXACTOS soportados:
//   "136/2015"      → "136/15"
//   "136-15"        → "136/15"
//   "136 / 2015"    → "136/15"
//   "1.234/15"      → "1234/15"   (puntos de miles entre dígitos: se eliminan ANTES del match)
//   "136/2015-D1"   → "136/15-D1" (preserva el sufijo -XX en MAYÚSCULAS)
//   no reconocido   → trim del original
export function normalizeSaeNumber(raw: string): string {
  const original = (raw ?? "").trim();
  // 1) Sacar puntos de miles SOLO entre dígitos (1.234 → 1234), sin tocar otros puntos.
  const s = original.replace(/(\d)\.(?=\d)/gu, "$1");
  // 2) N <sep> AA[ -SUF]. Año 2-4 dígitos → 2 dígitos. Sufijo -XX opcional preservado.
  const m = s.match(/(\d+)\s*[-/\s]\s*(\d{2,4})\b\s*(-[A-Za-z]+\d*)?/u);
  if (!m) return original;
  const numero = m[1]!;
  const anio2 = m[2]!.slice(-2);
  const sufijo = m[3] ? m[3].toUpperCase() : "";
  return `${numero}/${anio2}${sufijo}`;
}

// DD/MM/YYYY (SAE) → YYYY-MM-DD. null si no calza.
export function parseFechaSae(fecha: string | null | undefined): string | null {
  if (!fecha) return null;
  const m = String(fecha).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}/.test(fecha)) return String(fecha).slice(0, 10);
    return null;
  }
  return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

// HTML del proveído → texto plano (best-effort).
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// Parsea una URL del portal SAE para extraer procid + slug de jurisdicción:
//   https://consultaexpedientes.justucuman.gov.ar/<slug>/expediente/<procid>/historia
export function parseSaeUrl(
  url: string,
): { procid: string; jurisdictionSlug: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("justucuman.gov.ar")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const expIdx = parts.indexOf("expediente");
    if (expIdx < 1 || !parts[expIdx + 1]) return null;
    return {
      jurisdictionSlug: parts[expIdx - 1]!,
      procid: parts[expIdx + 1]!,
    };
  } catch {
    return null;
  }
}

// GET /jurisdictions/slug?slug=X — slug → id numérico.
export async function getJurisdictionIdBySlug(slug: string): Promise<string | null> {
  const data = await fetchJson(buildUrl("/jurisdictions/slug", { slug }));
  if (data && typeof data === "object") {
    const obj = data as { id?: string | number };
    if (obj.id !== undefined) return String(obj.id);
  }
  return null;
}

// --- Centros y fueros (sin captcha) -----------------------------------------
// Cache en módulo con TTL de 1 hora. Estos endpoints no requieren captcha y
// cambian rarísimo, así que un cache simple evita golpear el portal de más.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

type Cached<T> = { data: T; fetchedAt: number };

let centersCache: Cached<Center[]> | null = null;
const jurisdictionsCache = new Map<number, Cached<Jurisdiction[]>>();

function isFresh<T>(entry: Cached<T> | null | undefined): entry is Cached<T> {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// GET /centers — centros judiciales (1 Capital, 2 Concepción, …). Sin captcha.
export async function getCenters(): Promise<Center[]> {
  if (isFresh(centersCache)) return centersCache.data;
  const data = (await fetchJson(buildUrl("/centers"))) as Center[];
  const list = Array.isArray(data) ? data : [];
  centersCache = { data: list, fetchedAt: Date.now() };
  return list;
}

// GET /jurisdictions?center={id}&full=1 — fueros del centro. Sin captcha.
export async function getJurisdictions(centerId: number): Promise<Jurisdiction[]> {
  const cached = jurisdictionsCache.get(centerId);
  if (isFresh(cached)) return cached.data;
  const data = (await fetchJson(
    buildUrl("/jurisdictions", { center: centerId, full: 1 }),
  )) as Jurisdiction[];
  const list = Array.isArray(data) ? data : [];
  jurisdictionsCache.set(centerId, { data: list, fetchedAt: Date.now() });
  return list;
}

// Saca acentos/diacríticos para comparar sin importar tildes.
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function norm(s: string | null | undefined): string {
  return stripAccents((s ?? "").toLowerCase()).trim();
}

// Matchea un fuero por nombre/slug libre del usuario. Reglas:
//   1) slug exacto (case-insensitive, sin acentos)
//   2) description igual (case-insensitive, sin acentos)
//   3) inclusión bidireccional contra slug/name/description: el needle CONTIENE
//      al campo, o el campo CONTIENE al needle.
// Ej: "contencioso administrativo" / "Contencioso" / "CONTENCIOSO" → contencioso;
//     "cobros y apremios" → apremios (el needle CONTIENE "apremios").
// Si más de una jurisdicción distinta matchea por inclusión, gana la de match
// más específico (slug exacto > description igual > inclusión). Si sigue
// ambiguo (varias con el mismo mejor nivel), devuelve null.
export function matchFuero(
  jurisdictions: Jurisdiction[],
  needle: string,
): Jurisdiction | null {
  const n = norm(needle);
  if (!n) return null;

  // Rank: 3 = slug exacto, 2 = description igual, 1 = inclusión. 0 = no matchea.
  let bestRank = 0;
  const bestByRank = new Map<number, Set<number>>(); // rank → ids distintos
  const byId = new Map<number, Jurisdiction>();

  for (const j of jurisdictions) {
    const slug = norm(j.slug);
    const name = norm(j.name);
    const desc = norm(j.description);

    let rank = 0;
    if (slug && slug === n) {
      rank = 3;
    } else if (desc && desc === n) {
      rank = 2;
    } else {
      const fields = [slug, name, desc].filter(Boolean);
      const incl = fields.some(
        (f) => (f.length >= 3 && n.includes(f)) || (n.length >= 3 && f.includes(n)),
      );
      if (incl) rank = 1;
    }

    if (rank === 0) continue;
    byId.set(j.id, j);
    if (rank > bestRank) bestRank = rank;
    let set = bestByRank.get(rank);
    if (!set) {
      set = new Set<number>();
      bestByRank.set(rank, set);
    }
    set.add(j.id);
  }

  if (bestRank === 0) return null;
  const winners = bestByRank.get(bestRank)!;
  if (winners.size !== 1) return null; // ambiguo en el mejor nivel
  const id = [...winners][0]!;
  return byId.get(id) ?? null;
}
