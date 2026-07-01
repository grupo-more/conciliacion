import { createHash } from "crypto";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";
import { detectParser, detectPdfParser, isPdfBuffer } from "./detect";
import { computeDedupKeys } from "./dedup";
import { extractPdfText } from "./pdf";
import type {
  BankCode,
  NormalizedMovement,
  ParsedStatement,
  ParserCode,
} from "./types";
import { normalizeDescription } from "./normalize";

export const UNASSIGNED_PREFIX = "_UNASSIGNED_";

export function isUnassignedAccountNumber(n: string): boolean {
  return n.startsWith(UNASSIGNED_PREFIX);
}

export interface ImportPreviewItem {
  /** Movimiento normalizado del archivo. */
  movement: NormalizedMovement;
  dedupKey: string;
  status:
    | "NEW"               // se va a insertar
    | "DUP_SAME_ACCOUNT"  // ya existe en la cuenta destino (skip)
    | "DUP_OTHER_ACCOUNT" // existe perfecto en otra cuenta del mismo banco (skip, conservador)
    | "ERROR";            // error de parseo (ya viene de errors[])
  duplicateOfAccountId?: string | null;
  duplicateOfAccountLabel?: string | null;
  errorReason?: string;
}

export interface ImportPreview {
  parserCode: ParserCode;
  bankCode: BankCode;
  bankName: string;
  fileName: string;
  fileHash: string;
  /** Cuenta destino resuelta. Si null, se va a "Sin asignar" del banco. */
  resolvedAccount: ResolvedAccount;
  /** Si la cuenta del archivo no matcheó ninguna registrada → datos crudos detectados. */
  unresolvedAccountInfo?: {
    accountNumber: string;
    displayNumber?: string;
    holderName?: string;
    holderRut?: string;
  };
  periodFrom: Date | null;
  periodTo: Date | null;
  totals: {
    fileMovements: number;
    toInsert: number;
    duplicatesSameAccount: number;
    duplicatesOtherAccount: number;
    parseErrors: number;
  };
  items: ImportPreviewItem[];
  /** Si fileHash ya existe en algún StatementImport, info del previo. */
  alreadyImported?: {
    importedAt: Date;
    statementImportId: string;
    accountLabel: string;
  };
}

export interface ResolvedAccount {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
  isUnassigned: boolean;
  /** Cómo se resolvió: usado para reporte */
  resolutionMethod:
    | "DIRECT_MATCH"            // accountNumber del archivo matcheó una cuenta registrada
    | "FILENAME_MATCH"          // (BCI) extraída del nombre de archivo
    | "ONLY_BANK_ACCOUNT"       // hay una sola cuenta de ese banco (BCI sin filename)
    | "FALLBACK_UNASSIGNED";    // no se pudo resolver, va a "Sin asignar"
}

export interface ImportResult {
  preview: ImportPreview;
  /** Si se ejecutó la inserción (dryRun = false). */
  inserted?: {
    statementImportId: string;
    rowsInserted: number;
  };
  /** Si fue dryRun, está en undefined. */
}

interface RunImportOptions {
  fileName: string;
  fileBuffer: Buffer;
  /** Si dryRun = true, NO inserta, solo devuelve preview. */
  dryRun: boolean;
  /** ID de cuenta forzado (override) si el usuario seleccionó manualmente. */
  forceAccountId?: string;
}

/**
 * Punto de entrada principal del flujo de importación.
 *
 * Pasos:
 *  1) Lee workbook, detecta parser, parsea movimientos.
 *  2) Resuelve la cuenta destino (cascada: match directo → filename → única del banco
 *     → "Sin asignar").
 *  3) Calcula dedupKeys.
 *  4) Cruza intra-cuenta: descarta los que ya existen ahí.
 *  5) Cruza intra-banco (mismo bankCode, otras cuentas) con match PERFECTO en todos
 *     los campos identificadores: si existe ahí, se descarta del import (regla
 *     conservadora — solo descarta cuando hay match exacto).
 *  6) Si dryRun, devuelve el preview. Si no, inserta en transacción.
 */
