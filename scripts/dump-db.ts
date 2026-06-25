/**
 * Dump COMPLETO de la BD para análisis profundo del matching/conciliación.
 *
 * Junta en un solo JSON, ya cruzado:
 *   1. matches      → cada Consolidado con SU movimiento de tesorería y los
 *                     movimientos de banco vinculados (ambos lados a la vez),
 *                     status, matchType, score, ajuste, notas y estado/anulado.
 *   2. internos     → pares de traspaso interno OUT↔IN (se calculan al vuelo
 *                     con matchMirror, no están en la BD) + huérfanos.
 *   3. cruceTbk     → cruce POS (TbkTesoreria) ↔ settlement (TransbankSale),
 *                     reproduciendo la lógica de la tab "Cruce Transbank".
 *   4. raw          → tablas completas (Tesorería, Banco, TBK, Settlement,
 *                     Egresos) con TODOS los campos para cruzar a mano.
 *   + config        → cuentas, alias, entidades internas, rubros, syncRuns.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/dump-db.ts
 *
 * Salida:
 *   dumps/db_dump_<YYYY-MM-DD>.json   (gitignored)
 *
 * Después: copiá ese JSON a la carpeta dumps/ de tu máquina local y avisame.
 * No trae datos de auth (no incluye usuarios/passwords).
 *
 * BigInt se serializa como string. Trae tablas completas (la base es chica);
 * si alguna crece mucho, ajustar TAKE.
 */

import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import { isTransbank } from "@/lib/transbank/detect";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const TAKE = 100_000;
const CONCILIADO = new Set(["AUTO_MATCHED", "MANUAL"]);

