import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { extractEmbeddedReference } from "@/lib/cartolas/dedup";

/**
 * GET /api/cartolas/duplicates
 *
 * Detecta movimientos bancarios candidatos a ser duplicados del MISMO
 * movimiento del banco. Estrategia en dos pasos:
 *
 *   1. AGRUPAR por (accountId + day + amount + referencia embebida en la
 *      descripcion). Estos son CANDIDATOS preliminares.
 *
 *   2. VERIFICAR similitud de nombre de contraparte dentro del grupo. Solo
 *      mantenemos en el grupo a los que tienen nombre "compatible" con
 *      al menos uno de los otros (substring, jaccard > 0.5, RUT match, o
 *      ambos vacios). Esto evita falsos positivos cuando dos transacciones
 *      distintas comparten ref + monto + dia pero son de personas distintas.
 *
 *   3. EXPANDIR el grupo en sub-grupos compatibles (un grupo original podria
 *      contener dos sub-grupos reales: ej A-A-B donde A y B son personas
 *      distintas → genera grupo [A, A] y descarta B).
 *
 * Cada grupo resultante tiene `confidence`:
 *   - "HIGH":   todos los nombres son compatibles entre si (o todos vacios)
 *   - "MEDIUM": hay nombres compatibles pero tambien algunos sin verificar
 *   - "LOW":    no usado actualmente; los casos bajos se filtran fuera
 *
 * Query params:
 *   ?accountId=<uuid>    (opcional, filtrar por cuenta)
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");

  const movements = await prisma.bankMovement.findMany({
    // Los descartados quedan fuera de la detección de duplicados.
    where: { descartadoAt: null, ...(accountId ? { accountId } : {}) },
    include: {
      account: {
        select: { id: true, bankName: true, accountNumber: true, holderName: true },
      },
      consolidadoLinks: {
        select: { consolidadoId: true },
        take: 1,
      },
    },
    orderBy: [{ postDate: "asc" }, { createdAt: "asc" }],
  });

  // Paso 1: agrupar por clave preliminar
  type MovEntry = {
    id: string;
    description: string;
    counterpartyName: string | null;
    counterpartyRut: string | null;
    externalId: string | null;
    isLinkedToConsolidado: boolean;
    statementImportId: string;
    createdAt: string;
    accountId: string;
    accountLabel: string;
    amount: string;
    postDate: string;
    reference: string;
  };

  const prelim = new Map<string, MovEntry[]>();
  for (const m of movements) {
    const ref = extractEmbeddedReference(m.description);
    if (!ref) continue;
    const day = m.postDate.toISOString().slice(0, 10);
    const key = `${m.accountId}|${day}|${m.amount.toString()}|${ref}`;
    const acc = m.account;
    const entry: MovEntry = {
      id: m.id,
      description: m.description,
      counterpartyName: m.counterpartyName,
      counterpartyRut: m.counterpartyRut,
      externalId: m.externalId,
      isLinkedToConsolidado: m.consolidadoLinks.length > 0,
      statementImportId: m.statementImportId,
      createdAt: m.createdAt.toISOString(),
      accountId: m.accountId,
      accountLabel: `${acc.bankName} · ${acc.accountNumber} (${acc.holderName})`,
      amount: m.amount.toString(),
      postDate: day,
      reference: ref,
    };
    const arr = prelim.get(key) ?? [];
    arr.push(entry);
    prelim.set(key, arr);
  }

  // Paso 2 + 3: dentro de cada grupo, segmentar en clusters de nombres
  // compatibles. Cada cluster con >=2 elementos es un grupo de duplicados real.
  type DupGroup = {
    key: string;
    accountId: string;
    accountLabel: string;
    amount: string;
    postDate: string;
    reference: string;
    movements: MovEntry[];
    confidence: "HIGH" | "MEDIUM";
    confidenceReason: string;
  };

  const groups: DupGroup[] = [];

  for (const [key, members] of prelim.entries()) {
    if (members.length < 2) continue;

    // REGLA CRITICA: si todos comparten el mismo statementImportId, NO son
    // duplicados — son filas legítimas de la misma cartola (ej. 12 transferencias
    // del mismo monto/depositante listadas en la misma exportación bancaria).
    const uniqueImports = new Set(members.map((m) => m.statementImportId));
    if (uniqueImports.size === 1) continue;

    const clusters = clusterByCompatibleNames(members);
    for (let idx = 0; idx < clusters.length; idx++) {
      const cluster = clusters[idx];
      if (cluster.length < 2) continue;

      // Misma regla aplicada al cluster (puede haberse partido en sub-grupos
      // donde cada sub-grupo viene de un solo import).
      const clusterImports = new Set(cluster.map((m) => m.statementImportId));
      if (clusterImports.size === 1) continue;

      const { confidence, reason } = scoreClusterConfidence(cluster);
      groups.push({
        key: clusters.length === 1 ? key : `${key}|cluster${idx}`,
        accountId: cluster[0].accountId,
        accountLabel: cluster[0].accountLabel,
        amount: cluster[0].amount,
        postDate: cluster[0].postDate,
        reference: cluster[0].reference,
        movements: cluster,
        confidence,
        confidenceReason: reason,
      });
    }
  }

  // Ordenar por confidence (HIGH primero) y luego por tamaño desc
  groups.sort((a, b) => {
    const ca = a.confidence === "HIGH" ? 1 : 0;
    const cb = b.confidence === "HIGH" ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return b.movements.length - a.movements.length;
  });

  return NextResponse.json({
    totalDuplicateGroups: groups.length,
    highConfidenceGroups: groups.filter((g) => g.confidence === "HIGH").length,
    mediumConfidenceGroups: groups.filter((g) => g.confidence === "MEDIUM").length,
    totalDuplicateMovements: groups.reduce((s, g) => s + g.movements.length, 0),
    excessMovements: groups.reduce((s, g) => s + g.movements.length - 1, 0),
    groups,
  });
}

/* =============================== Helpers =============================== */