export async function runImport(opts: RunImportOptions): Promise<ImportResult> {
  const { fileName, fileBuffer, dryRun, forceAccountId } = opts;

  // 1) Hash del archivo, detectar parser, parsear.
  //    Soporta dos formatos de entrada: XLS/XLSX (universo histórico) y PDF
  //    (Mercado Pago hoy, futuros bancos sin export Excel).
  const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

  let parsed: ParsedStatement;
  let pickedBankCode: BankCode;
  let pickedBankName: string;
  const isPdf =
    isPdfBuffer(fileBuffer) || /\.pdf$/i.test(fileName);

  if (isPdf) {
    const text = await extractPdfText(fileBuffer);
    const pdfParser = detectPdfParser(text);
    if (!pdfParser) {
      throw new Error("No se pudo identificar el banco/formato del PDF.");
    }
    parsed = pdfParser.parse(text);
    pickedBankCode = pdfParser.bankCode;
    pickedBankName = pdfParser.bankName;
  } else {
    const wb = XLSX.read(fileBuffer, { cellDates: true });
    const parser = detectParser(wb);
    if (!parser) {
      throw new Error("No se pudo identificar el banco/formato del archivo.");
    }
    parsed = parser.parse(wb);
    pickedBankCode = parser.bankCode;
    pickedBankName = parser.bankName;
  }

  // 2) Resolver cuenta destino
  const resolved = await resolveAccount({
    parsed,
    fileName,
    forceAccountId,
  });

  // Detectar si el archivo ya fue importado a esa cuenta
  const previousImport = await prisma.statementImport.findUnique({
    where: {
      accountId_fileHash: {
        accountId: resolved.id,
        fileHash,
      },
    },
  });

  // 3) Calcular dedupKeys
  const dedupKeys = computeDedupKeys(parsed.movements);

  // 4) Cross-check intra-cuenta (cuenta destino)
  const existingInAccount = await prisma.bankMovement.findMany({
    where: {
      accountId: resolved.id,
      dedupKey: { in: dedupKeys },
    },
    select: { dedupKey: true },
  });
  const existingSet = new Set(existingInAccount.map((m) => m.dedupKey));

  // Movimientos ya descartados (registro durable). Si vuelven a importarse
  // porque su fila fue borrada, se reinsertan pero ya marcados como descartados
  // — nunca vuelven a conciliar ni a contar como pendientes.
  const descartadosRows = await prisma.movimientoDescartado.findMany({
    where: { accountId: resolved.id, dedupKey: { in: dedupKeys } },
    select: { dedupKey: true },
  });
  const descartadoSet = new Set(descartadosRows.map((d) => d.dedupKey));

  // 5) Cross-check intra-banco (otras cuentas del mismo banco) — match perfecto
  // Solo aplica para los movimientos que aún no están duplicados en la cuenta destino.
  const otherBankAccountIds = await prisma.bankAccount
    .findMany({
      where: {
        bankCode: resolved.bankCode,
        id: { not: resolved.id },
      },
      select: { id: true, accountNumber: true, displayNumber: true, holderName: true },
    });
  const otherIdsList = otherBankAccountIds.map((a) => a.id);
  const otherIdToLabel = new Map(
    otherBankAccountIds.map((a) => [
      a.id,
      buildAccountLabel(a.accountNumber, a.displayNumber, a.holderName),
    ])
  );

  // Si hay otras cuentas del mismo banco, buscamos potenciales matches por
  // (postDate, amount). Filtramos en memoria por el resto de campos.
  let candidatesByDay: Map<string, Array<CrossCandidate>> = new Map();
  if (otherIdsList.length > 0) {
    const dayBucketsToCheck = new Set<string>();
    for (const m of parsed.movements) {
      dayBucketsToCheck.add(m.postDate.toISOString().slice(0, 10));
    }
    if (dayBucketsToCheck.size > 0) {
      const days = Array.from(dayBucketsToCheck);
      const minDay = new Date(days.sort()[0]);
      const maxDay = new Date(days.sort().slice(-1)[0]);
      // post_date dentro del rango (inclusivo)
      const rangeEnd = new Date(maxDay);
      rangeEnd.setDate(rangeEnd.getDate() + 1);

      const candidates = await prisma.bankMovement.findMany({
        where: {
          accountId: { in: otherIdsList },
          postDate: { gte: minDay, lt: rangeEnd },
        },
        select: {
          accountId: true,
          postDate: true,
          amount: true,
          externalId: true,
          descriptionNorm: true,
          counterpartyRut: true,
        },
      });

      candidatesByDay = groupCandidatesByDay(candidates);
    }
  }

  // 6) Construir items con su status
  const items: ImportPreviewItem[] = [];
  let toInsert = 0;
  let dupSame = 0;
  let dupOther = 0;

  for (let i = 0; i < parsed.movements.length; i++) {
    const m = parsed.movements[i];
    const key = dedupKeys[i];

    if (existingSet.has(key)) {
      items.push({
        movement: m,
        dedupKey: key,
        status: "DUP_SAME_ACCOUNT",
        duplicateOfAccountId: resolved.id,
        duplicateOfAccountLabel: buildAccountLabel(
          resolved.accountNumber,
          resolved.displayNumber,
          resolved.holderName
        ),
      });
      dupSame++;
      continue;
    }

    const dayKey = m.postDate.toISOString().slice(0, 10);
    const dayCandidates = candidatesByDay.get(dayKey) ?? [];
    const perfectMatch = findPerfectMatch(m, dayCandidates);
    if (perfectMatch) {
      items.push({
        movement: m,
        dedupKey: key,
        status: "DUP_OTHER_ACCOUNT",
        duplicateOfAccountId: perfectMatch.accountId,
        duplicateOfAccountLabel:
          otherIdToLabel.get(perfectMatch.accountId) ?? perfectMatch.accountId,
      });
      dupOther++;
      continue;
    }

    items.push({ movement: m, dedupKey: key, status: "NEW" });
    toInsert++;
  }

  // Errores de parseo
  for (const e of parsed.errors) {
    items.push({
      movement: {
        externalId: null,
        postDate: new Date(0),
        transactionDate: null,
        amount: 0,
        currency: "CLP",
        direction: "IN",
        description: "",
        balanceAfter: null,
        counterpartyName: null,
        counterpartyRut: null,
        counterpartyAccount: null,
        counterpartyBank: null,
        branchLabel: null,
        txType: null,
        rawRow: { raw: e.raw, rowIndex: e.rowIndex },
      },
      dedupKey: "",
      status: "ERROR",
      errorReason: e.reason,
    });
  }

  const preview: ImportPreview = {
    parserCode: parsed.parserCode,
    bankCode: pickedBankCode,
    bankName: pickedBankName,
    fileName,
    fileHash,
    resolvedAccount: resolved,
    unresolvedAccountInfo:
      resolved.resolutionMethod === "FALLBACK_UNASSIGNED"
        ? {
            accountNumber: parsed.account.accountNumber,
            displayNumber: parsed.account.displayNumber,
            holderName: parsed.account.holderName,
            holderRut: parsed.account.holderRut,
          }
        : undefined,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    totals: {
      fileMovements: parsed.movements.length,
      toInsert,
      duplicatesSameAccount: dupSame,
      duplicatesOtherAccount: dupOther,
      parseErrors: parsed.errors.length,
    },
    items,
    alreadyImported: previousImport
      ? {
          importedAt: previousImport.createdAt,
          statementImportId: previousImport.id,
          accountLabel: buildAccountLabel(
            resolved.accountNumber,
            resolved.displayNumber,
            resolved.holderName
          ),
        }
      : undefined,
  };

  if (dryRun) {
    return { preview };
  }

  // 7) Inserción real, en transacción
  if (preview.alreadyImported) {
    // No re-creamos StatementImport con el mismo fileHash. Pero si por alguna razón
    // hay nuevos movimientos (file modificado pero mismo hash, raro), no haríamos nada.
    // En la práctica esto significa: ya importado, no hay nada que hacer.
    return {
      preview,
      inserted: {
        statementImportId: preview.alreadyImported.statementImportId,
        rowsInserted: 0,
      },
    };
  }

  const newItems = items.filter((it) => it.status === "NEW");

  const result = await prisma.$transaction(async (tx) => {
    const stmt = await tx.statementImport.create({
      data: {
        accountId: resolved.id,
        parserCode: parsed.parserCode,
        fileName,
        fileHash,
        periodFrom: parsed.periodFrom,
        periodTo: parsed.periodTo,
        rowsTotal: parsed.movements.length,
        rowsInserted: newItems.length,
        rowsDuplicated: dupSame + dupOther,
        rowsFailed: parsed.errors.length,
        rawMetadata: {
          parserCode: parsed.parserCode,
          accountInfo: parsed.account,
          metadata: parsed.metadata,
          resolution: resolved.resolutionMethod,
        } as object,
      },
    });

    if (newItems.length > 0) {
      await tx.bankMovement.createMany({
        data: newItems.map((it) => ({
          accountId: resolved.id,
          statementImportId: stmt.id,
          externalId: it.movement.externalId,
          postDate: it.movement.postDate,
          transactionDate: it.movement.transactionDate,
          amount: BigInt(it.movement.amount),
          currency: it.movement.currency,
          direction: it.movement.direction,
          description: it.movement.description,
          descriptionNorm: normalizeDescription(it.movement.description),
          balanceAfter:
            it.movement.balanceAfter !== null
              ? BigInt(it.movement.balanceAfter)
              : null,
          counterpartyName: it.movement.counterpartyName,
          counterpartyRut: it.movement.counterpartyRut,
          counterpartyAccount: it.movement.counterpartyAccount,
          counterpartyBank: it.movement.counterpartyBank,
          branchLabel: it.movement.branchLabel,
          txType: it.movement.txType,
          dedupKey: it.dedupKey,
          rawRow: it.movement.rawRow as object,
          // Si ya estaba descartado, reentra directo a "Movimientos descartados".
          descartadoAt: descartadoSet.has(it.dedupKey) ? new Date() : null,
        })),
        skipDuplicates: true,
      });
    }

    return stmt;
  });

  return {
    preview,
    inserted: {
      statementImportId: result.id,
      rowsInserted: newItems.length,
    },
  };
}

