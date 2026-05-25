import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const montserrat = Montserrat({
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: {
    default: "MoreGiros · Conciliación",
    template: "%s · MoreGiros",
  },
  description:
    "Plataforma de conciliación bancaria y movimientos Dynatech — MoreGiros by More Exchange",
  applicationName: "MoreGiros Conciliación",
};

export const viewport: Viewport = {
  themeColor: "#243a85",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={montserrat.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
