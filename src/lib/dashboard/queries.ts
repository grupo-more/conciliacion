import { prisma } from "@/lib/db";
import { parseGlosa } from "@/lib/reconciliation/glosa";

export type Period = "day" | "week" | "month";

export interface PeriodRange {
  /** Inicio del período (inclusivo). */
  start: Date;
  /** Fin del período (exclusivo). */
  end: Date;
  /** Inicio del período anterior (para comparativos). */
  prevStart: Date;
  prevEnd: Date;
  label: string;
}

/**
 * Calcula los rangos para un período. Usa la zona horaria local del servidor.
 *  - day:   hoy (00:00 → mañana 00:00); previo: ayer
 *  - week:  últimos 7 días incluyendo hoy; previo: 7 días anteriores
 *  - month: este mes calendario; previo: mes calendario anterior
 */
export function getPeriodRange(period: Period, now = new Date()): PeriodRange {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (period === "day") {
    const start = new Date(today);
    const end = addDays(start, 1);
    const prevStart = addDays(start, -1);
    const prevEnd = start;
    return { start, end, prevStart, prevEnd, label: "Hoy" };
  }

  if (period === "week") {
    const end = addDays(today, 1);
    const start = addDays(today, -6);
    const prevEnd = start;
    const prevStart = addDays(start, -7);
    return { start, end, prevStart, prevEnd, label: "Últimos 7 días" };
  }

  // month: 1 al último día del mes actual
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevEnd = start;
  return {
    start,
    end,
    prevStart,
    prevEnd,
    label: today.toLocaleString("es-CL", { month: "long", year: "numeric" }),
  };
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/* ----------------------------- KPIs ------------------------------ */

export interface KPIData {
  consolidatedBalance: number;
  /** Variación absoluta vs período anterior (último saldo del período prev). */
  consolidatedBalanceChange: number | null;
  consolidatedBalanceChangePct: number | null;
  totalIn: number;
  totalInPrev: number;
  totalOut: number;
  totalOutPrev: number;
  autoMatchRate: number; // 0-1
  autoMatchRatePrev: number | null;
  ventasProcessed: number;
  ventasTotal: number;
}

/**
 * Suma del saldo más reciente conocido por cuenta (al cierre del período actual).
 * Para cada cuenta, toma el balanceAfter del último BankMovement con post_date <
 * `until`. Si no hay movimientos antes de `until`, suma 0.
 */
export async function computeConsolidatedBalance(asOf: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ balance_after: bigint | null }>>`
    SELECT DISTINCT ON (bm.account_id) bm.balance_after
    FROM "BankMovement" bm
    JOIN "BankAccount" ba ON ba.id = bm.account_id
    WHERE bm.post_date < ${asOf}
      AND ba.account_number NOT LIKE '_UNASSIGNED_%'
      AND bm.balance_after IS NOT NULL
    ORDER BY bm.account_id, bm.post_date DESC, bm.created_at DESC
  `;
  return rows.reduce((acc, r) => acc + Number(r.balance_after ?? 0), 0);
}

export async function computeKPIs(range: PeriodRange): Promise<KPIData> {
  const [
    consolidatedBalance,
    consolidatedBalancePrev,
    inOutCurrent,
    inOutPrev,
    ventasCounts,
    ventasCountsPrev,
  ] = await Promise.all([
    computeConsolidatedBalance(range.end),
    computeConsolidatedBalance(range.prevEnd),
    sumInOut(range.start, range.end),
    sumInOut(range.prevStart, range.prevEnd),
    countVentasByStatus(range.start, range.end),
    countVentasByStatus(range.prevStart, range.prevEnd),
  ]);

  const consolidatedBalanceChange =
    consolidatedBalancePrev > 0
      ? consolidatedBalance - consolidatedBalancePrev
      : null;
  const consolidatedBalanceChangePct =
    consolidatedBalancePrev > 0
      ? (consolidatedBalance - consolidatedBalancePrev) / consolidatedBalancePrev
      : null;

  const ventasProcessed =
    ventasCounts.AUTO_MATCHED + ventasCounts.SUGGESTED + ventasCounts.MANUAL +
    ventasCounts.REVIEW + ventasCounts.NO_MATCH + ventasCounts.OUT_OF_SCOPE;
  const ventasMatched = ventasCounts.AUTO_MATCHED + ventasCounts.MANUAL;
  const ventasTotal = ventasProcessed + ventasCounts.UNPROCESSED;

  const ventasMatchedPrev = ventasCountsPrev.AUTO_MATCHED + ventasCountsPrev.MANUAL;
  const ventasProcessedPrev =
    ventasCountsPrev.AUTO_MATCHED + ventasCountsPrev.SUGGESTED + ventasCountsPrev.MANUAL +
    ventasCountsPrev.REVIEW + ventasCountsPrev.NO_MATCH + ventasCountsPrev.OUT_OF_SCOPE;

  return {
    consolidatedBalance,
    consolidatedBalanceChange,
    consolidatedBalanceChangePct,
    totalIn: inOutCurrent.in,
    totalInPrev: inOutPrev.in,
    totalOut: inOutCurrent.out,
    totalOutPrev: inOutPrev.out,
    autoMatchRate: ventasProcessed > 0 ? ventasMatched / ventasProcessed : 0,
    autoMatchRatePrev:
      ventasProcessedPrev > 0 ? ventasMatchedPrev / ventasProcessedPrev : null,
    ventasProcessed,
    ventasTotal,
  };
}

