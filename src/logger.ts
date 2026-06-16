// Logger a STDERR. Crítico en modo stdio: stdout está reservado para el protocolo
// JSON-RPC del MCP, así que cualquier log debe ir a stderr o corrompe la sesión.
function write(level: string, event: string, data?: unknown) {
  try {
    process.stderr.write(`${JSON.stringify({ level, event, data })}\n`);
  } catch {
    // si data no es serializable, no romper por un log
    process.stderr.write(`${level} ${event}\n`);
  }
}

export function logInfo(event: string, data?: unknown) {
  write("info", event, data);
}

export function logWarn(event: string, data?: unknown) {
  write("warn", event, data);
}

export function logError(event: string, err: unknown, data?: unknown) {
  const error = err instanceof Error ? { message: err.message, stack: err.stack } : err;
  write("error", event, { ...(typeof data === "object" && data ? data : { data }), error });
}
