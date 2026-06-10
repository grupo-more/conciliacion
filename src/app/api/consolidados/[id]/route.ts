import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  resolveCandidateAccounts,
  scoreCandidate,
  hasCrossAccountIdentity,
} from "@/lib/consolidados/match";
import { extractEmbeddedReference } from "@/lib/cartolas/dedup";
import { usoParcialAccountWhere } from "@/lib/cuentas/uso-parcial";

/**
 * GET /api/consolidados/[id]
 *
 * Detalle de un Consolidado: el movimiento Tesoreria, su estado, los links
 * actuales (BankMovements asociados) y, para casos en REVIEW/SUGGESTED,
 * los candidatos alternativos con su score desglosado.
 *
 * El [id] aquí es el id del TesoreriaMovement (no del Consolidado).
 */
export async function GET(
  _req: Request,
  context: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const tesoreriaId = context.params.id;
  const t = await prisma.tesoreriaMovement.findUnique({
    where: { id: tesoreriaId },
    include: {
      consolidado: {
        include: {
          links: {
            include: {
              bankMovement: { include: { account: true } },
            },
          },
        },
      },
    },
  });

  if (!t) {
    return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });
  }

  // Si está en estado abierto, computar candidatos alternativos con score
  const openStates = ["NO_MATCH", "SUGGESTED", "REVIEW"];
  let candidates:
    | Array<{
        bankMovementId: string;
        score: number;
        factors: Array<{ key: string; label: string; weight: number }>;
        postDate: string;
        amount: string;
        description: string;
        counterpartyName: string | null;
        counterpartyRut: string | null;
        account: {
          id: string;
          bankName: string;
          accountNumber: string;
          displayNumber: string | null;
          holderName: string;
        };
      }>
    | null = null;

  if (!t.consolidado || openStates.includes(t.consolidado.status)) {
    const aliasAccounts = await resolveCandidateAccounts(t.banco);
    const aliasIds = new Set(aliasAccounts.map((a) => a.id));

    // Alineado con el motor: la direccion depende del tipo de operacion
    // (egreso -> OUT, ingreso -> IN) y, si la API marco excepcion (deposito a
    // otro banco), se amplia la busqueda a TODAS las cuentas activas. Los
    // candidatos en cuentas distintas del alias pasan por el mismo gating de
    // identidad (RUT/nombre o RUT en glosa) para no proponer coincidencias de
    // monto entre bancos distintos.
    const isEgreso = t.tipoOperacion === "EGRESO" || t.monto < 0n;
    const direction = isEgreso ? "OUT" : "IN";

    const searchAccounts = t.esExcepcion
      ? await prisma.bankAccount.findMany({ where: { active: true } })
      : aliasAccounts;
    const searchIds = new Set(
      searchAccounts
        .filter((a) => !a.accountNumber.startsWith("_UNASSIGNED_"))
        .map((a) => a.id)
    );

    if (searchIds.size > 0) {
      const dayMs = 24 * 60 * 60 * 1000;
      const lower = new Date(t.fecha.getTime() - 7 * dayMs);
      const upper = new Date(t.fecha.getTime() + 7 * dayMs);

      const rawBms = await prisma.bankMovement.findMany({
        where: {
          direction,
          amount: t.monto,
          accountId: { in: Array.from(searchIds) },
          postDate: { gte: lower, lte: upper },
          consolidadoLinks: { none: {} },
          // Cuentas de uso parcial: no se ofrecen como candidatas.
          account: { isNot: usoParcialAccountWhere },
        },
        include: { account: true },
        orderBy: { postDate: "asc" },
        take: 20,
      });

      // Cross-cuenta solo con identidad firme; cuenta del alias pasa directo.
      const bms = rawBms.filter(
        (bm) => aliasIds.has(bm.accountId) || hasCrossAccountIdentity(t, bm)
      );

      // PROTECCION DEFENSIVA: si en BD hay BankMovements duplicados (mismo
      // movimiento real cargado desde dos cartolas), agruparlos visualmente
      // como UN solo candidato con un badge "duplicado en cartola". Asi el
      // usuario no ve dos botones "Vincular" idénticos. El dedup definitivo
      // se hace en Cartolas → "Detectar duplicados".
      const dedupGroups = new Map<string, typeof bms>();
      for (const bm of bms) {
        const ref = extractEmbeddedReference(bm.description);
        // Solo agrupa si hay ref embebida (señal fuerte). Sino, cada candidato
        // queda como un grupo de uno.
        const key = ref
          ? `${bm.accountId}|${bm.postDate.toISOString().slice(0, 10)}|${bm.amount.toString()}|${ref}`
          : `__solo__${bm.id}`;
        const arr = dedupGroups.get(key) ?? [];
        arr.push(bm);
        dedupGroups.set(key, arr);
      }

      candidates = Array.from(dedupGroups.values())
        .map((group) => {
          // Representante: el más antiguo (createdAt asc) o el que tenga link
          // a Consolidado si alguno lo tiene (improbable, ya filtramos).
          const rep = group.slice().sort((a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime()
          )[0];
          const { score, factors } = scoreCandidate(t, rep);
          const isDuplicate = group.length > 1;
          return {
            bankMovementId: rep.id,
            score,
            factors: factors.map((f) => ({
              key: f.key as string,
              label: f.label,
              weight: f.weight,
            })),
            postDate: rep.postDate.toISOString(),
            amount: rep.amount.toString(),
            description: rep.description,
            counterpartyName: rep.counterpartyName,
            counterpartyRut: rep.counterpartyRut,
            account: {
              id: rep.account.id,
              bankName: rep.account.bankName,
              accountNumber: rep.account.accountNumber,
              displayNumber: rep.account.displayNumber,
              holderName: rep.account.holderName,
            },
            duplicateInCartola: isDuplicate,
            duplicateCount: group.length,
          };
        })
        .sort((a, b) => b.score - a.score);
    }
  }

  // Propuesta persistida por el motor (SUGGESTED/REVIEW): los BankMovements que
  // dieron el score. Se hidratan SIEMPRE (no dependen del recálculo en vivo),
  // así el detalle muestra contra qué apunta el match aunque sea un split o el
  // candidato ya no aparezca en la búsqueda en vivo.
  let proposal: {
    bankMovementIds: string[];
    isSplit: boolean;
    totalAmount: string;
    score: number | null;
    movements: Array<{
      bankMovementId: string;
      postDate: string;
      amount: string;
      description: string | null;
      counterpartyName: string | null;
      counterpartyRut: string | null;
      score: number;
      factors: Array<{ key: string; label: string; weight: number }>;
      account: {
        id: string;
        bankName: string;
        accountNumber: string;
        displayNumber: string | null;
        holderName: string;
      };
      linkedElsewhere: boolean;
    }>;
  } | null = null;

  const rawProposal = t.consolidado?.proposalJson as
    | { bankMovementIds?: unknown }
    | null
    | undefined;
  const proposalIds = Array.isArray(rawProposal?.bankMovementIds)
    ? (rawProposal!.bankMovementIds as string[])
    : [];

  if (proposalIds.length > 0) {
    const pbms = await prisma.bankMovement.findMany({
      where: { id: { in: proposalIds } },
      include: {
        account: true,
        consolidadoLinks: { select: { consolidadoId: true } },
      },
    });
    const byId = new Map(pbms.map((b) => [b.id, b]));
    const ordered = proposalIds
      .map((id) => byId.get(id))
      .filter((b): b is (typeof pbms)[number] => !!b);
    if (ordered.length > 0) {
      const total = ordered.reduce((acc, b) => acc + b.amount, 0n);
      proposal = {
        bankMovementIds: ordered.map((b) => b.id),
        isSplit: ordered.length > 1,
        totalAmount: total.toString(),
        score: t.consolidado?.score ?? null,
        movements: ordered.map((bm) => {
          const { score, factors } = scoreCandidate(t, bm);
          return {
            bankMovementId: bm.id,
            postDate: bm.postDate.toISOString(),
            amount: bm.amount.toString(),
            description: bm.description,
            counterpartyName: bm.counterpartyName,
            counterpartyRut: bm.counterpartyRut,
            score,
            factors: factors.map((f) => ({
              key: f.key as string,
              label: f.label,
              weight: f.weight,
            })),
            account: {
              id: bm.account.id,
              bankName: bm.account.bankName,
              accountNumber: bm.account.accountNumber,
              displayNumber: bm.account.displayNumber,
              holderName: bm.account.holderName,
            },
            linkedElsewhere: bm.consolidadoLinks.some(
              (l) => l.consolidadoId !== t.consolidado?.id,
            ),
          };
        }),
      };
    }
  }

  return NextResponse.json({
    proposal,
    tesoreria: {
      id: t.id,
      externalId: t.externalId.toString(),
      fecha: t.fecha.toISOString(),
      monto: t.monto.toString(),
      glosa: t.glosa,
      banco: t.banco,
      bancoSucursal: t.bancoSucursal,
      bancoDetectado: t.bancoDetectado,
      esExcepcion: t.esExcepcion,
      folio: t.folio.toString(),
      sucursalId: t.sucursalId,
      sucursalName: t.sucursalName,
      cajeroUsername: t.cajeroUsername,
      cajeroName: t.cajeroName,
      clienteName: t.clienteName,
      clienteRut: t.clienteRut,
      tipoDocumento: t.tipoDocumento,
      rubroSucursal: t.rubroSucursal,
      rubroBanco: t.rubroBanco,
    },
    consolidado: t.consolidado
      ? {
          id: t.consolidado.id,
          status: t.consolidado.status,
          matchType: t.consolidado.matchType,
          score: t.consolidado.score,
          notes: t.consolidado.notes,
          outOfScopeReason: t.consolidado.outOfScopeReason,
          resolvedAccountId: t.consolidado.resolvedAccountId,
          links: t.consolidado.links.map((l) => ({
            bankMovementId: l.bankMovementId,
            postDate: l.bankMovement.postDate.toISOString(),
            amount: l.bankMovement.amount.toString(),
            description: l.bankMovement.description,
            counterpartyName: l.bankMovement.counterpartyName,
            counterpartyRut: l.bankMovement.counterpartyRut,
            account: {
              id: l.bankMovement.account.id,
              bankName: l.bankMovement.account.bankName,
              accountNumber: l.bankMovement.account.accountNumber,
              displayNumber: l.bankMovement.account.displayNumber,
              holderName: l.bankMovement.account.holderName,
            },
          })),
        }
      : null,
    candidates,
  });
}

