import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";

// RUT centinela que la API usa para ventas sin cliente identificado.
const GENERIC_CUSTOMER_RUT = "55555555-5";

/* --------------------------- Schema de respuesta --------------------------- */

const itemSchema = z.object({
  nombre: z.string(),
  cantidad: z.number(),
  precioUnitario: z.number(),
  monto: z.number(),
});

const rowSchema = z.object({
  contexto: z.object({
    id: z.number().int().positive(),
    sucursal: z.object({
      id: z.number().int().positive(),
      nombre: z.string().optional().nullable(),
    }),
    cajero: z
      .object({
        id: z.string(),
        nombre: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),
    cliente: z
      .object({
        nombre: z.string().optional().nullable(),
        documento: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),
  }),
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
  currency: z.string().optional().default("CLP"),
  items: z.array(itemSchema).default([]),
  fechaCarga: z.string().optional().nullable(),
  // Rubro contable de la sucursal (ej: 202 = caja sucursal X). Nullable porque
  // no todos los movimientos necesariamente lo traen.
  rubroSucursal: z.number().int().optional().nullable(),
  // Rubro contable del banco asociado (ej: 230 = Santander ME).
  rubroBanco: z.number().int().optional().nullable(),
  // Banco asignado al movimiento por reglas (string libre, ej "Santander ME").
  banco: z.string().optional().nullable(),
  // Banco que la sucursal/cajero tenía configurado.
  bancoSucursal: z.string().optional().nullable(),
  // Banco detectado heurísticamente por la API (puede diferir de "banco").
  bancoDetectado: z.string().optional().nullable(),
  // Flag de excepción: el movimiento no cumple alguna regla y requiere revisión.
  esExcepcion: z.boolean().optional().default(false),
});

export type DynatechRow = z.infer<typeof rowSchema>;

/* --------------------------------- Result --------------------------------- */

export interface SyncResult {
  ok: boolean;
  syncRunId?: string;
  fetchedRows: number;
  insertedRows: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  fetchMs: number;
  error?: string;
  errorDetail?: string;
}

/* ---------------------------- Helpers de fechas ---------------------------- */

function parseDynatechDate(s: string): Date {
  // Si la fecha ya viene con sufijo de zona horaria (Z, +HH:MM, -HH:MM), respetarla.
  if (/[Z+\-]\d{2}:?\d{2}$/.test(s) || s.endsWith("Z")) {
    return new Date(s);
  }
  const tz = process.env.DYNATECH_TIMEZONE_OFFSET || "-04:00";
  return new Date(`${s}${tz}`);
}

/* -------------------------- API throttle / staleness ------------------------ */

/**
 * Si el último sync OK fue hace menos de `maxAgeSeconds`, no hace nada y devuelve null.
 * Útil para llamar a esta función cada vez que el usuario abre la página sin saturar
 * la API de Dynatech.
 */
export async function syncDynatechIfStale(
  maxAgeSeconds = 30
): Promise<SyncResult | null> {
  const last = await prisma.dynatechSyncRun.findFirst({
    where: { status: "OK" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  if (last?.finishedAt && Date.now() - last.finishedAt.getTime() < maxAgeSeconds * 1000) {
    return null;
  }
  return runSync();
}

/* --------------------------------- runSync --------------------------------- */

/**
 * Ejecuta el sync incondicionalmente. Crea un DynatechSyncRun para auditoría,
 * fetchea el feed completo, valida con zod, e inserta los nuevos (dedup por
 * unique constraint en mCjId). Si falla, deja el run con status=ERROR y NO
 * actualiza el último OK.
 *
 * Nota: NO usamos cursor incremental (`?after_id=`) porque los mCjId no son
 * monotónicos globales — vienen particionados por sucursal (prefijo del id =
 * sucursal externa). Un MAX(mCjId) global filtraría incorrectamente los
 * movimientos nuevos de sucursales con prefijo más bajo. El feed completo es
 * chico (~3 semanas, decenas de movimientos) y el dedup por unique lo maneja
 * sin costo extra.
 */
export async function runSync(): Promise<SyncResult> {
  const apiUrl = process.env.DYNATECH_API_URL;
  const apiKey = process.env.DYNATECH_API_KEY;

  // Crear el registro de auditoría desde el inicio
  const run = await prisma.dynatechSyncRun.create({
    data: { status: "RUNNING" },
  });
  const runId = run.id;

  if (!apiUrl || !apiKey) {
    return finishWithError(runId, "DYNATECH_API_URL o DYNATECH_API_KEY no configuradas", 0);
  }

  const url = apiUrl;

  // Fetch
  const fetchStart = Date.now();
  let rawData: unknown;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return finishWithError(
        runId,
        `API Dynatech respondió HTTP ${res.status}`,
        Date.now() - fetchStart,
        body.slice(0, 500)
      );
    }
    rawData = await res.json();
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return finishWithError(
      runId,
      "No se pudo conectar a Dynatech",
      Date.now() - fetchStart,
      message
    );
  }
  const fetchMs = Date.now() - fetchStart;

  // La API puede responder como array crudo o envuelto en { data: [...] }.
  const rows: unknown[] | null = Array.isArray(rawData)
    ? rawData
    : Array.isArray((rawData as { data?: unknown })?.data)
    ? ((rawData as { data: unknown[] }).data)
    : null;

  if (!rows) {
    return finishWithError(runId, "Respuesta de Dynatech no es un array", fetchMs);
  }

  const fetchedRows = rows.length;

  // Validar
  const valid: DynatechRow[] = [];
  let skippedInvalid = 0;
  for (const raw of rows) {
    const r = rowSchema.safeParse(raw);
    if (r.success) {
      valid.push(r.data);
    } else {
      skippedInvalid++;
    }
  }

  // Insertar uno a uno con dedup por mCjId (createMany con skipDuplicates es válido,
  // pero lo hacemos uno a uno para devolver el conteo exacto sin re-consultar).
  let insertedRows = 0;
  let skippedDuplicates = 0;
  let nullRubroCount = 0;

  for (const r of valid) {
    const username = r.contexto.cajero?.id?.trim().toUpperCase();
    if (!username) {
      // Sin cajero no podemos insertar (columna NOT NULL). En la práctica
      // todos los movimientos vienen con cajero; este check es defensivo.
      skippedInvalid++;
      continue;
    }
    const cashierName = r.contexto.cajero?.nombre?.trim() || null;
    const rawRut = normalizeRut(r.contexto.cliente?.documento ?? null);
    const customerRut = rawRut && rawRut !== GENERIC_CUSTOMER_RUT ? rawRut : null;
    const customerName = customerRut
      ? r.contexto.cliente?.nombre?.trim() || null
      : null;
    const rubro = r.rubroSucursal ?? null;
    if (rubro === null) nullRubroCount++;
    try {
      await prisma.dynatechMovement.create({
        data: {
          mCjId: BigInt(r.contexto.id),
          branchExternalId: r.contexto.sucursal.id,
          branchExternalName: r.contexto.sucursal.nombre ?? null,
          cashierUsername: username,
          cashierName,
          customerName,
          customerRut,
          documentCode: r.documento?.codigo ?? 0,
          documentType: r.documento?.tipo ?? null,
          documentFolio: BigInt(r.documento?.folio ?? 0),
          observation: r.glosa ?? "",
          occurredAt: parseDynatechDate(r.fecha),
          loadedAt: r.fechaCarga ? parseDynatechDate(r.fechaCarga) : null,
          totalAmount: BigInt(Math.round(r.monto)),
          currency: r.currency ?? "CLP",
          rubro,
          rubroBank: r.rubroBanco ?? null,
          bankName: r.banco ?? null,
          branchBank: r.bancoSucursal ?? null,
          detectedBank: r.bancoDetectado ?? null,
          isException: r.esExcepcion ?? false,
          items: r.items as unknown as object,
          rawJson: r as unknown as object,
        },
      });
      insertedRows++;
    } catch (e) {
      // P2002 = unique constraint violation (mCjId ya existe)
      if (isUniqueViolation(e)) {
        skippedDuplicates++;
        continue;
      }
      // Otro error: lo registramos como inválido (no aborta el sync)
      skippedInvalid++;
      console.error(
        `[dynatech-sync] error insertando id=${r.contexto.id}`,
        e instanceof Error ? e.message : e
      );
    }
  }

  if (nullRubroCount > 0) {
    console.warn(
      `[dynatech-sync] ${nullRubroCount} movimiento(s) sin rubro en este batch (de ${valid.length} validos)`
    );
  }

  await prisma.dynatechSyncRun.update({
    where: { id: runId },
    data: {
      status: "OK",
      finishedAt: new Date(),
      fetchedRows,
      insertedRows,
      skippedDuplicates,
      skippedInvalid,
      fetchMs,
    },
  });

  return {
    ok: true,
    syncRunId: runId,
    fetchedRows,
    insertedRows,
    skippedDuplicates,
    skippedInvalid,
    fetchMs,
  };
}

async function finishWithError(
  runId: string,
  message: string,
  fetchMs: number,
  detail?: string
): Promise<SyncResult> {
  await prisma.dynatechSyncRun.update({
    where: { id: runId },
    data: {
      status: "ERROR",
      finishedAt: new Date(),
      errorMessage: detail ? `${message} — ${detail}` : message,
      fetchMs,
    },
  });
  return {
    ok: false,
    syncRunId: runId,
    fetchedRows: 0,
    insertedRows: 0,
    skippedDuplicates: 0,
    skippedInvalid: 0,
    fetchMs,
    error: message,
    errorDetail: detail,
  };
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return code === "P2002";
}
