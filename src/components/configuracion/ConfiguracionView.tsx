"use client";

import { useState } from "react";
import { PerfilTab } from "./PerfilTab";
import { RubrosTab } from "./RubrosTab";
import { BankAliasesTab } from "./BankAliasesTab";
import { DifMenorTab } from "./DifMenorTab";
import { EntidadesInternasTab } from "./EntidadesInternasTab";
import { SucursalesTab } from "./SucursalesTab";
import { UsuariosPerfilesTab } from "./UsuariosPerfilesTab";
import { DescartesTab } from "./DescartesTab";
import { usePermisos } from "@/lib/use-permisos";

type Tab =
  | "perfil"
  | "rubros"
  | "aliases"
  | "dif-menor"
  | "entidades-internas"
  | "sucursales"
  | "descartes"
  | "usuarios";

interface Props {
  user: { email: string; name: string | null };
}

export function ConfiguracionView({ user }: Props) {
  const [tab, setTab] = useState<Tab>("perfil");
  // Gating por variables del perfil: "Perfil" (datos propios) es para todos;
  // los maestros del sistema requieren `configurar`; usuarios/perfiles,
  // `gestionarUsuarios`. El backend igual valida cada mutación.
  const { can } = usePermisos();
  const verConfig = can("configurar");
  const verUsuarios = can("gestionarUsuarios");

  return (
    <div className="space-y-6">
      <div className="animate-fade-in-down">
        <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Administra tu perfil y los datos maestros del sistema.
        </p>
      </div>

      <div className="border-b border-border-soft">
        <nav className="flex gap-1 flex-wrap" aria-label="Secciones de configuración">
          <TabButton active={tab === "perfil"} onClick={() => setTab("perfil")}>
            Perfil
          </TabButton>
          {verConfig && (
            <>
              <TabButton active={tab === "rubros"} onClick={() => setTab("rubros")}>
                Rubros
              </TabButton>
              <TabButton active={tab === "aliases"} onClick={() => setTab("aliases")}>
                Mapeo de cuentas
              </TabButton>
              <TabButton active={tab === "dif-menor"} onClick={() => setTab("dif-menor")}>
                Dif menor a 100
              </TabButton>
              <TabButton
                active={tab === "entidades-internas"}
                onClick={() => setTab("entidades-internas")}
              >
                Entidades internas
              </TabButton>
              <TabButton active={tab === "sucursales"} onClick={() => setTab("sucursales")}>
                Sucursales
              </TabButton>
              <TabButton active={tab === "descartes"} onClick={() => setTab("descartes")}>
                Descartes automáticos
              </TabButton>
            </>
          )}
          {verUsuarios && (
            <TabButton active={tab === "usuarios"} onClick={() => setTab("usuarios")}>
              Usuarios y perfiles
            </TabButton>
          )}
        </nav>
      </div>

      <div className="animate-fade-in">
        {tab === "perfil" && <PerfilTab user={user} />}
        {verConfig && tab === "rubros" && <RubrosTab />}
        {verConfig && tab === "aliases" && <BankAliasesTab />}
        {verConfig && tab === "dif-menor" && <DifMenorTab />}
        {verConfig && tab === "entidades-internas" && <EntidadesInternasTab />}
        {verConfig && tab === "sucursales" && <SucursalesTab />}
        {verConfig && tab === "descartes" && <DescartesTab />}
        {verUsuarios && tab === "usuarios" && <UsuariosPerfilesTab />}
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
