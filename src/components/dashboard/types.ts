export type Period = "day" | "week" | "month";

export interface KPIData {
  consolidatedBalance: number;
  consolidatedBalanceChange: number | null;
  consolidatedBalanceChangePct: number | null;
  totalIn: number;
  totalInPrev: number;
  totalOut: number;
  totalOutPrev: number;
  autoMatchRate: number;
  autoMatchRatePrev: number | null;
  ventasProcessed: number;
  ventasTotal: number;
}

export interface AccountBalance {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
  balance: number;
  balanceAtStart: number;
  lastMovementDate: string | null;
  daysSinceLastMovement: number | null;
  movementCountInPeriod: number;
  inSumInPeriod: number;
  inCountInPeriod: number;
  outSumInPeriod: number;
  outCountInPeriod: number;
  reconciledInSum: number;
  reconciledInCount: number;
  unreconciledInSum: number;
  unreconciledInCount: number;
  /** Alias legacy de unreconciledInSum, mantenido para BalancesTable existente. */
  otherInSum: number;
}

export interface PipelineData {
  total: number;
  totalProcessed: number;
  byStatus: {
    AUTO_MATCHED: number;
    SUGGESTED: number;
    REVIEW: number;
    MANUAL: number;
    NO_MATCH: number;
    OUT_OF_SCOPE: number;
    UNPROCESSED: number;
  };
  backlogOver7d: number;
}

export interface FlowsBucket {
  date: string;
  in: number;
  out: number;
  net: number;
  consolidatedBalance: number;
}

export interface BranchSummary {
  branchExternalId: number;
  branchExternalName: string | null;
  ventasCount: number;
  ventasTotal: number;
  matchedCount: number;
  matchRate: number;
}

export interface CashierSummary {
  cashierUsername: string;
  cashierName: string | null;
  ventasCount: number;
  ventasTotal: number;
  glosaQualityCounts: { excellent: number; good: number; fair: number; poor: number };
  glosaQualityScore: number;
}

export interface AlertItem {
  kind: "BACKLOG" | "STALE_CARTOLA" | "SUCURSAL_INACTIVE" | "REVIEW_PENDING";
  severity: "warn" | "danger";
  message: string;
  count?: number;
}

export interface DashboardData {
  period: Period;
  range: {
    start: string;
    end: string;
    prevStart: string;
    prevEnd: string;
    label: string;
  };
  kpis: KPIData;
  balances: AccountBalance[];
  pipeline: PipelineData;
  flows: FlowsBucket[];
  topBranches: BranchSummary[];
  topCashiers: CashierSummary[];
  alerts: AlertItem[];
  generatedAt: string;
}