interface NamedMov {
  counterpartyName: string | null;
  counterpartyRut: string | null;
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

function tokensOf(name: string | null): Set<string> {
  if (!name) return new Set();
  const tokens = stripDiacritics(name)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function normalizeRut(rut: string | null): string {
  if (!rut) return "";
  return rut.replace(/[.\s]/g, "").toUpperCase();
}

/**
 * Dos contrapartes son compatibles si:
 *  - Ambas tienen el mismo RUT no vacio, O
 *  - Ambos nombres vacios (no podemos descartar duplicado), O
 *  - Uno de los nombres es vacio (asumimos compatible con cualquier), O
 *  - Un nombre es substring/prefijo del otro (truncamiento), O
 *  - Jaccard de tokens >= 0.5
 *
 * (Sin `export` porque Next.js no permite exports adicionales en route.ts —
 *  solo handlers HTTP y config. Helper interno.)
 */
function areCompatible(a: NamedMov, b: NamedMov): boolean {
  const rutA = normalizeRut(a.counterpartyRut);
  const rutB = normalizeRut(b.counterpartyRut);
  if (rutA && rutB) {
    return rutA === rutB; // RUT manda
  }

  const nameA = a.counterpartyName ? stripDiacritics(a.counterpartyName).trim() : "";
  const nameB = b.counterpartyName ? stripDiacritics(b.counterpartyName).trim() : "";
  if (!nameA || !nameB) return true; // uno vacio -> no podemos descartar

  // Substring/truncamiento
  if (nameA.includes(nameB) || nameB.includes(nameA)) return true;

  // Jaccard
  const ta = tokensOf(a.counterpartyName);
  const tb = tokensOf(b.counterpartyName);
  if (ta.size === 0 || tb.size === 0) return true;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  if (union === 0) return false;
  return inter / union >= 0.5;
}

/**
 * Agrupa los elementos en clusters donde todos los pares son compatibles.
 * Usa un union-find simple: dos elementos van al mismo cluster si son
 * compatibles directamente, y la compatibilidad se propaga transitivamente.
 *
 * Resultado: cada cluster es un sub-grupo de duplicados reales. Elementos
 * que no son compatibles con NINGUNO de los otros quedan en cluster propio
 * (size 1, descartado luego).
 */
function clusterByCompatibleNames<T extends NamedMov>(items: T[]): T[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (areCompatible(items[i], items[j])) union(i, j);
    }
  }

  const clusters = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = clusters.get(r) ?? [];
    arr.push(items[i]);
    clusters.set(r, arr);
  }
  return Array.from(clusters.values());
}

interface ClusterEntry extends NamedMov {
  statementImportId: string;
}

function scoreClusterConfidence<T extends ClusterEntry>(
  cluster: T[]
): { confidence: "HIGH" | "MEDIUM"; reason: string } {
  // SEGURIDAD CRITICA: grupos grandes (4+) siempre se marcan MEDIUM, aunque
  // los nombres coincidan. Razón: pueden ser multi-transferencias legítimas
  // del mismo depositante re-uploadeadas en distintas cartolas. Ejemplo:
  // 12 transferencias de $7M del mismo cliente → si hay 12 en cartola A y
  // 12 en cartola B, son 12 duplicados (no 1 grupo de 24). Requiere revisión.
  if (cluster.length >= 4) {
    // Calcular distribución por statementImportId
    const counts = new Map<string, number>();
    for (const m of cluster) {
      counts.set(m.statementImportId, (counts.get(m.statementImportId) ?? 0) + 1);
    }
    const countsArr = Array.from(counts.values());
    const isBalanced =
      countsArr.length >= 2 &&
      countsArr.every((c) => c === countsArr[0]);

    if (isBalanced) {
      return {
        confidence: "MEDIUM",
        reason: `⚠ Probable multi-transferencia re-uploadeada: ${countsArr[0]} movimientos repetidos en ${countsArr.length} cartolas. Antes de fusionar, verificá si el depositante realmente envió ${countsArr[0]} transferencias o si es una sola.`,
      };
    }

    return {
      confidence: "MEDIUM",
      reason: `Grupo grande (${cluster.length} movimientos). Puede ser duplicado real o multi-transferencia del mismo depositante. Revisá manualmente.`,
    };
  }

  // Grupos chicos (2-3): clusterización transitiva
  let allDirect = true;
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      if (!areCompatible(cluster[i], cluster[j])) {
        allDirect = false;
        break;
      }
    }
    if (!allDirect) break;
  }
  if (allDirect) {
    return {
      confidence: "HIGH",
      reason: "Contrapartes compatibles entre todos los movimientos.",
    };
  }
  return {
    confidence: "MEDIUM",
    reason:
      "Algunos nombres no coinciden directamente entre todos los pares. Revisá manualmente.",
  };
}
