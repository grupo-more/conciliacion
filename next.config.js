/** @type {import('next').NextConfig} */
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
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
    ];
  },
};

module.exports = nextConfig;