async function sumInOut(start: Date, end: Date): Promise<{ in: number; out: number }> {
  const r = await prisma.$queryRaw<Array<{ in_sum: bigint | null; out_sum: bigint | null }>>`
    SELECT
      COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END), 0)::bigint AS in_sum,
      COALESCE(SUM(CASE WHEN direction='OUT' THEN ABS(amount) ELSE 0 END), 0)::bigint AS out_sum
    FROM "BankMovement" bm
    JOIN "BankAccount" ba ON ba.id = bm.account_id
    WHERE bm.post_date >= ${start} AND bm.post_date < ${end}
      AND ba.account_number NOT LIKE '_UNASSIGNED_%'
  `;
  return {
    in: Number(r[0]?.in_sum ?? 0),
    out: Number(r[0]?.out_sum ?? 0),
  };
}

interface VentasCounts {
  AUTO_MATCHED: number;
  SUGGESTED: number;
  REVIEW: number;
  MANUAL: number;
  NO_MATCH: number;
  OUT_OF_SCOPE: number;
  UNPROCESSED: number;
}

async function countVentasByStatus(start: Date, end: Date): Promise<VentasCounts> {
  // Migrado a TesoreriaMovement + Consolidado (motor V3 de Consolidados).
  // Cuenta movimientos cuyos items contienen "Venta...".
  const rows = await prisma.$queryRaw<Array<{ status: string | null; n: bigint }>>`
    SELECT c.status, COUNT(*)::bigint AS n
    FROM "TesoreriaMovement" t
    LEFT JOIN "Consolidado" c ON c.tesoreria_movement_id = t.id
    WHERE t.fecha >= ${start} AND t.fecha < ${end}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.items) AS item
        WHERE (item->>'nombre') ILIKE 'Venta%'
      )
    GROUP BY c.status
  `;
  const out: VentasCounts = {
    AUTO_MATCHED: 0, SUGGESTED: 0, REVIEW: 0, MANUAL: 0,
    NO_MATCH: 0, OUT_OF_SCOPE: 0, UNPROCESSED: 0,
  };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.status === null) out.UNPROCESSED = n;
    else if (r.status in out) (out as unknown as Record<string, number>)[r.status] = n;
  }
  return out;
}

/* --------------------------- Saldos por cuenta -------------------------- */

export interface AccountBalanceRow {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
  balance: number;
  lastMovementDate: string | null;
  daysSinceLastMovement: number | null;
  movementCountInPeriod: number;
  inSumInPeriod: number;
  outSumInPeriod: number;
  reconciledInSum: number;
  otherInSum: number;
}

