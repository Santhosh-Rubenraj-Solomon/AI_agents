/**
 * utils/logger.ts — Structured logger with module context.
 */

export function createLogger(module: string) {
  const fmt = (level: string, msg: string, data?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const base = `[${ts}] [${level}] [${module}] ${msg}`;
    if (data && Object.keys(data).length > 0) {
      return `${base} ${JSON.stringify(data)}`;
    }
    return base;
  };

  return {
    info: (msg: string, data?: Record<string, unknown>) => console.log(fmt("INFO", msg, data)),
    warn: (msg: string, data?: Record<string, unknown>) => console.warn(fmt("WARN", msg, data)),
    error: (msg: string, data?: Record<string, unknown>) => console.error(fmt("ERROR", msg, data)),
    debug: (msg: string, data?: Record<string, unknown>) => console.debug(fmt("DEBUG", msg, data)),
  };
}
