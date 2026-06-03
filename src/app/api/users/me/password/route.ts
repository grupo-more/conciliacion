import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit-log";
import { getClientIp } from "@/lib/rate-limit";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, "Minimo 12 caracteres").max(200),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos invalidos", detail: parsed.error.issues },
      { status: 400 }
    );
  }

  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user || !user.active) {
    return NextResponse.json({ error: "Usuario invalido" }, { status: 401 });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "Contrasena actual incorrecta" },
      { status: 401 }
    );
  }

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: "La nueva contrasena debe ser distinta de la actual" },
      { status: 400 }
    );
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  audit("auth.password.changed", {
    ip: getClientIp(req),
    email: user.email,
    userId: user.id,
  });

  return NextResponse.json({ ok: true });
}
