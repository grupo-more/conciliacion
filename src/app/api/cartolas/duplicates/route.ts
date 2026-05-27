import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { extractEmbeddedReference } from "@/lib/cartolas/dedup";

/**
 * GET /api/cartolas/duplicates
 *
 * Detecta movimientos bancarios que parecen ser el mismo movimiento del
 * banco pero quedaron duplicados en BD por el dedup imperfecto antiguo
 * (ej: cartolas de distinto formato del mismo banco que truncan o expanden
 * el nombre del cliente).
 *
 * Criterio: agrupa por (accountId + amount + postDate.toDate() + referencia
 * embebida en la descripción). Si un grupo tiene >1 movimiento, son
 * candidatos a merge.
 *
 * Query params:
 *   ?accountId=<uuid>    (opcional, filtrar por cuenta)
 *
 * Response:
 *   { groups: Array<{ key, accountId, accountLabel, amount, postDate,
 *                     reference, movements: [...] }> }
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");

  const movements = await prisma.bankMovement.findMany({
    where: accountId ? { accountId } : {},
    include: {
      account: {
        select: { id: true, bankName: true, accountNumber: true, holderName: true },
      },
      consolidadoLinks: {
        select: { consolidadoId: true },
        take: 1,
      },
    },
    orderBy: [{ postDate: "asc" }, { createdAt: "asc" }],
  });

  // Agrupar por (accountId + day + amount + ref). Solo movimientos con ref
  // embebida — sin ref no podemos asegurar que sean el mismo movimiento.
  const groups = new Map<
    string,
    {
      key: string;
      accountId: string;
      accountLabel: string;
      amount: string;
      postDate: string;
      reference: string;
      movements: Array<{
        id: string;
        description: string;
        counterpartyName: string | null;
        counterpartyRut: string | null;
        externalId: string | null;
        isLinkedToConsolidado: boolean;
        statementImportId: string;
        createdAt: string;
      }>;
    }
  >();

  for (const m of movements) {
    const ref = extractEmbeddedReference(m.description);
    if (!ref) continue;

    const day = m.postDate.toISOString().slice(0, 10);
    const key = `${m.accountId}|${day}|${m.amount.toString()}|${ref}`;

    const acc = m.account;
    const accLabel = `${acc.bankName} · ${acc.accountNumber} (${acc.holderName})`;

    const existing = groups.get(key);
    const movEntry = {
      id: m.id,
      description: m.description,
      counterpartyName: m.counterpartyName,
      counterpartyRut: m.counterpartyRut,
      externalId: m.externalId,
      isLinkedToConsolidado: m.consolidadoLinks.length > 0,
      statementImportId: m.statementImportId,
      createdAt: m.createdAt.toISOString(),
    };

    if (existing) {
      existing.movements.push(movEntry);
    } else {
      groups.set(key, {
        key,
        accountId: m.accountId,
        accountLabel: accLabel,
        amount: m.amount.toString(),
        postDate: day,
        reference: ref,
        movements: [movEntry],
      });
    }
  }

  // Solo devolver grupos con >1 movimiento (duplicados reales)
  const duplicateGroups = Array.from(groups.values())
    .filter((g) => g.movements.length > 1)
    .sort((a, b) => b.movements.length - a.movements.length);

  return NextResponse.json({
    totalDuplicateGroups: duplicateGroups.length,
    totalDuplicateMovements: duplicateGroups.reduce(
      (s, g) => s + g.movements.length,
      0
    ),
    excessMovements: duplicateGroups.reduce(
      (s, g) => s + g.movements.length - 1,
      0
    ),
    groups: duplicateGroups,
  });
}
