import type { CuadraturaSettings } from "./settings";

/**
 * Construye el asiento de cuadratura Transbank a partir de los pares
 * conciliados (uno por par POS↔settlement). Agrupa por sucursal y arma:
 *
 *  1. Un asiento de 4 líneas POR SUCURSAL:
 *       HABER rubroVentas (17)      = Σ Dynatech (bruto POS)
 *       DEBE  rubroTesoreria (200)  = Σ Transbank (total abono neto)
 *       DEBE  rubroComision (708)   = Σ comisión + IVA comisión
 *       DEBE/HABER rubroDiferencia (1403) = Dynatech − Transbank − comisión
 *         (tapón que cuadra; va al haber si da negativo)
 *
 *  2. Un asiento de CONSOLIDACIÓN (según el correo del encargado):
 *       DEBE  rubroVentas (17)             = Σ Dynatech total
 *       HABER por sucursal (código Dynatech) = Σ Transbank (neto) de la sucursal
 *     Nota: este segundo asiento, tal como está descrito, no necesariamente
 *     cuadra (debe = ΣDynatech, haber = ΣTransbank). Mostramos ambos totales.
 */

export interface CuadraturaItemInput {
  sucursalId: number;
  sucursalName: string | null;
  sucursalCodigo: number | null;
  montoDynatech: bigint; // bruto POS
  montoTransbank: bigint; // total abono (neto)
  montoComision: bigint; // comisión cartola (comision + IVA) → base 1403
  montoComisionApi: bigint; // comisión Dynatech/API (con IVA) → rubro 708
  // Detalle por movimiento (para el desglose auditable). Opcional.
  tbkTesoreriaId?: string;
  transbankSaleId?: string;
  fecha?: string | null; // ISO
  opBoleta?: string | null;
  medioPago?: string | null;
}

export interface MovimientoDTO {
  tbkTesoreriaId: string | null;
  transbankSaleId: string | null;
  fecha: string | null;
  opBoleta: string | null;
  medioPago: string | null;
  dynatech: string; // bruto POS (boleta)
  transbankBruto: string; // monto liquidado por Transbank (neto + comisión cartola)
  transbank: string; // total abono (neto) → 200
  comisionApi: string; // Dynatech → 708
  comisionCartola: string; // settlement
  difMonto: string; // Transbank bruto − Dynatech (boleta) — diferencia de monto
  diferencia: string; // aporte al 1403 = dynatech − neto − comisión API (con signo)
}

export type AsientoSide = "DEBE" | "HABER";

export interface AsientoLineaDTO {
  rubro: number;
  cuenta: string | null;
  detalle: string;
  side: AsientoSide;
  debe: string | null;
  haber: string | null;
}

export interface SucursalAsientoDTO {
  sucursalId: number;
  sucursalName: string | null;
  sucursalCodigo: number | null;
  dynatech: string;
  transbank: string;
  comisionApi: string; // → 708
  comisionCartola: string;
  diferencia: string; // comisión cartola − comisión API (con signo) → 1403
  count: number;
  lineas: AsientoLineaDTO[];
  movimientos: MovimientoDTO[];
}

export interface ConsolidacionDTO {
  lineas: AsientoLineaDTO[];
  totalDebe: string;
  totalHaber: string;
  balanceado: boolean;
}

export interface CuadraturaAsientoDTO {
  sucursales: SucursalAsientoDTO[];
  consolidacion: ConsolidacionDTO;
  totals: {
    dynatech: string;
    transbank: string;
    comisionApi: string;
    comisionCartola: string;
    diferencia: string;
    debe: string;
    haber: string;
  };
}

const abs = (n: bigint) => (n < 0n ? -n : n);

