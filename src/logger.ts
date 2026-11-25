const SECRET_KEYS = /authorization|token|secret|password|api.?key|phone|email|address|transcript|error/i;

export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SECRET_KEYS.test(key)) safe[key] = value;
  }
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safe })}\n`);
}
