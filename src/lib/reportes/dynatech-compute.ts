/**
 * Cómputo del reporte "Dynatech sin contraparte". Compartido entre el
 * detalle (/api/reportes/dynatech-sin-conciliar) y la Auditoría de cuadre
 * (/api/reportes/auditoria-cuadre), para que ambos cuenten EXACTAMENTE lo
 * mismo.
 *
 * A diferencia de BankMovement, TesoreriaMovement no tiene un accountId real
 * — solo un `banco` (string suelto) y un `rubroBanco` (código numérico). Para
 * filtrar por una BankAccount específica (Auditoría de cuadre), resolvemos su
 * rubro vía RubroLabel.accountId (mismo mecanismo usado en OK/Egresos a
 * terceros/Traspasos internos) y filtramos por ese rubroBanco.
 */
import { prisma } from "@/lib/db";
import {
  agingBucket,
  dynatechMotivo,
  CONCILIADO_STATUSES,
  type AgingBucket,
  type DynatechMotivo,
} from "./classify";

const TAKE = 5000;

export interface DynatechFilters {
  banco?: string | null;
  tipo?: string | null; // "INGRESO" | "EGRESO"
  motivo?: DynatechMotivo | null;
  /** Filtra por la BankAccount real, resuelta vía RubroLabel.accountId → rubroBanco. */
  accountId?: string | null;
}

export interface DynatechRow {
  id: string;
  externalId: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  banco: string | null;
  sucursalName: string | null;
  sucursalId: number;
  clienteName: string | null;
  clienteRut: string | null;
  glosa: string;
  folio: string;
  motivo: DynatechMotivo;
}

export async function computeDynatechSinConciliar(
  from: Date,
  to: Date,
  filters: DynatechFilters = {},
  /** Fecha de referencia para el aging. Default hoy. Ver computeBancoSinConciliar. */
  agingRef?: Date,
) {
  // Resolver accountId -> rubro (enlace explícito Configuración → Rubros).
  // Sin enlace, no hay forma de saber qué TesoreriaMovement pertenecen a esa
  // cuenta real — se devuelve vacío en vez de adivinar.
  let rubroBancoFiltro: number | null = null;
  let accountSinRubro = false;
  if (filters.accountId) {
    const rubroLabel = await prisma.rubroLabel.findFirst({
      where: { accountId: filters.accountId },
      select: { rubro: true },
    });
    if (rubroLabel) rubroBancoFiltro = rubroLabel.rubro;
    else accountSinRubro = true;
  }

  const movements = accountSinRubro
    ? []
    : await prisma.tesoreriaMovement.findMany({
        where: {
          fecha: { gte: from, lt: to },
          estadoActual: { not: "ANU" },
          ...(filters.banco ? { banco: filters.banco } : {}),
          ...(filters.tipo === "INGRESO" || filters.tipo === "EGRESO"
            ? { tipoOperacion: filters.tipo }
            : {}),
          ...(rubroBancoFiltro !== null ? { rubroBanco: rubroBancoFiltro } : {}),
          NOT: { consolidado: { status: { in: [...CONCILIADO_STATUSES] } } },
        },
        select: {
          id: true,
          externalId: true,
          fecha: true,
          monto: true,
          tipoOperacion: true,
          banco: true,
          glosa: true,
          folio: true,
          sucursalName: true,
          sucursalId: true,
          clienteName: true,
          clienteRut: true,
          esExcepcion: true,
          acreedorTesoreriaAt: true,
          consolidado: { select: { status: true } },
        },
        orderBy: [{ fecha: "desc" }],
        take: TAKE,
      });

  const rows: DynatechRow[] = [];
  const bancoSet = new Set<string>();

  let count = 0;
  let montoAbs = 0n;
  const porTipo = mkAmountMap(["INGRESO", "EGRESO"]);
  const porMotivo = mkAmountMap<DynatechMotivo>([
    "sin_procesar",
    "sugerido",
    "revisar",
    "excepcion",
    "sin_match",
    "fuera_scope",
    "acreedor",
  ]);
  const porAging = mkAmountMap<AgingBucket>(["0-7", "8-30", "31-60", "60+"]);
  const porBanco = new Map<string, { count: number; monto: bigint }>();
  const now = agingRef ?? new Date();

  for (const tm of movements) {
    const motivo = dynatechMotivo(
      tm.consolidado?.status,
      tm.esExcepcion,
      tm.acreedorTesoreriaAt !== null,
    );
    if (filters.motivo && motivo !== filters.motivo) continue;

    const abs = tm.monto < 0n ? -tm.monto : tm.monto;
    const { days, bucket } = agingBucket(tm.fecha, now);
    if (tm.banco) bancoSet.add(tm.banco);

    count++;
    montoAbs += abs;
    bump(porTipo, tm.tipoOperacion === "EGRESO" ? "EGRESO" : "INGRESO", abs);
    bump(porMotivo, motivo, abs);
    bump(porAging, bucket, abs);
    const bk = tm.banco ?? "—";
    const be = porBanco.get(bk) ?? { count: 0, monto: 0n };
    be.count++;
    be.monto += abs;
    porBanco.set(bk, be);

    rows.push({
      id: tm.id,
      externalId: tm.externalId.toString(),
      fecha: tm.fecha.toISOString(),
      aging: days,
      agingBucket: bucket,
      tipoOperacion: tm.tipoOperacion === "EGRESO" ? "EGRESO" : "INGRESO",
      monto: abs.toString(),
      banco: tm.banco,
      sucursalName: tm.sucursalName,
      sucursalId: tm.sucursalId,
      clienteName: tm.clienteName,
      clienteRut: tm.clienteRut,
      glosa: tm.glosa,
      folio: tm.folio.toString(),
      motivo,
    });
  }

  return {
    truncated: movements.length === TAKE,
    rows,
    resumen: {
      count,
      monto: montoAbs.toString(),
      porTipo: dumpAmountMap(porTipo),
      porMotivo: dumpAmountMap(porMotivo),
      porAging: dumpAmountMap(porAging),
      porBanco: [...porBanco.entries()]
        .map(([label, b]) => ({ label, count: b.count, monto: b.monto.toString() }))
        .sort((a, b) => Number(BigInt(b.monto) - BigInt(a.monto))),
    },
    facets: {
      bancos: [...bancoSet].sort((a, b) => a.localeCompare(b)),
    },
  };
}

/* ============================== Helpers ============================== */

function mkAmountMap<K extends string>(
  keys: K[],
): Map<K, { count: number; monto: bigint }> {
  const m = new Map<K, { count: number; monto: bigint }>();
  for (const k of keys) m.set(k, { count: 0, monto: 0n });
  return m;
}

function bump<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
  key: K,
  abs: bigint,
) {
  const e = m.get(key);
  if (!e) return;
  e.count++;
  e.monto += abs;
}

function dumpAmountMap<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
): Record<K, { count: number; monto: string }> {
  const out = {} as Record<K, { count: number; monto: string }>;
  for (const [k, v] of m.entries()) {
    out[k] = { count: v.count, monto: v.monto.toString() };
  }
  return out;
}
