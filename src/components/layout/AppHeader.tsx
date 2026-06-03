"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";

interface Props {
  user: { email: string; name: string | null };
  /** Abre el drawer del sidebar en mobile. */
  onMenuClick?: () => void;
}

const SECTION_LABELS: Record<string, string> = {
  "/dashboard": "Dashboard general",
  "/dashboard/consolidados": "Consolidados",
  "/dashboard/cartolas": "Cartolas bancarias",
  "/dashboard/tesoreria": "Movimientos 200",
  "/dashboard/configuracion": "Configuración",
};

export function AppHeader({ user, onMenuClick }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const sectionLabel =
    Object.entries(SECTION_LABELS)
      .filter(([k]) => pathname.startsWith(k))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "Panel";

  const initials = getInitials(user.name || user.email);

  return (
    <header className="sticky top-0 z-30 h-14 md:h-16 border-b border-border-soft bg-white/80 backdrop-blur-md px-3 md:px-6 flex items-center justify-between gap-2 shadow-soft">
      <div className="flex items-center gap-2 md:gap-3 animate-fade-in-right min-w-0 flex-1">
        {/* Botón hamburguesa solo en mobile */}
        <button
          onClick={onMenuClick}
          className="md:hidden h-10 w-10 grid place-items-center rounded-md text-brand hover:bg-brand-tint transition-colors shrink-0"
          aria-label="Abrir menú"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>

        <div
          className="hidden md:block h-9 w-1 rounded-full bg-gradient-to-b from-brand via-brand-soft to-accent shrink-0"
          aria-hidden
        />
        <div className="min-w-0">
          <div className="hidden md:block text-[10px] uppercase tracking-[0.2em] text-text-muted font-semibold">
            MORE
          </div>
          <div className="text-sm md:text-base font-bold text-brand transition-colors duration-300 truncate">
            {sectionLabel}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 md:gap-3 animate-fade-in-left shrink-0">
        <div className="hidden sm:flex flex-col items-end">
          <div className="text-sm font-semibold text-brand leading-tight">
            {user.name || user.email.split("@")[0]}
          </div>
          {user.name && (
            <div className="text-[11px] text-text-muted leading-tight">
              {user.email}
            </div>
          )}
        </div>

        <Link
          href="/dashboard/configuracion"
          className="grid place-items-center h-9 w-9 md:h-10 md:w-10 rounded-full bg-brand text-white text-xs font-bold shadow-brand ring-2 ring-accent/30 transition-all duration-300 hover:scale-110 hover:ring-accent/60"
          title="Configuración"
          aria-label="Configuración"
        >
          {initials}
        </Link>

        <button
          onClick={logout}
          className="btn-ghost text-xs gap-1.5 group !px-2 md:!px-3"
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
        >
          <svg
            className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
          <span className="hidden sm:inline">Salir</span>
        </button>
      </div>
    </header>
  );
}

function getInitials(s: string): string {
  const cleaned = s.split("@")[0].trim();
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
