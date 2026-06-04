import type { BankParser, PdfBankParser } from "../types";
import { bciDetalladoParser } from "./bci-detallado";
import { santanderMovimientoParser } from "./santander-movimiento";
import { santanderHistoricaParser } from "./santander-historica";
import { santanderProvisoriaParser } from "./santander-provisoria";
import {
  internacionalProvisoriaParser,
  internacionalHistoricaParser,
} from "./internacional";
import { chileMovimientosParser } from "./chile";
import { chileCartolaParser } from "./chile-cartola";
import { mercadoPagoParser } from "./mercado-pago";

/**
 * Registro de parsers. Para agregar un nuevo banco/sub-formato:
 *  1. Crear el archivo del parser en este directorio.
 *  2. Importarlo aquí.
 *  3. Agregarlo al array.
 *
 * El detector recorre el array y devuelve el primer parser cuyo `matches()`
 * retorna true, así que si dos parsers pueden matchear, el orden importa.
 * En la práctica las firmas (nombre de hoja + celda A1) son disjuntas.
 */
export const PARSERS: BankParser[] = [
  bciDetalladoParser,
  santanderHistoricaParser,
  santanderProvisoriaParser,
  santanderMovimientoParser,
  internacionalHistoricaParser,
  internacionalProvisoriaParser,
  chileMovimientosParser,
  chileCartolaParser,
];

/**
 * Registro de parsers PDF. Hoy solo Mercado Pago; cualquier banco que
 * solo ofrezca cartola PDF cae aca.
 */
export const PDF_PARSERS: PdfBankParser[] = [mercadoPagoParser];
