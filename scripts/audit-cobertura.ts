/**
 * Auditoría de cobertura de conciliación.
 *
 * Valida que TODO movimiento esté contemplado por algún canal de resolución y
 * que no haya doble conteo. Tres universos:
 *   - BANCO (BankMovement): canales = motor (link AUTO/MANUAL), Abono Transbank,
 *     traspaso interno, egreso a tercero, dif menor, uso parcial (no relevante),
 *     o BRECHA (sin conciliar).
 *   - TESORERÍA (TesoreriaMovement): conciliado (AUTO/MANUAL), ANULADO,
 *     pendiente (NO_MATCH/REVIEW/SUGGESTED/OUT_OF_SCOPE), sin procesar.
 *   - EGRESOS OPERATIVOS (EgresoMovement): AUTO/MANUAL/SUGGESTED/NO_MATCH/sin.
 *
 * Identidad: total = Σ canales + brecha, sin que ningún movimiento caiga en
 * más de un canal (lista los conflictos). Es el chequeo de consistencia entre
 * las tabs, la Lista y el Reporte.
 *
 * Uso (en el SERVER, con DATABASE_URL):
 *   npx tsx scripts/audit-cobertura.ts                 → todo el histórico
 *   npx tsx scripts/audit-cobertura.ts 2026-06-01 2026-06-10
 */
import { PrismaClient } from "@prisma/client";
import { detectInterno, loadEntidadesInternas } from "@/lib/internos/detect";
import { isTransbank } from "@/lib/transbank/detect";
import { getDifMenorSettings, isDifMenor } from "@/lib/dif-menor/detect";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";

const prisma = new PrismaClient({ log: ["error"] });
const CONCILIADO = new Set(["AUTO_MATCHED", "MANUAL"]);

function parseArgDate(s: string | undefined): Date | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

