import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { verdrahteSprachkette } from "./sprachkette";

// NUR im Browser. Im Desktop macht die Aufnahme das Rust-Backend
// (Codacus' Pipeline: record_audio -> transcribe_audio -> chat_streaming
// -> synthesize -> play_audio_chunk). Liefen beide, griffen zwei Wege
// gleichzeitig aufs Mikrofon — Windows vergibt es exklusiv, der zweite
// bekam Stille (10.10.: 2844 Byte statt der gesprochenen Sekunden).
//
// Daniel 10.10.: "wenn ich gesagt habe nicht selbst implementieren
// sondern den code von codacus nehmen! dann waere das doch nicht
// passiert!" — richtig. Der Desktop faehrt wieder seinen Weg; diese
// Datei bleibt als Browser-Ersatz, wo es kein Rust-Backend gibt.
//
// Erkennung am Tauri-Merkmal, nicht an einer Umgebungsvariablen: die
// WebView setzt __TAURI_INTERNALS__, der Browser nicht.
const imDesktop = typeof (window as unknown as Record<string, unknown>)
  .__TAURI_INTERNALS__ !== "undefined";
if (!imDesktop) verdrahteSprachkette();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
