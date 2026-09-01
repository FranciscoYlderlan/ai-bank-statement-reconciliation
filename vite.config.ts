import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri espera porta fixa e nao limpa a tela
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021", outDir: "dist" },
});