/* ---------------------- Resolución de cuenta destino ---------------------- */

interface ResolveOpts {
  parsed: ParsedStatement;
  fileName: string;
  forceAccountId?: string;
}

async function resolveAccount(opts: ResolveOpts): Promise<ResolvedAccount> {
  const { parsed, fileName, forceAccountId } = opts;
  const bankCode = parsed.account.bankCode;

  if (forceAccountId) {
    const acc = await prisma.bankAccount.findUnique({
      where: { id: forceAccountId },
    });
    if (!acc) throw new Error("Cuenta forzada no existe.");
    return toResolved(acc, "DIRECT_MATCH");
  }

  // 1) Match directo por (bankCode, accountNumber) si el parser entregó el número
  if (parsed.account.accountNumber) {
    const direct = await prisma.bankAccount.findFirst({
      where: {
        bankCode,
        accountNumber: parsed.account.accountNumber,
      },
    });
    if (direct) return toResolved(direct, "DIRECT_MATCH");
  }

  // 2) Para BCI: extraer del filename si tiene "Cuenta_<num>"
  if (bankCode === "BCI" && !parsed.account.accountNumber) {
    const m = fileName.match(/Cuenta[_\s-]?(\d+)/i);
    if (m) {
      const numFromFile = m[1];
      const byFile = await prisma.bankAccount.findFirst({
        where: { bankCode, accountNumber: numFromFile },
      });
      if (byFile) return toResolved(byFile, "FILENAME_MATCH");
    }

    // 3) BCI: si solo hay UNA cuenta BCI real registrada → auto-asignar
    const bciReal = await prisma.bankAccount.findMany({
      where: {
        bankCode,
        active: true,
        accountNumber: { not: { startsWith: UNASSIGNED_PREFIX } },
      },
    });
    if (bciReal.length === 1) {
      return toResolved(bciReal[0], "ONLY_BANK_ACCOUNT");
    }
  }

  // 4) Fallback: cuenta "Sin asignar" del banco. Si no existe (caso tipico
  // al introducir un banco nuevo), la creamos automaticamente — el seed
  // historico solo tenia las 4 originales (BCI/Santander/Internacional/Chile).
  const unassignedKey = `${UNASSIGNED_PREFIX}${bankCode}`;
  let unassigned = await prisma.bankAccount.findFirst({
    where: { bankCode, accountNumber: unassignedKey },
  });
  if (!unassigned) {
    const bankName = inferBankName(bankCode);
    unassigned = await prisma.bankAccount.create({
      data: {
        bankCode,
        bankName,
        accountNumber: unassignedKey,
        holderName: "Sin asignar",
        alias: `Sin asignar - ${bankName}`,
        currency: "CLP",
      },
    });
  }
  return toResolved(unassigned, "FALLBACK_UNASSIGNED");
}

