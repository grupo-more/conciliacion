import { prisma } from "../src/lib/db";
import { computeScore, computeHistoryPatterns } from "../src/lib/reconciliation/score";
import { parseGlosa } from "../src/lib/reconciliation/glosa";

async function main() {
  const patterns = await computeHistoryPatterns();

  // Caso Guido: $1.166.000
  const guido = await prisma.dynatechMovement.findFirst({
    where: { totalAmount: 1_166_000n, customerRut: "16201411-0" },
  });
  if (!guido) {
    console.log("Guido no encontrado");
    return;
  }

  console.log("Guido Dyn:");
  console.log("  occurredAt:", guido.occurredAt.toISOString(), "(", guido.occurredAt.getTime(), ")");

  // Buscar candidato exacto
  const cands = await prisma.bankMovement.findMany({
    where: { direction: "IN", amount: 1_166_000n },
    include: { account: true },
    take: 5,
  });
  console.log(`\nCandidatos por monto exacto: ${cands.length}`);
  for (const c of cands) {
    console.log("\nCandidato:");
    console.log("  postDate:       ", c.postDate.toISOString(), "(", c.postDate.getTime(), ")");
    console.log("  transactionDate:", c.transactionDate?.toISOString() ?? "null");
    console.log("  counterpartyName:", c.counterpartyName);
    console.log("  counterpartyRut:", c.counterpartyRut);
    console.log("  account:", c.account.holderName, c.account.bankCode);

    const glosa = parseGlosa(guido.observation || "");
    console.log("\n  Glosa parsed:", glosa);

    const score = computeScore({
      dyn: guido,
      bank: c,
      accountBankCode: c.account.bankCode,
      glosa,
      patterns,
    });

    console.log(`\n  Score total: ${score.total}`);
    console.log(`  Status sugerido: ${score.suggestedStatus}`);
    console.log(`  Hard contradiction: ${score.hardContradiction ?? "no"}`);
    console.log(`  Factores:`);
    for (const f of score.factors) {
      console.log(`    ${f.weight >= 0 ? "+" : ""}${f.weight}  ${f.label} ${f.detail ? `(${f.detail})` : ""}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
