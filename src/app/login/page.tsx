"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/brand/Logo";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const lockSecondsLeft =
    lockedUntil !== null ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const locked = lockSecondsLeft > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retry =
          Number(data?.retryAfterSec) ||
          Number(res.headers.get("Retry-After")) ||
          60;
        setLockedUntil(Date.now() + retry * 1000);
        setError(data?.error || "Demasiados intentos. Espera unos minutos.");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Error al iniciar sesión");
        return;
      }
      setLockedUntil(null);
      router.replace(next);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md animate-fade-in-up">
      <div className="flex flex-col items-center mb-8 stagger">
        <div className="animate-float">
          <Logo variant="mark" tone="brand" className="h-20 w-20 drop-shadow-xl" />
        </div>
        <div className="mt-5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gradient-brand">
            MOREGIROS
          </h1>
          <p className="text-xs uppercase tracking-[0.2em] text-text-muted mt-1">
            by More Exchange
          </p>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="card space-y-5 hover-lift animate-scale-in"
      >
        <div className="text-center pb-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Panel de Conciliación
          </h2>
          <p className="text-sm text-text-muted mt-1">
            Inicia sesión para acceder
          </p>
        </div>

        <div className="divider" />

        <div className="space-y-4 stagger">
          <div>
            <label className="label" htmlFor="email">
              Correo corporativo
            </label>
            <input
              id="email"
              type="email"
              className="input"
              placeholder="usuario@moregiros.cl"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger animate-fade-in-down">
            {error}
            {locked && (
              <div className="mt-1 text-xs text-danger/80">
                Vuelve a intentar en {formatLockTime(lockSecondsLeft)}.
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          className="btn-primary w-full py-2.5"
          disabled={loading || locked}
        >
          {loading ? (
            <>
              <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              Ingresando…
            </>
          ) : locked ? (
            <>Bloqueado · {formatLockTime(lockSecondsLeft)}</>
          ) : (
            <>
              Ingresar
              <svg
                className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </>
          )}
        </button>
      </form>

      <p className="text-center text-[10px] uppercase tracking-[0.22em] text-text-dim mt-8">
        © {new Date().getFullYear()} · MoreGiros
        <span className="text-accent mx-1.5">●</span>
        Plataforma interna
      </p>
    </div>
  );
}

function formatLockTime(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export default function LoginPage() {
  return (
    <div className="min-h-screen relative flex items-center justify-center px-4 overflow-hidden bg-brand-soft">
      {/* Capas de fondo decorativas con mesh y grid */}
      <div className="absolute inset-0 bg-brand-mesh" aria-hidden />
      <div
        className="absolute inset-0 bg-pattern-grid opacity-50"
        aria-hidden
      />

      {/* Blobs flotantes */}
      <div
        className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-accent/10 blur-3xl animate-pulse-soft"
        aria-hidden
      />
      <div
        className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-brand/10 blur-3xl animate-pulse-soft"
        style={{ animationDelay: "1.5s" }}
        aria-hidden
      />
      <div
        className="absolute top-1/3 left-1/4 h-32 w-32 rounded-full bg-brand-tonal/15 blur-2xl animate-float"
        aria-hidden
      />

      <div className="relative z-10 w-full flex items-center justify-center">
        <Suspense
          fallback={
            <div className="text-sm text-text-muted">Cargando…</div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
