/**
 * Sprachkette fuer den Browserbetrieb (CEO, 08.10.2026).
 *
 * Belegfall, gemessen an der laufenden Seite /voice2/ um 10:4x:
 *
 *     Leertaste gedrueckt  -> Orb dreht sich (animate-spin-medium)
 *     getUserMedia-Aufrufe -> 0
 *
 * Der Orb zeigte Aufnahme an, und es wurde nichts aufgenommen. Daniel
 * hat das zweimal gemeldet ("bei voice 2 ist nichts zu klicken und
 * nichts aufzunehmen"), und er hatte beide Male recht: der erste Shim
 * bildete nur set_config und delete_knowledge_source ab. Die Aufnahme
 * macht im Desktop das Rust-Backend (cpal + whisper-rs), und im Browser
 * gab es dafuer keinen Ersatz — nur die Zustandsanzeige.
 *
 * Diese Datei ist dieser Ersatz. Sie haengt sich NUR an den Shim, nicht
 * an App.tsx: Codacus' Code bleibt unberuehrt und nachziehbar.
 *
 * Die Kette, jedes Glied gemessen bevor es verdrahtet wurde:
 *
 *     Mikrofon      MediaRecorder            hier neu
 *     Erkennung     POST /voice-api/hoeren   -> faster-whisper 8770
 *                   gemessen 08.10.: 4 s Audio -> 5,93 s, Text korrekt
 *     Antwort       POST /voice-api/sprechen -> local-reap, SSE satzweise
 *                   vorhanden seit 08.10. frueh
 *     Ausgabe       speechSynthesis          Browserstimme, unterbrechbar
 *
 * Warum die Browserstimme und nicht piper: piper laeuft auf
 * gpu-server-1, nicht auf netcup1 (gemessen: `which piper` leer, kein
 * Modell im Dateibaum). Ein Umweg ueber den anderen Rechner kostet je
 * Satz eine Netzrunde — und Daniels Hauptkritik war, dass man NICHT
 * UNTERBRECHEN kann. speechSynthesis.cancel() ist sofort. Sobald ein
 * TTS-Endpunkt steht (VOICE_TTS_URL im Dienst), nimmt `sprichSatz` ihn:
 * die Stelle ist eine einzige Funktion, kein Umbau.
 */

/** Zustaende, die App.tsx ueber das `processing`-Ereignis erwartet. */
type Stufe =
  | "idle" | "listening" | "transcribing" | "transcribed"
  | "thinking" | "tool_call" | "speaking" | "error";

const BASIS = (import.meta as { env?: Record<string, string> }).env
  ?.VITE_VOICE_API ?? "/voice-api";

/**
 * Debug-Ringpuffer (GH P0 10.10.: "no audio recorded" war blind).
 * Die letzten 60 Zeilen liegen in window.__dexterLog + localStorage
 * ("dexter-log") — Daniel muss nichts suchen, der Fehlertext nennt sie.
 * Kein Build-Tool, keine Deps: reines TS.
 */
const LOG_MAX = 60;
let ring: string[] = [];
try {
  ring = JSON.parse(localStorage.getItem("dexter-log") ?? "[]");
  if (!Array.isArray(ring)) ring = [];
} catch { ring = []; }
function dlog(...teile: unknown[]): void {
  const zeile = new Date().toISOString().slice(11, 19) + " "
    + teile.map((t) => String(t)).join(" ");
  ring.push(zeile);
  if (ring.length > LOG_MAX) ring = ring.slice(-LOG_MAX);
  try { localStorage.setItem("dexter-log", JSON.stringify(ring)); } catch { /* voll/privat */ }
  try { (window as unknown as Record<string, unknown>).__dexterLog = [...ring]; } catch { /* egal */ }
  console.debug("[dexter]", zeile);
}

/** Ein Ereignis so feuern, wie der Shim es an listen() weiterreicht. */
function feuern(name: string, nutzlast: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail: nutzlast }));
}

function stufe(s: Stufe, text = ""): void {
  feuern("processing", { stage: s, text });
}

// ---------------------------------------------------------------- Aufnahme

let aufnehmer: MediaRecorder | null = null;
let spur: MediaStream | null = null;
let haeppchen: Blob[] = [];
/** Laeuft gerade eine Antwort? Dann bricht die naechste Taste sie ab. */
let laufendeAntwort: AbortController | null = null;

/**
 * Mikrofon oeffnen und aufnehmen.
 *
 * Der Strom wird NICHT ueber die Aufnahme hinaus gehalten: ein offenes
 * Mikrofon ist ein rotes Kameralicht im Browser, und ein Dienst, der
 * dauerhaft mithoert, ist etwas anderes als einer, der auf Tastendruck
 * aufnimmt. Die halbe Sekunde Anlaufzeit ist der Preis dafuer.
 */
