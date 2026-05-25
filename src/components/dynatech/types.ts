export interface DynatechItem {
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  monto: number;
}

export interface DynatechMovementDTO {
  id: string;
  mCjId: string;
  branchExternalId: number;
  branchExternalName: string | null;
  cashierUsername: string;
  cashierName: string | null;
  customerName: string | null;
  customerRut: string | null;
  documentCode: number;
  documentType: string | null;
  documentFolio: string;
  observation: string;
  occurredAt: string;
  loadedAt: string | null;
  totalAmount: string;
  currency: string;
  rubro: number | null;
  items: DynatechItem[];
  syncedAt: string;
}

export interface MovementsResponse {
  total: number;
  limit: number;
  offset: number;
  movements: DynatechMovementDTO[];
  facets: {
    branches: Array<{ id: number; name: string | null }>;
    cashiers: string[];
    rubros: Array<{ rubro: number | null; name: string | null; count: number }>;
  };
}

export interface SyncStatusResponse {
  lastOk: {
    id: string;
    finishedAt: string | null;
    fetchedRows: number;
    insertedRows: number;
    skippedDuplicates: number;
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
  dateRange: {
    from: string | null;
    to: string | null;
  };
}

export interface SyncResult {
  ok: boolean;
  syncRunId?: string;
  fetchedRows: number;
  insertedRows: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  fetchMs: number;
  error?: string;
  errorDetail?: string;
  skipped?: boolean;
  reason?: string;
}
