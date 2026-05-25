"use client";

import { useState } from "react";
import { ConciliacionView } from "./ConciliacionView";
import { OverviewPairedView } from "./OverviewPairedView";

type Mode = "overview" | "by-status";

export function ConciliacionShell() {
  const [mode, setMode] = useState<Mode>("overview");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border-soft">
        <ModeTab
          label="Vista general"
          description="Panel pareado Dynatech ↔ Bancos"
          active={mode === "overview"}
          onClick={() => setMode("overview")}
        />
        <ModeTab
          label="Por estado"
          description="Cola de trabajo segmentada por estado"
          active={mode === "by-status"}
          onClick={() => setMode("by-status")}
        />
      </div>

      {mode === "overview" ? <OverviewPairedView /> : <ConciliacionView />}
    </div>
  );
}

function ModeTab({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={description}
      className={
        "px-4 py-2 text-sm border-b-2 transition-colors -mb-px " +
        (active
          ? "border-brand text-text font-medium"
          : "border-transparent text-text-muted hover:text-text")
      }
    >
      {label}
    </button>
  );
}
