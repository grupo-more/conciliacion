/**
 * Análisis exploratorio para diseñar las reglas de conciliación.
 *
 * Cruza los movimientos de cartolas (BankMovement) contra los movimientos de
 * Dynatech (DynatechMovement) y reporta:
 *  - Estadísticas básicas por lado
 *  - Cuántos Dynatech encuentran match exacto de monto en banco (mismo día / ±1d / ±3d)
 *  - Patrones recurrentes en mCjObs (sucursal/banco mencionado)
 *  - Patrones recurrentes en glosa bancaria (folios, "More Giros NNN")
 *  - Recomendaciones de reglas de matching
 */
import { prisma } from "../src/lib/db";

const fmt = (n: number | bigint) =>
  Number(n).toLocaleString("es-CL", { maximumFractionDigits: 0 });

function pct(part: number, total: number): string {
  if (total === 0) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  console.log("=".repeat(90));
  console.log("ANÁLISIS DE CONCILIACIÓN");
  console.log("=".repeat(90));

  // ---------------------------------------------------------------- 1. Conteos
  const totalBank = await prisma.bankMovement.count();
  const totalDyn = await prisma.dynatechMovement.count();
  console.log(`\nTotal BankMovement:     ${fmt(totalBank)}`);
  console.log(`Total DynatechMovement: ${fmt(totalDyn)}`);

  // ---------------------------------------------------------- 2. Bancos / cuentas
  console.log("\n" + "-".repeat(90));
  console.log("DISTRIBUCIÓN DE BANK MOVEMENTS POR CUENTA");
  console.log("-".repeat(90));

  const byAccount = await prisma.$queryRaw<
    Array<{
      bank_code: string;
      holder_name: string;
      account_number: string;
      n: bigint;
      abonos: bigint;
      cargos: bigint;
      sum_in: bigint;
      sum_out: bigint;
    }>
  >`
    SELECT ba.bank_code, ba.holder_name, ba.account_number,
           COUNT(*)::bigint AS n,
           SUM(CASE WHEN bm.direction='IN' THEN 1 ELSE 0 END)::bigint AS abonos,
           SUM(CASE WHEN bm.direction='OUT' THEN 1 ELSE 0 END)::bigint AS cargos,
           COALESCE(SUM(CASE WHEN bm.direction='IN' THEN bm.amount ELSE 0 END),0)::bigint AS sum_in,
           COALESCE(SUM(CASE WHEN bm.direction='OUT' THEN ABS(bm.amount) ELSE 0 END),0)::bigint AS sum_out
    FROM "BankMovement" bm
    JOIN "BankAccount" ba ON bm.account_id = ba.id
    GROUP BY ba.bank_code, ba.holder_name, ba.account_number
    ORDER BY ba.bank_code, ba.holder_name
  `;
  console.log(
    "Banco         | Empresa     | Cuenta      | Movs |   Abonos |    Cargos | Σ Abonos        | Σ Cargos"
  );
  for (const r of byAccount) {
    console.log(
      `${r.bank_code.padEnd(13)} | ${r.holder_name.padEnd(11).slice(0, 11)} | ${r.account_number.padEnd(11).slice(0, 11)} | ${fmt(r.n).padStart(4)} | ${fmt(r.abonos).padStart(8)} | ${fmt(r.cargos).padStart(9)} | ${fmt(r.sum_in).padStart(15)} | ${fmt(r.sum_out).padStart(15)}`
    );
  }

  // ----------------------------------------------------- 3. Dynatech por sucursal
  console.log("\n" + "-".repeat(90));
  console.log("DISTRIBUCIÓN DE DYNATECH POR SUCURSAL");
  console.log("-".repeat(90));

  const byBranch = await prisma.$queryRaw<
    Array<{
      branch_external_id: number;
      branch_external_name: string | null;
      n: bigint;
      total: bigint;
      compras: bigint;
      ventas: bigint;
    }>
  >`
    SELECT branch_external_id,
           branch_external_name,
           COUNT(*)::bigint AS n,
           SUM(total_amount)::bigint AS total,
           SUM(CASE WHEN (items->0->>'nombre') ILIKE 'Compra%' THEN 1 ELSE 0 END)::bigint AS compras,
           SUM(CASE WHEN (items->0->>'nombre') ILIKE 'Venta%' THEN 1 ELSE 0 END)::bigint AS ventas
    FROM "DynatechMovement"
    GROUP BY branch_external_id, branch_external_name
    ORDER BY branch_external_id
  `;
  console.log("Sucursal              | Movs | Compras | Ventas | Σ Total");
  for (const r of byBranch) {
    console.log(
      `${(r.branch_external_name ?? `#${r.branch_external_id}`).padEnd(21).slice(0, 21)} | ${fmt(r.n).padStart(4)} | ${fmt(r.compras).padStart(7)} | ${fmt(r.ventas).padStart(6)} | ${fmt(r.total).padStart(15)}`
    );
  }

  // ---------------------------------------- 4. Match por monto exacto + fecha
  console.log("\n" + "-".repeat(90));
  console.log("MATCH POR MONTO EXACTO (DYNATECH → BANK ABONO)");
  console.log("-".repeat(90));

  // Para cada Dynatech, contar movs banco con mismo monto en ventanas de fecha
  const matchStats = await prisma.$queryRaw<
    Array<{
      same_day: bigint;
      pm1: bigint;
      pm3: bigint;
      pm7: bigint;
      none: bigint;
      total: bigint;
    }>
  >`
    WITH dyn AS (SELECT id, total_amount, occurred_at::date AS d FROM "DynatechMovement"),
    matches AS (
      SELECT
        dyn.id,
        SUM(CASE WHEN bm.post_date::date = dyn.d THEN 1 ELSE 0 END) AS m_same_day,
        SUM(CASE WHEN ABS(bm.post_date::date - dyn.d) <= 1 THEN 1 ELSE 0 END) AS m_pm1,
        SUM(CASE WHEN ABS(bm.post_date::date - dyn.d) <= 3 THEN 1 ELSE 0 END) AS m_pm3,
        SUM(CASE WHEN ABS(bm.post_date::date - dyn.d) <= 7 THEN 1 ELSE 0 END) AS m_pm7
      FROM dyn
      LEFT JOIN "BankMovement" bm
        ON bm.amount = dyn.total_amount
       AND bm.direction = 'IN'
       AND ABS(bm.post_date::date - dyn.d) <= 7
      GROUP BY dyn.id, dyn.d
    )
    SELECT
      SUM(CASE WHEN m_same_day > 0 THEN 1 ELSE 0 END)::bigint AS same_day,
      SUM(CASE WHEN m_same_day = 0 AND m_pm1 > 0 THEN 1 ELSE 0 END)::bigint AS pm1,
      SUM(CASE WHEN m_pm1 = 0 AND m_pm3 > 0 THEN 1 ELSE 0 END)::bigint AS pm3,
      SUM(CASE WHEN m_pm3 = 0 AND m_pm7 > 0 THEN 1 ELSE 0 END)::bigint AS pm7,
      SUM(CASE WHEN m_pm7 = 0 THEN 1 ELSE 0 END)::bigint AS none,
      COUNT(*)::bigint AS total
    FROM matches
  `;
  const ms = matchStats[0];
  const total = Number(ms.total);
  console.log(`Total Dynatech analizados: ${fmt(total)}`);
  console.log(`  Match mismo día:             ${fmt(ms.same_day).padStart(4)} (${pct(Number(ms.same_day), total)})`);
  console.log(`  Match ±1 día:                ${fmt(ms.pm1).padStart(4)} (${pct(Number(ms.pm1), total)})`);
  console.log(`  Match ±3 días:               ${fmt(ms.pm3).padStart(4)} (${pct(Number(ms.pm3), total)})`);
  console.log(`  Match ±7 días:               ${fmt(ms.pm7).padStart(4)} (${pct(Number(ms.pm7), total)})`);
  console.log(`  Sin match (±7 días):         ${fmt(ms.none).padStart(4)} (${pct(Number(ms.none), total)})`);

  // ------------------------- 5. Distribución de # candidatos por Dynatech
  console.log("\n" + "-".repeat(90));
  console.log("¿CUÁN ÚNICO ES EL MATCH? (# candidatos por Dynatech, mismo día, monto exacto)");
  console.log("-".repeat(90));

  const candDist = await prisma.$queryRaw<
    Array<{ candidates: bigint; n: bigint }>
  >`
    WITH dyn AS (SELECT id, total_amount, occurred_at::date AS d FROM "DynatechMovement"),
    counts AS (
      SELECT dyn.id,
             COUNT(bm.id) AS cands
      FROM dyn
      LEFT JOIN "BankMovement" bm
        ON bm.amount = dyn.total_amount
       AND bm.direction = 'IN'
       AND bm.post_date::date = dyn.d
      GROUP BY dyn.id
    )
    SELECT cands::bigint AS candidates, COUNT(*)::bigint AS n
    FROM counts
    GROUP BY cands
    ORDER BY cands
  `;
  console.log("# candidatos | Dynatech");
  for (const r of candDist) {
    const c = Number(r.candidates);
    const label = c === 0 ? "Ninguno" : c === 1 ? "Único ✓" : `${c} ambig.`;
    console.log(`${String(c).padStart(11)} | ${fmt(r.n).padStart(4)}  (${label})`);
  }

  // ------------------------------------------------ 6. Match único: detalle
  console.log("\n" + "-".repeat(90));
  console.log("EJEMPLOS DE MATCHES ÚNICOS (mismo día, monto exacto, 1 candidato)");
  console.log("-".repeat(90));

  const uniqueMatches = await prisma.$queryRaw<
    Array<{
      dyn_id: string;
      dyn_date: Date;
      dyn_branch: string | null;
      dyn_obs: string;
      dyn_amount: bigint;
      bm_id: string;
      bm_account: string;
      bm_holder: string;
      bm_desc: string;
      bm_cp_name: string | null;
      bm_cp_rut: string | null;
    }>
  >`
    WITH dyn AS (SELECT id, total_amount, branch_external_name, observation, occurred_at::date AS d FROM "DynatechMovement"),
    counts AS (
      SELECT dyn.id AS dyn_id, dyn.d, dyn.total_amount, dyn.branch_external_name, dyn.observation,
             COUNT(bm.id) AS cands
      FROM dyn
      LEFT JOIN "BankMovement" bm
        ON bm.amount = dyn.total_amount
       AND bm.direction = 'IN'
       AND bm.post_date::date = dyn.d
      GROUP BY dyn.id, dyn.d, dyn.total_amount, dyn.branch_external_name, dyn.observation
      HAVING COUNT(bm.id) = 1
    )
    SELECT counts.dyn_id, counts.d AS dyn_date, counts.branch_external_name AS dyn_branch,
           counts.observation AS dyn_obs, counts.total_amount AS dyn_amount,
           bm.id AS bm_id,
           ba.bank_code || ' ' || ba.account_number AS bm_account,
           ba.holder_name AS bm_holder,
           bm.description AS bm_desc,
           bm.counterparty_name AS bm_cp_name,
           bm.counterparty_rut AS bm_cp_rut
    FROM counts
    JOIN "BankMovement" bm
      ON bm.amount = counts.total_amount
     AND bm.direction = 'IN'
     AND bm.post_date::date = counts.d
    JOIN "BankAccount" ba ON bm.account_id = ba.id
    LIMIT 10
  `;
  for (const r of uniqueMatches) {
    console.log(`\n  Dynatech ${r.dyn_date.toISOString().slice(0,10)} | ${r.dyn_branch} | $${fmt(r.dyn_amount)}`);
    console.log(`    Obs: "${r.dyn_obs.slice(0, 60)}"`);
    console.log(`    → BM ${r.bm_account} (${r.bm_holder})`);
    console.log(`      "${r.bm_desc.slice(0, 60)}"`);
    if (r.bm_cp_name) console.log(`      Contraparte: ${r.bm_cp_name} ${r.bm_cp_rut ?? ""}`);
  }

  // ---------------------------------- 7. Patterns en mCjObs (mención de banco)
  console.log("\n" + "-".repeat(90));
  console.log("MENCIONES DE BANCO EN mCjObs (Dynatech)");
  console.log("-".repeat(90));

  const obsBankPatterns = await prisma.$queryRaw<
    Array<{ pattern: string; n: bigint }>
  >`
    SELECT pattern, COUNT(*)::bigint AS n FROM (
      SELECT
        CASE
          WHEN observation ILIKE '%BCI%' THEN 'BCI'
          WHEN observation ILIKE '%SANTANDER%' OR observation ILIKE '%SANTNADER%' OR observation ILIKE '%SANTADNER%' THEN 'SANTANDER'
          WHEN observation ILIKE '%INTERNACIONAL%' THEN 'INTERNACIONAL'
          WHEN observation ILIKE '%BICE%' THEN 'BICE'
          WHEN observation ILIKE '%ITAU%' THEN 'ITAU'
          WHEN observation ILIKE '%CHILE%' THEN 'CHILE'
          WHEN observation ILIKE '%FALABELLA%' THEN 'FALABELLA'
          WHEN observation ILIKE '%ESTADO%' THEN 'ESTADO'
          ELSE '(sin banco identificable)'
        END AS pattern
      FROM "DynatechMovement"
    ) sub
    GROUP BY pattern
    ORDER BY n DESC
  `;
  for (const r of obsBankPatterns) {
    console.log(`  ${r.pattern.padEnd(30)} ${fmt(r.n).padStart(4)} (${pct(Number(r.n), totalDyn)})`);
  }

  // ----------------------------- 8. Patterns "More Giros NNN" en mCjObs
  console.log("\n" + "-".repeat(90));
  console.log("¿GLOSAS BANCARIAS MENCIONAN \"MORE GIROS NNNN\"?");
  console.log("-".repeat(90));

  const giroPatternDyn = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "DynatechMovement"
    WHERE observation ~* 'more\\s+giros?\\s*(nro\\.?)?\\s*\\d+'
  `;
  const giroPatternBank = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "BankMovement"
    WHERE description ~* 'more\\s+giros?\\s*\\d+'
  `;
  console.log(`  Dynatech con "More Giros NNN": ${fmt(giroPatternDyn[0].n)}`);
  console.log(`  Bank    con "More Giros NNN": ${fmt(giroPatternBank[0].n)}`);

  // ------------ 9. Match por monto + bank mencionado en obs (más certero)
  console.log("\n" + "-".repeat(90));
  console.log("MATCH POR MONTO + BANCO MENCIONADO EN mCjObs (mismo día)");
  console.log("-".repeat(90));

  const bankMentionMatch = await prisma.$queryRaw<
    Array<{
      mentioned_bank: string;
      total_dyn: bigint;
      with_match_in_that_bank: bigint;
    }>
  >`
    WITH dyn AS (
      SELECT id, total_amount, occurred_at::date AS d,
             CASE
               WHEN observation ILIKE '%BCI%' THEN 'BCI'
               WHEN observation ILIKE '%SANTANDER%' OR observation ILIKE '%SANTNADER%' OR observation ILIKE '%SANTADNER%' THEN 'SANTANDER'
               WHEN observation ILIKE '%INTERNACIONAL%' THEN 'INTERNACIONAL'
               ELSE NULL
             END AS bank
      FROM "DynatechMovement"
      WHERE observation ~* '(BCI|SANTANDER|SANTNADER|SANTADNER|INTERNACIONAL)'
    )
    SELECT dyn.bank AS mentioned_bank,
           COUNT(DISTINCT dyn.id)::bigint AS total_dyn,
           COUNT(DISTINCT CASE WHEN bm.id IS NOT NULL THEN dyn.id END)::bigint AS with_match_in_that_bank
    FROM dyn
    LEFT JOIN "BankMovement" bm ON bm.amount = dyn.total_amount
                                AND bm.direction = 'IN'
                                AND bm.post_date::date = dyn.d
    LEFT JOIN "BankAccount" ba ON bm.account_id = ba.id AND ba.bank_code = dyn.bank
    WHERE dyn.bank IS NOT NULL
    GROUP BY dyn.bank
    ORDER BY total_dyn DESC
  `;
  for (const r of bankMentionMatch) {
    console.log(`  ${r.mentioned_bank.padEnd(15)} ${fmt(r.with_match_in_that_bank).padStart(3)} / ${fmt(r.total_dyn).padStart(3)}  (${pct(Number(r.with_match_in_that_bank), Number(r.total_dyn))})`);
  }

  // ----------------------------- 10. ¿Cuántos BankMovement IN tienen match en Dynatech?
  console.log("\n" + "-".repeat(90));
  console.log("MATCHEABILIDAD INVERSA: BANK ABONO → DYNATECH");
  console.log("-".repeat(90));

  const reverseMatch = await prisma.$queryRaw<
    Array<{
      total_in: bigint;
      with_match: bigint;
      no_match: bigint;
    }>
  >`
    WITH bm_in AS (
      SELECT bm.id, bm.amount, bm.post_date::date AS d
      FROM "BankMovement" bm
      WHERE bm.direction = 'IN'
    )
    SELECT
      COUNT(*)::bigint AS total_in,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM "DynatechMovement" dm
        WHERE dm.total_amount = bm_in.amount
          AND dm.occurred_at::date = bm_in.d
      ) THEN 1 ELSE 0 END)::bigint AS with_match,
      SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM "DynatechMovement" dm
        WHERE dm.total_amount = bm_in.amount
          AND dm.occurred_at::date = bm_in.d
      ) THEN 1 ELSE 0 END)::bigint AS no_match
    FROM bm_in
  `;
  const rm = reverseMatch[0];
  console.log(`  Total BankMovement IN:    ${fmt(rm.total_in).padStart(4)}`);
  console.log(`  Con match en Dynatech:    ${fmt(rm.with_match).padStart(4)} (${pct(Number(rm.with_match), Number(rm.total_in))})`);
  console.log(`  Sin match en Dynatech:    ${fmt(rm.no_match).padStart(4)} (${pct(Number(rm.no_match), Number(rm.total_in))})`);

  // ------------------------------- 11. Sucursal Dynatech ↔ banco mencionado
  console.log("\n" + "-".repeat(90));
  console.log("CRUCE SUCURSAL DYNATECH ↔ BANCO MENCIONADO EN OBS");
  console.log("-".repeat(90));

  const branchToBank = await prisma.$queryRaw<
    Array<{
      branch: string | null;
      banco_obs: string;
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
        ELSE '(no menciona banco)'
      END AS banco_obs,
      COUNT(*)::bigint AS n
    FROM "DynatechMovement"
    GROUP BY branch_external_name, banco_obs
    ORDER BY branch_external_name, n DESC
  `;
  let curBranch: string | null | undefined = undefined;
  for (const r of branchToBank) {
    if (r.branch !== curBranch) {
      console.log(`\n  ${r.branch ?? "(sin sucursal)"}:`);
      curBranch = r.branch;
    }
    console.log(`     ${r.banco_obs.padEnd(25)} ${fmt(r.n).padStart(3)}`);
  }

  console.log("\n" + "=".repeat(90));
  console.log("FIN DEL ANÁLISIS");
  console.log("=".repeat(90));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
