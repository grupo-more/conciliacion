/**
 * Matcher OUT ↔ IN espejo entre cuentas propias.
 *
 * Entrada: BankMovements del rango (idealmente todos los OUT internos
 * detectados y todos los IN candidatos en cuentas nuestras).
 *
 * Salida: pares (OUT, IN) cuando hay match limpio o desambiguado, mas las
 * listas de huerfanos (OUTs sin IN espejo, INs internos sin OUT espejo).
 *
 * Criterios de matching:
 *   - amount absoluto identico
 *   - postDate dentro de DATE_WINDOW_DAYS (default ±2) — los traspasos a
 *     veces tardan un dia en aparecer del lado destino
 *   - account.holderRut de la cuenta destino del IN matchea la entidad
 *     interna detectada del OUT
 *
 * Desambiguacion cuando hay varios IN candidatos para un OUT:
 *   "cierre del circulo": preferimos el IN cuyo counterpartyRut/Name apunta
 *   al holderRut de la cuenta origen del OUT. Si solo uno de los candidatos
 *   cierra el circulo → ese gana.
 *
 * Si despues de eso queda mas de un IN candidato → el OUT entra al bucket
 * "ambiguo" y NO se forma par (queda como huerfano). El operador debe
 * resolverlo a mano (en una segunda iteracion podemos sumar pareo manual).
 */

import {
  detectInterno,
  matchRut,
  normalizeRut,
  type EntidadInternaLite,
} from "./detect";

export const DATE_WINDOW_DAYS = 2;

export interface BankMovementForMatch {
  id: string;
  accountId: string;
  postDate: Date;
  amount: bigint;
  direction: string;
  description: string | null;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  account: {
    id: string;
    bankName: string;
    holderName: string;
    holderRut: string | null;
    accountNumber: string;
    displayNumber: string | null;
  };
}

export interface MirrorPair {
  out: BankMovementForMatch;
  in: BankMovementForMatch;
  /** Entidad detectada como contraparte del OUT (= titular de la cuenta destino). */
  destEntidad: EntidadInternaLite;
  /** Calidad del match: clean=1 candidato, circle=desambiguado por cierre del circulo */
  matchQuality: "clean" | "circle";
  /** true si origen y destino tienen el mismo holderRut (traspaso intra-entidad). */
  intraEntidad: boolean;
}

export interface MirrorResult {
  pairs: MirrorPair[];
  outOrphans: Array<{
    out: BankMovementForMatch;
    /** Por que quedo huerfano. */
    reason: "no-dest-account" | "no-candidate" | "ambiguous";
    /** Si reason === "ambiguous", los candidatos que no se pudieron desambiguar. */
    candidates?: BankMovementForMatch[];
  }>;
  inOrphans: Array<{
    in: BankMovementForMatch;
    detectedEntidad: EntidadInternaLite;
  }>;
}

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function dateDiffDays(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / 86400000);
}

/** Verifica que un IN candidato "cierre el circulo" contra el OUT. */
function closesCircle(
  candidateIn: BankMovementForMatch,
  outAccountHolderRut: string,
): boolean {
  if (!outAccountHolderRut) return false;
  const cpRut = normalizeRut(candidateIn.counterpartyRut);
  if (cpRut && matchRut(cpRut, outAccountHolderRut)) return true;

  // Sin RUT explicito, intentamos por nombre: counterpartyName del IN suele
  // traer la entidad origen ("BACO SPA", "ME SPA"). No tenemos aqui el nombre
  // canonico de la cuenta origen, asi que comparamos contra holderName via
  // un fallback debil. Esto se hace en el caller que tiene la cuenta origen.
  return false;
}