export async function starteAufnahme(): Promise<void> {
  if (aufnehmer) return;  // Taste doppelt gedrueckt

  // Eine laufende Antwort weicht der neuen Frage. Das IST die
  // Unterbrechbarkeit, die im Desktop der globale Hotkey leistet.
  unterbrich();

  // Zustand SOFORT zeigen, nicht erst wenn das Mikrofon offen ist:
  // getUserMedia wartet auf die Berechtigungsabfrage und kann beliebig
  // lange haengen. Gemessen 08.10. 11:0x im Server-Chrome ohne Mikrofon:
  // der Aufruf kehrte nach 45 s noch nicht zurueck, die Oberflaeche
  // zeigte NICHTS. Stumm haengen ist schlimmer als ein Fehler.
  stufe("listening");

  try {
    const mikro = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // 15 s sind reichlich fuer "erlauben" anzuklicken. Danach ist es
    // kein langsamer Nutzer mehr, sondern eine Abfrage, die nie kam.
    const frist = new Promise<never>((_, weise_ab) =>
      setTimeout(() => weise_ab(new DOMException("", "TimeoutError")), 15000));
    spur = await Promise.race([mikro, frist]);
    dlog("getUserMedia ok, tracks=",
      spur.getAudioTracks().map((t) => t.label || "?").join(","));
  } catch (e) {
    // Kein stilles Scheitern: ohne Mikrofon ist die App nutzlos, und der
    // Nutzer muss wissen WARUM (Berechtigung abgelehnt? Kein Geraet?).
    const grund = e instanceof Error ? e.name : String(e);
    const text =
      grund === "NotAllowedError"
        ? "Mikrofon nicht freigegeben — im Browser erlauben und erneut druecken."
      : grund === "NotFoundError"
        ? "Kein Mikrofon gefunden."
      : grund === "TimeoutError"
        ? "Mikrofon antwortet nicht (15 s). Berechtigung im Schloss-Symbol "
          + "der Adresszeile pruefen."
        : `Mikrofon nicht verfuegbar: ${grund}`;
    stufe("error", text);
    return;
  }

  haeppchen = [];
  // audio/webm;codecs=opus ist das, was Chrome liefert; faster-whisper
  // nimmt es an (ffmpeg dahinter). Kein Format raten — was der Browser
  // kann, sagt isTypeSupported.
  const typ = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
  aufnehmer = typ ? new MediaRecorder(spur, { mimeType: typ })
                  : new MediaRecorder(spur);
  aufnehmer.ondataavailable = (e) => {
    if (e.data.size > 0) haeppchen.push(e.data);
  };
  aufnehmer.start();
  stufe("listening");
}

