import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { buildRubroMap, type AccountForRubro } from "@/lib/internos/rubro-resolver";

/**
 * Carga y serializa asientos manuales con sus líneas y rubros resueltos.
 * Compartido entre la lista de "Generados" y el detalle de una emisión, para
 * que el documento re-generado desde una emisión sea EXACTO al original.
 */
export interface AsientoSerializado {
  id: string;
  bankMovementId: string;
  tipo: string;
  fecha: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  bancoRubro: number | null;
  counterpartyName: string | null;
  glosa: string | null;
  montoNeto: string;
  retencionTasa: number | null;
  montoRetencion: string;
  retencionRubro: number | null;
  montoBruto: string;
  lineas: Array<{
    sucursalNombre: string;
    rubro: number | null;
    personas: number;
    porcentaje: number;
    monto: string;
  }>;
}

export async function loadAsientosSerializados(
  where: Prisma.AsientoManualWhereInput,
): Promise<AsientoSerializado[]> {
  const asientos = await prisma.asientoManual.findMany({
    where,
    include: {
      bankMovement: { include: { account: true } },
      lineas: { orderBy: { monto: "desc" }, include: { sucursal: { select: { codigo: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  // Rubro del banco (HABER del neto) resuelto con la misma cascada que usa
  // Traspasos internos: nombre de cuenta ↔ RubroLabel, o rubro de la entidad.
  const [rubros, entidades] = await Promise.all([
    prisma.rubroLabel.findMany({
      where: { isDifference: false },
      select: { rubro: true, name: true, accountId: true, sucursalId: true },
    }),
    loadEntidadesInternas(prisma),
  ]);
  // Mapa Sucursal.id → rubro contable (enlace explícito en Configuración → Rubros).
  const sucursalRubroMap = new Map<string, number>();
  for (const r of rubros) if (r.sucursalId) sucursalRubroMap.set(r.sucursalId, r.rubro);
  const accountsForRubro: AccountForRubro[] = [];
  const seenAcc = new Set<string>();
  for (const a of asientos) {
    const acc = a.bankMovement.account;
    if (!seenAcc.has(acc.id)) {
      seenAcc.add(acc.id);
      accountsForRubro.push({
        id: acc.id,
        bankName: acc.bankName,
        holderName: acc.holderName,
        holderRut: acc.holderRut,
      });
    }
  }
  const rubroMap = buildRubroMap(
    accountsForRubro,
    rubros,
    entidades.map((e) => ({ rutCanonico: e.rutCanonico, rubro: e.rubro })),
  );

  return asientos.map((a) => ({
    id: a.id,
    bankMovementId: a.bankMovementId,
    tipo: a.tipo,
    fecha: a.bankMovement.postDate.toISOString(),
    bankName: a.bankMovement.account.bankName,
    holderName: a.bankMovement.account.holderName,
    accountNumber: a.bankMovement.account.displayNumber || a.bankMovement.account.accountNumber,
    // Rubro contable del banco (HABER del neto), o null si no se pudo resolver.
    bancoRubro: rubroMap.get(a.bankMovement.account.id) ?? null,
    counterpartyName: a.bankMovement.counterpartyName,
    glosa: a.glosa,
    montoNeto: a.montoNeto.toString(),
    retencionTasa: a.retencionTasa != null ? Number(a.retencionTasa) : null,
    montoRetencion: a.montoRetencion.toString(),
    retencionRubro: a.retencionRubro,
    montoBruto: a.montoBruto.toString(),
    lineas: a.lineas.map((l) => ({
      sucursalNombre: l.sucursalNombre,
      // Rubro contable de la sucursal: enlace explícito (Rubros → Sucursal);
      // si no está enlazada, cae al código POS de la sucursal.
      rubro: sucursalRubroMap.get(l.sucursalId) ?? l.sucursal.codigo,
      personas: Number(l.personas),
      porcentaje: Number(l.porcentaje),
      monto: l.monto.toString(),
    })),
  }));
}
