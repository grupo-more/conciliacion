/**
 * Logo MORE — variante "M" estilizada en disco corporativo.
 *
 * Diseñada con tipografía Montserrat ExtraBold (la tipográfica principal
 * del manual de marca 2024). La M se inscribe en un disco azul corporativo
 * (#243a85) sobre blanco, o blanco sobre el disco según el tono.
 *
 * Variantes:
 *   - "horizontal": M + "MORE"
 *   - "vertical":   M arriba + "MORE" abajo
 *   - "mark":       solo la M en el disco
 *
 * Tonos:
 *   - "brand": disco azul corp, M blanca, texto azul corp (uso sobre blanco)
 *   - "white": disco blanco, M azul corp, texto blanco (uso sobre azul)
 *   - "mono":  todo azul corporativo (uso monocromático)
 */
interface LogoProps {
  variant?: "horizontal" | "vertical" | "mark";
  tone?: "brand" | "white" | "mono";
  className?: string;
  title?: string;
}

export function Logo({
  variant = "horizontal",
  tone = "brand",
  className,
  title = "MORE",
}: LogoProps) {
  const colors = getColors(tone);

  if (variant === "mark") {
    return (
      <svg
        className={className}
        viewBox="0 0 100 100"
        role="img"
        aria-label={title}
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>{title}</title>
        <MMark disc={colors.disc} letter={colors.letter} />
      </svg>
    );
  }

  if (variant === "vertical") {
    return (
      <svg
        className={className}
        viewBox="0 0 200 200"
        role="img"
        aria-label={title}
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>{title}</title>
        <g transform="translate(50, 0)">
          <MMark disc={colors.disc} letter={colors.letter} />
        </g>
        <g transform="translate(0, 130)">
          <text
            x="100"
            y="42"
            textAnchor="middle"
            fontFamily="var(--font-montserrat), sans-serif"
            fontWeight="800"
            fontSize="44"
            letterSpacing="-0.02em"
            fill={colors.text}
          >
            MORE
          </text>
        </g>
      </svg>
    );
  }

  // Horizontal (default)
  return (
    <svg
      className={className}
      viewBox="0 0 280 110"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <g transform="translate(0, 5)">
        <MMark disc={colors.disc} letter={colors.letter} />
      </g>
      <g>
        <text
          x="115"
          y="62"
          fontFamily="var(--font-montserrat), sans-serif"
          fontWeight="800"
          fontSize="44"
          letterSpacing="-0.02em"
          fill={colors.text}
        >
          MORE
        </text>
      </g>
    </svg>
  );
}

function getColors(tone: "brand" | "white" | "mono") {
  switch (tone) {
    case "white":
      return {
        disc: "#ffffff",
        letter: "#243a85",
        text: "#ffffff",
        tagline: "rgba(255, 255, 255, 0.92)",
      };
    case "mono":
      return {
        disc: "#243a85",
        letter: "#ffffff",
        text: "#243a85",
        tagline: "#243a85",
      };
    case "brand":
    default:
      return {
        disc: "#243a85",
        letter: "#ffffff",
        text: "#243a85",
        tagline: "#4b579b",
      };
  }
}

/**
 * Disco con la M estilizada al centro.
 * El subrayado cyan refuerza el acento de marca y conecta con la paleta
 * secundaria del manual (cyan 100%).
 */
function MMark({ disc, letter }: { disc: string; letter: string }) {
  return (
    <g>
      <circle cx="50" cy="50" r="48" fill={disc} />
      {/* Anillo accent muy sutil */}
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke="#00aeef"
        strokeOpacity="0.35"
        strokeWidth="0.8"
      />
      {/* La "M" centrada — Montserrat ExtraBold óptico */}
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-montserrat), sans-serif"
        fontWeight="800"
        fontSize="62"
        fill={letter}
        letterSpacing="-0.06em"
      >
        M
      </text>
      {/* Subrayado cyan corto — acento de marca */}
      <rect x="38" y="72" width="24" height="3" rx="1.5" fill="#00aeef" />
    </g>
  );
}
