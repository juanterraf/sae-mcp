# sae-mcp

**Servidor MCP para consultar causas del SAE** (Sistema de Administración de Expedientes del Poder Judicial de Tucumán) desde Claude — **Claude Desktop**, **Claude Code / Cowork** y **claude.ai** (web).

Le da a un asistente de IA la capacidad de **leer un expediente judicial**: carátula, partes, juzgado, movimientos (actuaciones) y el **texto** de los proveídos y adjuntos PDF — para resumir, analizar o buscar por número.

---

## Por qué es público

Este proyecto es una iniciativa de **[derechointeligente.com.ar](https://derechointeligente.com.ar)**.

Publicamos **el código completo y toda la investigación técnica** (cómo funciona por dentro el portal del SAE, cómo se diagnosticó y resolvió el problema de los fueros — ver [`docs/INVESTIGACION-SAE.md`](docs/INVESTIGACION-SAE.md)) **a disposición pública**, con un objetivo simple: **difundir las posibilidades que nos da la IA generativa** aplicada al derecho y a la justicia en Argentina.

Que cualquier persona —abogadas, abogados, estudiantes, desarrolladoras, justiciables— pueda ver, usar, copiar y mejorar esto. La licencia es **MIT**: usalo libremente.

> ⚖️ La información proviene del portal público del Poder Judicial de Tucumán y **no constituye asesoramiento jurídico**. Es una herramienta de consulta y productividad.

---

## Qué hace — las tools

| Tool | Qué hace | ¿Captcha? |
|---|---|---|
| **`sae_consultar_causa`** | Dada la **URL** del expediente en el portal del SAE, o `procid` + `jurisdiction`, trae carátula, partes, juzgado y movimientos. | ❌ No — confiable en cualquier entorno |
| **`sae_traer_documento`** | Dado un movimiento (`#histid`), baja el **proveído y/o los PDF adjuntos** y devuelve su **texto** para leer/resumir/analizar. | ❌ No |
| **`sae_listar_fueros`** | Lista los **fueros** (jurisdicciones) públicos de un centro judicial (id · nombre · slug) y los **centros** disponibles. | ❌ No |
| **`sae_buscar_por_numero`** | Dado el **número** (`7482/23`), busca el expediente en los fueros de un centro y devuelve procid + jurisdiction + carátula + movimientos. | ✅ Sí — usa navegador headless + reCAPTCHA |

> **La restricción clave del captcha:** reCAPTCHA decide por IP. La búsqueda **por número** anda confiable **corriendo local** (Desktop/Cowork, tu IP residencial) y puede fallar desde un datacenter. Todo lo demás (consulta por URL/procid, traer documentos, listar fueros) **no usa captcha y anda en cualquier lado**. Cuando `sae_buscar_por_numero` resuelve un caso, te devuelve el `procid`/`jurisdiction` para que después consultes sin captcha.

### ⚠️ La numeración se reinicia POR FUERO

El mismo número `N/AA` existe a la vez en **varios fueros** (apremios, contencioso, civil, trabajo…): la numeración se reinicia por fuero. Por eso `sae_buscar_por_numero`:

- Si **no** pasás fuero, **barre TODOS los fueros públicos** del centro. Si hay un único match exacto, lo devuelve (avisando si el mismo número aparece también en otros fueros). Si hay homónimos en varios fueros, devuelve la **lista de candidatos** (carátula · juzgado · procid · jurisdiction) para que elijas.
- Si pasás **`fuero`** (nombre o slug, ej. `fuero: "contencioso administrativo"` o `fuero: "apremios"`), busca **SOLO en ese fuero**. También podés pasar `jurisdiction` (id numérico), que gana sobre `fuero` si mandás ambos.
- Usá **`sae_listar_fueros`** para ver los fueros y centros disponibles.

---

## Cómo usarlo

Hay cuatro formas, de la más simple (cero terminal) a la más técnica.

### 1) Instalación de un click — `.mcpb` (para gente NO técnica)

Cada [Release](../../releases) trae un bundle **`sae-lite.mcpb`** ya armado. El usuario final NO necesita terminal, ni Node, ni editar JSON:

1. Descargá `sae-lite.mcpb` desde la pestaña **Releases**.
2. Hacé **doble click** → Claude Desktop abre un diálogo **"Install"**.
3. Apretá **Install** → Claude reinicia → ya tenés las tools.

Claude Desktop trae Node embebido, corre sin instalar nada. El bundle **Lite** incluye `sae_consultar_causa`, `sae_traer_documento` y `sae_listar_fueros` (todas **sin captcha**) — cubre el 90% del uso y anda en cualquier máquina. La búsqueda por número (con Chromium) queda en el bundle Full.

### 2) Claude Desktop (config manual)

Editá `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sae": {
      "command": "node",
      "args": ["C:\\ruta\\a\\sae-mcp\\dist\\stdio.js"],
      "env": { "SAE_BUSCAR_POR_NUMERO": "1" }
    }
  }
}
```

Reiniciá Claude Desktop. (Quitá la `env` si no querés la búsqueda por número / Chromium.)

### 3) Claude Code / Cowork

```bash
claude mcp add sae -- node /ruta/a/sae-mcp/dist/stdio.js
```

Stdio es el default. Como corre **local**, la búsqueda por número funciona (IP residencial).

### 4) claude.ai (web) — conector remoto / self-host

El transporte HTTP (`pnpm start:http`, o `node dist/http.js`) deja un endpoint **Streamable HTTP** en `POST /mcp`. Para usarlo como Custom Connector en claude.ai necesitás hostearlo con **HTTPS** (ej. detrás de Nginx en un VPS) y, según la política de claude.ai, **OAuth 2.1 + PKCE** (no incluido en esta versión).

derechointeligente.com.ar mantiene una **instancia hosteada** del transporte HTTP. Desde un server remoto conviene **liderar con `sae_consultar_causa`** (URL/procid): la búsqueda por número puede chocar con el captcha desde el datacenter.

#### Ejemplos de uso (lenguaje natural, dentro de Claude)

- *"Traeme los últimos movimientos de https://consultaexpedientes.justucuman.gov.ar/contencioso/expediente/17424/historia"*
- *"Buscá el expediente 136/15 en el fuero contencioso administrativo y resumime la última sentencia."*
- *"¿Qué fueros hay en el Centro Judicial Capital?"*
- *"Leeme el texto del movimiento #1714510 de esa causa."*

---

## Setup (desarrollo)

Requisitos: **Node 20+** y pnpm (o npm).

```bash
git clone https://github.com/juanterraf/sae-mcp.git
cd sae-mcp
pnpm install
pnpm playwright:install   # baja Chromium (solo necesario para sae_buscar_por_numero)
pnpm build                # compila a dist/
```

Probar rápido en modo dev (sin compilar):

```bash
pnpm dev          # stdio (lo que usan Desktop/Cowork) — tools sin captcha
pnpm dev:http     # HTTP en :8787 (para claude.ai remoto)
```

Para habilitar también `sae_buscar_por_numero` (Playwright):

```bash
pnpm playwright:install                       # una vez
SAE_BUSCAR_POR_NUMERO=1 pnpm dev               # ahora aparecen las 4 tools
```

### Re-empaquetar el `.mcpb` Lite

```bash
pnpm install --prod --ignore-scripts   # node_modules plano de runtime (.npmrc fuerza node-linker=hoisted)
pnpm build
npx -y @anthropic-ai/mcpb pack . sae-lite.mcpb
pnpm install --ignore-scripts          # restaurar devDeps para seguir desarrollando
```

**Por qué `node-linker=hoisted` (`.npmrc`):** los symlinks de pnpm NO sobreviven al zip del `.mcpb`. El layout plano lo arregla. El `.mcpbignore` saca Playwright y las herramientas de build del paquete.

---

## La investigación

En [`docs/INVESTIGACION-SAE.md`](docs/INVESTIGACION-SAE.md) está documentado **cómo funciona por dentro el portal del SAE** (endpoints de la API, el comportamiento del reCAPTCHA, el matching por prefijo, el orden de los fueros) y **cómo se usó IA generativa con un enfoque multi-agente** para diagnosticar y resolver el problema de los fueros homónimos. Es la parte que ponemos a disposición para difundir qué se puede hacer hoy con estas herramientas.

## Estructura

```text
src/
  sae-client.ts   # cliente HTTP de la API del SAE (sin captcha): historia, documentos,
                  #   fueros/centros, matchFuero, normalizeSaeNumber, anti-SSRF
  resolver.ts     # búsqueda por número con Playwright + reCAPTCHA (barrido multi-fuero)
  tools.ts        # las 4 tools + schemas zod + formateo
  pdf.ts          # extracción de texto de PDFs (digital + fallback OCR)
  ocr.ts          # OCR de PDFs escaneados vía pdftoppm + tesseract (requiere
                  #   poppler-utils y tesseract-ocr[-spa] instalados; si faltan,
                  #   se degrada a "sin texto extraíble". SAE_OCR=0 lo apaga)
  logger.ts       # logs a stderr (stdout está reservado para el protocolo MCP)
  server.ts       # arma el McpServer (agnóstico de transporte)
  stdio.ts        # entrypoint local (Desktop/Cowork)
  http.ts         # entrypoint Streamable HTTP (claude.ai / self-host)
```

## Notas

- El cliente es **standalone**: no depende de ningún CRM ni base de datos.
- Si el SAE cambia su sitekey de reCAPTCHA o el flujo del SPA, `resolver.ts` puede romperse. La consulta por **URL/procid** es la más estable.

## Licencia

[MIT](LICENSE) — © 2026 [derechointeligente.com.ar](https://derechointeligente.com.ar). Usalo, copialo, mejoralo y compartilo.
