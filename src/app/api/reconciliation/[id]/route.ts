import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { findCandidates } from "@/lib/reconciliation/match";
import { parseGlosa } from "@/lib/reconciliation/glosa";

/**
 * GET /api/reconciliation/[id]
 * Devuelve la conciliación con sus links actuales + candidatos disponibles.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const r = await prisma.reconciliation.findUnique({
    where: { id: params.id },
    include: {
      dynatechMovement: true,
      links: {
        include: {
          bankMovement: {
            include: {
              account: {
                select: {
                  bankCode: true,
                  bankName: true,
                  accountNumber: true,
                  displayNumber: true,
                  holderName: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!r) {
    return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  }

  const candidates = await findCandidates(r.dynatechMovementId);
  const glosa = parseGlosa(r.dynatechMovement.observation || "");

  const banksSum = r.links.reduce((acc, l) => acc + l.bankMovement.amount, 0n);

  return NextResponse.json({
    id: r.id,
    status: r.status,
    matchType: r.matchType,
    outOfScopeReason: r.outOfScopeReason,
    notes: r.notes,
    dynatech: {
      id: r.dynatechMovement.id,
      mCjId: r.dynatechMovement.mCjId.toString(),
      branchExternalId: r.dynatechMovement.branchExternalId,
      branchExternalName: r.dynatechMovement.branchExternalName,
      cashierUsername: r.dynatechMovement.cashierUsername,
      cashierName: r.dynatechMovement.cashierName,
      customerName: r.dynatechMovement.customerName,
      customerRut: r.dynatechMovement.customerRut,
      occurredAt: r.dynatechMovement.occurredAt.toISOString(),
      observation: r.dynatechMovement.observation,
      totalAmount: r.dynatechMovement.totalAmount.toString(),
      items: r.dynatechMovement.items,
      glosa,
    },
    banks: r.links.map((l) => ({
      linkId: l.id,
      id: l.bankMovement.id,
      accountId: l.bankMovement.accountId,
      account: l.bankMovement.account,
      postDate: l.bankMovement.postDate.toISOString(),
      amount: l.bankMovement.amount.toString(),
      description: l.bankMovement.description,
      counterpartyName: l.bankMovement.counterpartyName,
      counterpartyRut: l.bankMovement.counterpartyRut,
    })),
    banksSum: banksSum.toString(),
    candidates: candidates.map((c) => ({
      id: c.id,
      accountId: c.accountId,
      account: c.account,
      postDate: c.postDate.toISOString(),
      amount: c.amount.toString(),
      description: c.description,
      counterpartyName: c.counterpartyName,
      counterpartyRut: c.counterpartyRut,
      externalId: c.externalId,
      isLinked: r.links.some((l) => l.bankMovementId === c.id),
      score: c.score
        ? {
            total: c.score.total,
            suggestedStatus: c.score.suggestedStatus,
            hardContradiction: c.score.hardContradiction,
            factors: c.score.factors.map((f) => ({
              key: f.key,
              label: f.label,
              weight: f.weight,
              detail: f.detail ?? null,
            })),
          }
        : null,
    })),
  });
}

/**
 * POST /api/reconciliation/[id]
 * Acciones:
 *   approve                            → aprueba SUGGESTED → MANUAL
 *   manual { bankMovementIds: string[] }  → fija una lista (1 o N) como conciliación
 *   unmatch                            → vuelve a NO_MATCH (borra todos los links)
 *   out_of_scope { reason? }           → marca OUT_OF_SCOPE manual
 *   no_match                           → marca NO_MATCH manual
 */
const actionSchema = z.union([
  z.object({ action: z.literal("approve") }),
  z.object({
    action: z.literal("manual"),
    bankMovementIds: z.array(z.string().uuid()).min(1).max(10),
  }),
  z.object({ action: z.literal("unmatch") }),
  z.object({ action: z.literal("out_of_scope"), reason: z.string().optional() }),
  z.object({ action: z.literal("no_match") }),
]);

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const reconciliation = await prisma.reconciliation.findUnique({
    where: { id: params.id },
    include: { links: true },
  });
  if (!reconciliation) {
    return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  }

  const data = parsed.data;
  switch (data.action) {
    case "approve": {
      if (reconciliation.links.length === 0) {
        return NextResponse.json(
          { error: "No hay bank movements para aprobar" },
          { status: 400 }
        );
      }
      await prisma.reconciliation.update({
        where: { id: params.id },
        data: { status: "MANUAL", matchType: "MANUAL", matchedAt: new Date() },
      });
      return NextResponse.json({ ok: true, status: "MANUAL" });
    }

    case "manual": {
      // Validar todos los bank movements
      const bms = await prisma.bankMovement.findMany({
        where: { id: { in: data.bankMovementIds } },
      });
      if (bms.length !== data.bankMovementIds.length) {
        return NextResponse.json(
          { error: "Alguno de los movimientos no existe" },
          { status: 404 }
        );
      }

      // Verificar que no estén ya tomados por OTRA reconciliation
      const inUse = await prisma.reconciliationLink.findMany({
        where: {
          bankMovementId: { in: data.bankMovementIds },
          reconciliationId: { not: reconciliation.id },
        },
      });
      if (inUse.length > 0) {
        return NextResponse.json(
          {
            error:
              "Uno o más movimientos ya están conciliados con otro Dynatech",
          },
          { status: 409 }
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.reconciliationLink.deleteMany({
          where: { reconciliationId: reconciliation.id },
        });
        await tx.reconciliationLink.createMany({
          data: data.bankMovementIds.map((bmId) => ({
            reconciliationId: reconciliation.id,
            bankMovementId: bmId,
          })),
        });
        await tx.reconciliation.update({
          where: { id: reconciliation.id },
          data: {
            status: "MANUAL",
            matchType: "MANUAL",
            outOfScopeReason: null,
            matchedAt: new Date(),
          },
        });
      });

      return NextResponse.json({ ok: true, status: "MANUAL" });
    }

    case "unmatch": {
      await prisma.$transaction(async (tx) => {
        await tx.reconciliationLink.deleteMany({
          where: { reconciliationId: reconciliation.id },
        });
        await tx.reconciliation.update({
          where: { id: reconciliation.id },
          data: {
            status: "NO_MATCH",
            matchType: null,
            outOfScopeReason: null,
            matchedAt: new Date(),
          },
        });
      });
      return NextResponse.json({ ok: true, status: "NO_MATCH" });
    }

    case "out_of_scope": {
      await prisma.$transaction(async (tx) => {
        await tx.reconciliationLink.deleteMany({
          where: { reconciliationId: reconciliation.id },
        });
        await tx.reconciliation.update({
          where: { id: reconciliation.id },
          data: {
            status: "OUT_OF_SCOPE",
            matchType: null,
            outOfScopeReason: data.reason || "Marcado manualmente",
            matchedAt: new Date(),
          },
        });
      });
      return NextResponse.json({ ok: true, status: "OUT_OF_SCOPE" });
    }

    case "no_match": {
      await prisma.$transaction(async (tx) => {
        await tx.reconciliationLink.deleteMany({
          where: { reconciliationId: reconciliation.id },
        });
        await tx.reconciliation.update({
          where: { id: reconciliation.id },
          data: {
            status: "NO_MATCH",
            matchType: null,
            outOfScopeReason: null,
            matchedAt: new Date(),
          },
        });
      });
      return NextResponse.json({ ok: true, status: "NO_MATCH" });
    }
  }
}
