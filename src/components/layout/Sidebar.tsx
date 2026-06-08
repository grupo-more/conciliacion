"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Logo } from "@/components/brand/Logo";

interface NavItem {
  href: string;
  label: string;
  matchPrefix?: boolean;
  icon: React.ReactNode;
}

interface SidebarProps {
  /** Estado del drawer en mobile. En desktop (md+) el sidebar siempre está visible. */
  mobileOpen?: boolean;
  /** Se invoca al cerrar el drawer (overlay click, navegación, tecla Escape). */
  onMobileClose?: () => void;
}

// Sidebar de navegación. Los módulos activos son: Dashboard, Consolidados,
// Cartolas, Movimientos 200 (Tesorería) y Configuración.
const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/dashboard/consolidados",
    label: "Consolidados",
    matchPrefix: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h7M4 12h7M4 18h7" />
        <path d="M14 7l2 2 4-4" />
        <path d="M14 13l2 2 4-4" />
        <path d="M14 19l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/dashboard/cartolas",
    label: "Cartolas",
    matchPrefix: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
        <path d="M8 11h8M8 15h8M8 7h4" />
      </svg>
    ),
  },
  {
    href: "/dashboard/tesoreria",
    label: "Movimientos",
    matchPrefix: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M3 10h18" />
        <circle cx="12" cy="14.5" r="1.5" />
      </svg>
    ),
  },
];

const SETTINGS_ITEM: NavItem = {
  href: "/dashboard/configuracion",
  label: "Configuración",
  matchPrefix: true,
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();

  function isActive(item: NavItem): boolean {
    if (item.matchPrefix) return pathname.startsWith(item.href);
    return pathname === item.href;
  }

  // Cerrar drawer con Escape (solo aplica en mobile, en desktop no afecta).
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onMobileClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onMobileClose]);

  // Bloquear scroll del body cuando el drawer está abierto en mobile.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Overlay para mobile cuando el drawer está abierto */}
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          className="fixed inset-0 z-40 bg-brand/30 backdrop-blur-sm md:hidden animate-fade-in"
          aria-hidden
        />
      )}

      <aside
        className={
          "w-64 shrink-0 border-r border-border-soft bg-white/95 backdrop-blur-md shadow-soft flex flex-col " +
          // Mobile: fixed off-canvas con transform
          "fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-out " +
          (mobileOpen ? "translate-x-0" : "-translate-x-full") +
          // Desktop: sticky, siempre visible
          " md:sticky md:top-0 md:h-screen md:self-start md:translate-x-0 md:z-20 md:bg-white/80"
        }
      >
        {/* Logo en header del sidebar */}
        <div className="px-5 py-5 border-b border-border-soft flex items-center justify-between gap-2">
          <Link
            href="/dashboard"
            onClick={onMobileClose}
            className="block group flex-1 min-w-0"
            aria-label="MORE"
          >
            <div className="flex items-center gap-3">
              <Logo
                variant="mark"
                tone="brand"
                className="h-11 w-11 shrink-0 transition-all duration-450 ease-spring group-hover:scale-110 group-hover:rotate-3"
              />
              <div>
                <div className="text-base font-bold tracking-tight text-brand leading-tight">
                  MORE
                </div>
              </div>
            </div>
          </Link>
          {/* Botón de cerrar solo visible en mobile */}
          <button
            onClick={onMobileClose}
            className="md:hidden h-9 w-9 grid place-items-center rounded-md text-text-muted hover:bg-brand-tint hover:text-brand transition-colors"
            aria-label="Cerrar menú"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navegación */}
        <nav className="flex-1 px-3 py-4 space-y-1 stagger overflow-y-auto flex flex-col">
          {NAV_ITEMS.map((item) =>
            renderNavLink(item, isActive(item), onMobileClose)
          )}
          <div className="flex-1" aria-hidden />
          <div className="my-2 border-t border-border-soft/60" aria-hidden />
          {renderNavLink(SETTINGS_ITEM, isActive(SETTINGS_ITEM), onMobileClose)}
        </nav>

        {/* Footer del sidebar */}
        <div className="border-t border-border-soft px-5 py-4">
          <div className="flex items-center justify-between text-[10px]">
            <span className="tracking-wider text-text-dim font-semibold">
              © {new Date().getFullYear()}
            </span>
            <span className="rounded-full bg-accent/10 text-accent px-2 py-0.5 font-bold border border-accent/20 animate-pulse-soft">
              v1.0
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}

function renderNavLink(
  item: NavItem,
  active: boolean,
  onNavigate?: () => void
) {
  return (
    <Link
      key={item.href}
      href={item.href}
      onClick={onNavigate}
      className={
        "relative group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-semibold transition-all duration-250 ease-out overflow-hidden " +
        (active
          ? "bg-brand text-white shadow-brand"
          : "text-text-muted hover:bg-brand-tint hover:text-brand hover:translate-x-0.5")
      }
    >
      {active && (
        <>
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-accent"
            aria-hidden
          />
          <span
            className="absolute inset-y-0 right-0 w-1/3 bg-gradient-to-l from-accent/20 to-transparent opacity-60"
            aria-hidden
          />
        </>
      )}
      <span
        className={
          "h-4 w-4 shrink-0 transition-all duration-300 " +
          (active
            ? "text-white scale-110"
            : "text-text-muted group-hover:text-brand group-hover:scale-110")
        }
      >
        {item.icon}
      </span>
      <span>{item.label}</span>
    </Link>
  );
}
