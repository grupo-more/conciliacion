/**
 * Helper para extraer texto plano de un PDF usando pdf-parse v2.
 *
 * pdf-parse v2 es ESM y expone una clase `PDFParse`. Para evitar problemas
 * de bundling en Next.js (Edge / serverless), envolvemos la llamada en un
 * dynamic import — asi solo se carga cuando efectivamente subimos un PDF,
 * no en cada build.
 */

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}
