import { prisma } from "../src/lib/db";
import { runMatching } from "../src/lib/reconciliation/match";

function fmt(n: number | bigint): string {
  return new Intl.NumberFormat("es-CL").format(Number(n));
}

async function snapshot(label: string) {
  const byStatus = await prisma.reconciliation.groupBy({
    by: ["status"],
    _count: true,
  });
  const total = byStatus.reduce((acc, r) => acc + r._count, 0);
  console.log(`\n${label}  (total ${fmt(total)}):`);
  for (const r of byStatus.sort((a, b) => b._count - a._count)) {
    const pct = ((r._count / total) * 100).toFixed(1);
    console.log(`  ${r.status.padEnd(15)} ${String(r._count).padStart(6)}  (${pct}%)`);
  }
  return byStatus.reduce((acc, r) => {
    acc[r.status] = r._count;
    return acc;
  }, {} as Record<string, number>);
}

async function main() {
  console.log("═".repeat(60));
  console.log("Estado ANTES del re-procesamiento");
  console.log("═".repeat(60));
  const before = await snapshot("Antes");

  console.log("\n🔄 Ejecutando runMatching con las nuevas reglas…\n");
  const result = await runMatching({ reEvaluateOpenStates: true });
  console.log(`  Procesados:    ${result.processed}`);
  console.log(`  AUTO_MATCHED:  ${result.autoMatched}`);
  console.log(`  SUGGESTED:     ${result.suggested}`);
  console.log(`  REVIEW:        ${result.review}`);
  console.log(`  NO_MATCH:      ${result.noMatch}`);
  console.log(`  OUT_OF_SCOPE:  ${result.outOfScope}`);
  console.log(`  Errores:       ${result.errors}`);

  console.log("\n═".repeat(60));
  console.log("Estado DESPUÉS del re-procesamiento");
  console.log("═".repeat(60));
  const after = await snapshot("Después");

  console.log("\n═".repeat(60));
  console.log("DELTA");
  console.log("═".repeat(60));
  const allStates = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const s of allStates) {
    const b = before[s] ?? 0;
    const a = after[s] ?? 0;
    const d = a - b;
    const sign = d > 0 ? "+" : "";
    console.log(`  ${s.padEnd(15)} ${String(b).padStart(4)} → ${String(a).padStart(4)}  (${sign}${d})`);
  }

  // Casos clave: ¿el caso Sujela quedó bien?
  const sujela = await prisma.dynatechMovement.findFirst({
    where: { totalAmount: 100_000n, customerRut: "26325658-1" },
    include: { reconciliation: { select: { status: true, notes: true } } },
  });
  if (sujela) {
    console.log(`\n🎯 Caso Sujela ($100.000):`);
    console.log(`   Estado: ${sujela.reconciliation?.status}`);
    console.log(`   Notas: ${sujela.reconciliation?.notes ?? "—"}`);
  }

  // Casos del análisis: los 4 que tenían candidato exacto
  console.log(`\n🎯 Casos que antes eran NO_MATCH con candidato exacto disponible:`);
  const guido = await prisma.dynatechMovement.findFirst({
    where: { totalAmount: 1_166_000n, customerRut: "16201411-0" },
    include: { reconciliation: { select: { status: true, matchType: true, notes: true } } },
  });
  if (guido)
    console.log(
      `   Guido Andaur $1.166.000: ${guido.reconciliation?.status} / ${guido.reconciliation?.matchType ?? "—"}  ${guido.reconciliation?.notes ? `· ${guido.reconciliation.notes}` : ""}`
    );

  const nancy = await prisma.dynatechMovement.findFirst({
    where: { totalAmount: 1_001_000n, customerRut: "13907874-8" },
    include: { reconciliation: { select: { status: true, matchType: true, notes: true } } },
  });
  if (nancy)
    console.log(
      `   Nancy Calfuman $1.001.000: ${nancy.reconciliation?.status} / ${nancy.reconciliation?.matchType ?? "—"}  ${nancy.reconciliation?.notes ? `· ${nancy.reconciliation.notes}` : ""}`
    );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
