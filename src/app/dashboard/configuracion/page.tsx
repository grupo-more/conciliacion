import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ConfiguracionView } from "@/components/configuracion/ConfiguracionView";

export default async function ConfiguracionPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <ConfiguracionView
      user={{ email: session.email, name: session.name }}
    />
  );
}
