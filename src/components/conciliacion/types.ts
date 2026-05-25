export type ReconciliationStatus =
  | "AUTO_MATCHED"
  | "SUGGESTED"
  | "REVIEW"
  | "MANUAL"
  | "NO_MATCH"
  | "OUT_OF_SCOPE";

export interface AccountSlim {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
}

export interface BankLinkDTO {
  linkId?: string;
  id: string;
  accountId: string;
  account: AccountSlim;
  postDate: string;
  amount: string;
  currency?: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  externalId?: string | null;
}

export interface ScoreFactorDTO {
  key: string;
  label: string;
  weight: number;
  detail: string | null;
}

export interface CandidateScoreDTO {
  total: number;
  suggestedStatus: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" | "NO_MATCH";
  hardContradiction: string | null;
  factors: ScoreFactorDTO[];
}

export interface ReconciliationDTO {
  id: string;
  status: ReconciliationStatus;
  matchType: string | null;
  outOfScopeReason: string | null;
  notes: string | null;
  matchedAt: string;
  dynatech: {
    id: string;
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
    items: Array<{ nombre: string; cantidad: number; precioUnitario: number; monto: number }>;
    documentCode: number;
    documentFolio: string;
  };
  banks: BankLinkDTO[];
  banksSum: string;
  bankCount: number;
}

export interface ReconciliationListResponse {
  total: number;
  limit: number;
  offset: number;
  rows: ReconciliationDTO[];
  counts: Record<ReconciliationStatus | "UNPROCESSED", number>;
  facets: {
    branches: Array<{ id: number; name: string | null }>;
  };
}

export interface BranchDTO {
  externalId: number;
  name: string | null;
  movementCount: number;
  hint: {
    id: string;
    accountId: string;
    account: AccountSlim & { id: string };
    notes: string | null;
  } | null;
  history: {
    totalConfirmed: number;
    distribution: Array<{
      accountId: string;
      bankCode: string;
      holderName: string;
      count: number;
      ratio: number;
    }>;
  };
}

export type GlosaQuality = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";

export interface GlosaParsedDTO {
  bank: "BCI" | "SANTANDER" | "INTERNACIONAL" | null;
  unregisteredBank: string | null;
  holder: "ME SPA" | "MG SPA" | "BACO SPA" | "MORECAPITAL" | null;
  rut: string | null;
  giroNumber: string | null;
  clientHint: string | null;
  quality: GlosaQuality;
}

export interface ReconciliationDetailDTO {
  id: string;
  status: ReconciliationStatus;
  matchType: string | null;
  outOfScopeReason: string | null;
  notes: string | null;
  dynatech: {
    id: string;
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
    items: Array<{ nombre: string; cantidad: number; precioUnitario: number; monto: number }>;
    glosa: GlosaParsedDTO;
  };
  banks: BankLinkDTO[];
  banksSum: string;
  candidates: Array<BankLinkDTO & { isLinked: boolean; score: CandidateScoreDTO | null }>;
}

export interface OtherBankCreditsResponse {
  total: number;
  limit: number;
  offset: number;
  movements: Array<{
    id: string;
    accountId: string;
    account: AccountSlim;
    postDate: string;
    amount: string;
    currency: string;
    description: string;
    counterpartyName: string | null;
    counterpartyRut: string | null;
    externalId: string | null;
  }>;
}
