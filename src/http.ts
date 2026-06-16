import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./server.js";

// Entrypoint REMOTO (Streamable HTTP). Para usarlo como Custom Connector en
// claude.ai necesitás hostearlo con HTTPS + OAuth (ver README). Modo STATELESS:
// una instancia de server + transport por request (sin sesiones).
//
// OJO: la búsqueda por número (sae_buscar_por_numero) depende de reCAPTCHA y
// puede fallar desde un datacenter — desde acá liderá con sae_consultar_causa
// (URL/procid), que no usa captcha.
const app = express();
app.use(express.json({ limit: "4mb" }));

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`http error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

function methodNotAllowed(_req: Request, res: Response) {
  res
    .status(405)
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless)" }, id: null });
}
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  process.stderr.write(`sae-mcp (http) escuchando en :${port} — POST /mcp\n`);
});