async function main() {
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dumpsDir, `db_dump_${today}.json`);

  const [
    bankAccounts,
    bankAccountAliases,
    entidadesInternas,
    rubroLabels,
    tesoreriaRaw,
    bankMovementsRaw,
    consolidadosRaw,
    syncRuns,
    tbkRaw,
    salesRaw,
    egresoRaw,
    entidadesLite,
  ] = await Promise.all([
    prisma.bankAccount.findMany(),
    prisma.bankAccountAlias.findMany(),
    prisma.entidadInterna.findMany(),
    prisma.rubroLabel.findMany(),
    prisma.tesoreriaMovement.findMany({ take: TAKE, orderBy: { fecha: "desc" } }),
    prisma.bankMovement.findMany({
      take: TAKE,
      orderBy: { postDate: "desc" },
      include: {
        account: {
          select: {
            id: true, bankCode: true, bankName: true, alias: true,
            accountNumber: true, displayNumber: true, holderName: true, holderRut: true,
          },
        },
        _count: { select: { consolidadoLinks: true } },
        // Resolución de EGRESO: vínculo contra gasto operativo (EgresoMovement)
        // y asiento manual generado. Sin esto, los OUT resueltos por esas vías
        // se contaban como "sin resolver".
        egresoConciliacionLinks: {
          select: {
            conciliacion: {
              select: {
                status: true,
                matchType: true,
                egresoMovement: { select: { externalId: true, glosa: true, monto: true, rubroNombre: true } },
              },
            },
          },
        },
        asientoManual: { select: { estado: true, tipo: true, montoBruto: true, glosa: true } },
      },
    }),
    prisma.consolidado.findMany({
      take: TAKE,
      include: {
        tesoreriaMovement: true,
        links: {
          select: {
            bankMovementId: true,
            amountAllocated: true,
            bankMovement: {
              include: {
                account: {
                  select: {
                    id: true, bankCode: true, bankName: true, alias: true,
                    accountNumber: true, displayNumber: true, holderName: true, holderRut: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.tesoreriaSyncRun.findMany({ take: 15, orderBy: { startedAt: "desc" } }),
    prisma.tbkTesoreria.findMany({ take: TAKE, orderBy: { fecha: "desc" } }),
    prisma.transbankSale.findMany({ take: TAKE, orderBy: { fechaVenta: "desc" } }),
    prisma.egresoMovement.findMany({
      take: TAKE,
      orderBy: { fecha: "desc" },
      // Estado de conciliación del gasto operativo contra banco (Egresos a terceros).
      include: { conciliacion: { select: { status: true, matchType: true } } },
    }),
    loadEntidadesInternas(prisma),
  ]);

  /* ----------------------- 1. matches (joined) ----------------------- */
  // Cada consolidado con ambos lados. Incluye TODOS los status (matcheado,
  // conciliado, propuesto, anulado, etc.) para ver "cualquier junte".
  const matches = consolidadosRaw.map((c) => {
    const t = c.tesoreriaMovement;
    return {
      consolidadoId: c.id,
      status: c.status,
      matchType: c.matchType,
      score: c.score,
      resolvedAccountId: c.resolvedAccountId,
      notes: c.notes,
      outOfScopeReason: c.outOfScopeReason,
      adjustmentAmount: c.adjustmentAmount,
      adjustmentRubro: c.adjustmentRubro,
      linkCount: c.links.length,
      tesoreria: {
        id: t.id,
        externalId: t.externalId,
        fecha: t.fecha,
        monto: t.monto,
        tipoOperacion: t.tipoOperacion,
        banco: t.banco,
        bancoSucursal: t.bancoSucursal,
        bancoDetectado: t.bancoDetectado,
        rubroBanco: t.rubroBanco,
        rubroSucursal: t.rubroSucursal,
        esExcepcion: t.esExcepcion,
        estadoOriginal: t.estadoOriginal,
        estadoActual: t.estadoActual,
        anulado: t.anulado,
        sucursalName: t.sucursalName,
        clienteName: t.clienteName,
        clienteRut: t.clienteRut,
        folio: t.folio,
        glosa: t.glosa,
      },
      banco: c.links.map((l) => ({
        bankMovementId: l.bankMovementId,
        amountAllocated: l.amountAllocated,
        postDate: l.bankMovement.postDate,
        amount: l.bankMovement.amount,
        direction: l.bankMovement.direction,
        accountId: l.bankMovement.accountId,
        bankCode: l.bankMovement.account.bankCode,
        bankName: l.bankMovement.account.bankName,
        accountNumber: l.bankMovement.account.displayNumber ?? l.bankMovement.account.accountNumber,
        holderName: l.bankMovement.account.holderName,
        holderRut: l.bankMovement.account.holderRut,
        description: l.bankMovement.description,
        counterpartyName: l.bankMovement.counterpartyName,
        counterpartyRut: l.bankMovement.counterpartyRut,
      })),
    };
  });

  /* ----------------------- 2. traspasos internos ----------------------- */
  const forMatch: BankMovementForMatch[] = bankMovementsRaw.map((bm) => ({
    id: bm.id,
    accountId: bm.accountId,
    postDate: bm.postDate,
    amount: bm.amount,
    direction: bm.direction,
    description: bm.description,
    counterpartyName: bm.counterpartyName,
    counterpartyRut: bm.counterpartyRut,
    account: {
      id: bm.account.id,
      bankName: bm.account.bankName,
      holderName: bm.account.holderName,
      holderRut: bm.account.holderRut,
      accountNumber: bm.account.accountNumber,
      displayNumber: bm.account.displayNumber,
    },
  }));
  const mirror = matchMirror(forMatch, entidadesLite);
  const internos = {
    pairs: mirror.pairs.map((p) => ({
      matchQuality: p.matchQuality,
      intraEntidad: p.intraEntidad,
      destEntidad: p.destEntidad.nombreCanonico,
      out: lite(p.out),
      in: lite(p.in),
    })),
    outOrphans: mirror.outOrphans.map((o) => ({ reason: o.reason, out: lite(o.out) })),
    inOrphans: mirror.inOrphans.map((o) => ({
      detectedEntidad: o.detectedEntidad.nombreCanonico,
      in: lite(o.in),
    })),
  };

  /* ----------------------- 3. cruce Transbank ----------------------- */
  // Reproduce la lógica de la tab "Cruce Transbank" (POS ↔ settlement).
  const cruceTbk = computeCruce(tbkRaw, salesRaw);

  /* ----------------------- resumen egresos (consola) ----------------------- */
  const egresos = tesoreriaRaw.filter((t) => t.tipoOperacion === "EGRESO" || t.monto < 0n);
  const statusByTid = new Map(consolidadosRaw.map((c) => [c.tesoreriaMovementId, c.status]));
  const egresosPorStatus: Record<string, number> = {};
  for (const e of egresos) {
    const st = statusByTid.get(e.id) ?? "UNPROCESSED";
    egresosPorStatus[st] = (egresosPorStatus[st] ?? 0) + 1;
  }

  /* ----------------------- estado/anulado resumen ----------------------- */
  const anuladosTM = tesoreriaRaw.filter((t) => t.estadoActual === "ANU").length;
  const anuladosTbk = tbkRaw.filter((t) => t.estadoActual === "ANU").length;

  const dump = {
    generatedAt: new Date().toISOString(),
    counts: {
      bankAccounts: bankAccounts.length,
      bankAccountAliases: bankAccountAliases.length,
      entidadesInternas: entidadesInternas.length,
      rubroLabels: rubroLabels.length,
      tesoreriaMovements: tesoreriaRaw.length,
      tesoreriaEgresos: egresos.length,
      tesoreriaAnulados: anuladosTM,
      bankMovements: bankMovementsRaw.length,
      bankMovementsOUT: bankMovementsRaw.filter((b) => b.direction === "OUT").length,
      bankConAsientoManual: bankMovementsRaw.filter((b) => b.asientoManual?.estado === "GENERADO").length,
      bankConEgresoConc: bankMovementsRaw.filter((b) => b.egresoConciliacionLinks.length > 0).length,
      consolidados: consolidadosRaw.length,
      consolidadosConLink: consolidadosRaw.filter((c) => c.links.length > 0).length,
      tbkTesoreria: tbkRaw.length,
      tbkAnulados: anuladosTbk,
      transbankSale: salesRaw.length,
      egresoMovement: egresoRaw.length,
      internosPairs: mirror.pairs.length,
      internosOutOrphans: mirror.outOrphans.length,
      internosInOrphans: mirror.inOrphans.length,
      cruceCuadrados: cruceTbk.filter((r) => r.estado === "cuadrado").length,
      crucePosSinSett: cruceTbk.filter((r) => r.estado === "pos_sin_settlement").length,
      cruceSettSinPos: cruceTbk.filter((r) => r.estado === "settlement_sin_pos").length,
    },
    consolidadosPorStatus: countBy(consolidadosRaw.map((c) => c.status)),
    egresosPorStatus,

    // config
    bankAccounts,
    bankAccountAliases,
    entidadesInternas,
    rubroLabels,
    syncRuns,

    // 1-3: cruces
    matches,
    internos,
    cruceTbk,

    // 4: raw (todos los campos)
    raw: {
      tesoreria: tesoreriaRaw,
      bankMovements: bankMovementsRaw.map((b) => {
        const eConc = b.egresoConciliacionLinks[0]?.conciliacion ?? null;
        return {
          ...b,
          linkCount: b._count.consolidadoLinks,
          isTransbank: isTransbank({
            description: b.description,
            direction: b.direction,
          }),
          // Resolución por otras vías (para clasificar OUT correctamente):
          asientoManualEstado: b.asientoManual?.estado ?? null,
          egresoConcStatus: eConc?.status ?? null,
          egresoConc: eConc
            ? {
                status: eConc.status,
                matchType: eConc.matchType,
                egresoExternalId: eConc.egresoMovement.externalId.toString(),
                egresoGlosa: eConc.egresoMovement.glosa,
                egresoMonto: eConc.egresoMovement.monto.toString(),
                rubroNombre: eConc.egresoMovement.rubroNombre,
              }
            : null,
          _count: undefined,
          egresoConciliacionLinks: undefined,
          asientoManual: undefined,
        };
      }),
      tbkTesoreria: tbkRaw,
      transbankSale: salesRaw,
      egresoMovement: egresoRaw,
    },
  };

  const json = JSON.stringify(
    dump,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  writeFileSync(outPath, json, "utf8");

  console.log("=".repeat(60));
  console.log("DUMP DE ANÁLISIS PROFUNDO");
  console.log("=".repeat(60));
  console.log(JSON.stringify(dump.counts, null, 2));
  console.log("\nConsolidados por status:");
  console.log(JSON.stringify(dump.consolidadosPorStatus, null, 2));
  console.log("\nEgresos por estado de conciliación:");
  console.log(JSON.stringify(egresosPorStatus, null, 2));
  console.log(`\nArchivo: ${outPath}`);
  console.log("\nCopia ese JSON a la carpeta dumps/ de tu máquina local y avisame.");

  await prisma.$disconnect();
}

/** Reduce un BankMovementForMatch a lo esencial para el dump de internos. */
function lite(m: BankMovementForMatch) {
  return {
    id: m.id,
    postDate: m.postDate,
    amount: m.amount,
    direction: m.direction,
    bankName: m.account.bankName,
    holderName: m.account.holderName,
    holderRut: m.account.holderRut,
    accountNumber: m.account.displayNumber ?? m.account.accountNumber,
    description: m.description,
    counterpartyName: m.counterpartyName,
    counterpartyRut: m.counterpartyRut,
  };
}

function countBy(arr: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/**
 * Cruce POS↔settlement (misma lógica que /api/consolidados/cruce-transbank):
 * Pass 1 por boleta(=OP) con tolerancia de monto (recargo crédito ~2%),
 * Pass 2 fallback por monto exacto + fecha ±1.5d.
 */
function computeCruce(
  posAll: Array<{ id: string; opNumber: string | null; monto: bigint; fecha: Date; sucursalId: number; glosa: string }>,
  settAll: Array<{ id: string; numeroBoleta: string | null; montoVenta: bigint; fechaVenta: Date; sucursalId: number | null; comision: bigint; totalAbono: bigint }>,
) {
  const MATCH_TOLERANCE = 0.05;
  const absB = (n: bigint) => (n < 0n ? -n : n);
  const dayMs = 86400000;

  const settByBoleta = new Map<string, typeof settAll>();
  for (const sv of settAll) {
    if (!sv.numeroBoleta) continue;
    (settByBoleta.get(sv.numeroBoleta) ?? settByBoleta.set(sv.numeroBoleta, []).get(sv.numeroBoleta)!).push(sv);
  }
  const usedSett = new Set<string>();
  type Pair = { pos: (typeof posAll)[number]; sett: (typeof settAll)[number] | null; diff: bigint };
  const pairs: Pair[] = [];
  const unmatchedPos: typeof posAll = [];

  for (const pos of posAll) {
    const op = pos.opNumber;
    let best: (typeof settAll)[number] | null = null;
    let bestDiff = 0n;
    if (op) {
      const base = absB(pos.monto);
      for (const c of settByBoleta.get(op) ?? []) {
        if (usedSett.has(c.id)) continue;
        const diff = c.montoVenta - pos.monto;
        if (base > 0n && Number(absB(diff)) / Number(base) > MATCH_TOLERANCE) continue;
        if (best === null || absB(diff) < absB(bestDiff)) { best = c; bestDiff = diff; }
      }
    }
    if (best) { usedSett.add(best.id); pairs.push({ pos, sett: best, diff: bestDiff }); }
    else unmatchedPos.push(pos);
  }

  const freeSett = settAll.filter((s) => !usedSett.has(s.id));
  for (const pos of unmatchedPos) {
    const cand = freeSett.find(
      (s) =>
        !usedSett.has(s.id) &&
        s.montoVenta === pos.monto &&
        Math.abs(pos.fecha.getTime() - s.fechaVenta.getTime()) <= dayMs * 1.5 &&
        (s.sucursalId == null || s.sucursalId === pos.sucursalId),
    );
    if (cand) { usedSett.add(cand.id); pairs.push({ pos, sett: cand, diff: 0n }); }
    else pairs.push({ pos, sett: null, diff: 0n });
  }

  type CruceRow = {
    estado: "cuadrado" | "pos_sin_settlement" | "settlement_sin_pos";
    posId: string | null;
    op: string | null;
    fecha: Date;
    sucursalId: number | null;
    glosa: string | null;
    montoPos: bigint | null;
    settId: string | null;
    boleta: string | null;
    montoSett: bigint | null;
    comision: bigint | null;
    neto: bigint | null;
    diferencia: bigint | null;
  };

  const rows: CruceRow[] = pairs.map((p) => ({
    estado: p.sett ? "cuadrado" : "pos_sin_settlement",
    posId: p.pos.id,
    op: p.pos.opNumber,
    fecha: p.pos.fecha,
    sucursalId: p.pos.sucursalId,
    glosa: p.pos.glosa,
    montoPos: p.pos.monto,
    settId: p.sett?.id ?? null,
    boleta: p.sett?.numeroBoleta ?? null,
    montoSett: p.sett?.montoVenta ?? null,
    comision: p.sett?.comision ?? null,
    neto: p.sett?.totalAbono ?? null,
    diferencia: p.sett ? p.diff : null,
  }));

  for (const s of settAll.filter((x) => !usedSett.has(x.id))) {
    rows.push({
      estado: "settlement_sin_pos",
      posId: null,
      op: null,
      fecha: s.fechaVenta,
      sucursalId: s.sucursalId,
      glosa: null,
      montoPos: null,
      settId: s.id,
      boleta: s.numeroBoleta,
      montoSett: s.montoVenta,
      comision: s.comision,
      neto: s.totalAbono,
      diferencia: null,
    });
  }

  return rows;
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
