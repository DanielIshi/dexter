import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // RELATIV, nicht absolut — dieselbe Ausgabe muss an zwei Orten laufen.
  //
  // CEO 08.10.2026 setzte hier "/voice2/", weil die Web-Fassung unter
  // /voice2/ im dashboard-Vhost liegt. Richtig fuer den Vhost, aber es
  // hat die Desktop-App stillgelegt: dort ist die Basis
  // http://tauri.localhost/, die WebView suchte
  // tauri.localhost/voice2/assets/index-*.js, fand nichts, und der
  // Asset-Handler lieferte index.html als Rueckfall. Die Konsole sagte
  // (gemessen 10.10. ueber CDP in Daniels laufender App):
  //   "Failed to load module script: Expected a JavaScript-or-Wasm
  //    module script but the server responded with a MIME type of
  //    text/html"
  // Folge: document.body hatte 32 Zeichen, React war nicht gemountet,
  // window.__dexterLog undefined — kein Javascript lief. Daniel sah ein
  // "leeres schwarzes Fenster", und JEDES Symptom darueber (keine
  // Aufnahme, kein Ton, haengendes "transcribing") war eine Folge davon.
  //
  // "./" erzeugt relative Pfade (./assets/...). Die loesen unter
  // /voice2/ UND unter tauri.localhost/ richtig auf — ein Build fuer
  // beide Ziele, kein zweiter Bauweg, der auseinanderlaufen kann.
  base: "./",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
