import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runImport } from "@/lib/cartolas/import";
import { runConsolidados } from "@/lib/consolidados/match";
import { prisma } from "@/lib/db";
import { suggestEntidadByName } from "@/lib/internos/suggest";

/**
 * POST /api/cartolas/import?dryRun=1
 * multipart/form-data:
 *   - file: el archivo de cartola (.xlsx | .xls)
 *   - forceAccountId (opcional): override manual de cuenta destino
 *
 * Si `?dryRun=1`, devuelve el preview SIN insertar.
 * Si no, ejecuta la inserción con dedup y devuelve el resultado.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Falta el archivo (campo `file`)" },
      { status: 400 }
    );
  }

  const forceAccountIdRaw = form.get("forceAccountId");
  const forceAccountId =
    typeof forceAccountIdRaw === "string" && forceAccountIdRaw.trim() !== ""
      ? forceAccountIdRaw.trim()
      : undefined;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const buf = Buffer.from(await file.arrayBuffer());

  try {
    const result = await runImport({
      fileName: file.name,
      fileBuffer: buf,
      dryRun,
      forceAccountId,
    });

    // Después de un import real, re-ejecutar el motor de Consolidados para
    // que movimientos en estados abiertos (NO_MATCH, REVIEW) puedan matchear
    // con los nuevos BankMovements recién insertados. Preserva los MANUAL.
    if (!dryRun && result.inserted && result.inserted.rowsInserted > 0) {
      try {
        await runConsolidados({ dryRun: false, preserveManual: true });
      } catch (e) {
        console.error("[cartolas/import] error en runConsolidados:", e);
      }
    }

    // Cuando la resolucion cae en placeholder "Sin asignar" y tenemos
    // holderName parseado, sugerimos una EntidadInterna para que el UI pueda
    // pre-rellenar el holderRut al crear la cuenta nueva.
    let entidadSuggestion = null;
    if (
      result.preview.resolvedAccount.resolutionMethod === "FALLBACK_UNASSIGNED" &&
      result.preview.unresolvedAccountInfo?.holderName
    ) {
      const entidades = await prisma.entidadInterna.findMany({
        where: { active: true },
        select: {
          id: true,
          rutCanonico: true,
          nombreCanonico: true,
          aliases: true,
          rubro: true,
        },
      });
      const sug = suggestEntidadByName(
        result.preview.unresolvedAccountInfo.holderName,
        entidades,
      );
      entidadSuggestion = {
        reason: sug.reason,
        match: sug.match
          ? {
              id: sug.match.id,
              rutCanonico: sug.match.rutCanonico,
              nombreCanonico: sug.match.nombreCanonico,
              rubro: sug.match.rubro,
            }
          : null,
        candidates: sug.candidates.map((c) => ({
          id: c.id,
          rutCanonico: c.rutCanonico,
          nombreCanonico: c.nombreCanonico,
        })),
      };
    }

    return NextResponse.json(serializeResult(result, entidadSuggestion));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error al procesar el archivo";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

type EntidadSuggestionDTO = {
  reason: "exact" | "ambiguous" | "no-match" | "no-name";
  match: {
    id: string;
    rutCanonico: string;
    nombreCanonico: string;
    rubro: number | null;
  } | null;
  candidates: Array<{
    id: string;
    rutCanonico: string;
    nombreCanonico: string;
  }>;
} | null;

function serializeResult(
  result: import("@/lib/cartolas/import").ImportResult,
  entidadSuggestion: EntidadSuggestionDTO,
) {
  const p = result.preview;
  return {
    preview: {
      ...p,
      periodFrom: p.periodFrom?.toISOString() ?? null,
      periodTo: p.periodTo?.toISOString() ?? null,
      alreadyImported: p.alreadyImported
        ? {
            ...p.alreadyImported,
            importedAt: p.alreadyImported.importedAt.toISOString(),
          }
        : undefined,
      // Para reducir payload, NO mandamos los items completos en preview;
      // solo los conteos y muestras. La inserción se decide en server.
      items: p.items.slice(0, 50).map((it) => ({
        status: it.status,
        dedupKey: it.dedupKey,
        errorReason: it.errorReason,
        duplicateOfAccountLabel: it.duplicateOfAccountLabel,
        movement: serializeMovement(it.movement),
      })),
      itemsTotal: p.items.length,
      entidadSuggestion,
    },
    inserted: result.inserted,
  };
}

function serializeMovement(m: import("@/lib/cartolas/types").NormalizedMovement) {
  return {
    externalId: m.externalId,
    postDate: m.postDate.toISOString(),
    transactionDate: m.transactionDate?.toISOString() ?? null,
    amount: m.amount,
    currency: m.currency,
    direction: m.direction,
    description: m.description,
    balanceAfter: m.balanceAfter,
    counterpartyName: m.counterpartyName,
    counterpartyRut: m.counterpartyRut,
    counterpartyBank: m.counterpartyBank,
    branchLabel: m.branchLabel,
    txType: m.txType,
  };
}
