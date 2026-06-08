import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { importTransbankAbonos } from "@/lib/transbank/import-abonos";

/**
 * POST /api/transbank/import?dryRun=1
 * multipart/form-data: file = el .xls "Abonos por dia" de Transbank.
 *
 * Inserta en TransbankSale (settlement). NO toca BankMovement ni el motor de
 * consolidados — es una fuente aislada que luego se cruza con /api/tbk-tesoreria
 * en la tab "Cruce Transbank".
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo (campo `file`)" }, { status: 400 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    const result = await importTransbankAbonos({ fileName: file.name, fileBuffer: buf, dryRun });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error al procesar el archivo";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
