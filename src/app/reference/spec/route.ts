import fs from "fs";
import path from "path";

export async function GET() {
  const filePath = path.join(process.cwd(), "src", "openapi", "conciliacion-openapi.yaml");
  const content = fs.readFileSync(filePath, "utf-8");
  return new Response(content, {
    headers: { "Content-Type": "application/yaml" },
  });
}
