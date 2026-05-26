import type { WorkBook } from "xlsx";

export type Direction = "IN" | "OUT";

export type ParserCode =
  | "BCI_DETALLADO"
  | "SANTANDER_MOVIMIENTO"
  | "SANTANDER_HISTORICA"
  | "SANTANDER_PROVISORIA"
  | "INTERNACIONAL_PROVISORIA"
  | "INTERNACIONAL_HISTORICA";

export type BankCode = "BCI" | "SANTANDER" | "INTERNACIONAL";

export interface ParsedAccountInfo {
  bankCode: BankCode;
  /** Número normalizado (solo dígitos, sin guiones ni ceros a la izquierda relevantes según banco) */
  accountNumber: string;
  /** Tal cual lo muestra el banco, para mostrar en UI */
  displayNumber?: string;
  holderName?: string;
  holderRut?: string;
  currency?: string;
}

export interface NormalizedMovement {
  /** ID del banco, si lo provee y es no-nulo. */
  externalId: string | null;
  /** Fecha contable (la que usa el banco para extracto). */
  postDate: Date;
  /** Fecha de transacción real, si el banco la trae separada. */
  transactionDate: Date | null;
  /** Monto con signo: positivo = abono, negativo = cargo. */
  amount: number;
  currency: string;
  direction: Direction;
  /** Glosa cruda. */
  description: string;
  /** Saldo después del movimiento, si el banco lo trae. */
  balanceAfter: number | null;

  counterpartyName: string | null;
  counterpartyRut: string | null;
  counterpartyAccount: string | null;
  counterpartyBank: string | null;

  branchLabel: string | null;
  txType: string | null;

  /** Fila original del Excel (objeto plano para JSONB). */
  rawRow: Record<string, unknown>;
}

export interface ParsedStatement {
  parserCode: ParserCode;
  account: ParsedAccountInfo;
  periodFrom: Date | null;
  periodTo: Date | null;
  movements: NormalizedMovement[];
  /** Filas que no se pudieron parsear; útil para logging y debugging. */
  errors: Array<{ rowIndex: number; reason: string; raw: unknown }>;
  /** Metadata libre para auditoría: empresa, ejecutivo, etc. */
  metadata: Record<string, unknown>;
}

export interface BankParser {
  code: ParserCode;
  bankCode: BankCode;
  bankName: string;
  /** Decide si el workbook corresponde a este parser. */
  matches(wb: WorkBook): boolean;
  /** Parsea el workbook y devuelve el resultado normalizado. */
  parse(wb: WorkBook): ParsedStatement;
}
