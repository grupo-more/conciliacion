import { z } from "zod";
import { prisma } from "@/lib/db";

/**
 * Sync del feed /api/movimientos (movimientos-api) -> MovimientoCaja.
 *
 * Trae los DEPOSITOS/RETIROS FISICOS al banco (CAJA_BANCO) y traspasos entre
 * cuentas propias (BANCO_BANCO). Estos sí cuadran 1:1 contra la cartola (a
 * diferencia de las operaciones FX de dynatech). Aislado: no toca el motor de
 * Consolidados.
 *
 * Paginacion por cursor (after_id), igual que el sync de egresos.
 */

const rowSchema = z.object({
  id: z.number().int().positive(),
  mcjId: z.number().int(),
  categoria: z.string(),
  rubro: z.number().int(),
  banco: z.string().optional().nullable(),
  rubroBanco: z.number().int().optional().nullable(),
  rubroSucursal: z.number().int().optional().nullable(),
  direccion: z.string().optional().nullable(),
  mcjES: z.string().optional().nullable(),
  monto: z.number(),
  fecha: z.string(),
  glosa: z.string().optional().default(""),
  sucursal: z.object({ id: z.number().int(), nombre: z.string().optional().nullable() }),
  cajero: z.object({ id: z.string().optional().nullable(), nombre: z.string().optional().nullable() }).optional().nullable(),
  estado: z.object({ actual: z.string().optional().nullable(), anulado: z.boolean().optional().nullable() }).optional().nullable(),
  fechaCarga: z.string().optional().nullable(),
});

export interface MovimientosSyncResult {
  ok: boolean;
  fetchedRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedInvalid: number;
  pages: number;
  fetchMs: number;
  error?: string;
}

function parseDate(s: string): Date {
  if (/[Z+\-]\d{2}:?\d{2}$/.test(s) || s.endsWith("Z")) return new Date(s);
  const tz = process.env.DYNATECH_TIMEZONE_OFFSET || "-04:00";
  return new Date(`${s}${tz}`);
}

function withParams(base: string, limit: string, afterId: string | null): string {
  try {
    const u = new URL(base);
    if (!u.searchParams.has("categoria")) u.searchParams.set("categoria", "CAJA_BANCO,BANCO_BANCO");
    if (!u.searchParams.has("limit")) u.searchParams.set("limit", limit);
    if (afterId) u.searchParams.set("after_id", afterId);
    return u.toString();
  } catch {
    return base;
  }
}

export async function runMovimientosSync(): Promise<MovimientosSyncResult> {
  const base = process.env.MOVIMIENTOS_API_URL;
  const apiKey = process.env.MOVIMIENTOS_API_KEY || process.env.TESORERIA_API_KEY;
  const limit = process.env.MOVIMIENTOS_API_LIMIT ?? "5000";
  const MAX_PAGES = 200;

  const t0 = Date.now();
  let fetchedRows = 0, insertedRows = 0, updatedRows = 0, skippedInvalid = 0, pages = 0;

  if (!base) return { ok: false, fetchedRows, insertedRows, updatedRows, skippedInvalid, pages, fetchMs: 0, error: "MOVIMIENTOS_API_URL no configurada" };

  let afterId: string | null = null;
  const seen = new Set<string>();
  try {
    while (pages < MAX_PAGES) {
      const res = await fetch(withParams(base, limit, afterId), {
        cache: "no-store",
        headers: { Accept: "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
      });
      if (!res.ok) return finish(false, `HTTP ${res.status} en movimientos`);
      const json: unknown = await res.json();
      const data: unknown[] = Array.isArray(json)
        ? json
        : Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : [];
      pages++;
      if (data.length === 0) break;

      for (const raw of data) {
        const p = rowSchema.safeParse(raw);
        if (!p.success) { skippedInvalid++; continue; }
        const r = p.data;
        fetchedRows++;
        const externalId = BigInt(r.id);
        const existing = await prisma.movimientoCaja.findUnique({ where: { externalId }, select: { id: true } });
        const payload = {
          mcjId: BigInt(r.mcjId),
          categoria: r.categoria,
          rubro: r.rubro,
          banco: r.banco ?? null,
          rubroBanco: r.rubroBanco ?? null,
          rubroSucursal: r.rubroSucursal ?? null,
          direccion: r.direccion ?? null,
          mcjES: r.mcjES ?? null,
          monto: BigInt(Math.round(Math.abs(r.monto))),
          fecha: parseDate(r.fecha),
          glosa: r.glosa ?? "",
          sucursalId: r.sucursal.id,
          sucursalName: r.sucursal.nombre ?? null,
          cajeroUsername: r.cajero?.id?.trim().toUpperCase() || null,
          cajeroName: r.cajero?.nombre?.trim() || null,
          estadoActual: r.estado?.actual?.trim().toUpperCase() || null,
          anulado: r.estado?.anulado ?? false,
          fechaCarga: r.fechaCarga ? parseDate(r.fechaCarga) : null,
        };
        await prisma.movimientoCaja.upsert({
          where: { externalId },
          // create: arranca como NO_MATCH; el matcher lo resuelve aparte.
          create: { externalId, ...payload },
          // update: NO pisa el resultado de conciliacion (status/bankMovementId);
          // solo refresca los datos de origen.
          update: { ...payload, syncedAt: new Date() },
        });
        if (existing) updatedRows++; else insertedRows++;
      }

      const pg = (json as { pagination?: { has_more?: boolean; next_after_id?: number | string } }).pagination;
      if (!pg || !pg.has_more || pg.next_after_id == null) break;
      const next = String(pg.next_after_id);
      if (seen.has(next)) break;
      seen.add(next);
      afterId = next;
    }
  } catch (e) {
    return finish(false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  return finish(true);

  function finish(ok: boolean, error?: string): MovimientosSyncResult {
    return { ok, fetchedRows, insertedRows, updatedRows, skippedInvalid, pages, fetchMs: Date.now() - t0, error };
  }
}
