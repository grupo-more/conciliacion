import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getDifMenorSettings } from "@/lib/dif-menor/detect";
import { parseGlosa } from "@/lib/consolidados/glosa";
import { detectInterno, loadEntidadesInternas } from "@/lib/internos/detect";
import { usoParcialAccountWhere } from "@/lib/cuentas/uso-parcial";
import { excluirFueraAlcanceWhere } from "@/lib/consolidados/scope";

/** Ventana de fechas para considerar dos tesorerías parte del mismo
 *  depósito agrupado. Match estricto: misma semana. */
const SPLIT_GROUP_WINDOW_DAYS = 7;

/** Máximo tamaño de grupo de tesorerías candidatas para la búsqueda de
 *  combinaciones (pares y tripletas). Evita explosión combinatoria. */
const SPLIT_GROUP_MAX_SIZE = 8;

/**
 * GET /api/consolidados/compare
 *
 * Devuelve datos para la vista comparativa side-by-side:
 *  - bankMovements: BankMovements (IN) en el rango
 *  - tesoreriaMovements: TesoreriaMovements en el rango con su Consolidado
 *  - accounts: catalogo para filtros
 *
 * Por defecto solo los "abiertos" (NO_MATCH / REVIEW / OUT_OF_SCOPE para
 * Tesoreria, sin link para Bank). Con onlyUnmatched=false trae todos.
 *
 * Filtros:
 *  ?since=YYYY-MM-DD
 *  ?until=YYYY-MM-DD
 *  ?accountId=<uuid>   filtra BankMovements a una cuenta especifica
 *  ?banco=<string>     filtra Tesoreria por banco
 *  ?onlyUnmatched=true (default) o false
 *  ?hideInternal=true (default) o false
 *    Cuando true, oculta los BankMovements IN cuya contraparte detectada por
 *    el cascade de internos (counterpartyRut/Name → alias/RUT en glosa) cae
 *    en una EntidadInterna registrada. Esos movimientos no son ventas a
 *    cliente: son traspasos internos y tienen su asiento en la tab
 *    "Traspasos internos" — no se concilian contra Tesoreria.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const untilRaw = url.searchParams.get("until");
  const accountId = url.searchParams.get("accountId");
  const banco = (url.searchParams.get("banco") || "").trim();
  const onlyUnmatched = url.searchParams.get("onlyUnmatched") !== "false";
  const hideInternal = url.searchParams.get("hideInternal") !== "false";
  // Dirección del banco de trabajo:
  //   IN  (default) → Comparar Ingresos: cartola IN ↔ Tesorería INGRESO.
  //   OUT           → Comparar Egresos:  cartola OUT ↔ Tesorería EGRESO (Dynatech).
  // Los montos de OUT y EGRESO se guardan con el MISMO signo (ver
  // match-dynatech-terceros.ts), así que el balance de manual-link cuadra igual.
  const direction = url.searchParams.get("direction") === "OUT" ? "OUT" : "IN";
  const tipoOperacion = direction === "OUT" ? "EGRESO" : "INGRESO";

  // Default: ultimos 30 dias
  const now = new Date();
  const since = sinceRaw
    ? new Date(sinceRaw)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const until = untilRaw
    ? new Date(untilRaw + "T23:59:59")
    : new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Bank movements
  // Excluimos de Comparar tanto Transbank como las "diferencias menores":
  // ambos tienen asiento contable propio en Consolidados y no se concilian
  // contra Tesorería, así que no tienen nada que comparar acá.
  const difSettings = await getDifMenorSettings();
  const bankWhere: Prisma.BankMovementWhereInput = {
    direction,
    postDate: { gte: since, lte: until },
    ...(accountId ? { accountId } : {}),
    // Cuentas de uso parcial: no quedan disponibles para matchear acá (solo
    // importan sus traspasos internos).
    account: { isNot: usoParcialAccountWhere },
    // "Solo sin matchear": un movimiento de banco está RESUELTO (y sale de
    // Comparar) no solo por un link del motor, sino también si tiene un asiento
    // manual generado o ya está conciliado como egreso a tercero. Alineado con
    // la definición de "resuelto" de banco-compute.ts (Reportes / Asientos
    // manuales), para que no aparezca acá lo que en otro lado ya se dio por OK.
    ...(onlyUnmatched
      ? {
          consolidadoLinks: { none: {} },
          egresoConciliacionLinks: { none: {} },
          asientoManual: { is: null },
        }
      : {}),
    NOT: [
      {
        AND: [
          { description: { contains: "abn crd", mode: "insensitive" } },
          { description: { contains: "transba", mode: "insensitive" } },
        ],
      },
      {
        amount: { gt: 0n, lte: BigInt(difSettings.threshold) },
      },
    ],
  };
  const bankMovementsRaw = await prisma.bankMovement.findMany({
    where: bankWhere,
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
          alias: true,
        },
      },
      consolidadoLinks: {
        select: { consolidadoId: true },
        take: 1,
      },
      // Para el badge cuando "Solo sin matchear" está apagado: marcar los ya
      // resueltos por otra vía (asiento manual / egreso a tercero).
      asientoManual: { select: { estado: true } },
      egresoConciliacionLinks: { select: { conciliacionId: true }, take: 1 },
    },
    orderBy: [{ postDate: "desc" }, { amount: "desc" }],
    take: 1000,
  });

  // Filtro de internos: oculta los IN cuya contraparte matchea una entidad
  // interna activa. Se hace en JS (no en where) porque el detector usa
  // cascada con regex/parseo de glosa que no es expresable en Prisma.
  // Defensivo: si no hay entidades cargadas o el filtro esta apagado,
  // bankMovements queda igual a la query original — cero impacto.
  let bankMovements = bankMovementsRaw;
  if (hideInternal) {
    try {
      const entidades = await loadEntidadesInternas(prisma);
      if (entidades.length > 0) {
        bankMovements = bankMovementsRaw.filter(
          (bm) => !detectInterno(bm, entidades),
        );
      }
    } catch (e) {
      // Si falla la carga de entidades por cualquier motivo, NO rompemos
      // Comparar — solo logueamos y devolvemos todos los movs como si el
      // filtro no estuviera tildado.
      console.error("[compare] error filtrando internos:", e);
    }
  }

  // Tesoreria movements
  // Comparar es el banco de trabajo de INGRESOS (Tesoreria IN <-> cartola IN).
  // Los egresos se concilian contra cartola OUT por el motor y se revisan en
  // las tabs de egresos internos/terceros, asi que no se mezclan aca.
  const tesoreriaWhere = {
    fecha: { gte: since, lte: until },
    tipoOperacion,
    // Anulados en origen no son candidatos para comparar/conciliar.
    estadoActual: { not: "ANU" },
    // Ventas con tarjeta (claseOperacion="TBK"): NO se concilian acá. Llegan
    // duplicadas desde /api/dynatech, pero su cuadre real es POS (TbkTesoreria)
    // ↔ settlement (TransbankSale) en la tab "Cruce Transbank". Excluirlas evita
    // que aparezcan como ingresos "sin matchear" redundantes — mismo criterio que
    // del lado banco, donde se excluyen los abonos Transbank de la cartola.
    // (En Prisma, `not` deja pasar los null, así que las clases vacías se mantienen.)
    claseOperacion: { not: "TBK" },
    // Fuera de alcance (COMPRA CUENTA APP MORE GIROS): no se muestran ni cuadran.
    ...excluirFueraAlcanceWhere,
    ...(banco ? { banco } : {}),
    ...(onlyUnmatched
      ? {
          OR: [
            { consolidado: null },
            {
              consolidado: {
                status: { in: ["NO_MATCH", "REVIEW", "OUT_OF_SCOPE"] },
              },
            },
          ],
        }
      : {}),
  } as const;
  const tesoreriaMovements = await prisma.tesoreriaMovement.findMany({
    where: tesoreriaWhere,
    include: {
      consolidado: {
        select: { id: true, status: true, score: true, matchType: true },
      },
    },
    orderBy: [{ fecha: "desc" }, { monto: "desc" }],
    take: 1000,
  });

  // Catalogo de cuentas para filtros (sin las de uso parcial: no se matchean acá)
  const accounts = await prisma.bankAccount.findMany({
    where: { active: true, NOT: usoParcialAccountWhere },
    select: {
      id: true,
      bankCode: true,
      bankName: true,
      accountNumber: true,
      displayNumber: true,
      holderName: true,
      alias: true,
    },
    orderBy: [{ bankCode: "asc" }, { accountNumber: "asc" }],
  });

  // Bancos distintos en Tesoreria (para filtro)
  const bancosRows = await prisma.tesoreriaMovement.findMany({
    where: { banco: { not: null } },
    select: { banco: true },
    distinct: ["banco"],
  });
  const bancos = bancosRows.map((b) => b.banco!).filter(Boolean).sort();

  // Rubro sugerido por cuenta bancaria. Se infiere SOLO desde info de la
  // cartola (no de TesoreriaMovement.rubroBanco que puede estar mal cuando
  // la sucursal tipeó mal el banco). Estrategia en 2 niveles:
  //
  //   1) Override previo: si el operador ya hizo overrides en matches anteriores
  //      para esta cuenta, sugerimos el rubro más usado (la moda de overrides).
  //
  //   2) Match por nombre del catálogo: buscar un RubroLabel cuyo `name`
  //      contenga el bankName + holderName de la cuenta (ej. cuenta BCI ME SPA
  //      matchea con rubro "BCI ME"). Excluye los rubros marcados como
  //      isDifference (esos son para ajustes, no para banco/sucursal).
  //
  // Si ninguna estrategia da resultado, no hay sugerencia y el operador elige.
  const accountIdsInUse = Array.from(
    new Set(bankMovements.map((bm) => bm.accountId))
  );

  const suggestedRubroByAccount = new Map<string, number>();

  // (1) Aprendizaje por overrides previos
  const historico =
    accountIdsInUse.length > 0
      ? await prisma.consolidado.findMany({
          where: {
            status: { in: ["AUTO_MATCHED", "MANUAL"] },
            resolvedAccountId: { in: accountIdsInUse },
            overrideRubroBanco: { not: null },
          },
          select: {
            resolvedAccountId: true,
            overrideRubroBanco: true,
          },
        })
      : [];
  const counts = new Map<string, Map<number, number>>();
  for (const c of historico) {
    const accId = c.resolvedAccountId;
    const rubro = c.overrideRubroBanco;
    if (!accId || rubro === null) continue;
    if (!counts.has(accId)) counts.set(accId, new Map());
    const m = counts.get(accId)!;
    m.set(rubro, (m.get(rubro) ?? 0) + 1);
  }
  for (const [accId, rubroCounts] of counts) {
    let best: number | null = null;
    let bestCount = 0;
    for (const [rubro, count] of rubroCounts) {
      if (count > bestCount) {
        bestCount = count;
        best = rubro;
      }
    }
    if (best !== null) suggestedRubroByAccount.set(accId, best);
  }

  // (2) Match por nombre del catálogo para las cuentas que no tienen
  // override previo.
  const accountsWithoutSuggestion = accountIdsInUse.filter(
    (id) => !suggestedRubroByAccount.has(id)
  );
  if (accountsWithoutSuggestion.length > 0) {
    // Cargar info de las cuentas (necesitamos holderName + bankName) y los
    // rubros candidatos (los no-isDifference).
    const [accDetails, rubrosCat] = await Promise.all([
      prisma.bankAccount.findMany({
        where: { id: { in: accountsWithoutSuggestion } },
        select: {
          id: true,
          bankName: true,
          holderName: true,
        },
      }),
      prisma.rubroLabel.findMany({
        where: { isDifference: false },
        select: { rubro: true, name: true },
      }),
    ]);
    const norm = (s: string) =>
      s.toLowerCase().replace(/\s+/g, " ").trim();
    for (const acc of accDetails) {
      const accKey = norm(`${acc.bankName} ${acc.holderName}`);
      // Buscamos el rubro cuyo nombre normalizado matchee el accKey (igualdad
      // exacta primero, luego "contains" en cualquier dirección).
      const exact = rubrosCat.find((r) => norm(r.name) === accKey);
      if (exact) {
        suggestedRubroByAccount.set(acc.id, exact.rubro);
        continue;
      }
      const partial = rubrosCat.find((r) => {
        const rn = norm(r.name);
        return rn.length >= 3 && (accKey.includes(rn) || rn.includes(accKey));
      });
      if (partial) suggestedRubroByAccount.set(acc.id, partial.rubro);
    }
  }

  // === Detección de candidatos a split inverso ===
  //
  // Para cada BankMovement sin match (consolidadoLinks vacío), buscamos
  // combinaciones de 2 o 3 TesoreriaMovements sin matchear que:
  //   - Comparten clienteRut (≠ "55555555-5", el RUT genérico)
  //   - Comparten banco (string exacto del feed Tesorería)
  //   - Caen en una ventana de ±SPLIT_GROUP_WINDOW_DAYS alrededor del postDate del BM
  //   - Su suma == bm.amount
  //
  // Los grupos se exponen como pistas en la UI (badge "Posible depósito
  // agrupado"). El operador sigue cerrando el match manual con allocations
  // — esto solo es descubrimiento.
  //
  // Se prioriza el grupo más chico (N=2 antes que N=3) y el más cercano en
  // fecha al BM. Solo se reporta UNA sugerencia por bm/por tesorería para no
  // saturar la UI.

  const unmatchedBms = bankMovements.filter(
    (bm) => bm.consolidadoLinks.length === 0
  );
  // Tesorerías sin matchear (status NO_MATCH/REVIEW/OUT_OF_SCOPE o sin
  // consolidado). El campo `consolidado` puede ser null o tener un status
  // abierto.
  const unmatchedTms = tesoreriaMovements.filter((t) => {
    const st = t.consolidado?.status;
    return !st || ["NO_MATCH", "REVIEW", "OUT_OF_SCOPE"].includes(st);
  });

  // Indexar tesorerías sin matchear por (rut|banco)
  const tmsByGroup = new Map<string, typeof unmatchedTms>();
  for (const t of unmatchedTms) {
    const rut = (t.clienteRut ?? "").trim();
    const banco = (t.banco ?? "").trim();
    if (!rut || rut === "55555555-5" || !banco) continue;
    const key = `${rut}|${banco.toLowerCase()}`;
    const arr = tmsByGroup.get(key) ?? [];
    arr.push(t);
    tmsByGroup.set(key, arr);
  }

  // Para reportar cada bm y cada tesorería como máximo en una sugerencia.
  const bmHasSuggestion = new Set<string>();
  const tmHasSuggestion = new Set<string>();
  interface SuggestionEntry {
    bankMovementId: string;
    tesoreriaIds: string[];
    totalAmount: string;
    clienteRut: string;
    banco: string;
  }
  const suggestions: SuggestionEntry[] = [];

  const dayMs = 24 * 60 * 60 * 1000;
  for (const bm of unmatchedBms) {
    if (bmHasSuggestion.has(bm.id)) continue;
    const bmDate = bm.postDate.getTime();
    const bmAmount = bm.amount;

    // Recorremos cada grupo (cliente+banco) buscando combinaciones que sumen
    // bm.amount dentro de la ventana.
    for (const [, group] of tmsByGroup) {
      if (group.length < 2) continue;
      // Filtramos a la ventana del bm y a tesorerías no ya sugeridas.
      const inWindow = group.filter((t) => {
        if (tmHasSuggestion.has(t.id)) return false;
        const d = t.fecha.getTime();
        return Math.abs(d - bmDate) <= SPLIT_GROUP_WINDOW_DAYS * dayMs;
      });
      if (inWindow.length < 2) continue;
      // Capamos el tamaño del grupo para no explotar combinaciones.
      const capped = inWindow.slice(0, SPLIT_GROUP_MAX_SIZE);

      // Pares
      let found: typeof unmatchedTms | null = null;
      outer: for (let i = 0; i < capped.length; i++) {
        for (let j = i + 1; j < capped.length; j++) {
          const aMonto = BigInt(capped[i].monto);
          const bMonto = BigInt(capped[j].monto);
          if (aMonto + bMonto === bmAmount) {
            found = [capped[i], capped[j]];
            break outer;
          }
        }
      }
      // Tripletas si no hubo par
      if (!found && capped.length >= 3) {
        outer3: for (let i = 0; i < capped.length; i++) {
          for (let j = i + 1; j < capped.length; j++) {
            for (let k = j + 1; k < capped.length; k++) {
              const a = BigInt(capped[i].monto);
              const b = BigInt(capped[j].monto);
              const c = BigInt(capped[k].monto);
              if (a + b + c === bmAmount) {
                found = [capped[i], capped[j], capped[k]];
                break outer3;
              }
            }
          }
        }
      }

      if (found) {
        const first = found[0];
        suggestions.push({
          bankMovementId: bm.id,
          tesoreriaIds: found.map((t) => t.id),
          totalAmount: bmAmount.toString(),
          clienteRut: first.clienteRut ?? "",
          banco: first.banco ?? "",
        });
        bmHasSuggestion.add(bm.id);
        for (const t of found) tmHasSuggestion.add(t.id);
        break; // pasar al siguiente bm
      }
    }
  }

  // Mapas para que el cliente sepa rápido si un tm/bm está sugerido
  const suggestionByBmId = new Map<string, SuggestionEntry>();
  const suggestionByTmId = new Map<string, SuggestionEntry>();
  for (const s of suggestions) {
    suggestionByBmId.set(s.bankMovementId, s);
    for (const tid of s.tesoreriaIds) suggestionByTmId.set(tid, s);
  }

  return NextResponse.json({
    bankMovements: bankMovements.map((bm) => {
      const sg = suggestionByBmId.get(bm.id);
      return {
        id: bm.id,
        postDate: bm.postDate.toISOString(),
        amount: bm.amount.toString(),
        description: bm.description,
        counterpartyName: bm.counterpartyName,
        counterpartyRut: bm.counterpartyRut,
        account: {
          ...bm.account,
          suggestedRubro: suggestedRubroByAccount.get(bm.accountId) ?? null,
        },
        isLinked: bm.consolidadoLinks.length > 0,
        // Resuelto por otra vía (visible cuando se muestran todos): asiento
        // manual generado o egreso a tercero ya conciliado.
        resueltoPor:
          bm.asientoManual?.estado === "GENERADO"
            ? ("asiento" as const)
            : bm.egresoConciliacionLinks.length > 0
              ? ("egreso" as const)
              : null,
        suggestedSplit: sg
          ? {
              tesoreriaIds: sg.tesoreriaIds,
              totalAmount: sg.totalAmount,
              clienteRut: sg.clienteRut,
              banco: sg.banco,
            }
          : null,
      };
    }),
    tesoreriaMovements: tesoreriaMovements.map((t) => {
      const parsed = parseGlosa(t.glosa);
      const sg = suggestionByTmId.get(t.id);
      return {
        id: t.id,
        externalId: t.externalId.toString(),
        fecha: t.fecha.toISOString(),
        monto: t.monto.toString(),
        glosa: t.glosa,
        banco: t.banco,
        clienteName: t.clienteName,
        clienteRut: t.clienteRut,
        sucursalName: t.sucursalName,
        esExcepcion: t.esExcepcion,
        consolidado: t.consolidado,
        glosaParsed: {
          isMultiPart: parsed.isMultiPart,
          partNumber: parsed.partNumber,
        },
        suggestedSplit: sg
          ? {
              bankMovementId: sg.bankMovementId,
              tesoreriaIds: sg.tesoreriaIds,
              totalAmount: sg.totalAmount,
            }
          : null,
      };
    }),
    accounts,
    bancos,
    range: {
      since: since.toISOString(),
      until: until.toISOString(),
    },
  });
}
