/** @type {import('tailwindcss').Config} */
// Tokens da direcao "Verde-cofre / Livro-caixa" (ver docs/DESIGN.md).
// Evita classes de cor soltas: tudo passa por estes nomes semanticos.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#F4F6F8",
        surface: { DEFAULT: "#FFFFFF", muted: "#EAEEF2" },
        ink: { DEFAULT: "#1B2A33", soft: "#5A6B75" },
        line: "#D8E0E6",
        cofre: { DEFAULT: "#0E7C66", strong: "#0B6353", soft: "#E6F1EE" },
        entrada: { DEFAULT: "#1E9E6A", soft: "#E6F4EC" },
        saida: { DEFAULT: "#C0392B", soft: "#FBEBE8" },
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        body: ['"Public Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(27,42,51,0.06), 0 1px 3px rgba(27,42,51,0.05)",
        panel: "0 10px 30px rgba(27,42,51,0.10)",
        focus: "0 0 0 3px rgba(14,124,102,0.28)",
      },
      borderRadius: { card: "10px", pill: "999px" },
      ringColor: { cofre: "#0E7C66" },
    },
  },
  plugins: [],
};