export async function computeAccountBalances(
  range: PeriodRange,
  asOf: Date
): Promise<AccountBalanceRow[]> {
  const accounts = await prisma.bankAccount.findMany({
    where: {
      active: true,
      accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
    },
    orderBy: [{ bankName: "asc" }, { holderName: "asc" }],
  });

  const result: AccountBalanceRow[] = [];

  // "Hoy" en la zona horaria del servidor (00:00) — base para el cálculo de
  // freshness. No usamos `asOf` (que es el cierre de período) porque para
  // periodos mensuales `range.end` es el primer día del mes SIGUIENTE y
  // distorsionaría la frescura agregando ~días de mes restantes.
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  for (const a of accounts) {
    // Saldo: tomar el último movimiento con balance_after no nulo. Algunos
    // formatos (Santander Histórica/Provisoria) no traen saldo por movimiento,
    // así que esto puede quedar en 0 aunque la cuenta tenga movimientos.
    const lastWithBalance = await prisma.bankMovement.findFirst({
      where: { accountId: a.id, postDate: { lt: asOf }, balanceAfter: { not: null } },
      orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
      select: { balanceAfter: true, postDate: true },
    });

    // Frescura: tomar el último movimiento de cualquier tipo (no requiere saldo).
    const lastAny = await prisma.bankMovement.findFirst({
      where: { accountId: a.id },
      orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
      select: { postDate: true },
    });

    const balance = lastWithBalance?.balanceAfter ? Number(lastWithBalance.balanceAfter) : 0;
    const lastDate = lastAny?.postDate ?? null;
    const daysSince = lastDate
      ? Math.max(0, Math.floor((todayMidnight.getTime() - lastDate.getTime()) / 86400000))
      : null;

    const periodAggs = await prisma.$queryRaw<
      Array<{
        n: bigint;
        in_sum: bigint | null;
        out_sum: bigint | null;
        reconciled_in_sum: bigint | null;
      }>
    >`
      SELECT
        COUNT(*)::bigint AS n,
        COALESCE(SUM(CASE WHEN bm.direction='IN' THEN bm.amount ELSE 0 END), 0)::bigint AS in_sum,
        COALESCE(SUM(CASE WHEN bm.direction='OUT' THEN ABS(bm.amount) ELSE 0 END), 0)::bigint AS out_sum,
        COALESCE(SUM(
          CASE
            WHEN bm.direction='IN' AND EXISTS (
              SELECT 1 FROM "ConsolidadoLink" cl
              JOIN "Consolidado" c ON c.id = cl.consolidado_id
              WHERE cl.bank_movement_id = bm.id
                AND c.status IN ('AUTO_MATCHED','MANUAL')
            )
            THEN bm.amount
            ELSE 0
          END
        ), 0)::bigint AS reconciled_in_sum
      FROM "BankMovement" bm
      WHERE bm.account_id = ${a.id}
        AND bm.post_date >= ${range.start}
        AND bm.post_date < ${range.end}
    `;
    const agg = periodAggs[0];
    const inSum = Number(agg?.in_sum ?? 0);
    const reconciledIn = Number(agg?.reconciled_in_sum ?? 0);

    result.push({
      id: a.id,
      bankCode: a.bankCode,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      displayNumber: a.displayNumber,
      holderName: a.holderName,
      balance,
      lastMovementDate: lastDate?.toISOString() ?? null,
      daysSinceLastMovement: daysSince,
      movementCountInPeriod: Number(agg?.n ?? 0),
      inSumInPeriod: inSum,
      outSumInPeriod: Number(agg?.out_sum ?? 0),
      reconciledInSum: reconciledIn,
      otherInSum: Math.max(0, inSum - reconciledIn),
    });
  }

  return result;
}

/* ----------------------------- Pipeline -------------------------------- */

export interface PipelineData {
  total: number;
  totalProcessed: number;
  byStatus: {
    AUTO_MATCHED: number;
    SUGGESTED: number;
    REVIEW: number;
    MANUAL: number;
    NO_MATCH: number;
    OUT_OF_SCOPE: number;
    UNPROCESSED: number;
  };
  backlogOver7d: number;
}

export async function computePipeline(range: PeriodRange): Promise<PipelineData> {
  const counts = await countVentasByStatus(range.start, range.end);
  const total =
    counts.AUTO_MATCHED + counts.SUGGESTED + counts.REVIEW + counts.MANUAL +
    counts.NO_MATCH + counts.OUT_OF_SCOPE + counts.UNPROCESSED;
  const totalProcessed = total - counts.UNPROCESSED;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const backlog = await prisma.consolidado.count({
    where: {
      status: { in: ["NO_MATCH", "REVIEW", "SUGGESTED"] },
      matchedAt: { lt: sevenDaysAgo },
      tesoreriaMovement: {
        fecha: { gte: range.start, lt: range.end },
      },
    },
  });

  return {
    total,
    totalProcessed,
    byStatus: counts,
    backlogOver7d: backlog,
  };
}

/* ------------------------------- Flows --------------------------------- */

export interface FlowsBucket {
  date: string; // YYYY-MM-DD
  in: number;
  out: number;
  net: number;
  consolidatedBalance: number;
}