/** Aufnahme beenden und die ganze Kette anstossen. */
export async function beendeAufnahme(): Promise<void> {
  const a = aufnehmer;
  if (!a) return;
  aufnehmer = null;

  const fertig = new Promise<Blob>((loese) => {
    a.onstop = () => loese(new Blob(haeppchen, { type: a.mimeType || "audio/webm" }));
  });
  a.stop();
  const audio = await fertig;

  // Mikrofon sofort wieder schliessen.
  spur?.getTracks().forEach((t) => t.stop());
  spur = null;

  // Unter 0,3 s ist ein Verseher, kein Satz. Whisper halluziniert bei
  // Stille ganze Saetze ("Untertitel von ..."), das waere schlimmer als
  // nichts. ABER: still verwerfen ist genauso schlimm — 10.10. hiess das
  // bei Daniel "no audio recorded", und niemand sah warum. Deshalb Fehler
  // mit Diagnose statt stillem Idle.
  dlog("blob bytes=", audio.size, "type=", audio.type);
  if (audio.size < 2000) {
    dlog("LEERBLOB verworfen (<2000 B): Mikrofon liefert keine Daten");
    stufe("error",
      "Mikrofon liefert leere Aufnahme — Eingabegerät in Windows prüfen "
      + "(Einstellungen → Sound → Eingabe) und erneut drücken. "
      + "Diagnose steht in der Konsole (F12) unter __dexterLog.");
    return;
  }

  stufe("transcribing");
  try {
    await verarbeite(audio);
  } catch (e) {
    stufe("error", e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------- Verarbeitung

async function verarbeite(audio: Blob): Promise<void> {
  const abbruch = new AbortController();
  laufendeAntwort = abbruch;

  // 1) Erkennung
  const form = new FormData();
  form.append("file", audio, "aufnahme.webm");
  const rSTT = await fetch(`${BASIS}/hoeren`, {
    method: "POST", body: form, signal: abbruch.signal,
  });
  dlog("POST hoeren ->", rSTT.status, "basis=", BASIS);
  if (!rSTT.ok) {
    throw new Error(`Spracherkennung: HTTP ${rSTT.status} von ${BASIS}/hoeren`);
  }
  const { text } = (await rSTT.json()) as { text?: string };
  const frage = (text ?? "").trim();
  if (!frage) {
    stufe("error", "Nichts verstanden — bitte noch einmal.");
    return;
  }

  // App.tsx zeigt bei `transcribed` die Nutzer-Sprechblase an.
  stufe("transcribed", frage);
  stufe("thinking");

  // 2) Antwort, satzweise per SSE — jeder fertige Satz wird SOFORT
  //    gesprochen. Auf die ganze Antwort zu warten verdoppelt die
  //    gefuehlte Wartezeit.
  const rLLM = await fetch(`${BASIS}/sprechen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: frage }),
    signal: abbruch.signal,
  });
  if (!rLLM.ok || !rLLM.body) {
    throw new Error(`Antwort: HTTP ${rLLM.status} von ${BASIS}/sprechen`);
  }

  const leser = rLLM.body.getReader();
  const dekoder = new TextDecoder();
  let puffer = "";
  let gesprochen = "";
  let saetze = 0;

  while (true) {
    const { done, value } = await leser.read();
    if (done) break;
    puffer += dekoder.decode(value, { stream: true });

    // SSE: Bloecke sind durch eine Leerzeile getrennt.
    let schnitt: number;
    while ((schnitt = puffer.indexOf("\n\n")) >= 0) {
      const block = puffer.slice(0, schnitt);
      puffer = puffer.slice(schnitt + 2);

      let art = "message";
      let daten = "";
      for (const zeile of block.split("\n")) {
        if (zeile.startsWith("event:")) art = zeile.slice(6).trim();
        else if (zeile.startsWith("data:")) daten += zeile.slice(5).trim();
      }
      if (!daten) continue;

      let nutz: Record<string, unknown>;
      try { nutz = JSON.parse(daten); } catch { continue; }

      if (art === "satz") {
        saetze++;
        const s = String(nutz.text ?? "");
        gesprochen = gesprochen ? `${gesprochen} ${s}` : s;
        stufe("speaking", gesprochen);
        sprichSatz(s);
      } else if (art === "fehler") {
        stufe("error", String(nutz.grund ?? "unbekannter Fehler"));
        laufendeAntwort = null;
        return;
      }
    }
  }

  laufendeAntwort = null;
  if (saetze === 0) {
    stufe("error", "Das Modell hat nichts geantwortet.");
    return;
  }
  // `idle` setzt der Ausgabe-Zweig, sobald der letzte Satz verklungen ist.
}

// ---------------------------------------------------------------- Ausgabe

/** Noch nicht gesprochene Saetze, damit `idle` zum richtigen Zeitpunkt kommt. */
let offeneSaetze = 0;

function sprichSatz(satz: string): void {
  if (!("speechSynthesis" in window)) {
    // Kein stiller Ausfall: ohne Stimme ist es eine Textanwendung, und
    // das soll sichtbar sein.
    stufe("error", "Dieser Browser kann nicht sprechen (speechSynthesis fehlt).");
    return;
  }
  const a = new SpeechSynthesisUtterance(satz);
  a.lang = "de-DE";
  a.rate = 1.05;
  offeneSaetze++;
  const fertig = () => {
    offeneSaetze = Math.max(0, offeneSaetze - 1);
    if (offeneSaetze === 0 && !laufendeAntwort) stufe("idle");
  };
  a.onend = fertig;
  a.onerror = fertig;
  window.speechSynthesis.speak(a);
}

/** Alles sofort abbrechen: Escape, oder die naechste Frage. */
export function unterbrich(): void {
  laufendeAntwort?.abort();
  laufendeAntwort = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  offeneSaetze = 0;
}

// ------------------------------------------------------------ Verdrahtung

/**
 * An die Ereignisse haengen, die der Shim aus der Tastatur erzeugt.
 *
 * Bewusst hier und nicht in App.tsx: App.tsx gehoert Codacus. Wer diese
 * Datei entfernt, hat wieder die Attrappe — aber keinen kaputten Code.
 */
export function verdrahteSprachkette(): void {
  window.addEventListener("hotkey_pressed", () => { void starteAufnahme(); });
  window.addEventListener("hotkey_released", () => { void beendeAufnahme(); });
  // Eigener Name, siehe tauri-shim.ts: `pipeline_interrupted` wird dort
  // ueber den window-Bus an App.tsx verteilt. Haetten wir denselben
  // Namen, wuerde unser eigenes Feuern den Shim erneut ausloesen.
  window.addEventListener("sprachkette_abbruch", () => {
    unterbrich();
    stufe("idle");
  });
}
