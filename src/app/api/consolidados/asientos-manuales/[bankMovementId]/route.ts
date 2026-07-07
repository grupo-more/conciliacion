import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * GET    /api/consolidados/asientos-manuales/[bankMovementId] → detalle del
 *        movimiento + el asiento ya generado (si existe). Lo de sucursales y la
 *        tasa de retención el modal los pide a /api/sucursales y /api/asientos-settings.
 * DELETE /api/consolidados/asientos-manuales/[bankMovementId] → deshace el
 *        asiento (vuelve a pendientes).
 */
export async function GET(
  _req: Request,
  context: { params: { bankMovementId: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const bm = await prisma.bankMovement.findUnique({
    where: { id: context.params.bankMovementId },
    include: {
      account: true,
      asientoManual: { include: { lineas: { orderBy: { monto: "desc" } } } },
    },
  });
  if (!bm) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });

  const a = bm.asientoManual;
  return NextResponse.json({
    bankMovement: {
      id: bm.id,
      postDate: bm.postDate.toISOString(),
      amount: bm.amount.toString(),
      direction: bm.direction,
      description: bm.description,
      counterpartyName: bm.counterpartyName,
      counterpartyRut: bm.counterpartyRut,
      account: {
        bankName: bm.account.bankName,
        holderName: bm.account.holderName,
        displayNumber: bm.account.displayNumber,
        accountNumber: bm.account.accountNumber,
      },
    },
    asiento: a
      ? {
          id: a.id,
          tipo: a.tipo,
          estado: a.estado,
          montoNeto: a.montoNeto.toString(),
          retencionTasa: a.retencionTasa != null ? Number(a.retencionTasa) : null,
          montoRetencion: a.montoRetencion.toString(),
          retencionRubro: a.retencionRubro,
          montoBruto: a.montoBruto.toString(),
          glosa: a.glosa,
          lineas: a.lineas.map((l) => ({
            sucursalNombre: l.sucursalNombre,
            personas: Number(l.personas),
            porcentaje: Number(l.porcentaje),
            monto: l.monto.toString(),
          })),
        }
      : null,
  });
}

export async function DELETE(
  _req: Request,
  context: { params: { bankMovementId: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "generarAsientos");
  if (deniedPerm) return deniedPerm;

  const a = await prisma.asientoManual.findUnique({
    where: { bankMovementId: context.params.bankMovementId },
    select: { id: true },
  });
  if (!a) return NextResponse.json({ error: "No hay asiento para deshacer" }, { status: 404 });

  // Las líneas caen por cascade.
  await prisma.asientoManual.delete({ where: { id: a.id } });
  return NextResponse.json({ ok: true });
}
