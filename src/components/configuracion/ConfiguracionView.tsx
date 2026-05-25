"use client";

import { useState } from "react";
import { PerfilTab } from "./PerfilTab";
import { RubrosTab } from "./RubrosTab";

type Tab = "perfil" | "rubros";

interface Props {
  user: { email: string; name: string | null };
}

export function ConfiguracionView({ user }: Props) {
  const [tab, setTab] = useState<Tab>("perfil");

  return (
    <div className="space-y-6">
      <div className="animate-fade-in-down">
        <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Administra tu perfil y los datos maestros del sistema.
        </p>
      </div>

      <div className="border-b border-border-soft">
        <nav className="flex gap-1" aria-label="Secciones de configuración">
          <TabButton active={tab === "perfil"} onClick={() => setTab("perfil")}>
            Perfil
          </TabButton>
          <TabButton active={tab === "rubros"} onClick={() => setTab("rubros")}>
            Rubros
          </TabButton>
        </nav>
      </div>

      <div className="animate-fade-in">
        {tab === "perfil" && <PerfilTab user={user} />}
        {tab === "rubros" && <RubrosTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "relative px-4 py-2.5 text-sm font-semibold transition-colors duration-200 " +
        (active
          ? "text-brand"
          : "text-text-muted hover:text-brand")
      }
    >
      {children}
      {active && (
        <span
          className="absolute inset-x-2 -bottom-px h-0.5 bg-brand rounded-full"
          aria-hidden
        />
      )}
    </button>
  );
}
