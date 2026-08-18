import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeBancoSinConciliar } from "@/lib/reportes/banco-compute";
import { computeDynatechSinConciliar } from "@/lib/reportes/dynatech-compute";
import { AGING_BUCKETS, type AgingBucket } from "@/lib/reportes/classify";

/**
 * GET /api/reportes/auditoria-cuadre
 *   Vista general: resumen (sin filas de detalle) de las cuentas activas.
 *
 * GET /api/reportes/auditoria-cuadre?accountId=<uuid>
 *   Detalle completo de una cuenta: saldo del banco (cartola) A LA FECHA del
 *   saldo manual, la diferencia contra ese saldo manual, y las dos listas de
 *   pendientes (Banco sin Dynatech + Dynatech sin banco) de esa cuenta hasta
 *   esa fecha, con la suma neta de esos pendientes para ver si explican la
 *   diferencia.
 *
 * GET /api/reportes/auditoria-cuadre?accountId=<uuid>&saldoManualId=<uuid>
 *   Igual, pero reproduciendo la auditoría de un snapshot HISTORICO en vez del
 *   último cargado. Es lo que hace auditable el reporte: sin esto, cargar un
 *   saldo nuevo cambia lo que muestra el reporte y no hay forma de volver a ver
 *   lo que se vio en su momento.
 *
 * El aging de los pendientes se calcula contra la FECHA DE CORTE (la del saldo
 * manual), no contra hoy — si no, al abrir un snapshot de hace dos meses todos
 * los pendientes aparecerían con dos meses más de antigüedad de la que tenían.
 *
 * NOTA sobre el signo: `sumaPendientesNeta` es una primera hipótesis (IN/
 * INGRESO suma, OUT/EGRESO resta) — conviene validarla con un caso real antes
 * de confiar ciegamente en el badge "Cuadra". Si el signo queda al revés, se
 * ajusta acá nomás (un solo lugar).
 */

// Tolerancia de redondeo para considerar que "cuadra" (pesos).
const TOLERANCIA = 10n;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const saldoManualId = url.searchParams.get("saldoManualId");

  if (accountId) {
    const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
    if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
    const detalle = await auditoriaCuenta(account, /* incluirFilas */ true, saldoManualId);
    if (detalle === "SALDO_NO_ENCONTRADO") {
      return NextResponse.json(
        { error: "Ese saldo manual no existe o no es de esta cuenta" },
        { status: 404 },
      );
    }
    return NextResponse.json(detalle);
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { active: true, accountNumber: { not: { startsWith: "_UNASSIGNED_" } } },
    orderBy: [{ bankName: "asc" }, { holderName: "asc" }],
  });
  const resumen = await Promise.all(
    accounts.map((a) => auditoriaCuenta(a, /* incluirFilas */ false, null)),
  );
  return NextResponse.json({ cuentas: resumen });
}

interface AccountLite {
  id: string;
  bankCode: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  displayNumber: string | null;
  createdAt: Date;
}

