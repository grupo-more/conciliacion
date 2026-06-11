/**
 * Prorrateo de un asiento manual: reparte un monto BRUTO entre sucursales según
 * su headcount (Nº de personas), y calcula la retención de honorarios.
 *
 * Reparto exacto al peso (método de mayor resto / largest remainder): se floorea
 * cada línea y los pesos sobrantes del redondeo se asignan a las líneas con
 * mayor resto, de modo que Σ líneas == monto bruto SIEMPRE (el DEBE cuadra con
 * el HABER sin descuadre por redondeo).
 *
 * headcount puede ser fraccionado (ej. 1.5); se escala ×100 (Decimal(6,2)) para
 * trabajar con pesos enteros y evitar errores de coma flotante.
 */

export interface ProrrateoInput {
  id: string;
  nombre: string;
  personas: number;
}

export interface ProrrateoLinea {
  id: string;
  nombre: string;
  personas: number;
  porcentaje: number; // ej. 14.04
  monto: bigint;
}

/** Reparte `montoBruto` (>= 0) entre sucursales por personas. */
export function prorratear(
  montoBruto: bigint,
  sucursales: ProrrateoInput[],
): ProrrateoLinea[] {
  const weights = sucursales.map((s) => BigInt(Math.round(s.personas * 100)));
  const totalW = weights.reduce((a, b) => a + b, 0n);

  if (totalW === 0n || montoBruto === 0n) {
    return sucursales.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      personas: s.personas,
      porcentaje: 0,
      monto: 0n,
    }));
  }

  const floors = weights.map((w) => (montoBruto * w) / totalW);
  const remainders = weights.map((w) => (montoBruto * w) % totalW);
  const allocated = floors.reduce((a, b) => a + b, 0n);
  let leftover = montoBruto - allocated; // pesos a repartir (< nº de líneas)

  // Índices ordenados por resto desc, luego peso desc, luego orden estable.
  const order = remainders
    .map((_, i) => i)
    .sort((a, b) => {
      if (remainders[a] !== remainders[b]) return remainders[a] > remainders[b] ? -1 : 1;
      if (weights[a] !== weights[b]) return weights[a] > weights[b] ? -1 : 1;
      return a - b;
    });

  const monto = floors.slice();
  let k = 0;
  while (leftover > 0n && order.length > 0) {
    monto[order[k % order.length]] += 1n;
    leftover -= 1n;
    k++;
  }

  return sucursales.map((s, i) => ({
    id: s.id,
    nombre: s.nombre,
    personas: s.personas,
    porcentaje: Number(((Number(weights[i]) / Number(totalW)) * 100).toFixed(4)),
    monto: monto[i],
  }));
}

/**
 * Retención de honorarios. El monto del banco es el LÍQUIDO (lo que recibe el
 * profesional), NO el bruto. La retención del SII es un % del BRUTO (boleta),
 * así que el bruto se obtiene haciendo "grossing up":
 *
 *   bruto      = liquido / (1 - tasa)
 *   retencion  = bruto - liquido   (= bruto * tasa)
 *
 * Ej: liquido 100.000 a 15.25% → bruto 117.994, retención 17.994 (coincide con
 * la calculadora de boletas del SII). NO es liquido * (1 + tasa).
 */
export function calcRetencion(
  montoLiquido: bigint,
  tasaPct: number,
): { montoRetencion: bigint; montoBruto: bigint } {
  if (!tasaPct || tasaPct <= 0) {
    return { montoRetencion: 0n, montoBruto: montoLiquido };
  }
  // bruto = round(liquido / (1 - tasa/100)) con bigint, escala 2 decimales de %.
  // 1 - tasa/100 = (100 - tasa)/100 → bruto = liquido * 100 / (100 - tasa).
  // Escalamos ×100 (centésimas de %): denom = 10000 - tasa*100.
  const tasaScaled = BigInt(Math.round(tasaPct * 100)); // tasa% en centésimas
  const denom = 10000n - tasaScaled;
  if (denom <= 0n) {
    // tasa >= 100% no tiene sentido; no aplicar retención.
    return { montoRetencion: 0n, montoBruto: montoLiquido };
  }
  const montoBruto = (montoLiquido * 10000n + denom / 2n) / denom; // redondeo
  const montoRetencion = montoBruto - montoLiquido;
  return { montoRetencion, montoBruto };
}
