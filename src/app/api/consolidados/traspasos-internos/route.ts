import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import {
  matchMirror,
  type BankMovementForMatch,
} from "@/lib/internos/match";
import {
  buildRubroMap,
  type AccountForRubro,
} from "@/lib/internos/rubro-resolver";
import { consumedRefIds } from "@/lib/consolidados/emision-consumo";

/**
 * GET /api/consolidados/traspasos-internos?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &accountId=<uuid>&intra=include|exclude|only
 *
 * Devuelve los traspasos internos detectados como pares OUT ↔ IN espejo:
 *   - pairs: pares cuadrados (asiento contable Debe/Haber).
 *   - outOrphans: OUTs internos sin IN espejo en el rango.
 *   - inOrphans: INs internos sin OUT espejo en el rango.
 *
 * Cada lado del par viene con su rubro contable resuelto por heuristica
 * (lib/internos/rubro-resolver.ts). Donde no se puede resolver, viene null
 * y el front muestra "—".
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
  const intra = (url.searchParams.get("intra") || "include") as
    | "include"
    | "exclude"
    | "only";

  const entidades = await loadEntidadesInternas(prisma);

  // Para el matching necesitamos OUTs internos + TODOS los IN del rango
  // (no solo los detectados como internos: a veces el IN destino NO se
  // detecta como interno porque su counterparty viene vacio, pero igual
  // es el espejo correcto via amount + cuenta destino).
  //
  // Pero limitamos: solo INs en cuentas cuyo holderRut matchea alguna
  // entidad interna (el resto no nos sirven como destino).
  const movements = await prisma.bankMovement.findMany({
    where: {
      postDate: { gte: from, lt: to },
      descartadoAt: null,
    },
    include: {
      account: {
        select: {
          id: true,
          bankName: true,
          holderName: true,
          holderRut: true,
          accountNumber: true,
          displayNumber: true,
        },
      },
    },
    orderBy: [{ postDate: "asc" }, { id: "asc" }],
    take: 20000,
  });

  // Movimientos ya emitidos a gestión (folio): fuera del universo de ESTA tab
  // (se filtran ANTES del matcher para que los restantes pareen entre sí, en
  // vez de esconder pares a medias). OJO: solo afecta este listado — el
  // matchMirror de banco-compute (Reportes) corre aparte con el universo
  // completo, así que emitir jamás des-resuelve.
  const emitidos = await consumedRefIds("TRASPASOS_INTERNOS");
  const movimientosLibres =
    emitidos.size > 0 ? movements.filter((m) => !emitidos.has(m.id)) : movements;

  const result = matchMirror(
    movimientosLibres as BankMovementForMatch[],
    entidades,
  );

  // Rubro map: necesito el rubro de TODAS las cuentas involucradas en pares y huerfanos.
  const involvedAccountIds = new Set<string>();
  for (const p of result.pairs) {
    involvedAccountIds.add(p.out.account.id);
    involvedAccountIds.add(p.in.account.id);
  }
  for (const o of result.outOrphans) involvedAccountIds.add(o.out.account.id);
  for (const o of result.inOrphans) involvedAccountIds.add(o.in.account.id);

  const accountsForRubro: AccountForRubro[] = [];
  const accountInfo = new Map<string, BankMovementForMatch["account"]>();
  for (const m of movements) {
    if (involvedAccountIds.has(m.account.id) && !accountInfo.has(m.account.id)) {
      accountInfo.set(m.account.id, m.account);
      accountsForRubro.push({
        id: m.account.id,
        bankName: m.account.bankName,
        holderName: m.account.holderName,
        holderRut: m.account.holderRut,
      });
    }
  }
  const rubros = await prisma.rubroLabel.findMany({
    where: { isDifference: false },
    select: { rubro: true, name: true, accountId: true },
  });
  const rubroMap = buildRubroMap(
    accountsForRubro,
    rubros,
    entidades.map((e) => ({ rutCanonico: e.rutCanonico, rubro: e.rubro })),
  );
  const rubroNameByCode = new Map(rubros.map((r) => [r.rubro, r.name]));

  // Aplico filtros (accountId, intra).
  const filteredPairs = result.pairs.filter((p) => {
    if (accountId && p.out.account.id !== accountId && p.in.account.id !== accountId) {
      return false;
    }
    if (intra === "exclude" && p.intraEntidad) return false;
    if (intra === "only" && !p.intraEntidad) return false;
    return true;
  });

  // Serializar pares como filas Debe/Haber (estilo Abono Transbank).
  const rows: TraspasoRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const p of filteredPairs) {
    const groupId = p.out.id;
    const amount = absBig(p.out.amount);
    totalDebe += amount;
    totalHaber += amount;

    const outAcc = p.out.account;
    const inAcc = p.in.account;
    const outRubro = rubroMap.get(outAcc.id) ?? null;
    const inRubro = rubroMap.get(inAcc.id) ?? null;

    // DEBE: cuenta destino (donde la plata entra → carga su cuenta de mayor).
    // El "detalle" muestra la CONTRAPARTE (cuenta origen, outAcc) en vez de la
    // propia cuenta destino — convención contable: el glosa de cada lado
    // nombra de dónde vino / hacia dónde fue, no a sí mismo. El rubro/monto/
    // Debe siguen atados a la cuenta destino real (inAcc) sin cambios.
    rows.push({
      groupId,
      side: "DEBE",
      fecha: p.in.postDate.toISOString(),
      rubro: inRubro,
      rubroLabel: inRubro != null ? rubroNameByCode.get(inRubro) ?? null : null,
      detalle: accountDetalle(outAcc),
      contraparte: shortContraparte(p.in.counterpartyName, p.in.counterpartyRut),
      glosa: p.in.description ?? "",
      monto: amount.toString(),
      debe: amount.toString(),
      haber: null,
      bankMovementId: p.in.id,
      matchQuality: p.matchQuality,
      intraEntidad: p.intraEntidad,
    });

    // HABER: cuenta origen (de donde sale → abona su cuenta de mayor). Mismo
    // criterio: el "detalle" muestra la contraparte (cuenta destino, inAcc).
    rows.push({
      groupId,
      side: "HABER",
      fecha: p.out.postDate.toISOString(),
      rubro: outRubro,
      rubroLabel: outRubro != null ? rubroNameByCode.get(outRubro) ?? null : null,
      detalle: accountDetalle(inAcc),
      contraparte: shortContraparte(p.out.counterpartyName, p.out.counterpartyRut),
      glosa: p.out.description ?? "",
      monto: amount.toString(),
      debe: null,
      haber: amount.toString(),
      bankMovementId: p.out.id,
      matchQuality: p.matchQuality,
      intraEntidad: p.intraEntidad,
    });
  }

  // Huerfanos serializados como filas sueltas (no son par).
  const outOrphans = result.outOrphans
    .filter((o) => !accountId || o.out.account.id === accountId)
    .map((o) => ({
      id: o.out.id,
      fecha: o.out.postDate.toISOString(),
      cuenta: accountDetalle(o.out.account),
      rubro: rubroMap.get(o.out.account.id) ?? null,
      rubroLabel:
        rubroMap.get(o.out.account.id) != null
          ? rubroNameByCode.get(rubroMap.get(o.out.account.id)!) ?? null
          : null,
      monto: absBig(o.out.amount).toString(),
      contraparte: shortContraparte(o.out.counterpartyName, o.out.counterpartyRut),
      glosa: o.out.description ?? "",
      reason: o.reason,
      candidatesCount: o.candidates?.length ?? 0,
    }));

  const inOrphans = result.inOrphans
    .filter((o) => !accountId || o.in.account.id === accountId)
    .map((o) => ({
      id: o.in.id,
      fecha: o.in.postDate.toISOString(),
      cuenta: accountDetalle(o.in.account),
      rubro: rubroMap.get(o.in.account.id) ?? null,
      rubroLabel:
        rubroMap.get(o.in.account.id) != null
          ? rubroNameByCode.get(rubroMap.get(o.in.account.id)!) ?? null
          : null,
      monto: absBig(o.in.amount).toString(),
      contraparte: shortContraparte(o.in.counterpartyName, o.in.counterpartyRut),
      glosa: o.in.description ?? "",
      entidad: o.detectedEntidad.nombreCanonico,
    }));

  // Facets: cuentas involucradas (para el select).
  const accountListRaw = [...accountInfo.values()];
  const accountList = accountListRaw
    .map((a) => ({
      id: a.id,
      label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: {
      pairs: filteredPairs.length,
      debe: totalDebe.toString(),
      haber: totalHaber.toString(),
    },
    outOrphans,
    inOrphans,
    counts: {
      pairsClean: result.pairs.filter((p) => p.matchQuality === "clean").length,
      pairsCircle: result.pairs.filter((p) => p.matchQuality === "circle").length,
      pairsBlock: result.pairs.filter((p) => p.matchQuality === "block").length,
      pairsIntra: result.pairs.filter((p) => p.intraEntidad).length,
      outOrphans: result.outOrphans.length,
      inOrphans: result.inOrphans.length,
    },
    facets: { accounts: accountList },
  });
}

interface TraspasoRow {
  groupId: string;
  side: "DEBE" | "HABER";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  contraparte: string;
  glosa: string;
  monto: string;
  debe: string | null;
  haber: string | null;
  bankMovementId: string;
  matchQuality: "clean" | "circle" | "block";
  intraEntidad: boolean;
}

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function accountDetalle(a: BankMovementForMatch["account"]): string {
  const num = a.displayNumber || a.accountNumber;
  return [a.bankName, a.holderName, num].filter((s) => s && s.trim().length > 0).join(" · ");
}

function shortContraparte(
  name: string | null | undefined,
  rut: string | null | undefined,
): string {
  if (name && name.trim().length > 0) return name.trim();
  if (rut && rut.trim().length > 0) return rut.trim();
  return "";
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
