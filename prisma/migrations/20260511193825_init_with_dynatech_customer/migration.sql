-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "display_number" TEXT,
    "holder_name" TEXT NOT NULL,
    "holder_rut" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'CLP',
    "alias" TEXT,
    "purpose" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "parser_code" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "period_from" TIMESTAMP(3),
    "period_to" TIMESTAMP(3),
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_duplicated" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "raw_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMovement" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "statement_import_id" TEXT NOT NULL,
    "external_id" TEXT,
    "post_date" TIMESTAMP(3) NOT NULL,
    "transaction_date" TIMESTAMP(3),
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CLP',
    "direction" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "description_norm" TEXT NOT NULL,
    "balance_after" BIGINT,
    "counterparty_name" TEXT,
    "counterparty_rut" TEXT,
    "counterparty_account" TEXT,
    "counterparty_bank" TEXT,
    "branch_label" TEXT,
    "tx_type" TEXT,
    "dedup_key" TEXT NOT NULL,
    "raw_row" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DynatechMovement" (
    "id" TEXT NOT NULL,
    "m_cj_id" BIGINT NOT NULL,
    "branch_external_id" INTEGER NOT NULL,
    "branch_external_name" TEXT,
    "cashier_username" TEXT NOT NULL,
    "cashier_name" TEXT,
    "document_code" INTEGER NOT NULL,
    "document_type" TEXT,
    "document_folio" BIGINT NOT NULL DEFAULT 0,
    "customer_name" TEXT,
    "customer_rut" TEXT,
    "observation" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "loaded_at" TIMESTAMP(3),
    "total_amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CLP',
    "items" JSONB NOT NULL,
    "raw_json" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DynatechMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DynatechSyncRun" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "fetched_rows" INTEGER NOT NULL DEFAULT 0,
    "inserted_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_duplicates" INTEGER NOT NULL DEFAULT 0,
    "skipped_invalid" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "fetch_ms" INTEGER,

    CONSTRAINT "DynatechSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchAccountHint" (
    "id" TEXT NOT NULL,
    "branch_external_id" INTEGER NOT NULL,
    "branch_name" TEXT,
    "account_id" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchAccountHint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL,
    "dynatech_movement_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "match_type" TEXT,
    "out_of_scope_reason" TEXT,
    "notes" TEXT,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationLink" (
    "id" TEXT NOT NULL,
    "reconciliation_id" TEXT NOT NULL,
    "bank_movement_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "BankAccount_active_idx" ON "BankAccount"("active");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_bank_code_account_number_key" ON "BankAccount"("bank_code", "account_number");

-- CreateIndex
CREATE INDEX "StatementImport_account_id_created_at_idx" ON "StatementImport"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_account_id_file_hash_key" ON "StatementImport"("account_id", "file_hash");

-- CreateIndex
CREATE INDEX "BankMovement_account_id_post_date_idx" ON "BankMovement"("account_id", "post_date");

-- CreateIndex
CREATE INDEX "BankMovement_external_id_idx" ON "BankMovement"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "BankMovement_account_id_dedup_key_key" ON "BankMovement"("account_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "DynatechMovement_m_cj_id_key" ON "DynatechMovement"("m_cj_id");

-- CreateIndex
CREATE INDEX "DynatechMovement_branch_external_id_idx" ON "DynatechMovement"("branch_external_id");

-- CreateIndex
CREATE INDEX "DynatechMovement_cashier_username_idx" ON "DynatechMovement"("cashier_username");

-- CreateIndex
CREATE INDEX "DynatechMovement_occurred_at_idx" ON "DynatechMovement"("occurred_at");

-- CreateIndex
CREATE INDEX "DynatechMovement_document_code_idx" ON "DynatechMovement"("document_code");

-- CreateIndex
CREATE INDEX "DynatechMovement_document_folio_idx" ON "DynatechMovement"("document_folio");

-- CreateIndex
CREATE INDEX "DynatechMovement_customer_rut_idx" ON "DynatechMovement"("customer_rut");

-- CreateIndex
CREATE INDEX "DynatechSyncRun_started_at_idx" ON "DynatechSyncRun"("started_at");

-- CreateIndex
CREATE INDEX "DynatechSyncRun_status_started_at_idx" ON "DynatechSyncRun"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "BranchAccountHint_branch_external_id_key" ON "BranchAccountHint"("branch_external_id");

-- CreateIndex
CREATE INDEX "BranchAccountHint_branch_external_id_idx" ON "BranchAccountHint"("branch_external_id");

-- CreateIndex
CREATE INDEX "BranchAccountHint_account_id_idx" ON "BranchAccountHint"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_dynatech_movement_id_key" ON "Reconciliation"("dynatech_movement_id");

-- CreateIndex
CREATE INDEX "Reconciliation_status_idx" ON "Reconciliation"("status");

-- CreateIndex
CREATE INDEX "ReconciliationLink_reconciliation_id_idx" ON "ReconciliationLink"("reconciliation_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationLink_reconciliation_id_bank_movement_id_key" ON "ReconciliationLink"("reconciliation_id", "bank_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationLink_bank_movement_id_key" ON "ReconciliationLink"("bank_movement_id");

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMovement" ADD CONSTRAINT "BankMovement_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMovement" ADD CONSTRAINT "BankMovement_statement_import_id_fkey" FOREIGN KEY ("statement_import_id") REFERENCES "StatementImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchAccountHint" ADD CONSTRAINT "BranchAccountHint_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_dynatech_movement_id_fkey" FOREIGN KEY ("dynatech_movement_id") REFERENCES "DynatechMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationLink" ADD CONSTRAINT "ReconciliationLink_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "Reconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationLink" ADD CONSTRAINT "ReconciliationLink_bank_movement_id_fkey" FOREIGN KEY ("bank_movement_id") REFERENCES "BankMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
