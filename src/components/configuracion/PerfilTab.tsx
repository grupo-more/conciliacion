"use client";

import { useState } from "react";

interface Props {
  user: { email: string; name: string | null };
}

export function PerfilTab({ user }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);

    if (newPassword.length < 12) {
      setBanner({ kind: "err", msg: "La nueva contraseña debe tener al menos 12 caracteres." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setBanner({ kind: "err", msg: "La confirmación no coincide con la nueva contraseña." });
      return;
    }
    if (newPassword === currentPassword) {
      setBanner({ kind: "err", msg: "La nueva contraseña debe ser distinta de la actual." });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/users/me/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner({ kind: "err", msg: data.error || "No se pudo actualizar la contraseña." });
        return;
      }
      setBanner({ kind: "ok", msg: "Contraseña actualizada correctamente." });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="card">
        <h2 className="text-base font-semibold mb-4">Datos de la cuenta</h2>
        <div className="space-y-3 text-sm">
          <Field label="Nombre" value={user.name ?? "—"} />
          <Field label="Email" value={user.email} mono />
        </div>
        <p className="text-xs text-text-muted mt-4">
          Para cambiar el nombre o el email, contacta a un administrador.
        </p>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-4">Cambiar contraseña</h2>
        <form onSubmit={submitPassword} className="space-y-3">
          <div>
            <label className="label">Contraseña actual</label>
            <input
              type="password"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="label">Nueva contraseña</label>
            <input
              type="password"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
            <p className="text-xs text-text-muted mt-1">Mínimo 12 caracteres.</p>
          </div>
          <div>
            <label className="label">Confirmar nueva contraseña</label>
            <input
              type="password"
              className="input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </div>

          {banner && (
            <div
              className={
                "rounded-md p-2.5 text-sm border " +
                (banner.kind === "ok"
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger")
              }
            >
              {banner.msg}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
            className="btn-primary w-full"
          >
            {submitting ? "Guardando…" : "Actualizar contraseña"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={mono ? "font-mono" : ""}>{value}</div>
    </div>
  );
}