/**
 * bankName por defecto para los bancos conocidos. Se usa solo al lazy-crear
 * la cuenta "Sin asignar" de un banco nuevo — el usuario puede renombrar
 * despues desde Configuracion si quiere.
 */
function inferBankName(bankCode: string): string {
  switch (bankCode) {
    case "BCI": return "BCI";
    case "SANTANDER": return "Santander";
    case "INTERNACIONAL": return "Banco Internacional";
    case "CHILE": return "Banco de Chile";
    case "MERCADOPAGO": return "Mercado Pago";
    default: return bankCode;
  }
}

function toResolved(
  acc: {
    id: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    displayNumber: string | null;
    holderName: string;
  },
  method: ResolvedAccount["resolutionMethod"]
): ResolvedAccount {
  return {
    id: acc.id,
    bankCode: acc.bankCode,
    bankName: acc.bankName,
    accountNumber: acc.accountNumber,
    displayNumber: acc.displayNumber,
    holderName: acc.holderName,
    isUnassigned: isUnassignedAccountNumber(acc.accountNumber),
    resolutionMethod: method,
  };
}

/* --------------------------- Cross-check helpers --------------------------- */

interface CrossCandidate {
  accountId: string;
  postDate: Date;
  amount: bigint;
  externalId: string | null;
  descriptionNorm: string;
  counterpartyRut: string | null;
}