export function matchMirror(
  movements: BankMovementForMatch[],
  entidades: EntidadInternaLite[],
  options?: { windowDays?: number },
): MirrorResult {
  const windowDays = options?.windowDays ?? DATE_WINDOW_DAYS;

  // Indice de cuentas nuestras por entidad (holderRut → cuentas).
  // Una entidad puede tener varias cuentas (ej. ME en BCI, Santander, Chile).
  const accountsByEntityRut = new Map<string, BankMovementForMatch["account"][]>();
  const seenAccounts = new Set<string>();
  for (const m of movements) {
    if (seenAccounts.has(m.account.id)) continue;
    seenAccounts.add(m.account.id);
    const rut = normalizeRut(m.account.holderRut);
    if (!rut) continue;
    for (const e of entidades) {
      if (matchRut(rut, e.rutCanonico)) {
        if (!accountsByEntityRut.has(e.rutCanonico)) {
          accountsByEntityRut.set(e.rutCanonico, []);
        }
        accountsByEntityRut.get(e.rutCanonico)!.push(m.account);
        break;
      }
    }
  }

  // Particiono OUTs y INs internos.
  const outsInternal: Array<{ mov: BankMovementForMatch; entidad: EntidadInternaLite }> = [];
  const insInternal: Array<{ mov: BankMovementForMatch; entidad: EntidadInternaLite }> = [];
  for (const m of movements) {
    const det = detectInterno(m, entidades);
    if (!det) continue;
    if (m.direction === "OUT") outsInternal.push({ mov: m, entidad: det.entidad });
    else if (m.direction === "IN") insInternal.push({ mov: m, entidad: det.entidad });
  }

  // Para cada OUT, busco IN candidatos.
  const pairs: MirrorPair[] = [];
  const usedInIds = new Set<string>();
  const outOrphans: MirrorResult["outOrphans"] = [];

  for (const { mov: out, entidad: destEntidad } of outsInternal) {
    const destAccountIds = new Set(
      (accountsByEntityRut.get(destEntidad.rutCanonico) ?? []).map((a) => a.id),
    );

    if (destAccountIds.size === 0) {
      outOrphans.push({ out, reason: "no-dest-account" });
      continue;
    }

    const outAbs = absBig(out.amount);
    const candidates = movements.filter(
      (m) =>
        m.direction === "IN" &&
        destAccountIds.has(m.account.id) &&
        !usedInIds.has(m.id) &&
        absBig(m.amount) === outAbs &&
        dateDiffDays(m.postDate, out.postDate) <= windowDays,
    );

    if (candidates.length === 0) {
      outOrphans.push({ out, reason: "no-candidate" });
      continue;
    }

    if (candidates.length === 1) {
      const winner = candidates[0];
      usedInIds.add(winner.id);
      pairs.push({
        out,
        in: winner,
        destEntidad,
        matchQuality: "clean",
        intraEntidad:
          normalizeRut(out.account.holderRut) ===
          normalizeRut(winner.account.holderRut),
      });
      continue;
    }

    // Multiples candidatos → intentar cierre del circulo.
    const outHolderRut = normalizeRut(out.account.holderRut);
    const circleClosers = candidates.filter((c) =>
      closesCircle(c, outHolderRut),
    );

    if (circleClosers.length === 1) {
      const winner = circleClosers[0];
      usedInIds.add(winner.id);
      pairs.push({
        out,
        in: winner,
        destEntidad,
        matchQuality: "circle",
        intraEntidad:
          normalizeRut(out.account.holderRut) ===
          normalizeRut(winner.account.holderRut),
      });
      continue;
    }

    // No se pudo desambiguar → ambiguo, queda huerfano con candidatos.
    outOrphans.push({ out, reason: "ambiguous", candidates });
  }

  // INs internos no usados como espejo de ningun OUT = huerfanos.
  const inOrphans: MirrorResult["inOrphans"] = [];
  for (const { mov: i, entidad } of insInternal) {
    if (!usedInIds.has(i.id)) {
      inOrphans.push({ in: i, detectedEntidad: entidad });
    }
  }

  return { pairs, outOrphans, inOrphans };
}
