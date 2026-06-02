export interface BankAccountDTO {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
  holderRut: string | null;
  currency: string;
  alias: string | null;
  purpose: string | null;
  isUnassigned: boolean;
  movementCount: number;
}

export interface MovementDTO {
  id: string;
  accountId: string;
  account: {
    id: string;
    bankCode: string;
    bankName: string;
    holderName: string;
    displayNumber: string | null;
    accountNumber: string;
  };
  externalId: string | null;
  postDate: string;
  transactionDate: string | null;
  amount: string; // BigInt como string
  currency: string;
  direction: "IN" | "OUT";
  description: string;
  balanceAfter: string | null;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  counterpartyBank: string | null;
  branchLabel: string | null;
  txType: string | null;
  /** Si el BankMovement esta vinculado a un Consolidado, se incluye su id+status.
   *  null = no esta vinculado (sin matchear, abono Transbank, o egreso). */
  consolidado: { id: string; status: string } | null;
  /** True si la glosa matchea el patrón de abono Transbank ("ABN CRD ... TRANSBA").
   *  Estos movimientos no se concilian con Tesorería — tienen su propio asiento
   *  en el tab "Abono Transbank" de Consolidados. */
  transbank: boolean;
  /** True si el movimiento es una "diferencia menor" (IN ≤ threshold configurable,
   *  excluyendo Transbank). Tiene su propio asiento en el tab "Dif menor a 100"
   *  de Consolidados. Mutuamente excluyente con transbank. */
  difMenor: boolean;
}

export interface CartolaSummary {
  total: number;
  inTotal: number;
  inConciliated: number;
  inPending: number;
  inSum: string;
  inConciliatedSum: string;
  inPendingSum: string;
  /** Cantidad de abonos Transbank (IN con glosa "ABN CRD ... TRANSBA"). */
  inTransbank: number;
  /** Suma de abonos Transbank en CLP (BigInt como string). */
  inTransbankSum: string;
  /** Cantidad de diferencias menores (IN ≤ threshold, sin contar Transbank). */
  inDifMenor: number;
  /** Suma de diferencias menores en CLP (BigInt como string). */
  inDifMenorSum: string;
  outTotal: number;
  outSum: string;
}

export interface MovementsResponse {
  total: number;
  limit: number;
  offset: number;
  movements: MovementDTO[];
  summary: CartolaSummary | null;
}

export interface AccountsResponse {
  accounts: BankAccountDTO[];
}

export interface ImportPreviewResponse {
  preview: {
    parserCode: string;
    bankCode: string;
    bankName: string;
    fileName: string;
    fileHash: string;
    resolvedAccount: {
      id: string;
      bankCode: string;
      bankName: string;
      accountNumber: string;
      displayNumber: string | null;
      holderName: string;
      isUnassigned: boolean;
      resolutionMethod:
        | "DIRECT_MATCH"
        | "FILENAME_MATCH"
        | "ONLY_BANK_ACCOUNT"
        | "FALLBACK_UNASSIGNED";
    };
    unresolvedAccountInfo?: {
      accountNumber: string;
      displayNumber?: string;
      holderName?: string;
      holderRut?: string;
    };
    periodFrom: string | null;
    periodTo: string | null;
    totals: {
      fileMovements: number;
      toInsert: number;
      duplicatesSameAccount: number;
      duplicatesOtherAccount: number;
      parseErrors: number;
    };
    items: Array<{
      status: "NEW" | "DUP_SAME_ACCOUNT" | "DUP_OTHER_ACCOUNT" | "ERROR";
      dedupKey: string;
      errorReason?: string;
      duplicateOfAccountLabel?: string | null;
      movement: {
        externalId: string | null;
        postDate: string;
        amount: number;
        currency: string;
        direction: "IN" | "OUT";
        description: string;
        counterpartyName: string | null;
        counterpartyRut: string | null;
      };
    }>;
    itemsTotal: number;
    alreadyImported?: {
      importedAt: string;
      statementImportId: string;
      accountLabel: string;
    };
  };
  inserted?: {
    statementImportId: string;
    rowsInserted: number;
  };
}
