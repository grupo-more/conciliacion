import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/tesoreria/report
 *
 * Reporte cruzado para identificar visualmente que rubroSucursal apunta a
 * que rubroBanco. La salida es una matriz agrupada por `groupBy` (default
 * rubro-vs-rubro) que sirve tanto para tabla como para heatmap.
 *
 *   ?groupBy=rubro | banco | sucursal
 *     - rubro:    rubroSucursal x rubroBanco  (default; el reporte principal)
 *     - banco:    bancoSucursal x bancoDetectado
 *     - sucursal: sucursalName x banco
 *
 *   Filtros (mismos que /movements):
 *     ?since, ?until, ?excepcion, ?sucursalId, ?banco, ?cajero, ?q
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const groupBy = (url.searchParams.get("groupBy") || "rubro") as
    | "rubro"
    | "banco"
    | "sucursal";

  const where = buildWhere(url);

  // Traemos solo las columnas que necesitamos. groupBy de Prisma con _sum
  // no soporta varios campos arbitrarios facilmente cuando hay NULLs en la
  // clave, asi que hacemos el agrupado en memoria sobre el dataset filtrado.
  const rows = await prisma.tesoreriaMovement.findMany({
    where,
    select: {
      rubroBanco: true,
      rubroSucursal: true,
      banco: true,
      bancoSucursal: true,
      bancoDetectado: true,
      sucursalId: true,
      sucursalName: true,
      monto: true,
      esExcepcion: true,
    },
  });

  // Etiquetas humanas de rubros (RubroLabel se comparte con Dynatech).
  const rubroLabels = await prisma.rubroLabel.findMany({
    select: { rubro: true, name: true },
  });
  const labelByRubro = new Map(rubroLabels.map((l) => [l.rubro, l.name]));

  // Fallback automatico para columnas del informe rubro: para cada rubroBanco,
  // calcular el `banco` mas frecuente entre los movimientos con ese rubro.
  // Asi, si el usuario no configuro un nombre en Configuracion -> Rubros, el
  // header de columna muestra el nombre del banco que la API ya trae (ej.
  // "Santander ME", "BCI ME") en vez de un numero seco.
  const bancoCountByRubroBanco = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (r.rubroBanco !== null && r.banco) {
      let m = bancoCountByRubroBanco.get(r.rubroBanco);
      if (!m) {
        m = new Map();
        bancoCountByRubroBanco.set(r.rubroBanco, m);
      }
      m.set(r.banco, (m.get(r.banco) ?? 0) + 1);
    }
  }
  const bancoByRubroBanco = new Map<number, string>();
  for (const [rubro, counts] of bancoCountByRubroBanco.entries()) {
    let bestBanco: string | null = null;
    let bestCount = 0;
    for (const [b, c] of counts.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestBanco = b;
      }
    }
    if (bestBanco) bancoByRubroBanco.set(rubro, bestBanco);
  }

  // Construir matriz dinamicamente segun groupBy.
  const keyExtractor = (
    r: (typeof rows)[number]
  ): { rowKey: string; rowLabel: string; colKey: string; colLabel: string } => {
    if (groupBy === "banco") {
      const rowKey = r.bancoSucursal ?? "__null__";
      // El "(sin banco detectado)" es el caso NORMAL — la API no detecto nada
      // raro, el movimiento va al banco que la sucursal tenia asignado. Lo
      // etiquetamos como "Normal" para que sea evidente que no es un problema.
      const colKey = r.bancoDetectado ?? "__normal__";
      return {
        rowKey,
        rowLabel: r.bancoSucursal ?? "(sin banco sucursal)",
        colKey,
        colLabel: r.bancoDetectado ?? "Normal · sin detección",
      };
    }
    if (groupBy === "sucursal") {
      const rowKey = String(r.sucursalId);
      const colKey = r.banco ?? "__null__";
      return {
        rowKey,
        rowLabel: r.sucursalName ?? `#${r.sucursalId}`,
        colKey,
        colLabel: r.banco ?? "(sin banco)",
      };
    }
    // rubro (default)
    const rowKey = r.rubroSucursal === null ? "__null__" : String(r.rubroSucursal);
    const colKey = r.rubroBanco === null ? "__null__" : String(r.rubroBanco);
    return {
      rowKey,
      // Filas (rubroSucursal): mantienen formato "numero - nombre" cuando hay
      // nombre configurado en Configuracion -> Rubros, si no, solo el numero.
      rowLabel:
        r.rubroSucursal === null
          ? "(sin rubro sucursal)"
          : labelByRubro.get(r.rubroSucursal)
          ? `${r.rubroSucursal} - ${labelByRubro.get(r.rubroSucursal)}`
          : `${r.rubroSucursal}`,
      colKey,
      // Columnas (rubroBanco): mostrar solo el nombre. Preferencia:
      //   1. Nombre configurado en Configuracion -> Rubros
      //   2. Banco que viene del feed (ej. "Santander ME")
      //   3. Numero del rubro como ultimo recurso
      colLabel:
        r.rubroBanco === null
          ? "(sin rubro banco)"
          : labelByRubro.get(r.rubroBanco) ??
            bancoByRubroBanco.get(r.rubroBanco) ??
            String(r.rubroBanco),
    };
  };

  // cell[rowKey][colKey] = { count, total, excepciones }
  type Cell = {
    count: number;
    total: number;
    excepciones: number;
    rowLabel: string;
    colLabel: string;
  };
  const cells = new Map<string, Map<string, Cell>>();
  const rowLabels = new Map<string, string>();
  const colLabels = new Map<string, string>();

  let grandTotal = 0;
  let grandCount = 0;
  let grandExcepciones = 0;

  for (const r of rows) {
    const k = keyExtractor(r);
    rowLabels.set(k.rowKey, k.rowLabel);
    colLabels.set(k.colKey, k.colLabel);

    let rowMap = cells.get(k.rowKey);
    if (!rowMap) {
      rowMap = new Map();
      cells.set(k.rowKey, rowMap);
    }
    let cell = rowMap.get(k.colKey);
    if (!cell) {
      cell = { count: 0, total: 0, excepciones: 0, rowLabel: k.rowLabel, colLabel: k.colLabel };
      rowMap.set(k.colKey, cell);
    }
    const amt = Number(r.monto);
    cell.count++;
    cell.total += amt;
    if (r.esExcepcion) cell.excepciones++;

    grandCount++;
    grandTotal += amt;
    if (r.esExcepcion) grandExcepciones++;
  }

  // Convertir a estructura serializable + ordenada.
  // Orden: por "total" desc para que las celdas mas grandes salgan primero.
  const rowList = Array.from(rowLabels.entries())
    .map(([key, label]) => {
      const rowMap = cells.get(key);
      let rowTotal = 0;
      let rowCount = 0;
      let rowExc = 0;
      if (rowMap) {
        for (const c of rowMap.values()) {
          rowTotal += c.total;
          rowCount += c.count;
          rowExc += c.excepciones;
        }
      }
      return { key, label, total: rowTotal, count: rowCount, excepciones: rowExc };
    })
    .sort((a, b) => b.total - a.total);

  const colList = Array.from(colLabels.entries())
    .map(([key, label]) => {
      let colTotal = 0;
      let colCount = 0;
      let colExc = 0;
      for (const rowMap of cells.values()) {
        const c = rowMap.get(key);
        if (c) {
          colTotal += c.total;
          colCount += c.count;
          colExc += c.excepciones;
        }
      }
      return { key, label, total: colTotal, count: colCount, excepciones: colExc };
    })
    .sort((a, b) => b.total - a.total);

  const matrix = rowList.map((row) => ({
    rowKey: row.key,
    rowLabel: row.label,
    rowTotal: row.total,
    rowCount: row.count,
    rowExcepciones: row.excepciones,
    cells: colList.map((col) => {
      const cell = cells.get(row.key)?.get(col.key);
      return {
        colKey: col.key,
        count: cell?.count ?? 0,
        total: cell?.total ?? 0,
        excepciones: cell?.excepciones ?? 0,
      };
    }),
  }));

  return NextResponse.json({
    groupBy,
    rows: rowList,
    cols: colList,
    matrix,
    grand: {
      count: grandCount,
      total: grandTotal,
      excepciones: grandExcepciones,
    },
  });
}

