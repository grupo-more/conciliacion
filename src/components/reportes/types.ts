/** Tipos de respuesta de las rutas /api/reportes/*. */

export type AgingBucket = "0-7" | "8-30" | "31-60" | "60+";
export type BankTag = "interno" | "transbank" | "comision" | "sin_clasificar";
export type DynatechMotivo =
  | "sin_procesar"
  | "sugerido"
  | "revisar"
  | "excepcion"
  | "sin_match"
  | "fuera_scope";

export interface AmountCell {
  count: number;
  monto: string; // BigInt como string (magnitud)
}

/* ============================== Overview ============================== */

export interface OverviewSide {
  count: number;
  monto: string;
}

export interface ReportesOverview {
  from: string;
  to: string;
  banco: OverviewSide & {
    in: OverviewSide;
    out: OverviewSide;
  };
  dynatech: OverviewSide & {
    ingreso: OverviewSide;
    egreso: OverviewSide;
  };
}

/* ============================== Banco ============================== */

export interface BancoRow {
  id: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  direction: string; // IN | OUT
  accountId: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  tag: BankTag;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  description: string | null;
}

export interface BancoResponse {
  from: string;
  to: string;
  truncated: boolean;
  rows: BancoRow[];
  resumen: {
    count: number;
    monto: string;
    resueltos: {
      transbank: AmountCell;
      traspasos: AmountCell;
      noRelevante: AmountCell;
    };
    porDireccion: Record<string, AmountCell>;
    porTag: Record<BankTag, AmountCell>;
    porAging: Record<AgingBucket, AmountCell>;
    porBanco: { label: string; count: number; monto: string }[];
  };
  facets: { accounts: { id: string; label: string }[] };
}

/* ============================== Dynatech ============================== */

export interface DynatechRow {
  id: string;
  externalId: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  banco: string | null;
  sucursalName: string | null;
  sucursalId: number;
  clienteName: string | null;
  clienteRut: string | null;
  glosa: string;
  folio: string;
  motivo: DynatechMotivo;
}

export interface DynatechResponse {
  from: string;
  to: string;
  truncated: boolean;
  rows: DynatechRow[];
  resumen: {
    count: number;
    monto: string;
    porTipo: Record<string, AmountCell>;
    porMotivo: Record<DynatechMotivo, AmountCell>;
    porAging: Record<AgingBucket, AmountCell>;
    porBanco: { label: string; count: number; monto: string }[];
  };
  facets: { bancos: string[] };
}

/* ============================== Labels UI ============================== */

export const BANK_TAG_LABEL: Record<BankTag, string> = {
  interno: "Interno",
  transbank: "Transbank",
  comision: "Comisión / cargo",
  sin_clasificar: "Sin clasificar",
};

export const BANK_TAG_COLOR: Record<BankTag, string> = {
  interno: "bg-sky-100 text-sky-800 border-sky-300",
  transbank: "bg-violet-100 text-violet-800 border-violet-300",
  comision: "bg-amber-100 text-amber-800 border-amber-300",
  sin_clasificar: "bg-rose-100 text-rose-800 border-rose-300",
};

export const MOTIVO_LABEL: Record<DynatechMotivo, string> = {
  sin_procesar: "Sin procesar",
  sugerido: "Sugerido pendiente",
  revisar: "Revisar",
  excepcion: "Excepción API",
  sin_match: "Sin match",
  fuera_scope: "Fuera de scope",
};

export const MOTIVO_COLOR: Record<DynatechMotivo, string> = {
  sin_procesar: "bg-sky-100 text-sky-800 border-sky-300",
  sugerido: "bg-amber-100 text-amber-800 border-amber-300",
  revisar: "bg-orange-100 text-orange-800 border-orange-300",
  excepcion: "bg-violet-100 text-violet-800 border-violet-300",
  sin_match: "bg-rose-100 text-rose-800 border-rose-300",
  fuera_scope: "bg-zinc-200 text-zinc-700 border-zinc-300",
};

export const MOTIVO_ACCION: Record<DynatechMotivo, string> = {
  sin_procesar: "Correr 'Re-evaluar todo'",
  sugerido: "Revisar y confirmar en Lista",
  revisar: "Revisar candidatos en Lista",
  excepcion: "Depósito a otro banco — revisar cross-banco",
  sin_match: "Falta cartola o no hay contraparte",
  fuera_scope: "Configurar alias del banco",
};

export const AGING_BUCKETS: AgingBucket[] = ["0-7", "8-30", "31-60", "60+"];

export const AGING_LABEL: Record<AgingBucket, string> = {
  "0-7": "0-7 días",
  "8-30": "8-30 días",
  "31-60": "31-60 días",
  "60+": "+60 días",
};
