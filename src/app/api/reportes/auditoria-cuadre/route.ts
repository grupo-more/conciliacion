import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeBancoSinConciliar } from "@/lib/reportes/banco-compute";
import { computeDynatechSinConciliar } from "@/lib/reportes/dynatech-compute";

/**
 * GET /api/reportes/auditoria-cuadre
 *   Vista general: resumen (sin filas de detalle) de las 7 cuentas activas.
 *
 * GET /api/reportes/auditoria-cuadre?accountId=<uuid>
 *   Detalle completo de una cuenta: saldo del sistema A LA FECHA del último
 *   saldo manual cargado (no el de hoy — así se compara peras con peras),
 *   la diferencia contra ese saldo manual, y las dos listas de pendientes
 *   (Banco sin Dynatech + Dynatech sin banco) de esa cuenta hasta esa fecha,
 *   con la suma neta de esos pendientes para ver si explican la diferencia.
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

  if (accountId) {
    const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
    if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
    const detalle = await auditoriaCuenta(account, /* incluirFilas */ true);
    return NextResponse.json(detalle);
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { active: true, accountNumber: { not: { startsWith: "_UNASSIGNED_" } } },
    orderBy: [{ bankName: "asc" }, { holderName: "asc" }],
  });
  const resumen = await Promise.all(
    accounts.map((a) => auditoriaCuenta(a, /* incluirFilas */ false)),
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

async function auditoriaCuenta(account: AccountLite, incluirFilas: boolean) {
  const accountOut = {
    id: account.id,
    bankCode: account.bankCode,
    bankName: account.bankName,
    holderName: account.holderName,
    accountNumber: account.accountNumber,
    displayNumber: account.displayNumber,
  };

  const ultimoSaldoManual = await prisma.saldoManual.findFirst({
    where: { accountId: account.id },
    orderBy: { fecha: "desc" },
    include: { capturadoBy: { select: { name: true, email: true } } },
  });

  if (!ultimoSaldoManual) {
    return {
      account: accountOut,
      saldoManual: null,
      saldoSistema: null,
      diferencia: null,
      pendientes: null,
      sumaPendientesNeta: null,
      diferenciaSinExplicar: null,
      cuadra: null,
    };
  }

  const fecha = ultimoSaldoManual.fecha;
  const asOf = new Date(fecha);
  asOf.setDate(asOf.getDate() + 1); // incluye movimientos DEL día del saldo manual

  const ultimoConBalance = await prisma.bankMovement.findFirst({
    where: { accountId: account.id, postDate: { lt: asOf }, balanceAfter: { not: null } },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    select: { balanceAfter: true },
  });
  const saldoSistema = ultimoConBalance?.balanceAfter ?? null;
  const diferencia = saldoSistema !== null ? ultimoSaldoManual.monto - saldoSistema : null;

  // Universo de pendientes: desde que existe la cuenta hasta la fecha del
  // saldo manual (inclusive) — "todo lo pendiente" que pide auditar.
  const desde = account.createdAt;
  const [bancoRes, dynaRes] = await Promise.all([
    computeBancoSinConciliar(desde, asOf, { accountId: account.id }),
    computeDynatechSinConciliar(desde, asOf, { accountId: account.id }),
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
      id: ultimoSaldoManual.id,
      fecha: ultimoSaldoManual.fecha.toISOString().slice(0, 10),
      monto: ultimoSaldoManual.monto.toString(),
      nota: ultimoSaldoManual.nota,
      capturadoPor: ultimoSaldoManual.capturadoBy.name || ultimoSaldoManual.capturadoBy.email,
      createdAt: ultimoSaldoManual.createdAt.toISOString(),
    },
    saldoSistema: saldoSistema !== null ? saldoSistema.toString() : null,
    diferencia: diferencia !== null ? diferencia.toString() : null,
    pendientes: {
      bancoSinDynatech: {
        count: bancoRes.resumen.count,
        monto: bancoRes.resumen.monto,
        neto: netoBanco.toString(),
        rows: incluirFilas ? bancoRes.rows : undefined,
      },
      dynatechSinBanco: {
        count: dynaRes.resumen.count,
        monto: dynaRes.resumen.monto,
        neto: netoDyna.toString(),
        rows: incluirFilas ? dynaRes.rows : undefined,
      },
    },
    sumaPendientesNeta: sumaPendientesNeta.toString(),
    diferenciaSinExplicar: diferenciaSinExplicar !== null ? diferenciaSinExplicar.toString() : null,
    cuadra,
  };
}