export async function computeFlows(range: PeriodRange): Promise<FlowsBucket[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      d: Date;
      in_sum: bigint | null;
      out_sum: bigint | null;
    }>
  >`
    SELECT
      DATE(bm.post_date) AS d,
      COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END), 0)::bigint AS in_sum,
      COALESCE(SUM(CASE WHEN direction='OUT' THEN ABS(amount) ELSE 0 END), 0)::bigint AS out_sum
    FROM "BankMovement" bm
    JOIN "BankAccount" ba ON ba.id = bm.account_id
    WHERE bm.post_date >= ${range.start} AND bm.post_date < ${range.end}
      AND ba.account_number NOT LIKE '_UNASSIGNED_%'
    GROUP BY DATE(bm.post_date)
    ORDER BY d ASC
  `;

  // Indexar por día
  const byDay = new Map<string, { in: number; out: number }>();
  for (const r of rows) {
    const key = formatDateKey(r.d);
    byDay.set(key, {
      in: Number(r.in_sum ?? 0),
      out: Number(r.out_sum ?? 0),
    });
  }

  // Generar buckets continuos (incluye días sin movimientos)
  const buckets: FlowsBucket[] = [];
  let cursor = new Date(range.start);
  while (cursor < range.end) {
    const key = formatDateKey(cursor);
    const v = byDay.get(key) ?? { in: 0, out: 0 };
    buckets.push({
      date: key,
      in: v.in,
      out: v.out,
      net: v.in - v.out,
      consolidatedBalance: 0, // se llena luego
    });
    cursor = addDays(cursor, 1);
  }

  // Calcular saldo consolidado al cierre de cada día (balance running)
  // Para evitar N queries, calculamos una sola vez al inicio y vamos sumando net por día.
  if (buckets.length > 0) {
    const initialBalance = await computeConsolidatedBalance(range.start);
    let running = initialBalance;
    for (const b of buckets) {
      running += b.net;
      b.consolidatedBalance = running;
    }
  }

  return buckets;
}

function formatDateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* ------------------------------- Top --------------------------------- */

export interface BranchSummary {
  branchExternalId: number;
  branchExternalName: string | null;
  ventasCount: number;
  ventasTotal: number;
  matchedCount: number;
  matchRate: number;
}

export async function computeTopBranches(range: PeriodRange): Promise<BranchSummary[]> {
  // Migrado a TesoreriaMovement + Consolidado.
  const rows = await prisma.$queryRaw<
    Array<{
      sucursal_id: number;
      sucursal_name: string | null;
      ventas_count: bigint;
      ventas_total: bigint;
      matched_count: bigint;
    }>
  >`
    SELECT
      t.sucursal_id,
      t.sucursal_name,
      COUNT(*)::bigint AS ventas_count,
      COALESCE(SUM(t.monto), 0)::bigint AS ventas_total,
      COUNT(CASE WHEN c.status IN ('AUTO_MATCHED','MANUAL') THEN 1 END)::bigint AS matched_count
    FROM "TesoreriaMovement" t
    LEFT JOIN "Consolidado" c ON c.tesoreria_movement_id = t.id
    WHERE t.fecha >= ${range.start} AND t.fecha < ${range.end}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.items) AS item
        WHERE (item->>'nombre') ILIKE 'Venta%'
      )
    GROUP BY t.sucursal_id, t.sucursal_name
    ORDER BY ventas_total DESC
    LIMIT 10
  `;

  return rows.map((r) => {
    const ventas = Number(r.ventas_count);
    const matched = Number(r.matched_count);
    return {
      branchExternalId: r.sucursal_id,
      branchExternalName: r.sucursal_name,
      ventasCount: ventas,
      ventasTotal: Number(r.ventas_total),
      matchedCount: matched,
      matchRate: ventas > 0 ? matched / ventas : 0,
    };
  });
}

export interface CashierSummary {
  cashierUsername: string;
  cashierName: string | null;
  ventasCount: number;
  ventasTotal: number;
  glosaQualityCounts: { excellent: number; good: number; fair: number; poor: number };
  glosaQualityScore: number; // 0-100
}

/**
 * Top cajeros por volumen + calidad de glosa.
 * Calcula la calidad parseando cada glosa (en memoria, escala bien a miles).
 */
