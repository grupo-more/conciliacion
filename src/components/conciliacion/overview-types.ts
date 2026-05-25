import type { AccountSlim, ReconciliationStatus } from "./types";

export type OverviewStatus =
  | ReconciliationStatus
  | "UNPROCESSED"
  | "UNPAIRED_BANK";

export interface OverviewKpis {
  conciliated: { count: number; sum: number };
  pending: { count: number; sum: number };
  outOfScope: { count: number; sum: number };
  unpairedBank: { count: number; sum: number };
}

export interface OverviewDynatech {
  id: string;
  reconciliationId: string | null;
  mCjId: string;
  branchExternalId: number;
  branchExternalName: string | null;
  cashierUsername: string;
  cashierName: string | null;
  customerName: string | null;
  customerRut: string | null;
  occurredAt: string;
  observation: string;
  totalAmount: string;
  currency: string;
  documentCode: number;
  documentFolio: string;
  items: Array<{ nombre: string; cantidad: number; precioUnitario: number; monto: number }>;
}

export interface OverviewBank {
  id: string;
  accountId: string;
  account: AccountSlim & { id: string };
  postDate: string;
  amount: string;
  currency: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  externalId: string | null;
}

export interface OverviewPairRow {
  kind: "PAIR";
  sortDate: string;
  dynatech: OverviewDynatech;
  status: OverviewStatus;
  matchType: string | null;
  outOfScopeReason: string | null;
  banks: OverviewBank[];
  banksSum: string;
}

export interface OverviewOrphanRow {
  kind: "BANK_ORPHAN";
  sortDate: string;
  status: "UNPAIRED_BANK";
  bank: OverviewBank;
}

export type OverviewRow = OverviewPairRow | OverviewOrphanRow;

export interface OverviewResponse {
  period: "day" | "week" | "month";
  range: { start: string; end: string; label: string };
  kpis: OverviewKpis;
  rows: OverviewRow[];
  facets: {
    branches: Array<{ id: number; name: string | null }>;
    accounts: Array<AccountSlim & { id: string }>;
    statuses: OverviewStatus[];
  };
  generatedAt: string;
}
