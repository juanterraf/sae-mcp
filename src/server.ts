import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./tools.js";

// Crea una instancia del MCP server con las tools registradas. Agnóstico del
// transporte: stdio.ts y http.ts lo conectan a su transporte.
export function createServer(): McpServer {
  const server = new McpServer({
    name: "sae-tucuman",
    version: "0.1.0",
  });
  registerTools(server);
  return server;
}
