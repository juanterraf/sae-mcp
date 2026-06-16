import { chromium, type Browser, type Page } from "playwright";

import { logError, logInfo, logWarn } from "./logger.js";
import {
  getCenters,
  getJurisdictions,
  normalizeSaeNumber,
  type Center,
  type Jurisdiction,
} from "./sae-client.js";

// Resolver de casos SAE por número. Levanta un Chromium headless via Playwright,
// navega al buscador del fuero y ejecuta grecaptcha.execute() en la página real
// del SAE para obtener un token reCAPTCHA v2 Invisible. Con ese token consulta
// /proceedings y, si hay match, trae /proceedings/history.
//
// CLAVE — la numeración se reinicia POR FUERO: el mismo "136/2015" existe en
// varios fueros a la vez (apremios, contencioso, …). Por eso, sin fuero
// explícito, se BARREN TODOS los fueros públicos del centro y se desambigua.
//
// CLAVE 2 — el token reCAPTCHA Invisible NO está ligado a la jurisdiction: con
// UNA sola página cargada (la del primer fuero) se puede ejecutar grecaptcha de
// nuevo por cada consulta y llamar /proceedings con cualquier jurisdiction. Un
// solo page-load alcanza para barrer todos los fueros. NO se re-navega entre
// fueros (verificado en vivo).
//
// Limitación: reCAPTCHA Invisible decide por fingerprint + IP. Desde IP
// RESIDENCIAL (corriendo local, ej. Claude Desktop/Cowork) pasa silencioso.
// Desde un DATACENTER puede tirar challenge interactivo no resoluble → por eso
// hay un circuit breaker que corta rápido en la navegación INICIAL.

// Los tipos Center/Jurisdiction viven en sae-client.ts; se re-exportan acá por
// compatibilidad con quien los importaba desde resolver.
export type { Center, Jurisdiction };

export type SaeStory = {
  histid?: number;
  fecha?: string;
  fechaFirma?: string;
  dscr: string;
  texto?: string;
};

// Un match crudo de /proceedings, ya mapeado y clasificado.
export type Hit = {
  procid: string;
  jurisdictionId: string;
  jurisdictionSlug: string;
  jurisdictionName: string;
  caratula: string;
  juzgado: string | null;
  nroExpediente: string;
  /** true si nro_expediente === número buscado normalizado (no solo prefijo). */
  exact: boolean;
};

// Un fuero que no se pudo barrer (error HTTP, captcha, etc.).
export type FueroFail = { id: number; name: string; reason: string };

export type ResolveInput = {
  number: string;
  /** Si viene, RESTRINGE la búsqueda SOLO a ese fuero (semántica de fuero explícito). */
  jurisdictionId?: number;
  /** Restringe a las jurisdicciones de este centro. Default: 1 (CAPITAL). */
  centerId?: number;
};

export type ResolveOk = {
  status: "ok";
  number: string;
  /** El número tal cual lo trae el SAE (nro_expediente del match). */
  nroExpediente: string;
  procid: string;
  jurisdictionId: string;
  jurisdictionSlug: string;
  jurisdictionName: string;
  caratula: string;
  juzgado: string | null;
  stories: SaeStory[];
  /** Otros matches por prefijo/homónimos no exactos, resumidos por fuero. */
  otherMatches?: { fueroName: string; count: number }[];
};

export type ResolveResult =
  | ResolveOk
  | {
      status: "ambiguous";
      number: string;
      candidates: Hit[];
      truncated?: boolean;
      searched: string[];
      failed: FueroFail[];
      notTried: string[];
    }
  | {
      status: "not_found";
      number: string;
      searched: string[];
      failed: FueroFail[];
      notTried: string[];
    }
  | { status: "error"; number: string; message: string };

