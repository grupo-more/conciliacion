/**
 * Diagnóstico de UN movimiento que "no se sugiere" en Egresos a terceros.
 *
 * Replica la lógica exacta del motor (match-terceros.ts) y rastrea un monto
 * por las DOS tablas que vienen de la API:
 *   - EgresoMovement   (gastos operativos /api/egresos)  → ancla de egresos a terceros
 *   - TesoreriaMovement (movimientos de caja /dynatech)   → módulo principal
 * y por todas las salidas de cartola (BankMovement OUT) que calcen el monto.
 *
 * Para cada OUT candidato dice: ¿está en el pool de egresos a terceros? y si no,
 * qué filtro lo excluyó (linkeado a Tesorería, traspaso interno, manual, uso
 * parcial). Para cada EgresoMovement en la ventana ±7d calcula el score.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/diagnose-egreso.ts 900000
 *   npx tsx scripts/diagnose-egreso.ts 900000 BIS         # filtro de texto opcional
 *
 * Pegame la salida de consola.
 */
import { PrismaClient } from "@prisma/client";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import { scoreEgresoPair } from "@/lib/egresos/match-terceros";

const prisma = new PrismaClient({ log: ["error"] });
const DATE_WINDOW_DAYS = 7;

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}
function d(x: Date): string {
  return x.toISOString().slice(0, 10);
}
function clp(n: bigint): string {
  return `$${n.toString()}`;
}

