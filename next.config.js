/** @type {import('next').NextConfig} */

// CSP en modo Report-Only: el navegador NO bloquea recursos que violen la
// política, solo los reporta en la consola. Es la fase 1 segura — permite ver
// qué romperíamos antes de promover a CSP estricta (Content-Security-Policy).
// 'unsafe-inline' y 'unsafe-eval' están permitidos porque Next 14 los necesita
// para hidratación y dev; cuando se endurezca conviene migrar a nonces.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  // Anti-clickjacking: nadie puede embeber la app en un <iframe>.
  { key: "X-Frame-Options", value: "DENY" },
  // El navegador no debe adivinar MIME types (defensa contra XSS por upload).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No filtrar URL/path completos al navegar a otros orígenes.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Apaga APIs sensibles del navegador que la app no usa.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Fuerza HTTPS por 1 año una vez que el navegador vea la app sobre HTTPS.
  // No tiene efecto sobre HTTP plano, así que es seguro habilitarlo siempre.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // CSP en modo Report-Only para descubrir qué romperíamos antes de bloquear.
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pdf-parse v2 envuelve a pdfjs-dist, que carga su "worker" desde el
  // filesystem. Si Next lo bundlea, el path queda apuntando a
  // .next/server/chunks/pdf.worker.mjs (que no existe). Marcarlos como
  // externos hace que se carguen desde node_modules en runtime, donde el
  // worker file si vive al lado de la libreria.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist"],
    // Habilita src/instrumentation.ts (hook register() al arrancar el server).
    // Lo usamos para el scheduler de sincronizacion en segundo plano.
    instrumentationHook: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
    ];
  },
};

module.exports = nextConfig;