async function main() {
  const fromArg = parseArgDate(process.argv[2]);
  const toArg = parseArgDate(process.argv[3]);
  const where = fromArg && toArg
    ? { postDate: { gte: fromArg, lt: new Date(toArg.getTime() + 86400000) } }
    : {};
  const rangeLabel = fromArg && toArg ? `${process.argv[2]} → ${process.argv[3]}` : "TODO el histórico";

  const [entidades, dif, bms] = await Promise.all([
    loadEntidadesInternas(prisma),
    getDifMenorSettings(),
    prisma.bankMovement.findMany({
      where,
      include: {
        account: true,
        consolidadoLinks: { select: { consolidado: { select: { status: true } } } },
        egresoConciliacionLinks: { select: { conciliacion: { select: { status: true } } } },
        asientoManual: { select: { estado: true } },
      },
    }),
  ]);

  // Traspasos internos (sobre el universo cargado).
  const forMatch: BankMovementForMatch[] = bms.map((b) => ({
    id: b.id, accountId: b.accountId, postDate: b.postDate, amount: b.amount,
    direction: b.direction, description: b.description,
    counterpartyName: b.counterpartyName, counterpartyRut: b.counterpartyRut,
    account: {
      id: b.account.id, bankName: b.account.bankName, holderName: b.account.holderName,
      holderRut: b.account.holderRut, accountNumber: b.account.accountNumber,
      displayNumber: b.account.displayNumber,
    },
  }));
  const mirror = matchMirror(forMatch, entidades);
  const paired = new Set<string>();
  for (const p of mirror.pairs) { paired.add(p.out.id); paired.add(p.in.id); }

  const abs = (n: bigint) => (n < 0n ? -n : n);
  const chan: Record<string, { count: number; monto: bigint }> = {};
  const add = (k: string, m: bigint) => {
    chan[k] = chan[k] ?? { count: 0, monto: 0n };
    chan[k].count++; chan[k].monto += m;
  };
  const conflictsReal: string[] = [];
  let expectedOverlap = 0; // uso-parcial ∩ traspaso (esperado, no es bug)

  for (const b of bms) {
    const m = abs(b.amount);
    // Qué canales aplican (para detectar solapamiento).
    const hits: string[] = [];
    if (b.consolidadoLinks.some((l) => l.consolidado && CONCILIADO.has(l.consolidado.status))) hits.push("motor");
    if (isTransbank(b)) hits.push("transbank");
    if (paired.has(b.id)) hits.push("traspaso");
    if (isUsoParcialAccount(b.account)) hits.push("no_relevante");
    if (b.egresoConciliacionLinks.some((l) => l.conciliacion && CONCILIADO.has(l.conciliacion.status))) hits.push("egreso");
    if (isDifMenor(b, dif.threshold)) hits.push("dif_menor");
    if (b.asientoManual?.estado === "GENERADO") hits.push("asiento_manual");

    if (hits.length > 1) {
      const set = new Set(hits);
      const isExpected = set.size === 2 && set.has("no_relevante") && set.has("traspaso");
      if (isExpected) expectedOverlap++;
      else conflictsReal.push(`  [${hits.join(" + ")}] ${b.postDate.toISOString().slice(0, 10)} ${b.direction} ${b.amount} ${b.account.bankName} "${(b.description || "").slice(0, 30)}"`);
    }

    // Atribución con la MISMA prioridad que banco-compute (traspaso antes que
    // no_relevante: los traspasos de la cuenta de uso parcial SON relevantes).
    const channel =
      hits.includes("motor") ? "motor"
      : hits.includes("transbank") ? "transbank"
      : hits.includes("traspaso") ? "traspaso"
      : hits.includes("no_relevante") ? "no_relevante"
      : hits.includes("egreso") ? "egreso"
      : hits.includes("dif_menor") ? "dif_menor"
      : hits.includes("asiento_manual") ? "asiento_manual"
      : "BRECHA";
    add(channel, m);
  }

  const total = bms.length;
  const sum = Object.values(chan).reduce((s, c) => s + c.count, 0);

  console.log("=".repeat(64));
  console.log(`AUDITORÍA DE COBERTURA — ${rangeLabel}`);
  console.log("=".repeat(64));
  console.log(`\n--- BANCO (${total} movimientos) ---`);
  for (const k of ["motor", "transbank", "traspaso", "egreso", "dif_menor", "asiento_manual", "no_relevante", "BRECHA"]) {
    const c = chan[k] ?? { count: 0, monto: 0n };
    console.log(`  ${k.padEnd(13)} ${String(c.count).padStart(5)}  $${c.monto.toString()}`);
  }
  console.log(`  ${"TOTAL".padEnd(13)} ${String(sum).padStart(5)}  ${sum === total ? "✓ cuadra" : `✗ DESCUADRE (esperado ${total})`}`);

  console.log(`\n--- SOLAPES ESPERADOS (uso parcial ∩ traspaso): ${expectedOverlap} ---`);
  console.log("  (traspasos de la cuenta de uso parcial; cuentan como traspaso, ok)");
  console.log(`\n--- CONFLICTOS REALES (solape no esperado): ${conflictsReal.length} ---`);
  if (conflictsReal.length === 0) console.log("  ✓ ninguno (sin doble conteo)");
  else conflictsReal.slice(0, 40).forEach((c) => console.log(c));

  // TESORERÍA
  const tms = await prisma.tesoreriaMovement.findMany({
    where: fromArg && toArg ? { fecha: { gte: fromArg, lt: new Date(toArg.getTime() + 86400000) } } : {},
    include: { consolidado: { select: { status: true } } },
  });
  const tByStatus: Record<string, number> = {};
  for (const t of tms) {
    const k = t.estadoActual === "ANU" ? "ANULADO(estado)" : (t.consolidado?.status ?? "UNPROCESSED");
    tByStatus[k] = (tByStatus[k] ?? 0) + 1;
  }
  console.log(`\n--- TESORERÍA (${tms.length}) por estado ---`);
  for (const [k, v] of Object.entries(tByStatus).sort()) console.log(`  ${k.padEnd(16)} ${v}`);

  // EGRESOS OPERATIVOS
  const egr = await prisma.egresoMovement.findMany({
    where: fromArg && toArg ? { fecha: { gte: fromArg, lt: new Date(toArg.getTime() + 86400000) } } : {},
    include: { conciliacion: { select: { status: true } } },
  });
  const eByStatus: Record<string, number> = {};
  for (const e of egr) {
    const k = e.conciliacion?.status ?? "SIN_CONCILIACION";
    eByStatus[k] = (eByStatus[k] ?? 0) + 1;
  }
  console.log(`\n--- EGRESOS OPERATIVOS (${egr.length}) por estado ---`);
  for (const [k, v] of Object.entries(eByStatus).sort()) console.log(`  ${k.padEnd(16)} ${v}`);

  console.log("\nListo. Revisá: BANCO debe cuadrar, CONFLICTOS debe ser 0.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
