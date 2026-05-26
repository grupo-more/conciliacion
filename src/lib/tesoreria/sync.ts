import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";

/* --------------------------- Schema de respuesta --------------------------- */

const cajeroSchema = z.object({
  id: z.string(),
  nombre: z.string().optional().nullable(),
});

const clienteSchema = z
  .object({
    nombre: z.string().optional().nullable(),
    documento: z.string().optional().nullable(),
    rut: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

const rowSchema = z.object({
  id: z.number().int(),
  sucursalId: z.number().int(),
  sucursal: z.string().optional().nullable(),
  cajero: cajeroSchema,
  cliente: clienteSchema,
  folio: z.number().int().nonnegative().default(0),
  tipoDocumento: z.string().optional().nullable(),
  codigoDocumento: z.number().int().default(0),
  glosa: z.string().optional().default(""),
  banco: z.string().optional().nullable(),
  rubroBanco: z.number().int().optional().nullable(),
  rubroSucursal: z.number().int().optional().nullable(),
  monto: z.number(),
  fecha: z.string(),
  fechaCarga: z.string().optional().nullable(),
  bancoSucursal: z.string().optional().nullable(),
  bancoDetectado: z.string().optional().nullable(),
  esExcepcion: z.boolean().optional().default(false),
  items: z.array(z.unknown()).optional().default([]),
});

export type TesoreriaRow = z.infer<typeof rowSchema>;

/* --------------------------------- Result --------------------------------- */

export interface TesoreriaSyncResult {
  ok: boolean;
  syncRunId?: string;
  fetchedRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedInvalid: number;
  fetchMs: number;
  error?: string;
  errorDetail?: string;
}

/* ---------------------------- Helpers de fechas ---------------------------- */

function parseTesoreriaDate(s: string): Date {
  if (/[Z+\-]\d{2}:?\d{2}$/.test(s) || s.endsWith("Z")) {
    return new Date(s);
  }
  const tz = process.env.DYNATECH_TIMEZONE_OFFSET || "-04:00";
  return new Date(`${s}${tz}`);
}

/* -------------------------- API throttle / staleness ------------------------ */

export async function syncTesoreriaIfStale(
  maxAgeSeconds = 30
): Promise<TesoreriaSyncResult | null> {
  const last = await prisma.tesoreriaSyncRun.findFirst({
    where: { status: "OK" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  if (last?.finishedAt && Date.now() - last.finishedAt.getTime() < maxAgeSeconds * 1000) {
    return null;
  }
  return runTesoreriaSync();
}

/* --------------------------------- runSync --------------------------------- */

/**
 * Ejecuta el sync de Tesoreria. El feed viene del endpoint /api/banco/conciliacion
 * con el JSON ya clasificado por banco detectado vs banco asignado a sucursal.
 *
 * Usamos upsert (no insert-only) porque los movimientos pueden re-clasificarse
 * en el backend (cambia esExcepcion, bancoDetectado, rubroBanco) y queremos
 * reflejarlo. Para distinguir nuevos vs actualizados, pre-fetcheamos los IDs
 * existentes.
 */
export async function runTesoreriaSync(): Promise<TesoreriaSyncResult> {
  const apiUrl = process.env.TESORERIA_API_URL;
  const apiKey = process.env.TESORERIA_API_KEY;

  const run = await prisma.tesoreriaSyncRun.create({
    data: { status: "RUNNING" },
  });
  const runId = run.id;

  if (!apiUrl) {
    return finishWithError(runId, "TESORERIA_API_URL no configurada", 0);
  }

  const fetchStart = Date.now();
  let rawData: unknown;
  try {
    const res = await fetch(apiUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return finishWithError(
        runId,
        `API Tesoreria respondio HTTP ${res.status}`,
        Date.now() - fetchStart,
        body.slice(0, 500)
      );
    }
    rawData = await res.json();
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return finishWithError(
      runId,
      "No se pudo conectar a Tesoreria",
      Date.now() - fetchStart,
      message
    );
  }
  const fetchMs = Date.now() - fetchStart;

  const rows: unknown[] | null = Array.isArray(rawData)
    ? rawData
    : Array.isArray((rawData as { data?: unknown })?.data)
    ? ((rawData as { data: unknown[] }).data)
    : null;

  if (!rows) {
    return finishWithError(runId, "Respuesta de Tesoreria no es un array", fetchMs);
  }

  const fetchedRows = rows.length;
  const valid: TesoreriaRow[] = [];
  let skippedInvalid = 0;
  for (const raw of rows) {
    const r = rowSchema.safeParse(raw);
    if (r.success) {
      valid.push(r.data);
    } else {
      skippedInvalid++;
    }
  }

  // Pre-fetch para distinguir insert vs update.
  const validIds = valid.map((r) => BigInt(r.id));
  const existing = validIds.length
    ? await prisma.tesoreriaMovement.findMany({
        where: { externalId: { in: validIds } },
        select: { externalId: true },
      })
    : [];
  const existingSet = new Set(existing.map((e) => e.externalId.toString()));

  let insertedRows = 0;
  let updatedRows = 0;

  for (const r of valid) {
    const username = r.cajero.id.trim().toUpperCase();
    const clienteDocRaw =
      (r.cliente?.documento ?? r.cliente?.rut ?? null) || null;
    const clienteRut = clienteDocRaw ? normalizeRut(clienteDocRaw) : null;
    const clienteName = r.cliente?.nombre?.trim() || null;
    const wasExisting = existingSet.has(BigInt(r.id).toString());

    const payload = {
      sucursalId: r.sucursalId,
      sucursalName: r.sucursal ?? null,
      cajeroUsername: username,
      cajeroName: r.cajero.nombre?.trim() || null,
      clienteName,
      clienteRut,
      folio: BigInt(r.folio ?? 0),
      tipoDocumento: r.tipoDocumento ?? null,
      codigoDocumento: r.codigoDocumento ?? 0,
      glosa: r.glosa ?? "",
      banco: r.banco ?? null,
      bancoSucursal: r.bancoSucursal ?? null,
      bancoDetectado: r.bancoDetectado ?? null,
      rubroBanco: r.rubroBanco ?? null,
      rubroSucursal: r.rubroSucursal ?? null,
      monto: BigInt(Math.round(r.monto)),
      fecha: parseTesoreriaDate(r.fecha),
      fechaCarga: r.fechaCarga ? parseTesoreriaDate(r.fechaCarga) : null,
      esExcepcion: r.esExcepcion ?? false,
      items: r.items as unknown as object,
      rawJson: r as unknown as object,
    };

    try {
      await prisma.tesoreriaMovement.upsert({
        where: { externalId: BigInt(r.id) },
        create: { externalId: BigInt(r.id), ...payload },
        update: { ...payload, syncedAt: new Date() },
      });
      if (wasExisting) updatedRows++;
      else insertedRows++;
    } catch (e) {
      skippedInvalid++;
      console.error(
        `[tesoreria-sync] error en upsert id=${r.id}`,
        e instanceof Error ? e.message : e
      );
    }
  }

  await prisma.tesoreriaSyncRun.update({
    where: { id: runId },
    data: {
      status: "OK",
      finishedAt: new Date(),
      fetchedRows,
      insertedRows,
      updatedRows,
      skippedDuplicates: 0,
      skippedInvalid,
      fetchMs,
    },
  });

  return {
    ok: true,
    syncRunId: runId,
    fetchedRows,
    insertedRows,
    updatedRows,
    skippedInvalid,
    fetchMs,
  };
}

async function finishWithError(
  runId: string,
  message: string,
  fetchMs: number,
  detail?: string
): Promise<TesoreriaSyncResult> {
  await prisma.tesoreriaSyncRun.update({
    where: { id: runId },
    data: {
      status: "ERROR",
      finishedAt: new Date(),
      errorMessage: detail ? `${message} - ${detail}` : message,
      fetchMs,
    },
  });
  return {
    ok: false,
    syncRunId: runId,
    fetchedRows: 0,
    insertedRows: 0,
    updatedRows: 0,
    skippedInvalid: 0,
    fetchMs,
    error: message,
    errorDetail: detail,
  };
}