async function auditoriaCuenta(
  account: AccountLite,
  incluirFilas: boolean,
  saldoManualId: string | null,
) {
  const accountOut = {
    id: account.id,
    bankCode: account.bankCode,
    bankName: account.bankName,
    holderName: account.holderName,
    accountNumber: account.accountNumber,
    displayNumber: account.displayNumber,
  };

  // El último snapshot se necesita siempre: es el default y además permite
  // marcar si lo que se está viendo es el vigente o uno histórico.
  const ultimoSaldoManual = await prisma.saldoManual.findFirst({
    where: { accountId: account.id },
    orderBy: { fecha: "desc" },
    include: { capturadoBy: { select: { name: true, email: true } } },
  });

  let saldoManualSel = ultimoSaldoManual;
  if (saldoManualId) {
    saldoManualSel = await prisma.saldoManual.findFirst({
      where: { id: saldoManualId, accountId: account.id },
      include: { capturadoBy: { select: { name: true, email: true } } },
    });
    if (!saldoManualSel) return "SALDO_NO_ENCONTRADO" as const;
  }

  if (!saldoManualSel) {
    return {
      account: accountOut,
      saldoManual: null,
      esUltimoSnapshot: true,
      saldoSistema: null,
      saldoBancoFecha: null,
      diferencia: null,
      pendientes: null,
      sumaPendientesNeta: null,
      diferenciaSinExplicar: null,
      cuadra: null,
    };
  }

  const fecha = saldoManualSel.fecha;
  const asOf = new Date(fecha);
  asOf.setDate(asOf.getDate() + 1); // incluye movimientos DEL día del saldo manual

  const ultimoConBalance = await prisma.bankMovement.findFirst({
    where: { accountId: account.id, postDate: { lt: asOf }, balanceAfter: { not: null } },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    select: { balanceAfter: true, postDate: true },
  });
  const saldoSistema = ultimoConBalance?.balanceAfter ?? null;
  const diferencia = saldoSistema !== null ? saldoManualSel.monto - saldoSistema : null;

  // Universo de pendientes: desde que existe la cuenta hasta la fecha del
  // saldo manual (inclusive) — "todo lo pendiente" que pide auditar. NO se
  // acota por rango a propósito: la diferencia se calcula contra un saldo
  // absoluto (arrastra toda la historia), así que recortar la ventana de
  // pendientes rompería la aritmética de "los pendientes explican la
  // diferencia". Para organizar la lista se usa el desglose por antigüedad,
  // que agrupa sin esconder ni alterar los totales.
  const desde = account.createdAt;
  const [bancoRes, dynaRes] = await Promise.all([
    computeBancoSinConciliar(desde, asOf, { accountId: account.id }, fecha),
    computeDynatechSinConciliar(desde, asOf, { accountId: account.id }, fecha),
  ]);

  const netoBanco = bancoRes.rows.reduce(
    (acc, r) => acc + (r.direction === "IN" ? BigInt(r.monto) : -BigInt(r.monto)),
    0n,
  );
  const netoDyna = dynaRes.rows.reduce(
    (acc, r) => acc + (r.tipoOperacion === "INGRESO" ? BigInt(r.monto) : -BigInt(r.monto)),
    0n,
  );
  const sumaPendientesNeta = netoBanco + netoDyna;
  const diferenciaSinExplicar = diferencia !== null ? diferencia - sumaPendientesNeta : null;
  const cuadra =
    diferenciaSinExplicar !== null
      ? (diferenciaSinExplicar < 0n ? -diferenciaSinExplicar : diferenciaSinExplicar) <= TOLERANCIA
      : null;

  return {
    account: accountOut,
    saldoManual: {
      id: saldoManualSel.id,
      fecha: saldoManualSel.fecha.toISOString().slice(0, 10),
      monto: saldoManualSel.monto.toString(),
      nota: saldoManualSel.nota,
      capturadoPor: saldoManualSel.capturadoBy.name || saldoManualSel.capturadoBy.email,
      createdAt: saldoManualSel.createdAt.toISOString(),
    },
    // false = se está viendo un snapshot histórico, no el vigente.
    esUltimoSnapshot: saldoManualSel.id === ultimoSaldoManual?.id,
    saldoSistema: saldoSistema !== null ? saldoSistema.toString() : null,
    // Fecha del movimiento de cartola que aportó ese saldo. Si quedó muy atrás
    // de la fecha de corte, la cartola no está cargada hasta esa fecha y la
    // diferencia incluye días que simplemente no existen en el sistema.
    saldoBancoFecha: ultimoConBalance?.postDate.toISOString().slice(0, 10) ?? null,
    pendientes: {
      bancoSinDynatech: {
        count: bancoRes.resumen.count,
        monto: bancoRes.resumen.monto,
        neto: netoBanco.toString(),
        porAging: agingBreakdown(bancoRes.rows, (r) => r.direction === "IN"),
        rows: incluirFilas ? bancoRes.rows : undefined,
      },
      dynatechSinBanco: {
        count: dynaRes.resumen.count,
        monto: dynaRes.resumen.monto,
        neto: netoDyna.toString(),
        porAging: agingBreakdown(dynaRes.rows, (r) => r.tipoOperacion === "INGRESO"),
        rows: incluirFilas ? dynaRes.rows : undefined,
      },
    },
    sumaPendientesNeta: sumaPendientesNeta.toString(),
    diferenciaSinExplicar: diferenciaSinExplicar !== null ? diferenciaSinExplicar.toString() : null,
    cuadra,
  };
}

/**
 * Corte por antigüedad de los pendientes. Devuelve SIEMPRE los 4 buckets (con
 * count 0 los vacíos) para que el front tenga layout estable. `monto` es la
 * magnitud acumulada; `neto` respeta el signo (lo que ese bucket aporta a la
 * explicación de la diferencia).
 */
function agingBreakdown<T extends { agingBucket: AgingBucket; monto: string }>(
  rows: T[],
  esPositivo: (r: T) => boolean,
) {
  const acc = new Map<AgingBucket, { count: number; monto: bigint; neto: bigint }>();
  for (const b of AGING_BUCKETS) acc.set(b, { count: 0, monto: 0n, neto: 0n });

  for (const r of rows) {
    const e = acc.get(r.agingBucket);
    if (!e) continue;
    const abs = BigInt(r.monto);
    e.count++;
    e.monto += abs;
    e.neto += esPositivo(r) ? abs : -abs;
  }

  return AGING_BUCKETS.map((bucket) => {
    const e = acc.get(bucket)!;
    return {
      bucket,
      count: e.count,
      monto: e.monto.toString(),
      neto: e.neto.toString(),
    };
  });
}
