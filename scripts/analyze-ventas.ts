/**
 * Análisis enfocado: solo "Ventas" de Dynatech vs abonos en cartolas.
 *
 * Hipótesis: las "Compras de X" son egresos de CLP (la empresa paga al cliente
 * y deposita la moneda extranjera en otra cuenta) → no van a aparecer en
 * cartola CLP. Solo las "Ventas de X" generan ingreso CLP en banco.
 */
import { prisma } from "../src/lib/db";

const fmt = (n: number | bigint) =>
  Number(n).toLocaleString("es-CL", { maximumFractionDigits: 0 });

const pct = (part: number, total: number) =>
  total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`;

async function main() {
  console.log("=".repeat(90));
  console.log("ANÁLISIS ENFOCADO: VENTAS DYNATECH vs ABONOS BANCO");
  console.log("=".repeat(90));

  // ----------------------------- 1. Total Dynatech segregado por tipo de item
  const split = await prisma.$queryRaw<
    Array<{ tipo: string; n: bigint; suma: bigint }>
  >`
    SELECT
      CASE
        WHEN (items->0->>'nombre') ILIKE 'Venta%'  THEN 'VENTA (ingreso CLP)'
        WHEN (items->0->>'nombre') ILIKE 'Compra%' THEN 'COMPRA (egreso CLP)'
        ELSE 'OTRO'
      END AS tipo,
      COUNT(*)::bigint AS n,
      SUM(total_amount)::bigint AS suma
    FROM "DynatechMovement"
    GROUP BY tipo
    ORDER BY n DESC
  `;
  for (const r of split) {
    console.log(`  ${r.tipo.padEnd(25)} ${fmt(r.n).padStart(3)} movs  Σ ${fmt(r.suma).padStart(18)}`);
  }

  const ventasTotal = Number(split.find((s) => s.tipo.startsWith("VENTA"))?.n ?? 0);

  // -------------- 2. Match VENTAS Dynatech vs abonos cartolas (ventana 0/±2/±7)
  console.log("\n" + "-".repeat(90));
  console.log(`MATCH DE VENTAS (${ventasTotal} movs) → ABONOS BANCO POR MONTO EXACTO`);
  console.log("-".repeat(90));

  const matchStats = await prisma.$queryRaw<
    Array<{
      same_day: bigint;
      pm2: bigint;
      pm7: bigint;
      none: bigint;
    }>
  >`
    WITH dyn AS (
      SELECT id, total_amount, occurred_at::date AS d
      FROM "DynatechMovement"
      WHERE (items->0->>'nombre') ILIKE 'Venta%'
    ),
    counts AS (
      SELECT
        dyn.id,
        SUM(CASE WHEN bm.post_date::date = dyn.d THEN 1 ELSE 0 END) AS same,
        SUM(CASE WHEN ABS(bm.post_date::date - dyn.d) <= 2 THEN 1 ELSE 0 END) AS pm2,
        SUM(CASE WHEN ABS(bm.post_date::date - dyn.d) <= 7 THEN 1 ELSE 0 END) AS pm7
      FROM dyn
      LEFT JOIN "BankMovement" bm
        ON bm.amount = dyn.total_amount
       AND bm.direction = 'IN'
       AND ABS(bm.post_date::date - dyn.d) <= 7
      GROUP BY dyn.id
    )
    SELECT
      SUM(CASE WHEN same > 0 THEN 1 ELSE 0 END)::bigint AS same_day,
      SUM(CASE WHEN same = 0 AND pm2 > 0 THEN 1 ELSE 0 END)::bigint AS pm2,
      SUM(CASE WHEN pm2 = 0 AND pm7 > 0 THEN 1 ELSE 0 END)::bigint AS pm7,
      SUM(CASE WHEN pm7 = 0 THEN 1 ELSE 0 END)::bigint AS none
    FROM counts
  `;
  const ms = matchStats[0];
  console.log(`  Mismo día:                    ${fmt(ms.same_day).padStart(3)} (${pct(Number(ms.same_day), ventasTotal)})`);
  console.log(`  ±2 días (no mismo día):       ${fmt(ms.pm2).padStart(3)} (${pct(Number(ms.pm2), ventasTotal)})`);
  console.log(`  ±7 días (no ±2):              ${fmt(ms.pm7).padStart(3)} (${pct(Number(ms.pm7), ventasTotal)})`);
  console.log(`  SIN MATCH (±7 días):          ${fmt(ms.none).padStart(3)} (${pct(Number(ms.none), ventasTotal)})`);

  const totalConMatch =
    Number(ms.same_day) + Number(ms.pm2) + Number(ms.pm7);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  TOTAL CON MATCH (≤±7 días):   ${fmt(totalConMatch).padStart(3)} (${pct(totalConMatch, ventasTotal)}) ✓`);

  // ------------------------- 3. Distribución de candidatos por venta
  console.log("\n" + "-".repeat(90));
  console.log("CANDIDATOS POR VENTA (mismo día, monto exacto)");
  console.log("-".repeat(90));

  const candDist = await prisma.$queryRaw<
    Array<{ candidates: bigint; n: bigint }>
  >`
    WITH dyn AS (
      SELECT id, total_amount, occurred_at::date AS d
      FROM "DynatechMovement"
      WHERE (items->0->>'nombre') ILIKE 'Venta%'
    ),
    counts AS (
      SELECT dyn.id, COUNT(bm.id) AS cands
      FROM dyn
      LEFT JOIN "BankMovement" bm
        ON bm.amount = dyn.total_amount
       AND bm.direction = 'IN'
       AND bm.post_date::date = dyn.d
      GROUP BY dyn.id
    )
    SELECT cands::bigint AS candidates, COUNT(*)::bigint AS n
    FROM counts GROUP BY cands ORDER BY cands
  `;
  for (const r of candDist) {
    const c = Number(r.candidates);
    const label = c === 0 ? "Ninguno" : c === 1 ? "ÚNICO ✓" : "AMBIG";
    console.log(`  ${String(c).padStart(2)} candidato(s)  → ${fmt(r.n).padStart(3)} ventas  (${label})`);
  }

  // ------------------------- 4. Detalle de los SIN match con su sucursal/banco
  console.log("\n" + "-".repeat(90));
  console.log("VENTAS SIN MATCH — para entender por qué");
  console.log("-".repeat(90));

  const sinMatch = await prisma.$queryRaw<
    Array<{
      d: Date;
      branch: string | null;
      obs: string;
      total: bigint;
      banco_obs: string;
    }>
  >`
    WITH dyn AS (
      SELECT id, total_amount, occurred_at::date AS d, branch_external_name, observation,
             CASE
               WHEN observation ILIKE '%BCI%' THEN 'BCI ✓'
               WHEN observation ILIKE '%SANTANDER%' OR observation ILIKE '%SANTNADER%' OR observation ILIKE '%SANTADNER%' THEN 'SANTANDER ✓'
               WHEN observation ILIKE '%INTERNACIONAL%' THEN 'INTERNACIONAL ✓'
               WHEN observation ILIKE '%BICE%' THEN 'BICE ✗ (no registrado)'
               WHEN observation ILIKE '%ITAU%' THEN 'ITAU ✗ (no registrado)'
               WHEN observation ILIKE '%CHILE%' THEN 'CHILE ✗ (no registrado)'
               WHEN observation ILIKE '%FALABELLA%' THEN 'FALABELLA ✗'
               ELSE '— (sin pista)'
             END AS banco_obs
      FROM "DynatechMovement"
      WHERE (items->0->>'nombre') ILIKE 'Venta%'
    )
    SELECT dyn.d, dyn.branch_external_name AS branch, dyn.observation AS obs,
           dyn.total_amount AS total, dyn.banco_obs
    FROM dyn
    LEFT JOIN "BankMovement" bm
      ON bm.amount = dyn.total_amount
     AND bm.direction = 'IN'
     AND ABS(bm.post_date::date - dyn.d) <= 7
    WHERE bm.id IS NULL
    ORDER BY dyn.d DESC
    LIMIT 20
  `;
  console.log("Fecha      | Sucursal      | $ Total       | Banco obs                    | Obs");
  for (const r of sinMatch) {
    const branch = (r.branch ?? "—").slice(0, 13).padEnd(13);
    const total = fmt(r.total).padStart(12);
    const banco = r.banco_obs.padEnd(28);
    const obs = r.obs.slice(0, 35);
    console.log(`${r.d.toISOString().slice(0, 10)} | ${branch} | ${total} | ${banco} | ${obs}`);
  }

  // ------------------------- 5. ¿Sucursal tiene "banco preferido" implícito?
  console.log("\n" + "-".repeat(90));
  console.log("SUCURSAL → DISTRIBUCIÓN DE BANCOS MENCIONADOS (Ventas)");
  console.log("-".repeat(90));

  const branchToBank = await prisma.$queryRaw<
    Array<{
      branch: string | null;
      banco: string;
      n: bigint;
    }>
  >`
    SELECT
      branch_external_name AS branch,
      CASE
        WHEN observation ILIKE '%BCI%' THEN 'BCI'
        WHEN observation ILIKE '%SANTANDER%' OR observation ILIKE '%SANTNADER%' OR observation ILIKE '%SANTADNER%' THEN 'SANTANDER'
        WHEN observation ILIKE '%INTERNACIONAL%' THEN 'INTERNACIONAL'
        WHEN observation ILIKE '%BICE%' THEN 'BICE'
        WHEN observation ILIKE '%ITAU%' THEN 'ITAU'
        WHEN observation ILIKE '%CHILE%' THEN 'CHILE'
        ELSE '(no menciona)'
      END AS banco,
      COUNT(*)::bigint AS n
    FROM "DynatechMovement"
    WHERE (items->0->>'nombre') ILIKE 'Venta%'
    GROUP BY branch_external_name, banco
    ORDER BY branch_external_name, n DESC
  `;
  let curBranch: string | null | undefined = undefined;
  for (const r of branchToBank) {
    if (r.branch !== curBranch) {
      console.log(`\n  ${r.branch ?? "(sin sucursal)"}:`);
      curBranch = r.branch;
    }
    console.log(`     ${r.banco.padEnd(18)} ${fmt(r.n).padStart(3)}`);
  }

  console.log("\n" + "=".repeat(90));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
