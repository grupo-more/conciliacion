import { prisma } from "@/lib/db";
import { extractRut, matchRut, normalizeRut } from "@/lib/internos/detect";

/**
 * Match de movimientos de banco contra el maestro ProveedorAsiento (tab
 * "Proveedores" de Consolidados). Cascada de más a menos confiable — la misma
 * filosofía que el detector de entidades internas:
 *   1. counterpartyRut matchea el RUT del proveedor.
 *   2. RUT incrustado en counterpartyName ("Internet a 77.988.819-3").
 *   3. RUT prefijado en la glosa ("0766931421 Transf a KUSHKI...").
 *   4. Patrón de texto (contains, case-insensitive) en contraparte o glosa —
 *      respaldo para bancos que no traen RUT (ej. "Traspaso A: <persona>").
 */
export interface ProveedorLite {
  id: string;
  nombre: string;
  rut: string | null; // normalizado
  patrones: string[];
}

export interface ProveedorMatch {
  proveedor: ProveedorLite;
  via: "rut" | "rut_in_name" | "rut_in_desc" | "patron";
}

export async function loadProveedores(): Promise<ProveedorLite[]> {
  return prisma.proveedorAsiento.findMany({
    where: { active: true },
    select: { id: true, nombre: true, rut: true, patrones: true },
  });
}

export function matchProveedor(
  m: {
    counterpartyRut?: string | null;
    counterpartyName?: string | null;
    description?: string | null;
  },
  proveedores: ProveedorLite[],
): ProveedorMatch | null {
  if (proveedores.length === 0) return null;

  const rutDirect = normalizeRut(m.counterpartyRut);
  if (rutDirect) {
    for (const p of proveedores) {
      if (p.rut && matchRut(rutDirect, p.rut)) return { proveedor: p, via: "rut" };
    }
  }
  const rutInName = extractRut(m.counterpartyName);
  if (rutInName) {
    for (const p of proveedores) {
      if (p.rut && matchRut(rutInName, p.rut)) return { proveedor: p, via: "rut_in_name" };
    }
  }
  const rutInDesc = extractRut(m.description);
  if (rutInDesc) {
    for (const p of proveedores) {
      if (p.rut && matchRut(rutInDesc, p.rut)) return { proveedor: p, via: "rut_in_desc" };
    }
  }

  const hay = `${m.counterpartyName ?? ""} ${m.description ?? ""}`.toLowerCase();
  if (hay.trim()) {
    for (const p of proveedores) {
      for (const pat of p.patrones) {
        const t = pat.trim().toLowerCase();
        if (t.length >= 3 && hay.includes(t)) return { proveedor: p, via: "patron" };
      }
    }
  }
  return null;
}
