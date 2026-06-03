// Sliding-window rate limiter en memoria para /api/auth/login.
//
// Bloquea dos vectores en paralelo:
//   · IP: una IP no puede hacer más de MAX_PER_IP intentos fallidos en WINDOW_MS
//   · email: una cuenta no puede recibir más de MAX_PER_EMAIL intentos fallidos
//     en WINDOW_MS (defiende al usuario aunque el atacante rote IPs)
//
// State vive en el proceso Node. Con PM2 single-instance es suficiente. Si en
// el futuro se escala a multi-instancia o serverless, mover a Redis / DB.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 10;
const MAX_PER_EMAIL = 5;
const PRUNE_THRESHOLD = 1000;

type Bucket = { attempts: number[] };

const buckets = new Map<string, Bucket>();

function prune(now: number) {
  if (buckets.size < PRUNE_THRESHOLD) return;
  for (const [k, b] of buckets) {
    b.attempts = b.attempts.filter((t) => now - t < WINDOW_MS);
    if (b.attempts.length === 0) buckets.delete(k);
  }
}

export type RateCheck =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

function check(key: string, max: number, now: number): RateCheck {
  const bucket = buckets.get(key);
  if (!bucket) return { ok: true };
  bucket.attempts = bucket.attempts.filter((t) => now - t < WINDOW_MS);
  if (bucket.attempts.length < max) return { ok: true };
  const oldest = bucket.attempts[0];
  const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  return { ok: false, retryAfterSec };
}

export function checkLoginRate(ip: string, email: string): RateCheck {
  const now = Date.now();
  prune(now);
  const ipResult = check(`ip:${ip}`, MAX_PER_IP, now);
  if (!ipResult.ok) return ipResult;
  return check(`email:${email.toLowerCase()}`, MAX_PER_EMAIL, now);
}

export function recordLoginFailure(ip: string, email: string) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, `email:${email.toLowerCase()}`]) {
    const b = buckets.get(key) ?? { attempts: [] };
    b.attempts.push(now);
    buckets.set(key, b);
  }
}

export function resetLoginRate(ip: string, email: string) {
  buckets.delete(`ip:${ip}`);
  buckets.delete(`email:${email.toLowerCase()}`);
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