function buildWhere(url: URL): Prisma.TesoreriaMovementWhereInput {
  const sucursalId = url.searchParams.get("sucursalId");
  const cajero = url.searchParams.get("cajero");
  const banco = url.searchParams.get("banco");
  const excepcionRaw = url.searchParams.get("excepcion");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const search = url.searchParams.get("q");

  const where: Prisma.TesoreriaMovementWhereInput = {};
  if (sucursalId) {
    const n = parseInt(sucursalId, 10);
    if (!Number.isNaN(n)) where.sucursalId = n;
  }
  if (cajero) where.cajeroUsername = cajero.toUpperCase();
  if (banco) where.banco = banco;
  if (excepcionRaw === "1") where.esExcepcion = true;
  else if (excepcionRaw === "0") where.esExcepcion = false;

  if (since || until) {
    where.fecha = {};
    if (since) (where.fecha as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.fecha as Prisma.DateTimeFilter).lt = end;
    }
  }
  if (search && search.trim() !== "") {
    where.OR = [
      { glosa: { contains: search, mode: "insensitive" } },
      { sucursalName: { contains: search, mode: "insensitive" } },
      { cajeroUsername: { contains: search, mode: "insensitive" } },
      { banco: { contains: search, mode: "insensitive" } },
    ];
  }
  return where;
}
