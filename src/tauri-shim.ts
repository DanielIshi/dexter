/**
 * Tauri-Ersatz fuer den Browserbetrieb (CEO, 08.10.2026).
 *
 * Codacus' dexter ist eine Tauri-Desktop-App: das Rust-Backend bietet
 * `#[tauri::command]`-Funktionen, keinen HTTP-Server. Im Browser gibt es
 * kein Tauri, also faengt dieser Shim die beiden benutzten invoke-Aufrufe
 * und die vier Ereignisse ab und leitet sie auf den vorhandenen Dienst
 * SCRIPTS/ops/voice_api.py (Port 8105, oeffentlich /voice-api/) um.
 *
 * Gemessene Schnittstelle, nicht geraten:
 *   invoke("set_config")                -> POST /voice-api/config
 *   invoke("delete_knowledge_source")   -> DELETE /voice-api/wissen/<source>
 *   listen("hotkey_pressed"|"hotkey_released")  -> Leertaste im Browser
 *   listen("pipeline_interrupted")      -> Escape
 *   listen("messages_cleared")          -> eigenes Ereignis
 *
 * Fehlt ein Endpunkt im Dienst, scheitert der Aufruf SICHTBAR (Fehler in
 * der Konsole und abweisendes Promise) — kein stiller Erfolg. Ein Shim,
 * der Erfolg vortaeuscht, ist schlimmer als keiner.
 */

const BASIS = (import.meta as { env?: Record<string, string> }).env
  ?.VITE_VOICE_API ?? "/voice-api";

type Nutzlast = Record<string, unknown> | undefined;

/** Ersatz fuer @tauri-apps/api/core::invoke. */
export async function invoke<T = unknown>(
  befehl: string,
  args?: Nutzlast,
): Promise<T> {
  switch (befehl) {
    case "set_config": {
      const r = await fetch(`${BASIS}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args?.config ?? {}),
      });
      if (!r.ok) {
        throw new Error(`set_config: HTTP ${r.status} von ${BASIS}/config`);
      }
      return (await r.json()) as T;
    }

    case "delete_knowledge_source": {
      const quelle = encodeURIComponent(String(args?.source ?? ""));
      const r = await fetch(`${BASIS}/wissen/${quelle}`, { method: "DELETE" });
      if (!r.ok) {
        throw new Error(
          `delete_knowledge_source: HTTP ${r.status} von ${BASIS}/wissen/`,
        );
      }
      return (await r.json()) as T;
    }

    default:
      // Absichtlich laut: ein unbekannter Befehl ist ein Befund, kein
      // Normalfall. Wer hier still zurueckgibt, baut einen blinden Shim.
      throw new Error(
        `invoke("${befehl}") ist im Browser-Shim nicht abgebildet — ` +
          `siehe src/tauri-shim.ts`,
      );
  }
}

type Abmelden = () => void;

/**
 * Ersatz fuer @tauri-apps/api/event::listen.
 *
 * Die vier Ereignisse kommen im Desktop aus Rust (globale Hotkeys). Im
 * Browser gibt es keine globalen Tastenkuerzel, deshalb werden sie an
 * Tasten im Fenster gebunden:
 *   Leertaste gedrueckt / gelassen  -> hotkey_pressed / hotkey_released
 *   Escape                          -> pipeline_interrupted
 *   messages_cleared                -> eigenes CustomEvent
 */
export async function listen<T = unknown>(
  ereignis: string,
  rueckruf: (e: { payload: T }) => void,
): Promise<Abmelden> {
  if (ereignis === "hotkey_pressed" || ereignis === "hotkey_released") {
    const istRunter = ereignis === "hotkey_pressed";
    const typ = istRunter ? "keydown" : "keyup";
    const h = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // Nicht in Eingabefeldern: dort ist die Leertaste ein Leerzeichen.
      const z = e.target as HTMLElement | null;
      const tag = z?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || z?.isContentEditable) return;
      if (e.repeat) return;
      e.preventDefault();
      rueckruf({ payload: undefined as T });
    };
    window.addEventListener(typ, h);
    return () => window.removeEventListener(typ, h);
  }

  if (ereignis === "pipeline_interrupted") {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") rueckruf({ payload: undefined as T });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }

  // Eigene Ereignisse laufen ueber den window-Bus.
  const h = (e: Event) => {
    rueckruf({ payload: (e as CustomEvent).detail as T });
  };
  window.addEventListener(ereignis, h);
  return () => window.removeEventListener(ereignis, h);
}
