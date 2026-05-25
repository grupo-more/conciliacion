import type { Config } from "tailwindcss";

/**
 * Paleta MoreGiros (Manual de Marca 2024) — Tema CLARO corporativo.
 *
 *   Primario:   #243a85  · RGB 36/58/133  · PANTONE 102-16 C
 *   Secundario: #4b579b
 *   Tonal:      #8c8fc0
 *   Acento:     Cyan #00aeef (100%) / #6dcff6 (60%) / #b8e3f9 (40%)
 *   Grises:     20/50/80%
 *
 * Fondos blancos dominantes con matices azules (alineado con el manual:
 * el manual usa blanco como fondo principal y azul corporativo como
 * color de identidad / textos / marcas).
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#ffffff",
          soft: "#f5f7fc",
          card: "#ffffff",
          elevated: "#eef2fb",
          tint: "#e6ecf7",
          ink: "#243a85",
        },
        border: {
          DEFAULT: "#c8d0e6",
          soft: "#dde3f1",
          strong: "#8c8fc0",
        },
        text: {
          DEFAULT: "#1a2350",
          muted: "#5a6694",
          dim: "#8c8fc0",
          inverse: "#ffffff",
          brand: "#243a85",
        },
        brand: {
          DEFAULT: "#243a85",
          hover: "#1a2c66",
          soft: "#4b579b",
          tonal: "#8c8fc0",
          tint: "#e6ecf7",
          ink: "#1a2c66",
        },
        accent: {
          DEFAULT: "#00aeef",
          hover: "#0095cc",
          soft: "#6dcff6",
          muted: "#b8e3f9",
          tint: "#e6f6fd",
        },
        success: {
          DEFAULT: "#16a34a",
          soft: "#22c55e",
          tint: "#dcfce7",
        },
        danger: {
          DEFAULT: "#dc2626",
          soft: "#ef4444",
          tint: "#fee2e2",
        },
        warn: {
          DEFAULT: "#d97706",
          soft: "#f59e0b",
          tint: "#fef3c7",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-montserrat)",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: [
          "var(--font-montserrat)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      boxShadow: {
        brand: "0 8px 24px -8px rgba(36, 58, 133, 0.35)",
        accent: "0 0 0 3px rgba(0, 174, 239, 0.22)",
        card: "0 1px 2px rgba(36, 58, 133, 0.06), 0 4px 16px -8px rgba(36, 58, 133, 0.12)",
        "card-hover":
          "0 4px 8px -2px rgba(36, 58, 133, 0.08), 0 16px 32px -8px rgba(36, 58, 133, 0.18)",
        glow: "0 0 32px -8px rgba(0, 174, 239, 0.45)",
        soft: "0 1px 3px rgba(36, 58, 133, 0.08)",
      },
      backgroundImage: {
        "brand-gradient":
          "linear-gradient(135deg, #243a85 0%, #4b579b 50%, #00aeef 130%)",
        "brand-soft":
          "linear-gradient(180deg, #ffffff 0%, #eef2fb 100%)",
        "brand-mesh":
          "radial-gradient(at 0% 0%, rgba(36, 58, 133, 0.08) 0px, transparent 50%), radial-gradient(at 100% 0%, rgba(0, 174, 239, 0.10) 0px, transparent 50%), radial-gradient(at 50% 100%, rgba(140, 143, 192, 0.10) 0px, transparent 50%)",
        "hero-grid":
          "linear-gradient(rgba(36, 58, 133, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(36, 58, 133, 0.05) 1px, transparent 1px)",
        "accent-shimmer":
          "linear-gradient(90deg, transparent 0%, rgba(0, 174, 239, 0.18) 50%, transparent 100%)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-down": {
          "0%": { opacity: "0", transform: "translateY(-10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-left": {
          "0%": { opacity: "0", transform: "translateX(-12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "fade-in-right": {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.94)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "scale-bounce": {
          "0%": { opacity: "0", transform: "scale(0.9)" },
          "60%": { transform: "scale(1.02)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-down": {
          "0%": { opacity: "0", maxHeight: "0", transform: "translateY(-4px)" },
          "100%": {
            opacity: "1",
            maxHeight: "1000px",
            transform: "translateY(0)",
          },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "pulse-ring": {
          "0%": {
            boxShadow: "0 0 0 0 rgba(0, 174, 239, 0.5)",
          },
          "70%": {
            boxShadow: "0 0 0 12px rgba(0, 174, 239, 0)",
          },
          "100%": {
            boxShadow: "0 0 0 0 rgba(0, 174, 239, 0)",
          },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        "spin-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "bg-pan": {
          "0%": { backgroundPosition: "0% 0%" },
          "100%": { backgroundPosition: "200% 0%" },
        },
        wiggle: {
          "0%, 100%": { transform: "rotate(-1deg)" },
          "50%": { transform: "rotate(1deg)" },
        },
      },
      animation: {
        "fade-in": "fade-in 240ms ease-out",
        "fade-in-up": "fade-in-up 360ms cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-in-down": "fade-in-down 360ms cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-in-left": "fade-in-left 360ms cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-in-right": "fade-in-right 360ms cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in": "scale-in 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-bounce":
          "scale-bounce 420ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        "slide-down": "slide-down 320ms cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 1.6s linear infinite",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "pulse-ring": "pulse-ring 2s cubic-bezier(0.16, 1, 0.3, 1) infinite",
        float: "float 4s ease-in-out infinite",
        "spin-slow": "spin-slow 8s linear infinite",
        "bg-pan": "bg-pan 14s linear infinite",
        wiggle: "wiggle 600ms ease-in-out",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
        smooth: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      transitionDuration: {
        250: "250ms",
        350: "350ms",
        450: "450ms",
      },
    },
  },
  plugins: [],
};

export default config;