const SAE_FRONTEND = "https://consultaexpedientes.justucuman.gov.ar";
const SAE_API = "https://conexpbe.justucuman.gov.ar/api";
const NAV_TIMEOUT_MS = 30_000;
const CAPTCHA_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const PER_REQUEST_DELAY_MS = 400;
const RESOLVE_DEADLINE_MS = 60_000;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const CANDIDATES_CAP = 20;
const BREAKER_MESSAGE =
  "El buscador del SAE no está disponible desde acá ahora (probable captcha/bloqueo del portal). Si estás corriendo el server en un datacenter, probá correrlo LOCAL (Claude Desktop/Cowork) — desde IP residencial el captcha pasa. Alternativa: consultá la causa por URL/procid con sae_consultar_causa.";

async function saeGet(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { accept: "application/json" }, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function centerDisplayName(center: Center): string {
  const words = (center.description || center.name).trim().split(/\s+/u);
  return (words[words.length - 1] || center.name).toUpperCase();
}

// Compara dos números de expediente sin importar mayúsculas ni espacios.
function sameNumber(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

type RawProceeding = {
  procid: number | string;
  caratula?: string;
  nro_expediente?: string;
  juzgado?: { dscr?: string };
};

class SaeResolver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private currentCenterId: number | null = null;
  private currentFueroSlug: string | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private breakerOpenUntil = 0;

  private tripBreaker() {
    this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    logWarn("sae.resolver.breaker_open", { cooldownMs: BREAKER_COOLDOWN_MS });
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close().catch(() => undefined);
    }, IDLE_CLOSE_MS);
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.page && this.browser) return this.page;
    logInfo("sae.resolver.browser_start", {});
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      locale: "es-AR",
      timezoneId: "America/Argentina/Buenos_Aires",
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    this.browser = browser;
    this.page = page;
    return page;
  }

  async close() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      this.page = null;
      this.currentCenterId = null;
      this.currentFueroSlug = null;
      try {
        await b.close();
        logInfo("sae.resolver.browser_closed", {});
      } catch (err) {
        logError("sae.resolver.close_failed", err, {});
      }
    }
  }

  private async navigateToCenter(centerId: number): Promise<void> {
    if (this.currentCenterId === centerId) return;
    const page = await this.ensureBrowser();
    const centers = await getCenters();
    const center = centers.find((c) => c.id === centerId);
    if (!center) throw new Error(`center ${centerId} desconocido`);
    const display = centerDisplayName(center);

    await page.goto(SAE_FRONTEND, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForFunction(
      (name: string) => document.body.innerText.toUpperCase().includes(name),
      display,
      { timeout: 15_000 },
    );
    await page
      .getByText(new RegExp(`^${escapeRegExp(display)}$`, "i"))
      .first()
      .click();
    await page.waitForFunction(
      () =>
        /civil|trabajo|laboral|apremio|familia|documentos|contencioso/i.test(
          document.body.innerText,
        ),
      undefined,
      { timeout: 15_000 },
    );
    this.currentCenterId = centerId;
    this.currentFueroSlug = null;
  }

  // Navega al buscador de UN fuero. Esto carga la página con grecaptcha listo.
  // Como el token sirve para cualquier jurisdiction, alcanza con hacerlo UNA
  // vez (para el primer fuero) y después solo ejecutar captcha por consulta.
  private async navigateToFueroBuscador(jur: Jurisdiction, centerId: number): Promise<void> {
    if (this.currentCenterId === centerId && this.currentFueroSlug === jur.slug) return;

    if (this.currentCenterId !== centerId || this.currentFueroSlug !== null) {
      this.currentCenterId = null;
      this.currentFueroSlug = null;
      await this.navigateToCenter(centerId);
    }

    const page = await this.ensureBrowser();
    await page
      .getByText(new RegExp(`^${escapeRegExp(jur.description)}$`, "i"))
      .first()
      .click({ timeout: 10_000 });

    await page.waitForFunction(
      () => {
        const g = (window as unknown as { grecaptcha?: { execute?: unknown } }).grecaptcha;
        return typeof g !== "undefined" && typeof g.execute === "function";
      },
      { timeout: CAPTCHA_TIMEOUT_MS },
    );
    this.currentFueroSlug = jur.slug;
  }

  private async executeCaptcha(): Promise<string> {
    const page = await this.ensureBrowser();
    const result = await page.evaluate(() => {
      return new Promise<{ ok: true; token: string } | { ok: false; reason: string }>(
        (resolve) => {
          try {
            const w = window as unknown as {
              ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
              grecaptcha: {
                execute: (id: number) => void;
                reset: (id: number) => void;
                getResponse: (id: number) => string;
              };
            };
            const keys = Object.keys(w.___grecaptcha_cfg?.clients ?? {});
            const widgetId = keys.length > 0 ? parseInt(keys[0] ?? "0", 10) : 0;
            try {
              w.grecaptcha.reset(widgetId);
            } catch {
              /* noop */
            }
            const start = Date.now();
            const intervalId = setInterval(() => {
              try {
                const token = w.grecaptcha.getResponse(widgetId);
                if (token) {
                  clearInterval(intervalId);
                  resolve({ ok: true, token });
                }
                if (Date.now() - start > 20_000) {
                  clearInterval(intervalId);
                  resolve({ ok: false, reason: "captcha timeout (¿challenge?)" });
                }
              } catch (e: unknown) {
                clearInterval(intervalId);
                resolve({ ok: false, reason: `getResponse threw: ${(e as Error)?.message ?? "?"}` });
              }
            }, 200);
            w.grecaptcha.execute(widgetId);
          } catch (e: unknown) {
            resolve({ ok: false, reason: `execute threw: ${(e as Error)?.message ?? "?"}` });
          }
        },
      );
    });
    if (!result.ok) throw new Error(result.reason);
    return result.token;
  }

  private async searchProceeding(
    jurisdictionId: number,
    number: string,
    captcha: string,
  ): Promise<RawProceeding[]> {
    const url = new URL(`${SAE_API}/proceedings`);
    url.searchParams.set("jurisdiction", String(jurisdictionId));
    url.searchParams.set("number", number);
    url.searchParams.set("page", "1");
    url.searchParams.set("captcha", captcha);
    const resp = await saeGet(url.toString(), SEARCH_TIMEOUT_MS);
    if (resp.status === 404) {
      throw new Error("captcha_rejected");
    }
    if (!resp.ok) {
      throw new Error(`search HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      success: boolean;
      data: RawProceeding[];
      message?: string;
    };
    if (!json.success) {
      throw new Error(`search success=false: ${json.message ?? ""}`);
    }
    return Array.isArray(json.data) ? json.data : [];
  }

  private async getHistory(procid: string, jurisdictionId: string): Promise<SaeStory[]> {
    const url = new URL(`${SAE_API}/proceedings/history`);
    url.searchParams.set("proceeding", procid);
    url.searchParams.set("jurisdiction", jurisdictionId);
    const resp = await saeGet(url.toString(), SEARCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`history HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      success: boolean;
      data?: { stories?: SaeStory[] };
    };
    return json?.data?.stories ?? [];
  }

  // Mapea todos los results de un fuero a Hit, clasificando exact vs prefijo.
  private mapHits(jur: Jurisdiction, results: RawProceeding[], searchNumber: string): Hit[] {
    return results.map((r) => {
      const nro = (r.nro_expediente ?? "").trim();
      return {
        procid: String(r.procid),
        jurisdictionId: String(jur.id),
        jurisdictionSlug: jur.slug,
        jurisdictionName: jur.name,
        caratula: r.caratula || `Expediente ${searchNumber}`,
        juzgado: r.juzgado?.dscr ?? null,
        nroExpediente: nro,
        exact: nro !== "" && sameNumber(nro, searchNumber),
      };
    });
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    this.touch();
    return this.withLock(async () => {
      try {
        if (Date.now() < this.breakerOpenUntil) {
          return { status: "error", number: input.number, message: BREAKER_MESSAGE };
        }
        const centerId = input.centerId ?? 1;
        const searchNumber = normalizeSaeNumber(input.number);
        const allJur = await getJurisdictions(centerId);
        const publicJur = allJur.filter((j) => j.is_public !== 0);

        // Fuero explícito → RESTRINGIR la lista SOLO a ese fuero.
        let tryOrder: Jurisdiction[];
        if (input.jurisdictionId !== undefined) {
          const only = publicJur.find((j) => j.id === input.jurisdictionId);
          if (!only) {
            const valid = publicJur.map((j) => `${j.id} · ${j.name}`).join("; ");
            return {
              status: "error",
              number: input.number,
              message:
                `El fuero (jurisdiction) ${input.jurisdictionId} no existe o no es público en el centro ${centerId}. ` +
                `Fueros válidos: ${valid || "(ninguno)"}.`,
            };
          }
          tryOrder = [only];
        } else {
          tryOrder = publicJur;
        }

        const deadline = Date.now() + RESOLVE_DEADLINE_MS;
        const searched: string[] = []; // nombres de fueros efectivamente barridos
        const failed: FueroFail[] = [];
        const notTried: string[] = [];
        const hits: Hit[] = [];
        // Marca un corte: a partir de ese índice, los fueros van a notTried.
        let cutFrom = -1;

        for (let i = 0; i < tryOrder.length; i++) {
          const jur = tryOrder[i]!;

          if (Date.now() > deadline) {
            logWarn("sae.resolver.deadline_exceeded", {
              number: input.number,
              searchedCount: searched.length,
            });
            cutFrom = i;
            break;
          }

          // Navegación: solo la PRIMERA vez carga la página (el token sirve para
          // cualquier jurisdiction). Si falla la nav inicial → circuit breaker.
          if (this.currentFueroSlug === null) {
            try {
              await this.navigateToFueroBuscador(jur, centerId);
            } catch (err) {
              logWarn("sae.resolver.nav_failed", {
                slug: jur.slug,
                error: err instanceof Error ? err.message : String(err),
              });
              this.tripBreaker();
              await this.close().catch(() => undefined);
              return { status: "error", number: input.number, message: BREAKER_MESSAGE };
            }
          }

          // Consulta del fuero con token fresco.
          let results: RawProceeding[] | null = null;
          try {
            const captcha = await this.executeCaptcha();
            results = await this.searchProceeding(jur.id, searchNumber, captcha);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === "captcha_rejected") {
              // Reintento UNA vez con token nuevo.
              try {
                const captcha2 = await this.executeCaptcha();
                results = await this.searchProceeding(jur.id, searchNumber, captcha2);
              } catch (err2) {
                const msg2 = err2 instanceof Error ? err2.message : String(err2);
                failed.push({ id: jur.id, name: jur.name, reason: `captcha: ${msg2}` });
                // Si el reintento murió por el captcha mismo (no por la red), la
                // página está muerta: cortar el barrido como en la rama de abajo.
                if (msg2.startsWith("captcha timeout") || msg2.startsWith("execute threw") || msg2.startsWith("getResponse threw")) {
                  cutFrom = i + 1;
                  break;
                }
                results = null;
              }
            } else if (msg.startsWith("captcha timeout") || msg.startsWith("execute threw") || msg.startsWith("getResponse threw")) {
              // El captcha (no la red) falló. Intentar UNA re-navegación completa
              // a este fuero y reintentar la consulta. Si vuelve a fallar, la
              // página está muerta: registrar este fuero y cortar el barrido
              // (los restantes → notTried). No insistir fuero por fuero.
              this.currentFueroSlug = null;
              try {
                await this.navigateToFueroBuscador(jur, centerId);
                const captcha3 = await this.executeCaptcha();
                results = await this.searchProceeding(jur.id, searchNumber, captcha3);
              } catch (err3) {
                const msg3 = err3 instanceof Error ? err3.message : String(err3);
                failed.push({ id: jur.id, name: jur.name, reason: `captcha: ${msg3}` });
                cutFrom = i + 1; // este ya quedó en failed; los siguientes notTried
                break;
              }
            } else {
              // Otros errores HTTP → failed, seguir con el próximo fuero.
              failed.push({ id: jur.id, name: jur.name, reason: msg });
              results = null;
            }
          }

          // searched = fueros donde la búsqueda se completó (results !== null,
          // aunque venga vacía). Los que fallaron quedan SOLO en failed.
          if (results !== null) {
            searched.push(jur.name);
            if (results.length > 0) {
              hits.push(...this.mapHits(jur, results, searchNumber));
            }
          }

          await sleep(PER_REQUEST_DELAY_MS);
        }

        // Fueros que quedaron sin probar (por corte o deadline).
        if (cutFrom >= 0) {
          for (let k = cutFrom; k < tryOrder.length; k++) {
            notTried.push(tryOrder[k]!.name);
          }
        }

        // --- Decisión final sobre los hits acumulados ---
        const exactHits = hits.filter((h) => h.exact);
        const nonExact = hits.filter((h) => !h.exact);

        if (exactHits.length === 1) {
          const hit = exactHits[0]!;
          const stories = await this.getHistory(hit.procid, hit.jurisdictionId);
          // otherMatches: resumen por fuero de los demás matches (no este hit).
          const others = hits.filter((h) => h.procid !== hit.procid);
          const byFuero = new Map<string, number>();
          for (const o of others) {
            byFuero.set(o.jurisdictionName, (byFuero.get(o.jurisdictionName) ?? 0) + 1);
          }
          const otherMatches = [...byFuero.entries()].map(([fueroName, count]) => ({
            fueroName,
            count,
          }));
          return {
            status: "ok",
            number: input.number,
            nroExpediente: hit.nroExpediente || searchNumber,
            procid: hit.procid,
            jurisdictionId: hit.jurisdictionId,
            jurisdictionSlug: hit.jurisdictionSlug,
            jurisdictionName: hit.jurisdictionName,
            caratula: hit.caratula,
            juzgado: hit.juzgado,
            stories,
            ...(otherMatches.length > 0 ? { otherMatches } : {}),
          };
        }

        if (exactHits.length > 1) {
          const capped = exactHits.slice(0, CANDIDATES_CAP);
          return {
            status: "ambiguous",
            number: input.number,
            candidates: capped,
            ...(exactHits.length > CANDIDATES_CAP ? { truncated: true } : {}),
            searched,
            failed,
            notTried,
          };
        }

        // Sin exactos, pero hay matches por prefijo → ambiguo con esos.
        if (nonExact.length > 0) {
          const capped = nonExact.slice(0, CANDIDATES_CAP);
          return {
            status: "ambiguous",
            number: input.number,
            candidates: capped,
            ...(nonExact.length > CANDIDATES_CAP ? { truncated: true } : {}),
            searched,
            failed,
            notTried,
          };
        }

        return {
          status: "not_found",
          number: input.number,
          searched,
          failed,
          notTried,
        };
      } catch (err) {
        logError("sae.resolver.resolve_failed", err, { number: input.number });
        return {
          status: "error",
          number: input.number,
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.touch();
      }
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

declare global {
  // eslint-disable-next-line no-var
  var __saeResolver: SaeResolver | undefined;
}

function getResolver(): SaeResolver {
  if (!globalThis.__saeResolver) {
    globalThis.__saeResolver = new SaeResolver();
  }
  return globalThis.__saeResolver;
}

export async function resolveCaso(input: ResolveInput): Promise<ResolveResult> {
  return getResolver().resolve(input);
}

export async function closeResolver() {
  if (globalThis.__saeResolver) {
    await globalThis.__saeResolver.close();
    globalThis.__saeResolver = undefined;
  }
}
