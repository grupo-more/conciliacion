// Log estructurado de eventos sensibles. Escribe JSON line a stdout — PM2 ya
// captura stdout en logs/out.log, así que sin infra adicional queda trazabilidad
// mínima de auth (login OK/fail, logout, cambios de password, rate-limit).
//
// Cuando se mueva a logging centralizado (CloudWatch, Loki, etc.) basta con
// apuntar el agente a este stream — el formato ya es JSON parseable.

type AuthEvent =
  | "auth.login.ok"
  | "auth.login.fail"
  | "auth.login.blocked"
  | "auth.logout"
  | "auth.password.changed";

interface AuditPayload {
  ip?: string;
  email?: string;
  userId?: string;
  reason?: string;
  retryAfterSec?: number;
}

export function audit(event: AuthEvent, payload: AuditPayload = {}) {
  const line = {
    ts: new Date().toISOString(),
    event,
    ...payload,
  };
  // eslint-disable-next-line no-console
  console.info(JSON.stringify(line));
}
