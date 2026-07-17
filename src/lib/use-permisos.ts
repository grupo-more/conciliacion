"use client";

import { useEffect, useState } from "react";
import type { Accion, Modulo, Permisos, TabConsolidados } from "@/lib/perms-shared";

/**
 * Hook de permisos para la UI. Trae /api/auth/me una vez por carga de página
 * (cache a nivel módulo) y expone can()/canVer().
 *
 * Es solo GATING VISUAL: el enforcement real está en las rutas API
 * (denyUnless). Mientras carga (me === null) se muestra todo, para no
 * parpadear al admin; si un no-autorizado alcanza a clickear, el backend
 * responde 403 con mensaje claro.
 */
export interface MeResp {
  user: { id: string; email: string; name: string | null };
  esAdmin: boolean;
  perfilNombre: string | null;
  permisos: Permisos;
}

let cache: MeResp | null = null;
let inflight: Promise<MeResp | null> | null = null;

async function fetchMe(): Promise<MeResp | null> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return null;
    const j = (await res.json()) as MeResp;
    return j?.user ? j : null;
  } catch {
    return null;
  }
}

export function usePermisos() {
  const [me, setMe] = useState<MeResp | null>(cache);

  useEffect(() => {
    if (cache) return;
    inflight ??= fetchMe().then((j) => {
      cache = j;
      inflight = null;
      return j;
    });
    let alive = true;
    inflight.then((j) => {
      if (alive) setMe(j);
    });
    return () => {
      alive = false;
    };
  }, []);

  const loaded = me !== null;
  const can = (a: Accion): boolean => !loaded || me.esAdmin || me.permisos.acciones[a] === true;
  const canVer = (m: Modulo): boolean => !loaded || me.esAdmin || me.permisos.modulos[m] === true;
  // Tab de Consolidados visible: default TRUE (solo se oculta si el perfil la
  // desmarcó). Mientras carga o admin → visible.
  const canVerTab = (t: TabConsolidados): boolean =>
    !loaded || me.esAdmin || me.permisos.tabs?.[t] !== false;

  return { me, loaded, can, canVer, canVerTab };
}
