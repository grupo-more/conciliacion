import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";

/**
 * Sync del feed POS de ventas con tarjeta: /api/tbk-tesoreria.
 *
 * Mismo shape que Dynatech pero AISLADO: cae en TbkTesoreria (no en
 * TesoreriaMovement), por lo que NO entra al motor de consolidados (ingresos).
 * Se cruza contra TransbankSale en la tab "Cruce Transbank".
 *
 * El feed pagina por cursor: { data:[...], pagination:{ limit, next_after_id,
 * has_more } }. Iteramos hasta has_more=false (con tope de seguridad).
 */

const recordSchema = z.object({
  contexto: z.object({
    id: z.number().int().positive(),
    sucursal: z.object({
      id: z.number().int(),
      nombre: z.string().optional().nullable(),
    }),
    cajero: z
      .object({ id: z.string().optional().nullable(), nombre: z.string().optional().nullable() })
      .optional()
      .nullable(),
  }),
  glosa: z.string().optional().default(""),
  fecha: z.string(),
  monto: z.number(),
  folio: z.number().int().nonnegative().optional().default(0),
  cliente: z
    .object({
      nombre: z.string().optional().nullable(),
      documento: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  rubro: z.number().int().optional().nullable(),
  currency: z.string().optional().default("CLP"),
  fechaCarga: z.string().optional().nullable(),
  tipo: z.string().optional().default("TBK"),
});

export interface TbkSyncResult {
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

/**
 * Extrae el N° de operacion (= N° de boleta del settlement Transbank) de la
 * glosa POS. Ejemplos: "OP3958"→3958, "VTA. TBK. DBTO. OP. 3922"→3922,
 * "GIRO 13370 N OPE 3932"→3932 (no 13370), "NO 003919"→3919.
 */
export function extractOpNumber(glosa: string): string | null {
  const g = (glosa || "").toUpperCase();
  const re = /\b(?:N\s*OPE|OPE|OP|NO|TD\s*OP|TCKT|TKT)[\s.:#]*0*(\d{2,7})/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(g)) !== null) last = m[1];
  if (last) return last.replace(/^0+/, "") || last;
  const nums = g.match(/\d{2,7}/g);
  return nums ? nums[nums.length - 1].replace(/^0+/, "") || nums[nums.length - 1] : null;
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

export async function runTbkTesoreriaSync(): Promise<TbkSyncResult> {
  const apiUrl =
    process.env.TBK_TESORERIA_API_URL ||
    "http://172.16.10.172:5158/api/tbk-tesoreria";
  const apiKey = process.env.TBK_TESORERIA_API_KEY || process.env.TESORERIA_API_KEY;
  // El feed tope la pagina en 1000 y trae has_more cuando hay mas → paginamos
  // por cursor. El nombre del parametro de cursor es configurable por si la API
  // no usa "after_id" (el response trae next_after_id).
  const limit = process.env.TBK_TESORERIA_API_LIMIT ?? "1000";
  const cursorParam = process.env.TBK_TESORERIA_AFTER_PARAM ?? "after_id";
  const MAX_PAGES = 200;

  const t0 = Date.now();
  let fetchedRows = 0;
  let insertedRows = 0;
  let updatedRows = 0;
  let skippedInvalid = 0;
  let pages = 0;
  let afterId: string | null = null;
  const seenCursors = new Set<string>();

  try {
    while (pages < MAX_PAGES) {
      const url = withParams(apiUrl, limit, afterId, cursorParam);
      const res = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
      });
      if (!res.ok) {
        return finish(false, `HTTP ${res.status} en tbk-tesoreria`);
      }
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
        if (!p.success) {
          skippedInvalid++;
          continue;
        }
        const r = p.data;
        fetchedRows++;
        const externalId = BigInt(r.contexto.id);
        const existing = await prisma.tbkTesoreria.findUnique({
          where: { externalId },
          select: { id: true },
        });
        const clienteDoc = r.cliente?.documento ?? null;
        const payload = {
          sucursalId: r.contexto.sucursal.id,
          sucursalName: r.contexto.sucursal.nombre ?? null,
          cajeroUsername: r.contexto.cajero?.id?.trim().toUpperCase() || null,
          cajeroName: r.contexto.cajero?.nombre?.trim() || null,
          glosa: r.glosa ?? "",
          opNumber: extractOpNumber(r.glosa ?? ""),
          fecha: parseDate(r.fecha),
          monto: BigInt(Math.round(r.monto)),
          folio: BigInt(r.folio ?? 0),
          rubro: r.rubro ?? null,
          tipo: r.tipo ?? "TBK",
          clienteName: r.cliente?.nombre?.trim() || null,
          clienteRut: clienteDoc ? normalizeRut(clienteDoc) : null,
          fechaCarga: r.fechaCarga ? parseDate(r.fechaCarga) : null,
          rawJson: r as unknown as object,
        };
        await prisma.tbkTesoreria.upsert({
          where: { externalId },
          create: { externalId, ...payload },
          update: { ...payload, syncedAt: new Date() },
        });
        if (existing) updatedRows++;
        else insertedRows++;
      }

      // Paginacion por cursor.
      const pg = (json as { pagination?: { has_more?: boolean; next_after_id?: number | string } }).pagination;
      if (!pg || !pg.has_more || pg.next_after_id == null) break;
      const next = String(pg.next_after_id);
      if (seenCursors.has(next)) break; // anti-loop
      seenCursors.add(next);
      afterId = next;
    }
  } catch (e) {
    return finish(false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }

  return finish(true);

  function finish(ok: boolean, error?: string): TbkSyncResult {
    return {
      ok,
      fetchedRows,
      insertedRows,
      updatedRows,
      skippedInvalid,
      pages,
      fetchMs: Date.now() - t0,
      error,
    };
  }
}
