import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  detectInterno,
  loadEntidadesInternas,
  type MatchVia,
} from "@/lib/internos/detect";

/**
 * GET /api/consolidados/egresos-internos?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &accountId=<uuid>&entidadId=<uuid>&via=rut|rut_in_name|rut_in_desc|alias
 *
 * Recorre los BankMovement con direction=OUT en el rango y aplica la cascada
 * de deteccion de internos (ver lib/internos/detect.ts). Devuelve solo los
 * que matchearon alguna entidad, con la entidad identificada y la "via" del
 * match (RUT directo, RUT en nombre, RUT en glosa, alias por nombre).
 *
 * Es una vista derivada — no hay match con Tesoreria, no hay deshacer. La
 * configuracion de entidades vive en EntidadInterna y se gestiona desde la
 * tab Configuracion > Entidades internas.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  const accountId = url.searchParams.get("accountId") || null;
  const entidadIdFilter = url.searchParams.get("entidadId") || null;
  const viaFilter = url.searchParams.get("via") as MatchVia | null;

  const entidades = await loadEntidadesInternas(prisma);
  if (entidades.length === 0) {
    return NextResponse.json({
      from: from.toISOString(),
      to: to.toISOString(),
      rows: [],
      totals: { count: 0, monto: "0" },
      facets: { accounts: [], entidades: [] },
    });
  }

  const movements = await prisma.bankMovement.findMany({
    where: {
      direction: "OUT",
      postDate: { gte: from, lt: to },
      ...(accountId ? { accountId } : {}),
    },
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
          alias: true,
        },
      },
    },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    take: 5000,
  });

  const rows: EgresoInternoRow[] = [];
  let totalMonto = 0n;

  for (const bm of movements) {
    const match = detectInterno(bm, entidades);
    if (!match) continue;
    if (entidadIdFilter && match.entidad.id !== entidadIdFilter) continue;
    if (viaFilter && match.via !== viaFilter) continue;

    const abs = bm.amount < 0n ? -bm.amount : bm.amount;
    totalMonto += abs;

    const cuentaNumero = bm.account.displayNumber || bm.account.accountNumber;
    const cuentaLabel = [bm.account.bankName, bm.account.holderName, cuentaNumero]
      .filter((s) => s && s.trim().length > 0)
      .join(" · ");

    rows.push({
      id: bm.id,
      fecha: bm.postDate.toISOString(),
      accountId: bm.account.id,
      cuentaLabel,
      bankName: bm.account.bankName,
      accountNumber: cuentaNumero,
      monto: abs.toString(),
      counterpartyRut: bm.counterpartyRut,
      counterpartyName: bm.counterpartyName,
      description: bm.description,
      entidadId: match.entidad.id,
      entidadNombre: match.entidad.nombreCanonico,
      entidadRut: match.entidad.rutCanonico,
      entidadRubro: match.entidad.rubro,
      via: match.via,
      evidence: match.evidence,
    });
  }

  // Facets: cuentas y entidades vistas en el rango completo (sin filtro).
  const allInRange = movements;
  const accountIds = new Set<string>();
  const entidadMatchCount = new Map<string, number>();
  for (const bm of allInRange) {
    accountIds.add(bm.accountId);
    const m = detectInterno(bm, entidades);
    if (m) {
      entidadMatchCount.set(
        m.entidad.id,
        (entidadMatchCount.get(m.entidad.id) ?? 0) + 1,
      );
    }
  }

  const accountList =
    accountIds.size > 0
      ? await prisma.bankAccount.findMany({
          where: { id: { in: [...accountIds] } },
          select: {
            id: true,
            bankName: true,
            displayNumber: true,
            accountNumber: true,
            holderName: true,
          },
        })
      : [];

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: { count: rows.length, monto: totalMonto.toString() },
    facets: {
      accounts: accountList
        .map((a) => ({
          id: a.id,
          label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      entidades: entidades
        .map((e) => ({
          id: e.id,
          nombre: e.nombreCanonico,
          count: entidadMatchCount.get(e.id) ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
    },
  });
}

interface EgresoInternoRow {
  id: string;
  fecha: string;
  accountId: string;
  cuentaLabel: string;
  bankName: string;
  accountNumber: string;
  monto: string;
  counterpartyRut: string | null;
  counterpartyName: string | null;
  description: string | null;
  entidadId: string;
  entidadNombre: string;
  entidadRut: string;
  entidadRubro: number | null;
  via: MatchVia;
  evidence: string;
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null,
): { from: Date; to: Date } {
  if (fromRaw && toRaw) {
    const from = parseDateOnly(fromRaw);
    const to = parseDateOnly(toRaw);
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setDate(toEnd.getDate() + 1);
      return { from, to: toEnd };
    }
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

function parseDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