function groupCandidatesByDay(candidates: CrossCandidate[]): Map<string, CrossCandidate[]> {
  const map = new Map<string, CrossCandidate[]>();
  for (const c of candidates) {
    const day = c.postDate.toISOString().slice(0, 10);
    const arr = map.get(day) ?? [];
    arr.push(c);
    map.set(day, arr);
  }
  return map;
}

/**
 * Match PERFECTO ultra-conservador: todos los campos identificadores deben coincidir.
 * Si UN solo campo difiere (incluyendo nulos asimétricos), NO es match.
 *
 * Filosofía: "preferimos tener una de sobra a perder una". Por eso solo descartamos
 * cuando estamos absolutamente seguros de que es el mismo movimiento ya registrado.
 */
function findPerfectMatch(
  m: NormalizedMovement,
  candidates: CrossCandidate[]
): CrossCandidate | null {
  const mDescNorm = normalizeDescription(m.description);
  const mAmount = BigInt(m.amount);
  const mPostIso = m.postDate.toISOString().slice(0, 10);

  for (const c of candidates) {
    const cPostIso = c.postDate.toISOString().slice(0, 10);
    if (cPostIso !== mPostIso) continue;
    if (c.amount !== mAmount) continue;
    if ((c.externalId ?? null) !== (m.externalId ?? null)) continue;
    if ((c.counterpartyRut ?? null) !== (m.counterpartyRut ?? null)) continue;
    if (c.descriptionNorm !== mDescNorm) continue;
    return c;
  }
  return null;
}

/* ------------------------------- Utilidades ------------------------------- */

export function buildAccountLabel(
  accountNumber: string,
  displayNumber: string | null | undefined,
  holderName: string
): string {
  if (isUnassignedAccountNumber(accountNumber)) {
    return holderName; // "Sin asignar"
  }
  const num = displayNumber || accountNumber;
  return `${holderName} ${num}`;
}
