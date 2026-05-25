/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from "../src/lib/db";
import { parseGlosa } from "../src/lib/reconciliation/glosa";

/**
 * Análisis profundo de la conciliación actual: estadísticas, errores potenciales,
 * candidatos sospechosos. Solo lectura.
 */

function fmt(n: number | bigint): string {
  return new Intl.NumberFormat("es-CL").format(Number(n));
}

function similarity(a: string, b: string): number {
  // Jaccard sobre tokens normalizados
  const norm = (s: string) =>
    s
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (A.size === 0 || B.size === 0) return 0;
  const inter = new Set([...A].filter((x) => B.has(x)));
  const uni = new Set([...A, ...B]);
  return inter.size / uni.size;
}

async function main() {
  console.log("═".repeat(70));
  console.log("ANÁLISIS DE CONCILIACIÓN — diagnóstico de calidad");
  console.log("═".repeat(70));

  // ─────────────────────────────────────────────────────────────
  // 1. Volumen general
  // ─────────────────────────────────────────────────────────────
  const totalDyn = await prisma.dynatechMovement.count();
  const totalBank = await prisma.bankMovement.count({ where: { direction: "IN" } });
  const totalRecon = await prisma.reconciliation.count();

  console.log("\n📊 VOLUMEN");
  console.log(`  Ventas Dynatech totales:        ${fmt(totalDyn)}`);
  console.log(`  Abonos bancarios (IN) totales:  ${fmt(totalBank)}`);
  console.log(`  Conciliaciones creadas:         ${fmt(totalRecon)}`);

  // ─────────────────────────────────────────────────────────────
  // 2. Distribución por estado
  // ─────────────────────────────────────────────────────────────
  const byStatus = await prisma.reconciliation.groupBy({
    by: ["status"],
    _count: true,
  });
  console.log("\n📊 DISTRIBUCIÓN POR ESTADO");
  for (const r of byStatus.sort((a, b) => b._count - a._count)) {
    const pct = ((r._count / totalRecon) * 100).toFixed(1);
    console.log(`  ${r.status.padEnd(15)} ${String(r._count).padStart(6)}  (${pct}%)`);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Distribución por matchType (solo matcheados)
  // ─────────────────────────────────────────────────────────────
  const byMatchType = await prisma.reconciliation.groupBy({
    by: ["matchType"],
    _count: true,
    where: { matchType: { not: null } },
  });
  console.log("\n📊 TIPO DE MATCH");
  for (const r of byMatchType.sort((a, b) => b._count - a._count)) {
    console.log(`  ${(r.matchType ?? "null").padEnd(20)} ${String(r._count).padStart(6)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Calidad de glosa en la base
  // ─────────────────────────────────────────────────────────────
  const allDyn = await prisma.dynatechMovement.findMany({
    select: { observation: true, customerRut: true },
  });
  const qualityCount = { EXCELLENT: 0, GOOD: 0, FAIR: 0, POOR: 0 };
  const hasBank = { yes: 0, no: 0 };
  const hasHolder = { yes: 0, no: 0 };
  const hasUnregistered = { yes: 0, no: 0 };
  const hasGenericCustomer = { yes: 0, no: 0 };

  for (const d of allDyn) {
    const g = parseGlosa(d.observation || "");
    qualityCount[g.quality]++;
    if (g.bank) hasBank.yes++;
    else hasBank.no++;
    if (g.holder) hasHolder.yes++;
    else hasHolder.no++;
    if (g.unregisteredBank) hasUnregistered.yes++;
    else hasUnregistered.no++;
    if (!d.customerRut) hasGenericCustomer.yes++;
    else hasGenericCustomer.no++;
  }
  console.log("\n📝 CALIDAD DE GLOSA DYNATECH");
  const totalG = allDyn.length;
  for (const [q, n] of Object.entries(qualityCount)) {
    const pct = ((n / totalG) * 100).toFixed(1);
    console.log(`  ${q.padEnd(10)} ${String(n).padStart(6)}  (${pct}%)`);
  }
  console.log(
    `\n  Glosa con banco identificado:    ${fmt(hasBank.yes)} / ${fmt(totalG)} ` +
      `(${((hasBank.yes / totalG) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Glosa con titular identificado:  ${fmt(hasHolder.yes)} / ${fmt(totalG)} ` +
      `(${((hasHolder.yes / totalG) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Glosa con banco NO registrado:   ${fmt(hasUnregistered.yes)}  (debería ir a OUT_OF_SCOPE)`
  );
  console.log(
    `  Cliente genérico (sin RUT):      ${fmt(hasGenericCustomer.yes)} / ${fmt(totalG)} ` +
      `(${((hasGenericCustomer.yes / totalG) * 100).toFixed(1)}%)`
  );

  // ─────────────────────────────────────────────────────────────
  // 5. Disponibilidad de counterparty en bancos
  // ─────────────────────────────────────────────────────────────
  const bankSample = await prisma.bankMovement.findMany({
    where: { direction: "IN" },
    select: { counterpartyRut: true, counterpartyName: true },
    take: 20000,
  });
  const bankWithRut = bankSample.filter((b) => b.counterpartyRut).length;
  const bankWithName = bankSample.filter((b) => b.counterpartyName).length;
  console.log("\n🏦 EVIDENCIA EN ABONOS BANCARIOS");
  console.log(
    `  Con counterpartyRut:   ${fmt(bankWithRut)} / ${fmt(bankSample.length)} ` +
      `(${((bankWithRut / bankSample.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Con counterpartyName:  ${fmt(bankWithName)} / ${fmt(bankSample.length)} ` +
      `(${((bankWithName / bankSample.length) * 100).toFixed(1)}%)`
  );

  // ─────────────────────────────────────────────────────────────
  // 6. SOSPECHOSOS: conciliaciones AUTO_MATCHED o SUGGESTED con
  //    posible contradicción de RUT o nombre
  // ─────────────────────────────────────────────────────────────
  console.log("\n🚨 BÚSQUEDA DE MATCHES SOSPECHOSOS YA CONFIRMADOS");
  console.log("   (AUTO_MATCHED / SUGGESTED / MANUAL con señales de contradicción)\n");

  const matches = await prisma.reconciliation.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "SUGGESTED", "MANUAL"] },
    },
    include: {
      dynatechMovement: {
        select: {
          customerRut: true,
          customerName: true,
          observation: true,
          totalAmount: true,
          occurredAt: true,
          branchExternalName: true,
        },
      },
      links: {
        include: {
          bankMovement: {
            select: {
              counterpartyRut: true,
              counterpartyName: true,
              description: true,
              amount: true,
              postDate: true,
              account: { select: { holderName: true, bankCode: true } },
            },
          },
        },
      },
    },
  });

  let rutContradict = 0;
  let nameMismatch = 0;
  let bothBlind = 0;
  const ejemplosRutContradict: any[] = [];
  const ejemplosNameMismatch: any[] = [];

  for (const r of matches) {
    const dyn = r.dynatechMovement;
    const links = r.links;
    if (links.length === 0) continue;

    // Sumar contradicciones por cada link
    for (const link of links) {
      const bm = link.bankMovement;
      const rutDyn = dyn.customerRut;
      const rutBank = bm.counterpartyRut;

      if (rutDyn && rutBank && rutDyn !== rutBank) {
        rutContradict++;
        if (ejemplosRutContradict.length < 8) {
          ejemplosRutContradict.push({
            status: r.status,
            matchType: r.matchType,
            dynRut: rutDyn,
            bankRut: rutBank,
            dynName: dyn.customerName,
            bankName: bm.counterpartyName,
            amount: dyn.totalAmount,
            obs: dyn.observation,
            account: bm.account.holderName + " · " + bm.account.bankCode,
          });
        }
      }

      // Nombres muy distintos cuando ambos están y los RUTs no contradicen
      if (
        dyn.customerName &&
        bm.counterpartyName &&
        (!rutDyn || !rutBank || rutDyn === rutBank)
      ) {
        const sim = similarity(dyn.customerName, bm.counterpartyName);
        if (sim < 0.15) {
          nameMismatch++;
          if (ejemplosNameMismatch.length < 8) {
            ejemplosNameMismatch.push({
              status: r.status,
              matchType: r.matchType,
              dynName: dyn.customerName,
              bankName: bm.counterpartyName,
              similarity: sim.toFixed(2),
              amount: dyn.totalAmount,
              obs: dyn.observation,
              account: bm.account.holderName + " · " + bm.account.bankCode,
            });
          }
        }
      }

      // Match a ciegas: ni RUT ni nombre comparables
      if (!rutDyn && !bm.counterpartyRut && !dyn.customerName) {
        bothBlind++;
      }
    }
  }

  console.log(`  Matches con RUTs contradictorios:  ${rutContradict}`);
  console.log(`  Matches con nombres muy distintos: ${nameMismatch}`);
  console.log(`  Matches "a ciegas" (sin RUT ni nombre identificable): ${bothBlind}`);

  if (ejemplosRutContradict.length > 0) {
    console.log("\n  ✕ Ejemplos de RUT contradictorio (top 8):");
    for (const e of ejemplosRutContradict) {
      console.log(
        `    [${e.status}/${e.matchType ?? "—"}] $${fmt(e.amount)}  Dyn: ${e.dynName} [${e.dynRut}]  ⇄  Bank: ${e.bankName} [${e.bankRut}]`
      );
      console.log(`      Cuenta: ${e.account}  ·  Glosa: "${(e.obs ?? "").substring(0, 70)}"`);
    }
  }
  if (ejemplosNameMismatch.length > 0) {
    console.log("\n  ✕ Ejemplos de nombre muy distinto sin RUT que confirme (top 8):");
    for (const e of ejemplosNameMismatch) {
      console.log(
        `    [${e.status}/${e.matchType ?? "—"}] $${fmt(e.amount)}  Dyn: "${e.dynName}"  ⇄  Bank: "${e.bankName}"  (sim ${e.similarity})`
      );
      console.log(`      Cuenta: ${e.account}  ·  Glosa: "${(e.obs ?? "").substring(0, 70)}"`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 7. Análisis de la ventana de fechas en los matches actuales
  // ─────────────────────────────────────────────────────────────
  const dayBuckets: Record<string, number> = {
    "0": 0,
    "1-2": 0,
    "3-7": 0,
    ">7": 0,
  };
  for (const r of matches) {
    for (const link of r.links) {
      const d1 = new Date(r.dynatechMovement.occurredAt);
      d1.setHours(0, 0, 0, 0);
      const d2 = new Date(link.bankMovement.postDate);
      d2.setHours(0, 0, 0, 0);
      const diff = Math.abs(Math.round((d2.getTime() - d1.getTime()) / 86400000));
      if (diff === 0) dayBuckets["0"]++;
      else if (diff <= 2) dayBuckets["1-2"]++;
      else if (diff <= 7) dayBuckets["3-7"]++;
      else dayBuckets[">7"]++;
    }
  }
  console.log("\n📅 DIFERENCIA DE DÍAS EN MATCHES ACTUALES");
  for (const [k, v] of Object.entries(dayBuckets)) {
    console.log(`  ${k.padEnd(6)} días:  ${fmt(v)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 8. Cuántas SUGGESTED tienen RUTs ausentes en banco (= match débil)
  // ─────────────────────────────────────────────────────────────
  const suggestedNoRutBank = matches.filter(
    (r) =>
      r.status === "SUGGESTED" &&
      r.links.length === 1 &&
      !r.links[0].bankMovement.counterpartyRut
  ).length;
  const suggestedWithDynRut = matches.filter(
    (r) =>
      r.status === "SUGGESTED" &&
      r.links.length === 1 &&
      r.dynatechMovement.customerRut &&
      !r.links[0].bankMovement.counterpartyRut
  ).length;
  console.log(`\n  Conciliaciones SUGGESTED con banco sin RUT:  ${fmt(suggestedNoRutBank)}`);
  console.log(`    de las cuales el Dynatech sí tenía RUT:    ${fmt(suggestedWithDynRut)}`);
  console.log(`    (oportunidad: agregar comparación de nombre)`);

  // ─────────────────────────────────────────────────────────────
  // 9. Cuántas ventas son <$10.000 vs >=$10.000 (montos comunes)
  // ─────────────────────────────────────────────────────────────
  const amounts = await prisma.dynatechMovement.findMany({
    select: { totalAmount: true },
  });
  const amountBuckets: Record<string, number> = {
    "<10k": 0,
    "10k-50k": 0,
    "50k-100k": 0,
    "100k-500k": 0,
    ">=500k": 0,
  };
  // Y "redondeados" — múltiplos exactos de $10.000 (más prone a colisiones falsas)
  let multiplos10k = 0;
  let multiplos50k = 0;
  for (const a of amounts) {
    const v = Number(a.totalAmount);
    if (v < 10_000) amountBuckets["<10k"]++;
    else if (v < 50_000) amountBuckets["10k-50k"]++;
    else if (v < 100_000) amountBuckets["50k-100k"]++;
    else if (v < 500_000) amountBuckets["100k-500k"]++;
    else amountBuckets[">=500k"]++;
    if (v > 0 && v % 10_000 === 0) multiplos10k++;
    if (v > 0 && v % 50_000 === 0) multiplos50k++;
  }
  console.log("\n💰 DISTRIBUCIÓN DE MONTOS DYNATECH");
  for (const [k, v] of Object.entries(amountBuckets)) {
    console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
  }
  console.log(`  Múltiplos exactos de $10.000:  ${fmt(multiplos10k)} (alto riesgo colisión)`);
  console.log(`  Múltiplos exactos de $50.000:  ${fmt(multiplos50k)}`);

  // ─────────────────────────────────────────────────────────────
  // 10. Ejemplo concreto: cuántos abonos hay con $100.000 en últimos 30 días
  // ─────────────────────────────────────────────────────────────
  const hace30d = new Date();
  hace30d.setDate(hace30d.getDate() - 30);
  const c100k = await prisma.bankMovement.count({
    where: { direction: "IN", amount: 100_000, postDate: { gte: hace30d } },
  });
  const v100k = await prisma.dynatechMovement.count({
    where: { totalAmount: 100_000, occurredAt: { gte: hace30d } },
  });
  console.log(
    `\n🎯 $100.000 últimos 30d:  ${fmt(v100k)} ventas vs ${fmt(c100k)} abonos bancarios`
  );
  console.log(
    `   ⇒ ratio ${(c100k / Math.max(v100k, 1)).toFixed(2)} abonos por venta — alto riesgo de match casual`
  );

  console.log("\n" + "═".repeat(70));
  console.log("Listo. Cerrando conexión.");
  console.log("═".repeat(70));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
