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

export interface Permisos {
  modulos: Record<Modulo, boolean>;
  acciones: Record<Accion, boolean>;
}

export function buildPermisos(modulos: boolean, acciones: boolean): Permisos {
  return {
    modulos: Object.fromEntries(MODULOS.map((m) => [m, modulos])) as Permisos["modulos"],
    acciones: Object.fromEntries(ACCIONES.map((a) => [a, acciones])) as Permisos["acciones"],
  };
}

/** Todos los permisos (esAdmin). */
export const PERMISOS_TODO: Permisos = buildPermisos(true, true);
/** Solo lectura: ve todos los módulos, ninguna acción. Default sin perfil. */
export const PERMISOS_SOLO_LECTURA: Permisos = buildPermisos(true, false);

/** Normaliza un Json de BD a la forma canónica (claves faltantes → false). */
export function normalizePermisos(raw: unknown): Permisos {
  const r = (raw ?? {}) as { modulos?: Record<string, unknown>; acciones?: Record<string, unknown> };
  const out = buildPermisos(false, false);
  for (const m of MODULOS) out.modulos[m] = r.modulos?.[m] === true;
  for (const a of ACCIONES) out.acciones[a] = r.acciones?.[a] === true;
  return out;
}
