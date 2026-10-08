import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { verdrahteSprachkette } from "./sprachkette";

// Browserbetrieb: im Desktop macht das Rust-Backend die Aufnahme, hier
// niemand. Einmal beim Start einhaengen, bevor React rendert.
verdrahteSprachkette();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
