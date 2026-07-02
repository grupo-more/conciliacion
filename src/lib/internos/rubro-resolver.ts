/**
 * Resuelve el rubro contable de una BankAccount con una cascada heuristica.
 *
 * Hoy el schema no tiene un campo rubro fijo en BankAccount (se quito en
 * 20260528170000_drop_account_rubro porque no aplicaba al flujo Consolidados).
 * Para "Traspasos internos" lo necesitamos identificar igual, asi que vamos
 * con best-effort:
 *
 *   1) Match por nombre: norm(bankName + " " + holderName) == norm(RubroLabel.name)
 *      (mismo criterio que /api/consolidados/compare ya usa para sugerir rubro).
 *   2) Si la cuenta pertenece a una EntidadInterna activa con rubro asignado,
 *      usamos ese rubro como fallback.
 *   3) null si nada matchea — el front muestra "—" en esa fila.
 *
 * Donde quede en null, el operador puede crear el RubroLabel con el nombre
 * exacto "BankName HolderName" y aparece solo, o asignar la cuenta a una
 * EntidadInterna con rubro.
 */

export interface AccountForRubro {
  id: string;
  bankName: string;
  holderName: string;
  holderRut?: string | null;
}

export interface RubroLabelLite {
  rubro: number;
  name: string;
  /** Cuenta bancaria enlazada explícitamente a este rubro (Configuración → Rubros). */
  accountId?: string | null;
}

export interface EntidadInternaLiteForRubro {
  rutCanonico: string;
  rubro: number | null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function normRut(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[^0-9kK]/g, "").toUpperCase();
}

function matchRut(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ax = a.replace(/^0+/, "");
  const bx = b.replace(/^0+/, "");
  if (ax === bx) return true;
  if (ax.length >= 7 && bx.startsWith(ax)) return true;
  if (bx.length >= 7 && ax.startsWith(bx)) return true;
  return false;
}

/**
 * Devuelve el rubro asignado a la cuenta segun la cascada, o null.
 */
export function resolveRubroForAccount(
  acc: AccountForRubro,
  rubros: RubroLabelLite[],
  entidades: EntidadInternaLiteForRubro[],
): number | null {
  // 0) Enlace EXPLÍCITO cuenta → rubro (Configuración → Rubros). Fuente de verdad.
  const explicit = rubros.find((r) => r.accountId && r.accountId === acc.id);
  if (explicit) return explicit.rubro;

  // 1) Exact match de "bankName holderName"
  const accKey = norm(`${acc.bankName} ${acc.holderName}`);
  const exact = rubros.find((r) => norm(r.name) === accKey);
  if (exact) return exact.rubro;

  // 1b) Contains relax: rubro cuyo nombre contiene la combinacion o viceversa
  const contains = rubros.find(
    (r) =>
      norm(r.name).includes(accKey) ||
      accKey.includes(norm(r.name)),
  );
  if (contains) return contains.rubro;

  // 2) Rubro de la entidad interna a la que pertenece la cuenta
  const rutNorm = normRut(acc.holderRut);
  if (rutNorm) {
    for (const e of entidades) {
      if (e.rubro != null && matchRut(rutNorm, e.rutCanonico)) {
        return e.rubro;
      }
    }
  }

  return null;
}

/**
 * Mapa accountId → rubro resuelto (o null). Util para precomputar antes de
 * armar el response y no llamar al resolver por cada fila.
 */
export function buildRubroMap(
  accounts: AccountForRubro[],
  rubros: RubroLabelLite[],
  entidades: EntidadInternaLiteForRubro[],
): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const a of accounts) {
    m.set(a.id, resolveRubroForAccount(a, rubros, entidades));
  }
  return m;
}
