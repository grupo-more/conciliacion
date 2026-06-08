"use client";

import { useState } from "react";
import { TesoreriaView } from "./TesoreriaView";
import { TbkMovView } from "./TbkMovView";
import { EgresoMovView } from "./EgresoMovView";

type Sub = "200" | "17" | "egresos";

/**
 * Módulo "Movimientos": vista completa de los 3 feeds del POS, cada uno en su
 * sub-tab (tablas y columnas a medida). Cada fuente vive en su propia tabla y
 * NINGUNA entra al motor de consolidados — esto es solo vista.
 *   - 200 (Tesorería): /api/dynatech  → TesoreriaMovement
 *   - 17 (Transbank):  /api/tbk-tesoreria → TbkTesoreria
 *   - Egresos:         /api/egresos   → EgresoMovement
 */
export function MovimientosView() {
  const [sub, setSub] = useState<Sub>("200");

  return (
    <div className="space-y-5">
      <div className="animate-fade-in-down">
        <h1 className="text-2xl font-semibold tracking-tight">Movimientos</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Feeds del sistema POS por rubro. Cada pestaña es una fuente distinta.
        </p>
      </div>

      <div className="flex gap-2 border-b border-border-soft">
        <SubTab active={sub === "200"} onClick={() => setSub("200")}>200 · Tesorería</SubTab>
        <SubTab active={sub === "17"} onClick={() => setSub("17")}>17 · Transbank</SubTab>
        <SubTab active={sub === "egresos"} onClick={() => setSub("egresos")}>Egresos</SubTab>
      </div>

      {sub === "200" && <TesoreriaView embedded />}
      {sub === "17" && <TbkMovView />}
      {sub === "egresos" && <EgresoMovView />}
    </div>
  );
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
        (active
          ? "border-brand text-brand"
          : "border-transparent text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}
