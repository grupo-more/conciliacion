import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";

/* --------------------------- Schema de respuesta --------------------------- */
//
// Esta sync consume /api/dynatech (formato anidado con `contexto`). Es el
// endpoint unificado que reemplaza al viejo /api/banco/conciliacion.
//
// El nombre "tesoreria" del modulo es legacy. La tabla y el modulo de UI
// "Movimientos 200" siguen llamandose internamente Tesoreria por historia,
// pero la fuente de datos es la misma API que usa Dynatech.

const cajeroSchema = z
  .object({
    id: z.string(),
    nombre: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

const clienteSchema = z
  .object({
    nombre: z.string().optional().nullable(),
    documento: z.string().optional().nullable(),
    rut: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

const itemSchema = z.object({
  nombre: z.string(),
  cantidad: z.number(),
  precioUnitario: z.number(),
  monto: z.number(),
});

// Estado del documento en origen (campo nuevo de la API, jun-2026). CAJ =
// cajeado (valido), ANU = anulado. `anulado`=true marca la transicion CAJ->ANU
// (se anulo despues de existir como valido); un doc que nace ANU trae
// anulado=false. Todo opcional para robustez con payloads viejos.
const estadoSchema = z
  .object({
    original: z.string().optional().nullable(),
    actual: z.string().optional().nullable(),
    anulado: z.boolean().optional().nullable(),
  })
  .optional()
  .nullable();

const rowSchema = z.object({
  // El payload viene anidado en `contexto`
  contexto: z.object({
    id: z.number().int().positive(),
    sucursal: z.object({
      id: z.number().int().positive(),
      nombre: z.string().optional().nullable(),
    }),
    cajero: cajeroSchema,
    cliente: clienteSchema,
    estado: estadoSchema,
  }),
  // documento es nullable a nivel root
  documento: z
    .object({
      codigo: z.number().int(),
      tipo: z.string().optional().nullable(),
      folio: z.number().int().nonnegative().default(0),
    })
    .optional()
    .nullable(),
  glosa: z.string().optional().default(""),
  fecha: z.string(),
  monto: z.number(),
  // CLASE de operación: TBK | INGRESO | EGRESO | CRYPTOMKT_* (string libre para
  // no rechazar valores nuevos). La DIRECCIÓN viene en `naturalezaOperacion`.
  tipoOperacion: z.string().optional().nullable(),
  // DIRECCIÓN del movimiento (jun-2026): INGRESO | EGRESO. Si no viene, se deriva
  // del signo del monto / de la clase en el upsert.
  naturalezaOperacion: z.string().optional().nullable(),
  currency: z.string().optional().default("CLP"),
  banco: z.string().optional().nullable(),
  rubroBanco: z.number().int().optional().nullable(),
  rubroSucursal: z.number().int().optional().nullable(),
  bancoSucursal: z.string().optional().nullable(),
  bancoDetectado: z.string().optional().nullable(),
  esExcepcion: z.boolean().optional().default(false),
  items: z.array(itemSchema).optional().default([]),
  fechaCarga: z.string().optional().nullable(),
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
 * Ejecuta el sync. El feed viene del endpoint /api/dynatech (endpoint
 * unificado que reemplaza al viejo /api/banco/conciliacion). El JSON viene
 * ya clasificado por banco detectado vs banco asignado a sucursal.
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
  const validIds = valid.map((r) => BigInt(r.contexto.id));
  const existing = validIds.length
    ? await prisma.tesoreriaMovement.findMany({
        where: { externalId: { in: validIds } },
        select: { externalId: true },
      })
    : [];
  const existingSet = new Set(existing.map((e) => e.externalId.toString()));

  let insertedRows = 0;
  let updatedRows = 0;
  let skippedNoCashier = 0;

  for (const r of valid) {
    // OJO: NO descartamos los `tipoOperacion="TBK"`. Aunque la API los etiquete
    // así, no hay garantía de que sean el mismo movimiento que llega por el feed
    // TbkTesoreria (esa etiqueta es solo un dato más de esta API, no una llave de
    // duplicado). Los guardamos como un movimiento más, con su clase = "TBK".
    // Sin cajero no podemos insertar (columna NOT NULL). En la practica todos
    // los movimientos vienen con cajero; este check es defensivo.
    const username = r.contexto.cajero?.id?.trim().toUpperCase();
    if (!username) {
      skippedNoCashier++;
      skippedInvalid++;
      continue;
    }
    const cajeroName = r.contexto.cajero?.nombre?.trim() || null;

    const clienteDocRaw =
      (r.contexto.cliente?.documento ?? r.contexto.cliente?.rut ?? null) || null;
    const clienteRut = clienteDocRaw ? normalizeRut(clienteDocRaw) : null;
    const clienteName = r.contexto.cliente?.nombre?.trim() || null;
    const wasExisting = existingSet.has(BigInt(r.contexto.id).toString());

    // DIRECCIÓN (INGRESO/EGRESO): la API la manda en `naturalezaOperacion`.
    // Fallback robusto: si la clase es EGRESO/CRYPTOMKT_RETIRO o el monto es
    // negativo => EGRESO; si no, INGRESO. (OJO: el signo NO basta — los retiros
    // cripto son egresos con monto positivo.)
    const nat = r.naturalezaOperacion;
    const tipoOperacion: "INGRESO" | "EGRESO" =
      nat === "EGRESO" || nat === "INGRESO"
        ? nat
        : r.tipoOperacion === "EGRESO" || r.tipoOperacion === "CRYPTOMKT_RETIRO" || r.monto < 0
          ? "EGRESO"
          : "INGRESO";

    const payload = {
      sucursalId: r.contexto.sucursal.id,
      sucursalName: r.contexto.sucursal.nombre ?? null,
      cajeroUsername: username,
      cajeroName,
      clienteName,
      clienteRut,
      folio: BigInt(r.documento?.folio ?? 0),
      tipoDocumento: r.documento?.tipo ?? null,
      codigoDocumento: r.documento?.codigo ?? 0,
      glosa: r.glosa ?? "",
      banco: r.banco ?? null,
      bancoSucursal: r.bancoSucursal ?? null,
      bancoDetectado: r.bancoDetectado ?? null,
      rubroBanco: r.rubroBanco ?? null,
      rubroSucursal: r.rubroSucursal ?? null,
      monto: BigInt(Math.round(r.monto)),
      tipoOperacion,
      claseOperacion: r.tipoOperacion ?? null,
      fecha: parseTesoreriaDate(r.fecha),
      fechaCarga: r.fechaCarga ? parseTesoreriaDate(r.fechaCarga) : null,
      esExcepcion: r.esExcepcion ?? false,
      estadoOriginal: r.contexto.estado?.original?.trim().toUpperCase() || null,
      estadoActual: r.contexto.estado?.actual?.trim().toUpperCase() || null,
      anulado: r.contexto.estado?.anulado ?? false,
      items: r.items as unknown as object,
      rawJson: r as unknown as object,
    };

    try {
      await prisma.tesoreriaMovement.upsert({
        where: { externalId: BigInt(r.contexto.id) },
        create: { externalId: BigInt(r.contexto.id), ...payload },
        update: { ...payload, syncedAt: new Date() },
      });
      if (wasExisting) updatedRows++;
      else insertedRows++;
    } catch (e) {
      skippedInvalid++;
      console.error(
        `[tesoreria-sync] error en upsert id=${r.contexto.id}`,
        e instanceof Error ? e.message : e
      );
    }
  }

  if (skippedNoCashier > 0) {
    console.warn(
      `[tesoreria-sync] ${skippedNoCashier} movimiento(s) descartados por falta de cajero.`
    );
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
