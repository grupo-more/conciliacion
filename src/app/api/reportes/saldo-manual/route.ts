import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * GET  /api/reportes/saldo-manual?accountId=<uuid>
 *   Historial de saldos manuales de una cuenta (más reciente primero).
 *
 * POST /api/reportes/saldo-manual
 *   { accountId, fecha: "YYYY-MM-DD", monto, nota? }
 *   Crea un nuevo snapshot (no sobreescribe el anterior — queda el historial
 *   completo para trazabilidad de la Auditoría de cuadre).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "Falta accountId" }, { status: 400 });
  }

  const saldos = await prisma.saldoManual.findMany({
    where: { accountId },
    include: { capturadoBy: { select: { name: true, email: true } } },
    orderBy: { fecha: "desc" },
    take: 100,
  });

  return NextResponse.json({
    saldos: saldos.map((s) => ({
      id: s.id,
      fecha: s.fecha.toISOString().slice(0, 10),
      monto: s.monto.toString(),
      nota: s.nota,
      capturadoPor: s.capturadoBy.name || s.capturadoBy.email,
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

const bodySchema = z.object({
  accountId: z.string().uuid(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto: z.union([z.number(), z.string()]),
  nota: z.string().trim().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const denied = await denyUnless(session, "conciliar");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.format() },
      { status: 400 },
    );
  }
  const { accountId, nota } = parsed.data;
  const [y, m, d] = parsed.data.fecha.split("-").map(Number);
  const fecha = new Date(y, m - 1, d, 0, 0, 0, 0);
  const monto = BigInt(Math.round(Number(parsed.data.monto)));

  const account = await prisma.bankAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) return NextResponse.json({ error: "La cuenta no existe" }, { status: 404 });

  const created = await prisma.saldoManual.create({
    data: { accountId, fecha, monto, nota: nota?.trim() || null, capturadoById: session.sub },
  });

  return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
}
