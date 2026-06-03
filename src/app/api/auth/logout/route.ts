import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit-log";
import { getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const session = await getSession();
  clearSessionCookie();
  if (session) {
    audit("auth.logout", {
      ip: getClientIp(req),
      email: session.email,
      userId: session.sub,
    });
  }
  return NextResponse.json({ ok: true });
}