/**
 * PATCH /api/consolidados/[id]
 *
 * Permite acciones manuales:
 *  - { action: "confirm", bankMovementId: "..." }  → fija el match a esa BM
 *  - { action: "reject" }                          → marca como NO_MATCH
 *  - { action: "notes", notes: "..." }             → solo actualiza notas
 */
export async function PATCH(
  req: Request,
  context: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const tesoreriaId = context.params.id;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const t = await prisma.tesoreriaMovement.findUnique({
    where: { id: tesoreriaId },
    include: { consolidado: true },
  });
  if (!t) {
    return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });
  }

  switch (body.action) {
    case "confirm": {
      const bmId = body.bankMovementId;
      if (typeof bmId !== "string") {
        return NextResponse.json(
          { error: "bankMovementId requerido" },
          { status: 400 }
        );
      }
      const bm = await prisma.bankMovement.findUnique({
        where: { id: bmId },
        include: { consolidadoLinks: true },
      });
      if (!bm) {
        return NextResponse.json(
          { error: "BankMovement no existe" },
          { status: 404 }
        );
      }
      if (
        bm.consolidadoLinks.length > 0 &&
        !bm.consolidadoLinks.some((l) => l.consolidadoId === t.consolidado?.id)
      ) {
        return NextResponse.json(
          { error: "Ese BankMovement ya está vinculado a otro consolidado" },
          { status: 409 }
        );
      }
      await prisma.$transaction(async (tx) => {
        // Limpiar links previos
        if (t.consolidado) {
          await tx.consolidadoLink.deleteMany({
            where: { consolidadoId: t.consolidado.id },
          });
        }
        const consolidado = t.consolidado
          ? await tx.consolidado.update({
              where: { id: t.consolidado.id },
              data: {
                status: "MANUAL",
                matchType: "MANUAL",
                resolvedAccountId: bm.accountId,
                matchedAt: new Date(),
              },
            })
          : await tx.consolidado.create({
              data: {
                tesoreriaMovementId: tesoreriaId,
                status: "MANUAL",
                matchType: "MANUAL",
                resolvedAccountId: bm.accountId,
              },
            });
        await tx.consolidadoLink.create({
          data: { consolidadoId: consolidado.id, bankMovementId: bmId },
        });
      });
      return NextResponse.json({ ok: true });
    }

    case "reject": {
      if (!t.consolidado) {
        // Crear como NO_MATCH si no existe
        await prisma.consolidado.create({
          data: {
            tesoreriaMovementId: tesoreriaId,
            status: "NO_MATCH",
            matchType: null,
          },
        });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.consolidadoLink.deleteMany({
            where: { consolidadoId: t.consolidado!.id },
          });
          await tx.consolidado.update({
            where: { id: t.consolidado!.id },
            data: { status: "NO_MATCH", matchType: null, matchedAt: new Date() },
          });
        });
      }
      return NextResponse.json({ ok: true });
    }

    case "notes": {
      const notes = typeof body.notes === "string" ? body.notes : null;
      if (!t.consolidado) {
        await prisma.consolidado.create({
          data: {
            tesoreriaMovementId: tesoreriaId,
            status: "REVIEW",
            notes,
          },
        });
      } else {
        await prisma.consolidado.update({
          where: { id: t.consolidado.id },
          data: { notes },
        });
      }
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json(
        { error: `Acción desconocida: ${body.action}` },
        { status: 400 }
      );
  }
}
