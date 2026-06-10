export interface TesoreriaMovementDTO {
  id: string;
  externalId: string;
  sucursalId: number;
  sucursalName: string | null;
  cajeroUsername: string;
  cajeroName: string | null;
  clienteName: string | null;
  clienteRut: string | null;
  folio: string;
  tipoDocumento: string | null;
  codigoDocumento: number;
  glosa: string;
  banco: string | null;
  bancoSucursal: string | null;
  bancoDetectado: string | null;
  rubroBanco: number | null;
  rubroSucursal: number | null;
  monto: string;
  fecha: string;
  fechaCarga: string | null;
  esExcepcion: boolean;
  estadoActual: string | null;
  anulado: boolean;
  items: unknown[];
  syncedAt: string;
}

export interface MovementsResponse {
  total: number;
  limit: number;
  offset: number;
  movements: TesoreriaMovementDTO[];
  facets: {
    sucursales: Array<{ id: number; name: string | null }>;
    cajeros: string[];
    bancos: Array<{ name: string; count: number }>;
    rubrosBanco: Array<{ rubro: number | null; name: string | null; count: number }>;
    rubrosSucursal: Array<{ rubro: number | null; name: string | null; count: number }>;
  };
}

export interface SyncStatusResponse {
  lastOk: {
    id: string;
    finishedAt: string | null;
    fetchedRows: number;
    insertedRows: number;
    updatedRows: number;
    skippedInvalid: number;
    fetchMs: number | null;
  } | null;
  lastAny: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
  } | null;
  totalMovements: number;
  totalExcepciones: number;
  dateRange: { from: string | null; to: string | null };
}

export interface SyncResult {
  ok: boolean;
  syncRunId?: string;
  fetchedRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedInvalid: number;
  fetchMs: number;
  error?: string;
  errorDetail?: string;
  skipped?: boolean;
  reason?: string;
}

export type GroupBy = "rubro" | "banco" | "sucursal";

export interface ReportResponse {
  groupBy: GroupBy;
  rows: Array<{
    key: string;
    label: string;
    total: number;
    count: number;
    excepciones: number;
  }>;
  cols: Array<{
    key: string;
    label: string;
    total: number;
    count: number;
    excepciones: number;
  }>;
  matrix: Array<{
    rowKey: string;
    rowLabel: string;
    rowTotal: number;
    rowCount: number;
    rowExcepciones: number;
    cells: Array<{
      colKey: string;
      count: number;
      total: number;
      excepciones: number;
    }>;
  }>;
  grand: { count: number; total: number; excepciones: number };
}
