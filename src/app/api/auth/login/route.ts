import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { createSession, setSessionCookie } from "@/lib/auth";
import {
  checkLoginRate,
  getClientIp,
  recordLoginFailure,
  resetLoginRate,
} from "@/lib/rate-limit";
import { audit } from "@/lib/audit-log";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const ip = getClientIp(req);

  const rate = checkLoginRate(ip, email);
  if (!rate.ok) {
    audit("auth.login.blocked", { ip, email, retryAfterSec: rate.retryAfterSec });
    return NextResponse.json(
      {
        error: "Demasiados intentos. Vuelve a intentar en unos minutos.",
        retryAfterSec: rate.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSec) },
      }
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    recordLoginFailure(ip, email);
    audit("auth.login.fail", { ip, email, reason: "unknown_user" });
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
  }
  if (!user.active) {
    recordLoginFailure(ip, email);
    audit("auth.login.fail", { ip, email, userId: user.id, reason: "user_disabled" });
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    recordLoginFailure(ip, email);
    audit("auth.login.fail", { ip, email, userId: user.id, reason: "bad_password" });
    return NextResponse.json({ error: "Credenciales inválidas" }, { status: 401 });
  }

  resetLoginRate(ip, email);
  audit("auth.login.ok", { ip, email, userId: user.id });

  const token = await createSession({
    sub: user.id,
    email: user.email,
    name: user.name,
  });
  setSessionCookie(token);

  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
}
