import { z } from "zod";
import { prisma } from "@/lib/db";

/**
 * Sync del feed de gastos operativos /api/egresos -> EgresoMovement.
 *
 * Shape plano (distinto a dynatech): id, fecha, monto, glosa, sucursal{id,nombre},
 * cajero{id,nombre}, rubro{id,nombre}, fechaCarga. Aislado del motor de
 * consolidados (no entra a TesoreriaMovement). Solo vista por ahora.
 *
 * La muestra no trae paginacion; igual soportamos cursor por si la API la agrega.
 */

const recordSchema = z.object({
  id: z.number().int().positive(),
  fecha: z.string(),
  monto: z.number(),
  glosa: z.string().optional().default(""),
  sucursal: z.object({
    id: z.number().int(),
    nombre: z.string().optional().nullable(),
  }),
  cajero: z
    .object({ id: z.string().optional().nullable(), nombre: z.string().optional().nullable() })
    .optional()
    .nullable(),
  rubro: z
    .object({ id: z.number().int().optional().nullable(), nombre: z.string().optional().nullable() })
    .optional()
    .nullable(),
  fechaCarga: z.string().optional().nullable(),
});

export interface EgresosSyncResult {
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

function withParams(base: string, limit: string, afterId: string | null, cursorParam: string): string {
  try {
    const u = new URL(base);
    if (!u.searchParams.has("limit")) u.searchParams.set("limit", limit);
    if (afterId) u.searchParams.set(cursorParam, afterId);
    return u.toString();
  } catch {
    return base;
  }
}

export async function runEgresosSync(): Promise<EgresosSyncResult> {
  const apiUrl = process.env.EGRESOS_API_URL || "http://172.16.10.172:5158/api/egresos";
  const apiKey = process.env.EGRESOS_API_KEY || process.env.TESORERIA_API_KEY;
  const limit = process.env.EGRESOS_API_LIMIT ?? "1000";
  const cursorParam = process.env.EGRESOS_AFTER_PARAM ?? "after_id";
  const MAX_PAGES = 200;

  const t0 = Date.now();
  let fetchedRows = 0, insertedRows = 0, updatedRows = 0, skippedInvalid = 0, pages = 0;
  let afterId: string | null = null;
  const seenCursors = new Set<string>();

  try {
    while (pages < MAX_PAGES) {
      const res = await fetch(withParams(apiUrl, limit, afterId, cursorParam), {
        cache: "no-store",
        headers: { Accept: "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
      });
      if (!res.ok) return finish(false, `HTTP ${res.status} en egresos`);
      const json: unknown = await res.json();
      const data: unknown[] = Array.isArray(json)
        ? json
        : Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : [];
      pages++;
      if (data.length === 0) break;

      for (const raw of data) {
        const p = recordSchema.safeParse(raw);
        if (!p.success) { skippedInvalid++; continue; }
        const r = p.data;
        fetchedRows++;
        const externalId = BigInt(r.id);
        const existing = await prisma.egresoMovement.findUnique({
          where: { externalId },
          select: { id: true },
        });
        const payload = {
          sucursalId: r.sucursal.id,
          sucursalName: r.sucursal.nombre ?? null,
          cajeroUsername: r.cajero?.id?.trim().toUpperCase() || null,
          cajeroName: r.cajero?.nombre?.trim() || null,
          glosa: r.glosa ?? "",
          monto: BigInt(Math.round(r.monto)),
          rubroId: r.rubro?.id ?? null,
          rubroNombre: r.rubro?.nombre?.trim() || null,
          fecha: parseDate(r.fecha),
          fechaCarga: r.fechaCarga ? parseDate(r.fechaCarga) : null,
          rawJson: r as unknown as object,
        };
        await prisma.egresoMovement.upsert({
          where: { externalId },
          create: { externalId, ...payload },
          update: { ...payload, syncedAt: new Date() },
        });
        if (existing) updatedRows++; else insertedRows++;
      }

      const pg = (json as { pagination?: { has_more?: boolean; next_after_id?: number | string } }).pagination;
      if (!pg || !pg.has_more || pg.next_after_id == null) break;
      const next = String(pg.next_after_id);
      if (seenCursors.has(next)) break;
      seenCursors.add(next);
      afterId = next;
    }
  } catch (e) {
    return finish(false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  return finish(true);

  function finish(ok: boolean, error?: string): EgresosSyncResult {
    return { ok, fetchedRows, insertedRows, updatedRows, skippedInvalid, pages, fetchMs: Date.now() - t0, error };
  }
}
