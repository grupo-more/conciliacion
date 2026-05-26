import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  resolveCandidateAccounts,
  scoreCandidate,
} from "@/lib/consolidados/match";

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
        account: { id: string; bankName: string; accountNumber: string };
      }>
    | null = null;

  if (!t.consolidado || openStates.includes(t.consolidado.status)) {
    const accounts = await resolveCandidateAccounts(t.banco);
    const accountIds = new Set(accounts.map((a) => a.id));
    if (accountIds.size > 0) {
      const dayMs = 24 * 60 * 60 * 1000;
      const lower = new Date(t.fecha.getTime() - 7 * dayMs);
      const upper = new Date(t.fecha.getTime() + 7 * dayMs);

      const bms = await prisma.bankMovement.findMany({
        where: {
          direction: "IN",
          amount: t.monto,
          accountId: { in: Array.from(accountIds) },
          postDate: { gte: lower, lte: upper },
          consolidadoLinks: { none: {} },
        },
        include: { account: true },
        orderBy: { postDate: "asc" },
        take: 20,
      });

      candidates = bms
        .map((bm) => {
          const { score, factors } = scoreCandidate(t, bm);
          return {
            bankMovementId: bm.id,
            score,
            factors: factors.map((f) => ({
              key: f.key as string,
              label: f.label,
              weight: f.weight,
            })),
            postDate: bm.postDate.toISOString(),
            amount: bm.amount.toString(),
            description: bm.description,
            counterpartyName: bm.counterpartyName,
            counterpartyRut: bm.counterpartyRut,
            account: {
              id: bm.account.id,
              bankName: bm.account.bankName,
              accountNumber: bm.account.accountNumber,
            },
          };
        })
        .sort((a, b) => b.score - a.score);
    }
  }

  return NextResponse.json({
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
