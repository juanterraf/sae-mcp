# Investigación: el portal del SAE por dentro, y cómo se resolvió el bug de los fueros con IA generativa

> Publicado por **[derechointeligente.com.ar](https://derechointeligente.com.ar)** a disposición pública,
> para difundir las posibilidades que nos da la IA generativa aplicada al derecho.
>
> Todo lo que sigue se obtuvo consultando **endpoints públicos** del portal del Poder Judicial de Tucumán,
> sin eludir ninguna autenticación ni medida de seguridad. La información es de consulta y **no constituye
> asesoramiento jurídico**.

---

## 1. Arquitectura del portal SAE

El portal de consulta de expedientes de Tucumán son **dos piezas**:

- **Frontend (SPA):** `https://consultaexpedientes.justucuman.gov.ar` — la página que ve el usuario.
- **API backend (REST):** `https://conexpbe.justucuman.gov.ar/api` — los datos.

Todas las respuestas vienen envueltas en el mismo sobre:

```json
{ "success": true, "data": <...>, "message": "Datos enviados correctamente" }
```

### Endpoints relevantes

| Método | Endpoint | ¿Captcha? | Qué devuelve |
|---|---|---|---|
| `GET` | `/centers` | ❌ | Centros judiciales |
| `GET` | `/jurisdictions?center={id}&full=1` | ❌ | Fueros del centro (con `units` = juzgados) |
| `GET` | `/jurisdictions/slug?slug={slug}` | ❌ | slug → id numérico |
| `GET` | `/proceedings?jurisdiction&number&page&captcha` | ✅ | Búsqueda de expedientes por número |
| `GET` | `/proceedings/history?proceeding&jurisdiction` | ❌ | Carátula + actuaciones (movimientos) |
| `POST` | `/proceedings/history/text/download` | ❌ | URL del PDF del proveído |
| `POST` | `/proceedings/history/file` | ❌ | URL de un archivo adjunto |

La consecuencia práctica más importante: **solo la búsqueda inicial por número exige captcha.** Una vez que tenés
el `procid` + `jurisdiction` de una causa, **todo lo demás (movimientos, textos, adjuntos) se consulta sin captcha**
y es confiable desde cualquier entorno, incluido un servidor remoto.

---

## 2. Centros y fueros

```
Centros:
  1 · CAPITAL        (Centro Judicial Capital)
  2 · CJC            (Centro Judicial Concepción)
  3 · CJM            (Centro Judicial Monteros)
  4 · CJE            (Centro Judicial Este)
  5 · JUSTICIA PAZ   (Justicia de Paz)

Fueros públicos del Centro 1 (Capital), tal como los devuelve la API:
  18 · APREMIOS      (slug: apremios)
   2 · CIVIL         (slug: civil)
   1 · CONTENCIOSO   (slug: contencioso)    ← "Contencioso Administrativo"
  11 · DOCUMENTOS    (slug: documentos)
  17 · ORIGINARIOS   (slug: originarios)
  14 · TRABAJO       (slug: trabajo)
   4 · FAMILIA       (is_public = 0, oculto)
```

Los `id` de jurisdicción son **globales y únicos** entre centros (no se reinician por centro). En cambio,
**la numeración de los expedientes SÍ se reinicia por fuero.**

---

## 3. El bug: "siempre me trae Apremios"

**Síntoma reportado:** al buscar el expediente `136/2015`, la herramienta devolvía siempre

> *MUNICIPALIDAD DE SAN MIGUEL DE TUCUMÁN C/ SIEMESEN DE BIELKE AIDA BEATRIZ S/ COBRO EJECUTIVO*
> (Juzgado de Cobros y **Apremios** I)

cuando en realidad se buscaba la causa homónima del fuero **Contencioso Administrativo**.

**Causa raíz (confirmada en vivo):** dos hechos que se combinan.

1. **La numeración se reinicia por fuero.** El número `136/15` existe simultáneamente en Apremios, Contencioso,
   Civil, Documentos y Trabajo — son cinco expedientes distintos.
2. **La API lista los fueros en orden alfabético por slug**, así que `apremios` queda **primero**. La versión
   vieja del resolver recorría los fueros en ese orden y **devolvía el primer match**, cortando la búsqueda. Por
   eso siempre caía en Apremios y nunca llegaba a Contencioso.

```
136/2015 →  [apremios] ✅ match → return   ❌ nunca se prueban civil, contencioso, ...
            (orden alfabético: apremios viene antes que contencioso)
```

---

## 4. Hallazgos clave del reverse-engineering

Reproduciendo el caso en vivo con un navegador headless (Playwright) sobre el portal real, surgieron tres
hechos que no eran obvios y que cambiaron el diseño de la solución:

### 4.1. El token de reCAPTCHA **no está atado al fuero**

El `/proceedings` valida un token reCAPTCHA v2 *invisible*. Lo esperable sería que el token estuviera ligado a la
jurisdicción que se estaba consultando. **No lo está:** con la página de un fuero cargada, se puede generar un
token fresco y usarlo para consultar `jurisdiction={cualquier otro id}` → `HTTP 200, success=true`.

**Implicancia:** un **solo** page-load alcanza para **barrer todos los fueros** del centro (generando un token nuevo
por consulta, ~1.4 s por fuero). No hace falta re-navegar el portal entero por cada fuero. El barrido completo de
los 6 fueros de Capital baja de minutos a **~18 segundos**.

### 4.2. El backend matchea por **prefijo**, no por número exacto

Buscar `136/15` no devuelve un único expediente: devuelve el principal **más sus incidentes y derivados**
(`136/15-D1`, `136/15-A1` … `136/15-A7`). En el fuero Contencioso eso son **10 resultados**; en Trabajo, 20. Tomar
`results[0]` a ciegas es incorrecto: hay que **filtrar el match exacto** cuyo `nro_expediente` coincide con el
número buscado, y tratar los demás como derivados.

### 4.3. El captcha es obligatorio y se valida del lado servidor

Sin token, o con un token inválido, el backend responde `HTTP 404 / success:false` (`"El campo captcha es
obligatorio"` / `"No se puede validar el captcha…"`). No hay forma de saltearlo: por eso la búsqueda por número
necesita un navegador real y solo es confiable desde IP residencial.

---

## 5. La solución

A partir de esos hechos, el rediseño:

- **Barrido completo con desambiguación.** En vez de cortar en el primer match, se acumulan los resultados de
  **todos** los fueros. Si el número existe en uno solo → se devuelve. Si existe en varios → se devuelve la
  **lista de candidatos** (fuero · carátula · juzgado · procid · jurisdiction) para que el usuario elija. Nunca
  más se "adivina" un fuero.
- **Filtro de match exacto** sobre `nro_expediente` (case/trim-insensitive), separando principal de incidentes.
- **Un solo page-load** para todo el barrido (gracias a 4.1).
- **Parámetro `fuero` por nombre o slug** (`"contencioso administrativo"`, `"apremios"`) para apuntar directo a un
  fuero, más una tool nueva **`sae_listar_fueros`** para descubrir los fueros e IDs disponibles.
- **`not_found` honesto:** distingue fueros buscados sin resultado, fallados (captcha/red) y no probados (por
  deadline), en vez de afirmar que "no existe".

**Resultado verificado:** `136/2015` sin fuero → lista de 5 candidatos exactos (incluyendo Apremios `87448` y
Contencioso `17424`). `136/2015` con `fuero: "contencioso administrativo"` → directo a *MIRANDA ELBA EUGENIA C/
PROVINCIA DE TUCUMÁN S/ DAÑOS Y PERJUICIOS* (procid `17424`, Cámara CA Sala III, 307 movimientos).

---

## 6. Cómo se hizo: IA generativa con enfoque multi-agente

Lo interesante para difundir no es solo el resultado, sino **el método**. Todo el ciclo —diagnóstico, diseño,
implementación y verificación— se orquestó con **múltiples agentes de IA trabajando en paralelo**, cada uno con un
rol acotado:

**Fase 1 — Diagnóstico (3 agentes en paralelo):**
1. **Relevamiento de la API** — mapeó centros, fueros y el orden exacto que devuelve el backend.
2. **Reproducción en vivo** — levantó un navegador real contra el portal y midió el comportamiento del captcha,
   el matching por prefijo y los tiempos (de acá salieron los hallazgos 4.1–4.3).
3. **Auditoría del código** — leyó el resolver y enumeró los modos de falla, confirmando la causa raíz.

**Fase 2 — Implementación y verificación:**
4. Un agente **implementó** el rediseño completo y compiló.
5. Dos agentes **revisores adversariales** (uno de correctitud, otro de regresiones) intentaron *refutar* que el
   fix estuviera bien.
6. Un agente de **smoke test en vivo** corrió el caso real `136/15` contra el portal y confirmó los criterios de
   aceptación end-to-end.

Esta forma de trabajar —**fan-out** de tareas independientes, **verificación adversarial** antes de dar algo por
bueno, y **pruebas contra el sistema real** en vez de suposiciones— es buena parte de lo que hoy hace a la IA
generativa una herramienta confiable para tareas técnicas serias. Lo compartimos para que más gente lo aproveche.

---

*derechointeligente.com.ar — difundiendo IA generativa aplicada al derecho.*