async function main() {
  const montoArg = process.argv[2];
  const textArg = (process.argv[3] || "").trim().toUpperCase();
  if (!montoArg || !/^\d+$/.test(montoArg)) {
    console.error("Uso: npx tsx scripts/diagnose-egreso.ts <monto-abs> [texto]");
    console.error("  ej: npx tsx scripts/diagnose-egreso.ts 900000 BIS");
    process.exit(1);
  }
  const target = absBig(BigInt(montoArg));
  const matchesText = (s: string | null | undefined) =>
    !textArg || (s ? s.toUpperCase().includes(textArg) : false);

  console.log("=".repeat(70));
  console.log(`DIAGNÓSTICO  monto=${clp(target)}  texto="${textArg || "(ninguno)"}"`);
  console.log("=".repeat(70));

  // ----- Universo (igual que el motor) -----
  const [allBms, entidades, manualConcs, tesoreriaLinks] = await Promise.all([
    prisma.bankMovement.findMany({
      where: { direction: { in: ["IN", "OUT"] } },
      include: { account: true },
      orderBy: { postDate: "asc" },
    }),
    loadEntidadesInternas(prisma),
    prisma.egresoConciliacion.findMany({ where: { status: "MANUAL" }, include: { links: true } }),
    prisma.consolidadoLink.findMany({ select: { bankMovementId: true } }),
  ]);

  const manualBmIds = new Set<string>();
  for (const c of manualConcs) for (const l of c.links) manualBmIds.add(l.bankMovementId);
  const tesoreriaLinked = new Set(tesoreriaLinks.map((l) => l.bankMovementId));

  const forMatch: BankMovementForMatch[] = allBms.map((bm) => ({
    id: bm.id, accountId: bm.accountId, postDate: bm.postDate, amount: bm.amount,
    direction: bm.direction, description: bm.description,
    counterpartyName: bm.counterpartyName, counterpartyRut: bm.counterpartyRut,
    account: {
      id: bm.account.id, bankName: bm.account.bankName, holderName: bm.account.holderName,
      holderRut: bm.account.holderRut, accountNumber: bm.account.accountNumber,
      displayNumber: bm.account.displayNumber,
    },
  }));
  const internalOutIds = new Set(matchMirror(forMatch, entidades).pairs.map((p) => p.out.id));

  // ----- 1) BankMovement OUT que calzan el monto -----
  const outs = allBms.filter(
    (bm) => bm.direction === "OUT" && absBig(bm.amount) === target && (matchesText(bm.counterpartyName) || matchesText(bm.description)),
  );
  console.log(`\n--- 1) CARTOLA OUT con monto ${clp(target)} : ${outs.length} ---`);
  for (const bm of outs) {
    const reasons: string[] = [];
    if (tesoreriaLinked.has(bm.id)) reasons.push("YA LINKEADO A TESORERÍA (módulo principal)");
    if (internalOutIds.has(bm.id)) reasons.push("PATA DE TRASPASO INTERNO");
    if (manualBmIds.has(bm.id)) reasons.push("usado por egreso MANUAL");
    if (isUsoParcialAccount(bm.account)) reasons.push("cuenta de USO PARCIAL (no relevante)");
    const inPool = reasons.length === 0;
    console.log(
      `\n  • ${d(bm.postDate)}  ${bm.account.bankName} ${bm.account.displayNumber ?? bm.account.accountNumber}`,
    );
    console.log(`    contraparte: ${bm.counterpartyName ?? "—"}  rut: ${bm.counterpartyRut ?? "—"}`);
    console.log(`    glosa: ${bm.description ?? "—"}`);
    console.log(`    EN POOL EGRESOS A TERCEROS: ${inPool ? "SÍ ✓" : "NO ✗ → " + reasons.join(" + ")}`);
  }
  if (outs.length === 0) console.log("  (ninguno — el monto no aparece como salida de cartola)");

  // ----- 2) EgresoMovement que calzan el monto -----
  const egresos = await prisma.egresoMovement.findMany({
    where: { monto: { in: [target, -target] } },
    include: { conciliacion: { include: { links: true } } },
    orderBy: { fecha: "asc" },
  });
  const egresosF = egresos.filter((e) => matchesText(e.glosa));
  console.log(`\n--- 2) EGRESO OPERATIVO (EgresoMovement) con monto ${clp(target)} : ${egresosF.length} ---`);
  for (const e of egresosF) {
    console.log(`\n  • ${d(e.fecha)}  glosa: ${e.glosa}`);
    console.log(`    rubro: ${e.rubroNombre ?? "—"}  estado conc.: ${e.conciliacion?.status ?? "SIN CONCILIACIÓN"}`);
    // score contra cada OUT en pool dentro de la ventana
    const lower = new Date(e.fecha.getTime() - DATE_WINDOW_DAYS * 86400000);
    const upper = new Date(e.fecha.getTime() + DATE_WINDOW_DAYS * 86400000);
    const cands = outs.filter(
      (bm) => !tesoreriaLinked.has(bm.id) && !internalOutIds.has(bm.id) && !manualBmIds.has(bm.id) &&
        !isUsoParcialAccount(bm.account) && bm.postDate >= lower && bm.postDate <= upper,
    );
    if (cands.length === 0) {
      console.log(`    sin OUT candidato en pool dentro de ±${DATE_WINDOW_DAYS}d`);
    }
    for (const bm of cands) {
      const { score, factors } = scoreEgresoPair(e, bm as Parameters<typeof scoreEgresoPair>[1]);
      const status = score >= 50 ? "AUTO_MATCHED" : score >= 30 ? "SUGGESTED" : "REVIEW (no se propone)";
      console.log(
        `    vs OUT ${d(bm.postDate)} ${bm.account.bankName}: score=${score} → ${status}  [${factors.map((f) => f.label).join(", ")}]`,
      );
    }
  }
  if (egresosF.length === 0) console.log("  (ninguno — NO existe gasto operativo por este monto)");

  // ----- 3) TesoreriaMovement que calzan el monto (módulo principal) -----
  const tms = await prisma.tesoreriaMovement.findMany({
    where: { monto: { in: [target, -target] } },
    include: { consolidado: { select: { status: true, proposalJson: true } } },
    orderBy: { fecha: "asc" },
  });
  const bmById = new Map(allBms.map((bm) => [bm.id, bm]));
  const tmsF = tms.filter((t) => matchesText(t.glosa) || matchesText(t.clienteName));
  console.log(`\n--- 3) TESORERÍA (TesoreriaMovement) con monto ${clp(target)} : ${tmsF.length} ---`);
  console.log("    (estos NO se concilian en egresos a terceros, sino en el módulo principal)");
  for (const t of tmsF) {
    console.log(`\n  • ${d(t.fecha)}  #${t.externalId}  banco: ${t.banco ?? "—"} / detectado: ${t.bancoDetectado ?? "—"}  esExcepcion=${t.esExcepcion}`);
    console.log(`    cliente: ${t.clienteName ?? "—"}  glosa: ${t.glosa}`);
    console.log(`    estado conc.: ${t.consolidado?.status ?? "SIN PROCESAR"}`);
    const propIds = (t.consolidado?.proposalJson as { bankMovementIds?: string[] } | null)?.bankMovementIds ?? [];
    for (const id of propIds) {
      const bm = bmById.get(id);
      console.log(
        bm
          ? `    → propone OUT ${d(bm.postDate)} ${bm.account.bankName} ${bm.account.displayNumber ?? bm.account.accountNumber} ${clp(absBig(bm.amount))} "${bm.counterpartyName ?? bm.description ?? ""}"`
          : `    → propone bankMovementId ${id} (fuera del universo cargado)`,
      );
    }
  }
  if (tmsF.length === 0) console.log("  (ninguno)");

  console.log("\n" + "=".repeat(70));
  console.log("LECTURA:");
  console.log("  • Si hay OUT pero NINGÚN EgresoMovement (sección 2 vacía) y SÍ");
  console.log("    Tesorería (sección 3): es CASO A → no es egreso a tercero, es");
  console.log("    un movimiento de caja; revisar cross-banco en módulo principal.");
  console.log("  • Si hay EgresoMovement pero el OUT está fuera de pool: CASO B →");
  console.log("    desbloquear el OUT (ver qué filtro lo excluyó en sección 1).");
  console.log("  • Si secciones 2 y 3 vacías: CASO C → la API no lo está enviando.");
  console.log("=".repeat(70));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
