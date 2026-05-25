import { prisma } from "../src/lib/db";
import { parseGlosa } from "../src/lib/reconciliation/glosa";

function isVenta(items: unknown): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.some(
    (it) =>
      typeof it === "object" &&
      it !== null &&
      typeof (it as { nombre?: unknown }).nombre === "string" &&
      ((it as { nombre: string }).nombre).toLowerCase().startsWith("venta")
  );
}

async function main() {
  const all = await prisma.dynatechMovement.findMany({
    select: {
      id: true,
      observation: true,
      totalAmount: true,
      items: true,
      reconciliation: { select: { status: true } },
    },
  });

  let ventasUnreg = 0;
  let noVentaUnreg = 0;
  const ejemplosVentaUnreg: Array<{ obs: string; amount: bigint; status: string | null }> = [];

  for (const m of all) {
    const g = parseGlosa(m.observation || "");
    if (!g.unregisteredBank) continue;
    if (g.bank) continue; // ya filtrado el caso conflicto, no aplica

    const esVenta = isVenta(m.items);
    if (esVenta) {
      ventasUnreg++;
      if (ejemplosVentaUnreg.length < 20) {
        ejemplosVentaUnreg.push({
          obs: m.observation,
          amount: m.totalAmount,
          status: m.reconciliation?.status ?? null,
        });
      }
    } else {
      noVentaUnreg++;
    }
  }

  console.log(`Total con banco no registrado en glosa: ${ventasUnreg + noVentaUnreg}`);
  console.log(`  Son VENTAS reales:     ${ventasUnreg}  (deberían ir a OUT_OF_SCOPE)`);
  console.log(`  NO son ventas (cargas/mutilados/internos): ${noVentaUnreg}  (correctamente excluidos)`);

  if (ejemplosVentaUnreg.length > 0) {
    console.log("\nVentas con banco no registrado en glosa — estado actual:");
    for (const e of ejemplosVentaUnreg) {
      console.log(`  [${(e.status ?? "—").padEnd(15)}] $${e.amount.toString().padStart(10)}  "${e.obs.substring(0, 70)}"`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