export function buildCuadraturaAsiento(
  items: CuadraturaItemInput[],
  settings: CuadraturaSettings,
): CuadraturaAsientoDTO {
  // Agrupar por sucursal.
  const groups = new Map<
    number,
    {
      sucursalId: number;
      sucursalName: string | null;
      sucursalCodigo: number | null;
      dynatech: bigint;
      transbank: bigint;
      comisionApi: bigint;
      comisionCartola: bigint;
      c708: bigint; // lo que va al rubro 708 (API si vino, si no la cartola)
      count: number;
      movimientos: MovimientoDTO[];
    }
  >();

  for (const it of items) {
    let g = groups.get(it.sucursalId);
    if (!g) {
      g = {
        sucursalId: it.sucursalId,
        sucursalName: it.sucursalName,
        sucursalCodigo: it.sucursalCodigo,
        dynatech: 0n,
        transbank: 0n,
        comisionApi: 0n,
        comisionCartola: 0n,
        c708: 0n,
        count: 0,
        movimientos: [],
      };
      groups.set(it.sucursalId, g);
    }
    const dyn = abs(it.montoDynatech);
    // 708 = comisión API si vino; si no (débito sin comisión API) = comisión cartola.
    // 1403 = comisión cartola − lo que fue al 708 (la diferencia API↔cartola).
    const c708i = it.montoComisionApi > 0n ? it.montoComisionApi : it.montoComision;
    g.dynatech += dyn;
    g.transbank += it.montoTransbank;
    g.comisionApi += it.montoComisionApi;
    g.comisionCartola += it.montoComision;
    g.c708 += c708i;
    g.count += 1;
    const transbankBruto = it.montoTransbank + it.montoComision; // neto + comisión cartola
    g.movimientos.push({
      tbkTesoreriaId: it.tbkTesoreriaId ?? null,
      transbankSaleId: it.transbankSaleId ?? null,
      fecha: it.fecha ?? null,
      opBoleta: it.opBoleta ?? null,
      medioPago: it.medioPago ?? null,
      dynatech: dyn.toString(),
      transbankBruto: transbankBruto.toString(),
      transbank: it.montoTransbank.toString(),
      comisionApi: it.montoComisionApi.toString(),
      comisionCartola: it.montoComision.toString(),
      difMonto: (transbankBruto - dyn).toString(),
      // Por movimiento: al 708 va el recargo (difMonto); al 1403 "Diferencia" va
      // c708 − recargo (= comisión de débito; en crédito da 0).
      diferencia: (c708i - (transbankBruto - dyn)).toString(),
    });
    // El nombre/código pueden venir nulos en algún par; rellenamos si aparecen.
    if (!g.sucursalName && it.sucursalName) g.sucursalName = it.sucursalName;
    if (g.sucursalCodigo == null && it.sucursalCodigo != null) g.sucursalCodigo = it.sucursalCodigo;
  }

  const ordered = [...groups.values()].sort(
    (a, b) => (a.sucursalCodigo ?? a.sucursalId) - (b.sucursalCodigo ?? b.sucursalId),
  );

  let totDynatech = 0n;
  let totVentas = 0n; // neto + comisión cartola (= bruto Transbank)
  let totTransbank = 0n;
  let totComisionApi = 0n;
  let totComisionCartola = 0n;
  let totDiferencia = 0n;
  let totDebe = 0n;
  let totHaber = 0n;

  const sucursales: SucursalAsientoDTO[] = ordered.map((g) => {
    // Modelo (CUADRA con 3 líneas de comisión):
    //   17 Ventas (H)            = neto + comisión cartola (= bruto Transbank)
    //   200 Tesorería (D)        = neto
    //   708 Comisión (D)         = Σ recargo (bruto − boleta = el 2% del crédito)
    //   1403 Diferencia (D)      = comisión por operación (c708) − recargo
    //   1403 Diferencia a favor(H)= c708 − comisión cartola (lo que ganamos: cobramos
    //                               2% en crédito y Transbank cobró menos)
    // Las 3 últimas hacen que cuadre: Debe = Haber.
    const ventas = g.transbank + g.comisionCartola; // bruto
    const recargo = ventas - g.dynatech; // Σ bruto − Σ boleta → 708
    const dif1403 = g.c708 - recargo; // → 1403 "Diferencia" (DEBE, comisión de débito)
    const favor = g.c708 - g.comisionCartola; // → 1403 "Diferencia a favor" (HABER si +)
    const cuenta = g.sucursalName ?? (g.sucursalCodigo != null ? `#${g.sucursalCodigo}` : `#${g.sucursalId}`);

    const lineas: AsientoLineaDTO[] = [
      {
        rubro: settings.rubroVentas,
        cuenta,
        detalle: "Ventas",
        side: "HABER",
        debe: null,
        haber: ventas.toString(),
      },
      {
        rubro: settings.rubroTesoreria,
        cuenta,
        detalle: "Tesorería",
        side: "DEBE",
        debe: g.transbank.toString(),
        haber: null,
      },
      {
        rubro: settings.rubroComision,
        cuenta,
        detalle: "Comisión Transbank",
        side: "DEBE",
        debe: recargo.toString(),
        haber: null,
      },
    ];
    // 1403 "Diferencia" (comisión que cobra Transbank por débito) — al debe.
    if (dif1403 !== 0n) {
      lineas.push({
        rubro: settings.rubroDiferencia,
        cuenta,
        detalle: "Diferencia",
        side: dif1403 >= 0n ? "DEBE" : "HABER",
        debe: dif1403 >= 0n ? dif1403.toString() : null,
        haber: dif1403 < 0n ? abs(dif1403).toString() : null,
      });
    }
    // 1403 "Diferencia a favor" (lo que ganamos en crédito) — al haber.
    if (favor !== 0n) {
      lineas.push({
        rubro: settings.rubroDiferencia,
        cuenta,
        detalle: favor > 0n ? "Diferencia a favor" : "Diferencia en contra",
        side: favor > 0n ? "HABER" : "DEBE",
        debe: favor < 0n ? abs(favor).toString() : null,
        haber: favor > 0n ? favor.toString() : null,
      });
    }

    // Totales (cuadra): debe = transbank + recargo + dif1403(si +) + favor(si −);
    //                   haber = ventas + favor(si +) + dif1403(si −).
    totDynatech += g.dynatech;
    totVentas += ventas;
    totTransbank += g.transbank;
    totComisionApi += g.comisionApi;
    totComisionCartola += g.comisionCartola;
    totDiferencia += dif1403 - favor;
    totDebe +=
      g.transbank + recargo + (dif1403 > 0n ? dif1403 : 0n) + (favor < 0n ? abs(favor) : 0n);
    totHaber += ventas + (favor > 0n ? favor : 0n) + (dif1403 < 0n ? abs(dif1403) : 0n);

    return {
      sucursalId: g.sucursalId,
      sucursalName: g.sucursalName,
      sucursalCodigo: g.sucursalCodigo,
      dynatech: g.dynatech.toString(),
      transbank: g.transbank.toString(),
      comisionApi: g.comisionApi.toString(),
      comisionCartola: g.comisionCartola.toString(),
      diferencia: diferencia.toString(),
      count: g.count,
      lineas,
      movimientos: g.movimientos.sort((a, b) => (b.fecha ?? "").localeCompare(a.fecha ?? "")),
    };
  });

  // Asiento de consolidación (según correo): DEBE rubro ventas (total Dynatech),
  // HABER por sucursal usando su código "Registro Dynatech" = total rubro 200.
  const consLineas: AsientoLineaDTO[] = [
    {
      rubro: settings.rubroVentas,
      cuenta: null,
      detalle: "Consolidado ventas",
      side: "DEBE",
      debe: totVentas.toString(),
      haber: null,
    },
    ...ordered.map<AsientoLineaDTO>((g) => ({
      rubro: g.sucursalCodigo ?? g.sucursalId,
      cuenta: g.sucursalName ?? (g.sucursalCodigo != null ? `#${g.sucursalCodigo}` : `#${g.sucursalId}`),
      detalle: "Tesorería sucursal",
      side: "HABER",
      debe: null,
      haber: g.transbank.toString(),
    })),
  ];
  const consDebe = totVentas;
  const consHaber = totTransbank;

  return {
    sucursales,
    consolidacion: {
      lineas: consLineas,
      totalDebe: consDebe.toString(),
      totalHaber: consHaber.toString(),
      balanceado: consDebe === consHaber,
    },
    totals: {
      dynatech: totDynatech.toString(),
      transbank: totTransbank.toString(),
      comisionApi: totComisionApi.toString(),
      comisionCartola: totComisionCartola.toString(),
      diferencia: totDiferencia.toString(),
      debe: totDebe.toString(),
      haber: totHaber.toString(),
    },
  };
}
