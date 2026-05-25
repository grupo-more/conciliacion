/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from "../src/lib/db";
import { parseGlosa } from "../src/lib/reconciliation/glosa";

function fmt(n: number | bigint): string {
  return new Intl.NumberFormat("es-CL").format(Number(n));
}

async function main() {
  console.log("═".repeat(70));
  console.log("¿POR QUÉ HAY TANTOS NO_MATCH?");
  console.log("═".repeat(70));

  const noMatch = await prisma.reconciliation.findMany({
    where: { status: "NO_MATCH" },
    include: {
      dynatechMovement: {
        select: {
          totalAmount: true,
          observation: true,
          customerRut: true,
          customerName: true,
          occurredAt: true,
          branchExternalId: true,
          branchExternalName: true,
        },
      },
    },
  });

  console.log(`\nTotal NO_MATCH: ${noMatch.length}`);

  // ¿Cuántas tienen banco no registrado en glosa?
  let outOfScope = 0;
  let glosaBank = 0;
  let glosaHolder = 0;
  let glosaPoor = 0;
  let withDynRut = 0;

  // Para cada NO_MATCH, ver cuántos abonos bancarios hubo en ±7 días con monto exacto
  let withMatchingAmount = 0;
  let withMatchingAmountAndRut = 0;
  const ejemplosConCandidato: any[] = [];

  for (const r of noMatch) {
    const d = r.dynatechMovement;
    const g = parseGlosa(d.observation || "");
    if (g.unregisteredBank) outOfScope++;
    if (g.bank) glosaBank++;
    if (g.holder) glosaHolder++;
    if (g.quality === "POOR") glosaPoor++;
    if (d.customerRut) withDynRut++;

    // Verificar si había candidato real con monto exacto en ±7d
    const occDate = new Date(d.occurredAt);
    occDate.setHours(0, 0, 0, 0);
    const from = new Date(occDate);
    from.setDate(from.getDate() - 7);
    const to = new Date(occDate);
    to.setDate(to.getDate() + 8);

    const candidatos = await prisma.bankMovement.findMany({
      where: {
        direction: "IN",
        postDate: { gte: from, lt: to },
        amount: d.totalAmount,
        reconciliationLinks: { none: {} },
      },
      select: {
        amount: true,
        postDate: true,
        counterpartyRut: true,
        counterpartyName: true,
        description: true,
        account: { select: { holderName: true, bankCode: true } },
      },
    });

    if (candidatos.length > 0) {
      withMatchingAmount++;
      const rutMatch = candidatos.find((c) => c.counterpartyRut === d.customerRut);
      if (rutMatch) withMatchingAmountAndRut++;

      if (ejemplosConCandidato.length < 8) {
        ejemplosConCandidato.push({
          dynAmount: d.totalAmount,
          dynRut: d.customerRut,
          dynName: d.customerName,
          obs: d.observation,
          candidatos: candidatos.length,
          primero: candidatos[0],
        });
      }
    }
  }

  console.log(`\nDesglose causas:`);
  console.log(`  Glosa menciona banco NO registrado:  ${outOfScope}  (deberían ser OUT_OF_SCOPE)`);
  console.log(`  Glosa identifica banco registrado:   ${glosaBank}`);
  console.log(`  Glosa identifica titular:            ${glosaHolder}`);
  console.log(`  Glosa POOR (sin info útil):          ${glosaPoor}`);
  console.log(`  Tienen RUT cliente identificado:     ${withDynRut}`);
  console.log("");
  console.log(`  Con candidato exacto en ±7d (no se matchearon): ${withMatchingAmount}`);
  console.log(`    de los cuales con RUT coincidente:            ${withMatchingAmountAndRut}`);

  if (ejemplosConCandidato.length > 0) {
    console.log(
      `\n  Ejemplos de NO_MATCH que SÍ tenían candidato exacto disponible:`
    );
    for (const e of ejemplosConCandidato) {
      console.log(
        `\n    $${fmt(e.dynAmount)}  Dyn: "${e.dynName ?? "—"}" [${e.dynRut ?? "—"}]`
      );
      console.log(`      Obs: "${(e.obs ?? "").substring(0, 80)}"`);
      console.log(
        `      Candidato: $${fmt(e.primero.amount)} ${e.primero.postDate.toISOString().substring(0, 10)} · ${e.primero.account.holderName} · ${e.primero.account.bankCode}`
      );
      console.log(
        `        Contraparte: "${e.primero.counterpartyName ?? "—"}" [${e.primero.counterpartyRut ?? "—"}]`
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Caso específico del usuario: $100.000 Sujela Al Achkar 02-05-2026
  // ────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("CASO ESPECÍFICO: $100.000 SUJELA AL ACHKAR (mCjObs NRO.12932)");
  console.log("═".repeat(70));

  const caso = await prisma.dynatechMovement.findFirst({
    where: {
      totalAmount: 100_000n,
      customerRut: "26325658-1",
    },
    include: {
      reconciliation: {
        include: {
          links: {
            include: {
              bankMovement: {
                select: {
                  amount: true,
                  postDate: true,
                  counterpartyName: true,
                  counterpartyRut: true,
                  description: true,
                  account: { select: { holderName: true, bankCode: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (caso) {
    console.log(`\nVenta Dynatech:`);
    console.log(`  Fecha: ${caso.occurredAt.toISOString()}`);
    console.log(`  Monto: $${fmt(caso.totalAmount)}`);
    console.log(`  Cliente: ${caso.customerName} [${caso.customerRut}]`);
    console.log(`  Sucursal: ${caso.branchExternalName}`);
    console.log(`  Glosa: "${caso.observation}"`);
    console.log(`  Estado actual: ${caso.reconciliation?.status} / ${caso.reconciliation?.matchType ?? "—"}`);
    console.log(`  Notas: ${caso.reconciliation?.notes ?? "—"}`);

    const occ = new Date(caso.occurredAt);
    occ.setHours(0, 0, 0, 0);
    const from = new Date(occ);
    from.setDate(from.getDate() - 7);
    const to = new Date(occ);
    to.setDate(to.getDate() + 8);

    // Todos los candidatos posibles (mismo criterio que findCandidates):
    // amount <= totalAmount, en ±7d
    const todos = await prisma.bankMovement.findMany({
      where: {
        direction: "IN",
        postDate: { gte: from, lt: to },
        amount: { lte: caso.totalAmount },
      },
      select: {
        amount: true,
        postDate: true,
        counterpartyName: true,
        counterpartyRut: true,
        description: true,
        account: { select: { holderName: true, bankCode: true } },
      },
      orderBy: { postDate: "asc" },
    });

    console.log(`\nCandidatos que el modal muestra (regla actual: amount <= total): ${todos.length}`);
    for (const c of todos.slice(0, 15)) {
      const eq = c.amount === caso.totalAmount ? "✓EXACTO" : "       ";
      console.log(
        `  ${eq}  $${fmt(c.amount).padStart(9)} ${c.postDate.toISOString().substring(0, 10)} · ${c.account.bankCode.padEnd(13)} · ${(c.counterpartyName ?? "—").substring(0, 28).padEnd(28)} [${c.counterpartyRut ?? "—"}]`
      );
    }

    // ¿Cuántos serían si filtramos a amount = total?
    const exactos = todos.filter((c) => c.amount === caso.totalAmount);
    console.log(`\n  Si filtráramos a monto EXACTO solamente: ${exactos.length} candidatos`);
    console.log(`  Si además filtráramos por RUT del cliente: ${exactos.filter((c) => c.counterpartyRut === caso.customerRut).length}`);
  } else {
    console.log("\n  No se encontró el caso. Quizá ya cambió de estado.");
  }

  // ────────────────────────────────────────────────────────────────
  // ¿Cuántos AUTO_MATCHED se hicieron a ciegas?
  // ────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("AUDITORÍA DE LOS 12 AUTO_MATCHED");
  console.log("═".repeat(70));

  const autos = await prisma.reconciliation.findMany({
    where: { status: "AUTO_MATCHED" },
    include: {
      dynatechMovement: {
        select: {
          totalAmount: true,
          observation: true,
          customerRut: true,
          customerName: true,
          occurredAt: true,
        },
      },
      links: {
        include: {
          bankMovement: {
            select: {
              amount: true,
              postDate: true,
              counterpartyRut: true,
              counterpartyName: true,
              description: true,
              account: { select: { holderName: true, bankCode: true } },
            },
          },
        },
      },
    },
  });

  for (const r of autos) {
    const dyn = r.dynatechMovement;
    const link = r.links[0];
    if (!link) continue;
    const bm = link.bankMovement;
    const rutMatch =
      dyn.customerRut && bm.counterpartyRut && dyn.customerRut === bm.counterpartyRut;
    const rutDisp = rutMatch ? "✓RUT" : "    ";

    console.log(
      `\n  [${r.matchType ?? "—"}] ${rutDisp} $${fmt(dyn.totalAmount)} ` +
        `${dyn.occurredAt.toISOString().substring(0, 10)} → ${bm.postDate.toISOString().substring(0, 10)}`
    );
    console.log(
      `    Dyn:  ${dyn.customerName ?? "(genérico)"} [${dyn.customerRut ?? "—"}]`
    );
    console.log(
      `    Bank: ${bm.counterpartyName ?? "—"} [${bm.counterpartyRut ?? "—"}] · ${bm.account.holderName} · ${bm.account.bankCode}`
    );
    console.log(`    Obs:  "${(dyn.observation ?? "").substring(0, 70)}"`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
