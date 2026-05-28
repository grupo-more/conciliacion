export type ConsolidadoStatus =
  | "AUTO_MATCHED"
  | "MANUAL"
  | "SUGGESTED"
  | "REVIEW"
  | "NO_MATCH"
  | "OUT_OF_SCOPE"
  | "UNPROCESSED";

export interface AccountInfo {
  id: string;
  bankCode?: string;
  bankName: string;
  accountNumber: string;
  displayNumber?: string | null;
  holderName?: string;
  alias?: string | null;
}

export interface ConsolidadoLinkDTO {
  bankMovementId: string;
  postDate: string;
  amount: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  account: AccountInfo;
}

export interface ConsolidadoDTO {
  id: string;
  status: ConsolidadoStatus;
  matchType: string | null;
  score: number | null;
  notes: string | null;
  outOfScopeReason?: string | null;
  resolvedAccountId: string | null;
  links: ConsolidadoLinkDTO[];
}

export interface ConsolidadoRow {
  id: string; // tesoreria id
  externalId: string;
  fecha: string;
  monto: string;
  sucursalId: number;
  sucursalName: string | null;
  banco: string | null;
  bancoSucursal: string | null;
  bancoDetectado: string | null;
  esExcepcion: boolean;
  glosa: string;
  folio: string;
  clienteName: string | null;
  clienteRut: string | null;
  rubroSucursal: number | null;
  rubroBanco: number | null;
  consolidado: ConsolidadoDTO | null;
}

export interface OverviewResponse {
  period: "day" | "week" | "month";
  counts: Record<string, number>;
  rows: ConsolidadoRow[];
  facets: { bancos: string[] };
}

export interface CandidateDTO {
  bankMovementId: string;
  score: number;
  factors: Array<{ key: string; label: string; weight: number }>;
  postDate: string;
  amount: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  account: { id: string; bankName: string; accountNumber: string };
  /** True si la BD tiene otros BankMovements idénticos (mismo monto+día+ref+cuenta).
   *  El listado solo muestra un representante, pero los otros están en BD esperando
   *  ser limpiados con "Detectar duplicados". */
  duplicateInCartola?: boolean;
  duplicateCount?: number;
}

export interface DetailResponse {
  tesoreria: {
    id: string;
    externalId: string;
    fecha: string;
    monto: string;
    glosa: string;
    banco: string | null;
    bancoSucursal: string | null;
    bancoDetectado: string | null;
    esExcepcion: boolean;
    folio: string;
    sucursalId: number;
    sucursalName: string | null;
    cajeroUsername: string;
    cajeroName: string | null;
    clienteName: string | null;
    clienteRut: string | null;
    tipoDocumento: string | null;
    rubroSucursal: number | null;
    rubroBanco: number | null;
  };
  consolidado: ConsolidadoDTO | null;
  candidates: CandidateDTO[] | null;
}

/* ============================== Tab "OK" ============================== */

export interface OKRow {
  /** Identificador del asiento (consolidadoId). Filas con mismo groupId
   *  pertenecen al mismo movimiento conciliado. */
  groupId: string;
  side: "BANCO" | "SUCURSAL" | "AJUSTE";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  /** Nombre legible: rubroLabel si existe, sino fallback al banco/sucursal. */
  detalle: string;
  cliente: string;
  glosa: string;
  /** BigInt como string (positivo). null si no aplica a este lado. */
  debe: string | null;
  haber: string | null;
  // Trazabilidad
  consolidadoId: string;
  tesoreriaId: string;
  bankMovementId: string | null;
}

export interface OKResponse {
  from: string;
  to: string;
  rows: OKRow[];
  totals: { debe: string; haber: string };
  facets: {
    accounts: Array<{ id: string; label: string }>;
    rubrosSucursales: Array<{ rubro: number; label: string | null }>;
  };
}

export interface RunResult {
  ok: boolean;
  processed: number;
  autoMatched: number;
  suggested: number;
  review: number;
  noMatch: number;
  outOfScope: number;
  errors: number;
  ms: number;
}

export const STATUS_LABELS: Record<ConsolidadoStatus, string> = {
  AUTO_MATCHED: "Conciliado auto",
  MANUAL: "Conciliado manual",
  SUGGESTED: "Sugerido",
  REVIEW: "Revisar",
  NO_MATCH: "Sin match",
  OUT_OF_SCOPE: "Fuera de scope",
  UNPROCESSED: "Sin procesar",
};

export const STATUS_ORDER: ConsolidadoStatus[] = [
  "AUTO_MATCHED",
  "MANUAL",
  "SUGGESTED",
  "REVIEW",
  "NO_MATCH",
  "OUT_OF_SCOPE",
  "UNPROCESSED",
];

export const STATUS_COLORS: Record<ConsolidadoStatus, string> = {
  AUTO_MATCHED: "bg-emerald-100 text-emerald-800 border-emerald-200",
  MANUAL: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SUGGESTED: "bg-amber-100 text-amber-800 border-amber-200",
  REVIEW: "bg-orange-100 text-orange-800 border-orange-200",
  NO_MATCH: "bg-rose-100 text-rose-800 border-rose-200",
  OUT_OF_SCOPE: "bg-zinc-200 text-zinc-700 border-zinc-300",
  UNPROCESSED: "bg-sky-100 text-sky-800 border-sky-200",
};
