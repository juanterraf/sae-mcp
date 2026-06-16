import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

// Entrypoint LOCAL (Claude Desktop / Cowork / Claude Code). Comunica por
// stdin/stdout (JSON-RPC). NUNCA escribir a stdout fuera del protocolo: los logs
// van a stderr (ver logger.ts). Es el modo donde la búsqueda por número anda
// confiable (corre en tu IP residencial).
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("sae-mcp (stdio) listo\n");