export async function computeTopCashiers(range: PeriodRange): Promise<CashierSummary[]> {
  // Migrado a TesoreriaMovement.
  const movs = await prisma.tesoreriaMovement.findMany({
    where: {
      fecha: { gte: range.start, lt: range.end },
    },
    select: {
      cajeroUsername: true,
      cajeroName: true,
      glosa: true,
      monto: true,
      items: true,
    },
  });

  // Filtrar solo Ventas
  const ventas = movs.filter((m) => {
    const items = m.items as Array<{ nombre?: string }> | null;
    return Array.isArray(items) && items.some((i) => i?.nombre?.toLowerCase().startsWith("venta"));
  });

  const grouped = new Map<string, CashierSummary>();
  for (const m of ventas) {
    const key = m.cajeroUsername;
    let agg = grouped.get(key);
    if (!agg) {
      agg = {
        cashierUsername: key,
        cashierName: m.cajeroName,
        ventasCount: 0,
        ventasTotal: 0,
        glosaQualityCounts: { excellent: 0, good: 0, fair: 0, poor: 0 },
        glosaQualityScore: 0,
      };
      grouped.set(key, agg);
    }
    // Si entró sin nombre y un movimiento posterior lo trae, completarlo
    if (!agg.cashierName && m.cajeroName) agg.cashierName = m.cajeroName;
    agg.ventasCount++;
    agg.ventasTotal += Number(m.monto);

    const q = parseGlosa(m.glosa || "").quality;
    if (q === "EXCELLENT") agg.glosaQualityCounts.excellent++;
    else if (q === "GOOD") agg.glosaQualityCounts.good++;
    else if (q === "FAIR") agg.glosaQualityCounts.fair++;
    else agg.glosaQualityCounts.poor++;
  }

  // Score: ponderado (excellent=100, good=75, fair=40, poor=0)
  for (const c of grouped.values()) {
    const t = c.ventasCount;
    if (t === 0) continue;
    const score =
      (c.glosaQualityCounts.excellent * 100 +
        c.glosaQualityCounts.good * 75 +
        c.glosaQualityCounts.fair * 40 +
        c.glosaQualityCounts.poor * 0) /
      t;
    c.glosaQualityScore = Math.round(score);
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.ventasTotal - a.ventasTotal)
    .slice(0, 10);
}

/* ------------------------------- Alerts -------------------------------- */

export interface AlertItem {
  kind: "BACKLOG" | "STALE_CARTOLA" | "SUCURSAL_INACTIVE" | "REVIEW_PENDING";
  severity: "warn" | "danger";
  message: string;
  count?: number;
}

export async function computeAlerts(): Promise<AlertItem[]> {
  const alerts: AlertItem[] = [];

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fiveDaysAgo = new Date();
  fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

  // Backlog: NO_MATCH/REVIEW/SUGGESTED viejos (migrado a Consolidado).
  const backlog = await prisma.consolidado.count({
    where: {
      status: { in: ["NO_MATCH", "REVIEW", "SUGGESTED"] },
      matchedAt: { lt: sevenDaysAgo },
    },
  });
  if (backlog > 0) {
    alerts.push({
      kind: "BACKLOG",
      severity: backlog > 10 ? "danger" : "warn",
      message: `${backlog} movimientos llevan >7 días sin conciliar`,
      count: backlog,
    });
  }

  const reviewPending = await prisma.consolidado.count({
    where: { status: "REVIEW" },
  });
  if (reviewPending > 0) {
    alerts.push({
      kind: "REVIEW_PENDING",
      severity: "warn",
      message: `${reviewPending} movimientos en estado "Revisar" (hay candidatos por elegir)`,
      count: reviewPending,
    });
  }

  // Cartolas desactualizadas (>5 días sin movimiento nuevo)
  const accounts = await prisma.bankAccount.findMany({
    where: {
      active: true,
      accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
    },
    select: { id: true, holderName: true, bankName: true },
  });
  for (const a of accounts) {
    const last = await prisma.bankMovement.findFirst({
      where: { accountId: a.id },
      orderBy: { postDate: "desc" },
      select: { postDate: true },
    });
    if (!last || last.postDate < fiveDaysAgo) {
      const days = last
        ? Math.floor((Date.now() - last.postDate.getTime()) / 86400000)
        : null;
      alerts.push({
        kind: "STALE_CARTOLA",
        severity: days !== null && days > 14 ? "danger" : "warn",
        message: `Cartola ${a.holderName} · ${a.bankName} ${
          days !== null ? `desactualizada (${days} días)` : "no tiene movimientos"
        }`,
      });
    }
  }

  // Sucursales inactivas (>5 días sin movimientos en Tesoreria).
  const branches = await prisma.tesoreriaMovement.groupBy({
    by: ["sucursalId", "sucursalName"],
  });
  for (const b of branches) {
    const last = await prisma.tesoreriaMovement.findFirst({
      where: { sucursalId: b.sucursalId },
      orderBy: { fecha: "desc" },
      select: { fecha: true },
    });
    if (last && last.fecha < fiveDaysAgo) {
      const days = Math.floor((Date.now() - last.fecha.getTime()) / 86400000);
      alerts.push({
        kind: "SUCURSAL_INACTIVE",
        severity: "warn",
        message: `Sucursal ${b.sucursalName ?? `#${b.sucursalId}`} sin movimientos hace ${days} días`,
      });
    }
  }

  return alerts;
}
