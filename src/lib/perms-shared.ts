/**
 * Constantes y tipos de permisos COMPARTIDOS entre server y client.
 * Sin imports de servidor (next/headers, prisma): importable desde componentes
 * "use client". La lógica de enforcement vive en src/lib/perms.ts (server).
 */

export const MODULOS = [
  "dashboard",
  "consolidados",
  "cartolas",
  "movimientos",
  "reportes",
] as const;
export type Modulo = (typeof MODULOS)[number];

export const ACCIONES = [
  "conciliar",
  "reevaluar",
  "generarAsientos",
  "importar",
  "depurar",
  "configurar",
  "gestionarUsuarios",
] as const;
export type Accion = (typeof ACCIONES)[number];

export const ACCION_LABELS: Record<Accion, string> = {
  conciliar: "Conciliar / vincular",
  reevaluar: "Re-evaluar matching",
  generarAsientos: "Generar asientos y cuadraturas",
  importar: "Importar cartolas / sincronizar",
  depurar: "Depurar (papelera, descartar, duplicados)",
  configurar: "Editar configuración",
  gestionarUsuarios: "Gestionar usuarios y perfiles",
};

export const MODULO_LABELS: Record<Modulo, string> = {
  dashboard: "Dashboard",
  consolidados: "Consolidados",
  cartolas: "Cartolas",
  movimientos: "Movimientos",
  reportes: "Reportes",
};

// Tabs DENTRO de Consolidados que se pueden ocultar por perfil (visibilidad
// granular; el módulo "consolidados" gatea la sección entera, esto cada tab).
// Las claves = los ids de tab de ConsolidadosView.
export const TABS_CONSOLIDADOS = [
  "list",
  "compare",
  "compare-egresos",
  "ok",
  "abono-transbank",
  "cruce-transbank",
  "egresos-terceros",
  "traspasos-internos",
  "dif-menor",
  "asientos-manuales",
  "proveedores",
] as const;
export type TabConsolidados = (typeof TABS_CONSOLIDADOS)[number];

export const TAB_CONSOLIDADOS_LABELS: Record<TabConsolidados, string> = {
  list: "Lista",
  compare: "Comparar Ingresos",
  "compare-egresos": "Comparar Egresos",
  ok: "OK",
  "abono-transbank": "Abono Transbank",
  "cruce-transbank": "Cruce Transbank",
  "egresos-terceros": "Egresos a terceros",
  "traspasos-internos": "Traspasos internos",
  "dif-menor": "Dif menor a 100",
  "asientos-manuales": "Asientos manuales",
  proveedores: "Proveedores",
};

export interface Permisos {
  modulos: Record<Modulo, boolean>;
  acciones: Record<Accion, boolean>;
  tabs: Record<TabConsolidados, boolean>;
}

export function buildPermisos(modulos: boolean, acciones: boolean): Permisos {
  return {
    modulos: Object.fromEntries(MODULOS.map((m) => [m, modulos])) as Permisos["modulos"],
    acciones: Object.fromEntries(ACCIONES.map((a) => [a, acciones])) as Permisos["acciones"],
    // Tabs de Consolidados: por defecto TODAS visibles (es visibilidad, no
    // privilegio). Un perfil solo oculta las que desmarca.
    tabs: Object.fromEntries(TABS_CONSOLIDADOS.map((t) => [t, true])) as Permisos["tabs"],
  };
}

/** Todos los permisos (esAdmin). */
export const PERMISOS_TODO: Permisos = buildPermisos(true, true);
/** Solo lectura: ve todos los módulos, ninguna acción. Default sin perfil. */
export const PERMISOS_SOLO_LECTURA: Permisos = buildPermisos(true, false);

/** Normaliza un Json de BD a la forma canónica (claves faltantes → false). */
export function normalizePermisos(raw: unknown): Permisos {
  const r = (raw ?? {}) as {
    modulos?: Record<string, unknown>;
    acciones?: Record<string, unknown>;
    tabs?: Record<string, unknown>;
  };
  const out = buildPermisos(false, false);
  for (const m of MODULOS) out.modulos[m] = r.modulos?.[m] === true;
  for (const a of ACCIONES) out.acciones[a] = r.acciones?.[a] === true;
  // Tabs de Consolidados: default VISIBLE — solo se oculta si viene explícito en
  // false. Así los perfiles viejos (sin `tabs`) y las tabs nuevas quedan visibles.
  for (const t of TABS_CONSOLIDADOS) out.tabs[t] = r.tabs?.[t] !== false;
  return out;
}
