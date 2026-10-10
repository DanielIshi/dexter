import { useEffect, useState, useRef } from "react";
import { invoke } from "./tauri-shim";
import { listen } from "./tauri-shim";
import "./App.css";

interface ProcessingState {
  stage: string;
  text: string;
}

interface ToolsConfig {
  search_knowledge: boolean;
  screenshot: boolean;
  read_clipboard: boolean;
  open_url: boolean;
  get_current_time: boolean;
  list_apps: boolean;
  run_command: boolean;
  web_fetch: boolean;
}

interface SandboxConfig {
  mode: "Guarded" | "Docker";
  timeout_secs: number;
  readable_paths: string[];
  workspace: string;
  docker_image: string;
  allow_network: boolean;
}

interface VoiceConfig {
  whisper_model_path: string;
  ollama_url: string;
  ollama_model: string;
  embed_model: string;
  vision_model: string;
  chatterbox_url: string;
  chatterbox_voice: string;
  system_prompt: string;
  tools: ToolsConfig;
  sandbox: SandboxConfig;
}

interface AudioChunk {
  index: number;
  audio: string;
}

interface ChatBubble {
  role: "user" | "assistant" | "status" | "tool";
  text: string;
  id: number;
}

type SettingsTab = "config" | "tools" | "knowledge";

let bubbleId = 0;

const TOOL_LABEL_MAP: Record<string, string> = {
  take_screenshot: "Taking screenshot",
  search_knowledge: "Searching knowledge",
  read_clipboard: "Reading clipboard",
  open_url: "Opening URL",
  get_current_time: "Checking time",
  list_running_apps: "Listing apps",
  run_command: "Running command",
  web_fetch: "Fetching web page",
};

/* ─────────────────────────── Settings: Config Tab ─────────────────────────── */

function ConfigTab({ config, setConfig }: { config: VoiceConfig; setConfig: (c: VoiceConfig) => void }) {
  return (
    <div className="flex flex-col gap-5 p-5 px-6">
      <FieldGroup title="Speech Recognition">
        <Field label="Whisper Model Path">
          <Input value={config.whisper_model_path} onChange={(v) => setConfig({ ...config, whisper_model_path: v })} />
        </Field>
      </FieldGroup>

      <FieldGroup title="Language Model">
        <Field label="Ollama URL">
          <Input value={config.ollama_url} onChange={(v) => setConfig({ ...config, ollama_url: v })} />
        </Field>
        <Field label="Chat Model">
          <Input value={config.ollama_model} onChange={(v) => setConfig({ ...config, ollama_model: v })} />
        </Field>
        <Field label="Embedding Model">
          <Input value={config.embed_model} onChange={(v) => setConfig({ ...config, embed_model: v })} placeholder="nomic-embed-text" />
        </Field>
        <Field label="Vision Model">
          <Input value={config.vision_model} onChange={(v) => setConfig({ ...config, vision_model: v })} placeholder="llava (for screenshot tool)" />
        </Field>
      </FieldGroup>

      <FieldGroup title="Text-to-Speech">
        <Field label="Chatterbox URL">
          <Input value={config.chatterbox_url} onChange={(v) => setConfig({ ...config, chatterbox_url: v })} />
        </Field>
        <Field label="Voice">
          <Input value={config.chatterbox_voice} onChange={(v) => setConfig({ ...config, chatterbox_voice: v })} />
        </Field>
      </FieldGroup>

      <FieldGroup title="Personality">
        <Field label="System Prompt">
          <textarea
            value={config.system_prompt}
            onChange={(e) => setConfig({ ...config, system_prompt: e.target.value })}
            rows={6}
            className="w-full bg-white/[0.05] border border-white/10 text-white/90 px-3 py-2.5 rounded-lg text-[13px] font-inherit outline-none resize-y min-h-[80px] transition-all duration-200 focus:border-blue-500/50 focus:bg-white/[0.07] placeholder:text-white/20"
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

/* ─────────────────────────── Settings: Tools Tab ─────────────────────────── */

const TOOL_DEFINITIONS: { key: keyof ToolsConfig; name: string; desc: string; icon: string }[] = [
  { key: "screenshot", name: "Screenshot", desc: "Capture and describe what's on your screen", icon: "📸" },
  { key: "read_clipboard", name: "Read Clipboard", desc: "Read current text from your clipboard", icon: "📋" },
  { key: "search_knowledge", name: "Knowledge Search", desc: "Search your local knowledge base for context", icon: "🔍" },
  { key: "open_url", name: "Open URL", desc: "Open websites in your default browser", icon: "🌐" },
  { key: "get_current_time", name: "Current Time", desc: "Get the current date, time, and day of week", icon: "🕐" },
  { key: "list_apps", name: "Running Apps", desc: "List currently running applications", icon: "🖥" },
  { key: "web_fetch", name: "Web Fetch", desc: "Fetch and read web pages for information", icon: "🕸" },
  { key: "run_command", name: "Shell Command", desc: "Execute terminal commands on your Mac", icon: "⚡" },
];

function ToolsTab({ config, setConfig }: { config: VoiceConfig; setConfig: (c: VoiceConfig) => void }) {
  const toggleTool = (key: keyof ToolsConfig) => {
    setConfig({ ...config, tools: { ...config.tools, [key]: !config.tools[key] } });
  };

  const setSandbox = (patch: Partial<SandboxConfig>) => {
    setConfig({ ...config, sandbox: { ...config.sandbox, ...patch } });
  };

  const enabledCount = TOOL_DEFINITIONS.filter((t) => config.tools[t.key]).length;

  return (
    <div className="flex flex-col gap-5 p-5 px-6">
      <p className="text-[13px] text-white/40 leading-relaxed flex items-center gap-2">
        Enable or disable tools the assistant can use.
        <span className="text-[11px] text-cyan-400/60 bg-cyan-400/[0.08] px-2 py-0.5 rounded">
          {enabledCount}/{TOOL_DEFINITIONS.length} active
        </span>
      </p>

      <div className="flex flex-col gap-1">
        {TOOL_DEFINITIONS.map((tool) => {
          const enabled = config.tools[tool.key];
          return (
            <div
              key={tool.key}
              className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all duration-200 ${
                enabled
                  ? "bg-white/[0.03] border-white/[0.06]"
                  : "bg-white/[0.01] border-white/[0.03] opacity-50"
              }`}
            >
              <span className="text-xl w-8 text-center shrink-0">{tool.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-white/85">{tool.name}</div>
                <div className="text-[11px] text-white/30 leading-relaxed mt-0.5">{tool.desc}</div>
              </div>
              <Toggle on={enabled} onToggle={() => toggleTool(tool.key)} />
            </div>
          );
        })}
      </div>

      {config.tools.run_command && (
        <FieldGroup title="Shell Sandbox">
          <p className="text-[12px] text-white/30 leading-relaxed -mt-1">
            Commands are validated, environment sanitized, and all executions logged.
          </p>

          <div className="flex gap-1 bg-white/[0.04] rounded-lg p-0.5">
            {(["Guarded", "Docker"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setSandbox({ mode })}
                className={`flex-1 py-2 px-3 rounded-md text-[13px] font-medium border-none cursor-pointer transition-all duration-200 ${
                  config.sandbox.mode === mode
                    ? "bg-blue-500/30 text-white/90"
                    : "bg-transparent text-white/40 hover:text-white/60"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-white/25 leading-relaxed">
            {config.sandbox.mode === "Guarded"
              ? "Isolated workspace, sanitized env, blocked dangerous commands."
              : "Docker container with memory/CPU limits, read-only root. Requires Docker Desktop."}
          </p>

          <Field label="Workspace Directory">
            <Input value={config.sandbox.workspace} onChange={(v) => setSandbox({ workspace: v })} />
          </Field>
          <Field label="Timeout (seconds)">
            <input
              type="number"
              value={config.sandbox.timeout_secs}
              onChange={(e) => setSandbox({ timeout_secs: parseInt(e.target.value) || 30 })}
              className="w-full bg-white/[0.05] border border-white/10 text-white/90 px-3 py-2.5 rounded-lg text-[13px] outline-none transition-all duration-200 focus:border-blue-500/50 focus:bg-white/[0.07]"
            />
          </Field>

          {config.sandbox.mode === "Docker" && (
            <>
              <Field label="Docker Image">
                <Input value={config.sandbox.docker_image} onChange={(v) => setSandbox({ docker_image: v })} />
              </Field>
              <Field label="Readable Paths (mounted read-only)">
                <textarea
                  value={config.sandbox.readable_paths.join("\n")}
                  onChange={(e) => setSandbox({ readable_paths: e.target.value.split("\n").filter(Boolean) })}
                  rows={3}
                  placeholder={"~/Documents\n~/Desktop\n~/Downloads"}
                  className="w-full bg-white/[0.05] border border-white/10 text-white/90 px-3 py-2.5 rounded-lg text-[13px] font-inherit outline-none resize-y transition-all duration-200 focus:border-blue-500/50 focus:bg-white/[0.07] placeholder:text-white/20"
                />
              </Field>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-white/80">Allow Network</div>
                  <div className="text-[11px] text-white/30 mt-0.5">Let commands access the internet</div>
                </div>
                <Toggle on={config.sandbox.allow_network} onToggle={() => setSandbox({ allow_network: !config.sandbox.allow_network })} />
              </div>
            </>
          )}
        </FieldGroup>
      )}
    </div>
  );
}

/* ─────────────────────────── Settings: Knowledge Tab ─────────────────────────── */

function KnowledgeTab() {
  const [sources, setSources] = useState<[string, number][]>([]);
  const [ingesting, setIngesting] = useState(false);
  const [textSource, setTextSource] = useState("");
  const [textContent, setTextContent] = useState("");
  const [status, setStatus] = useState("");

  const loadSources = async () => {
    try {
      const result = await invoke<[string, number][]>("list_knowledge_sources");
      setSources(result);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => { loadSources(); }, []);

  const ingestText = async () => {
    if (!textSource.trim() || !textContent.trim()) return;
    setIngesting(true);
    setStatus("");
    try {
      const chunks = await invoke<number>("ingest_text", { source: textSource, text: textContent });
      setStatus(`Ingested ${chunks} chunks from "${textSource}"`);
      setTextSource("");
      setTextContent("");
      loadSources();
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
    setIngesting(false);
  };

  const ingestFile = async () => {
    setIngesting(true);
    setStatus("");
    try {
      const path = prompt("Enter file path:");
      if (!path) { setIngesting(false); return; }
      const chunks = await invoke<number>("ingest_file", { path });
      setStatus(`Ingested ${chunks} chunks`);
      loadSources();
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
    setIngesting(false);
  };

  const deleteSource = async (source: string) => {
    try {
      await invoke("delete_knowledge_source", { source });
      loadSources();
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  return (
    <div className="flex flex-col gap-5 p-5 px-6">
      <p className="text-[13px] text-white/40 leading-relaxed">
        Add documents for the assistant to reference during conversations.
      </p>

      <FieldGroup title="Add Text">
        <Field label="Source Name">
          <Input value={textSource} onChange={setTextSource} placeholder="e.g. project-notes" />
        </Field>
        <Field label="Content">
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            rows={5}
            placeholder="Paste text content here..."
            className="w-full bg-white/[0.05] border border-white/10 text-white/90 px-3 py-2.5 rounded-lg text-[13px] font-inherit outline-none resize-y min-h-[80px] transition-all duration-200 focus:border-blue-500/50 focus:bg-white/[0.07] placeholder:text-white/20"
          />
        </Field>
        <div className="flex gap-2">
          <button
            onClick={ingestText}
            disabled={ingesting || !textSource.trim() || !textContent.trim()}
            className="px-4 py-2 rounded-lg text-[13px] font-medium border-none cursor-pointer bg-blue-500 text-white transition-all duration-150 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {ingesting ? "Ingesting..." : "Add Text"}
          </button>
          <button
            onClick={ingestFile}
            disabled={ingesting}
            className="px-4 py-2 rounded-lg text-[13px] font-medium border-none cursor-pointer bg-white/10 text-white/80 transition-all duration-150 hover:bg-white/[0.15] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add File
          </button>
        </div>
      </FieldGroup>

      {status && (
        <div className="text-[12px] text-cyan-400/80 px-3 py-2 bg-cyan-400/[0.08] rounded-lg">
          {status}
        </div>
      )}

      <FieldGroup title={`Sources (${sources.length})`}>
        {sources.length === 0 ? (
          <div className="text-[13px] text-white/25 text-center py-5">
            No documents in knowledge base yet.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {sources.map(([name, chunks]) => (
              <div key={name} className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors duration-150">
                <div className="flex items-center gap-2.5">
                  <span className="text-[13px] text-white/80 font-medium">{name}</span>
                  <span className="text-[10px] text-white/25 bg-white/[0.05] px-2 py-0.5 rounded">{chunks} chunks</span>
                </div>
                <button
                  onClick={() => deleteSource(name)}
                  className="w-7 h-7 rounded-md border-none bg-red-500/10 text-red-400/60 text-base cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-red-500/20 hover:text-red-400/90"
                  title="Remove source"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </FieldGroup>
    </div>
  );
}

/* ─────────────────────────── Shared Components ─────────────────────────── */

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 bg-white/[0.025] border border-white/[0.06] rounded-xl p-4">
      <div className="text-[11px] font-semibold text-white/40 uppercase tracking-wider">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-white/40">{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-white/[0.05] border border-white/10 text-white/90 px-3 py-2.5 rounded-lg text-[13px] outline-none transition-all duration-200 focus:border-blue-500/50 focus:bg-white/[0.07] placeholder:text-white/20"
    />
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative w-11 h-6 rounded-full border-none cursor-pointer shrink-0 transition-colors duration-200 ${
        on ? "bg-blue-500" : "bg-white/10"
      }`}
    >
      <div
        className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full bg-white transition-transform duration-200 ${
          on ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

/* ─────────────────────────── Settings View ─────────────────────────── */

function Settings() {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("config");

  useEffect(() => {
    invoke<VoiceConfig>("get_config").then(setConfig);
  }, []);

  const save = async () => {
    if (!config) return;
    await invoke("set_config", { config });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  if (!config) return null;

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "config", label: "Config" },
    { id: "tools", label: "Tools" },
    { id: "knowledge", label: "Knowledge" },
  ];

  return (
    <div className="h-screen flex flex-col settings-bg backdrop-blur-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3.5" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <h2 className="text-base font-semibold text-white/85 tracking-tight">Settings</h2>
        {tab !== "knowledge" && (
          <button
            onClick={save}
            className="px-4 py-1.5 rounded-md text-[12px] font-medium border-none cursor-pointer bg-blue-500 text-white hover:bg-blue-600 transition-colors duration-150"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {saved ? "Saved!" : "Save"}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 px-6 border-b border-white/[0.08]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-[13px] font-medium border-none bg-transparent cursor-pointer -mb-px transition-colors duration-150 border-b-2 ${
              tab === t.id
                ? "text-white/90 border-b-blue-500"
                : "text-white/35 border-b-transparent hover:text-white/55"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {tab === "config" && <ConfigTab config={config} setConfig={setConfig} />}
        {tab === "tools" && <ToolsTab config={config} setConfig={setConfig} />}
        {tab === "knowledge" && <KnowledgeTab />}
      </div>
    </div>
  );
}

/* ─────────────────────────── Orb View ─────────────────────────── */

function Orb() {
  const [stage, setStage] = useState("idle");
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const bubblesEndRef = useRef<HTMLDivElement>(null);

  // 10.10.2026 (CEO, GH#2990): Wachhund gegen haengende Zwischenzustaende.
  //
  // Daniel: "wie stoppe ich denn das zuhoeren? jetzt die ganze zeit gelb
  // transcribing steht da". Bleibt eine Stufe stehen, zeigt die Anzeige
  // einen Zustand, den es nicht mehr gibt — und der Nutzer wartet auf
  // etwas, das nie kommt. Schlimmer als ein Fehler, weil es wie Arbeit
  // aussieht.
  //
  // Nur die VORUEBERGEHENDEN Stufen bekommen eine Frist. "speaking" ist
  // bewusst NICHT dabei: eine lange Antwort darf lange sprechen.
  useEffect(() => {
    const FRISTEN: Record<string, number> = {
      listening: 60_000,     // Taste klemmt oder wurde nie losgelassen
      transcribing: 45_000,  // Erkennung braucht sonst 0,3-1 s
      thinking: 120_000,     // Modell kalt oder Warteschlange
      tool_call: 120_000,
    };
    const frist = FRISTEN[stage];
    if (!frist) return;
    const t = setTimeout(() => {
      setStage("idle");
      addBubble(
        "status",
        `Abgebrochen — "${stage}" hat nicht geantwortet. Shift+Z fuer einen neuen Versuch.`,
      );
    }, frist);
    return () => clearTimeout(t);
  }, [stage]);

  const audioQueueRef = useRef<{ index: number; url: string }[]>([]);
  const isPlayingRef = useRef(false);
  const totalChunksRef = useRef<number | null>(null);
  const playedCountRef = useRef(0);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    bubblesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles]);

  const addBubble = (role: ChatBubble["role"], text: string) => {
    setBubbles((prev) => [...prev, { role, text, id: bubbleId++ }]);
  };

  const stopAllAudio = () => {
    // Stop currently playing audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      currentAudioRef.current = null;
    }
    // Revoke all queued audio URLs
    for (const item of audioQueueRef.current) {
      URL.revokeObjectURL(item.url);
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    totalChunksRef.current = null;
    playedCountRef.current = 0;
  };

  const playNext = () => {
    if (isPlayingRef.current) return;
    audioQueueRef.current.sort((a, b) => a.index - b.index);
    if (audioQueueRef.current.length === 0) {
      if (totalChunksRef.current !== null && playedCountRef.current >= totalChunksRef.current) {
        setStage("idle");
        totalChunksRef.current = null;
        playedCountRef.current = 0;
      }
      return;
    }
    const next = audioQueueRef.current.shift()!;
    isPlayingRef.current = true;
    const audio = new Audio(next.url);
    currentAudioRef.current = audio;
    audio.play().catch(() => {});
    audio.onended = () => { URL.revokeObjectURL(next.url); currentAudioRef.current = null; isPlayingRef.current = false; playedCountRef.current++; playNext(); };
    audio.onerror = () => { URL.revokeObjectURL(next.url); currentAudioRef.current = null; isPlayingRef.current = false; playedCountRef.current++; playNext(); };
  };

  useEffect(() => {
    const unInterrupted = listen("pipeline_interrupted", () => {
      stopAllAudio();
    });
    const unPressed = listen("hotkey_pressed", () => {
      stopAllAudio();
      setStage("listening");
    });
    const unReleased = listen("hotkey_released", () => { setStage("transcribing"); });
    return () => {
      unInterrupted.then((fn) => fn());
      unPressed.then((fn) => fn());
      unReleased.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<ProcessingState>("processing", (event) => {
      const { stage: newStage, text } = event.payload;
      setStage(newStage);
      if (newStage === "transcribed") {
        addBubble("user", text);
      } else if (newStage === "tool_call") {
        // Replace any existing tool/status chip with the new one (only keep one)
        setBubbles((prev) => {
          const filtered = prev.filter((b) => b.role !== "tool" && b.role !== "status");
          return [...filtered, { role: "tool", text, id: bubbleId++ }];
        });
      } else if (newStage === "speaking") {
        // Remove ephemeral tool/status chips when assistant starts speaking
        setBubbles((prev) => {
          const filtered = prev.filter((b) => b.role !== "tool" && b.role !== "status");
          const last = filtered[filtered.length - 1];
          if (last && last.role === "assistant") {
            const updated = [...filtered];
            updated[updated.length - 1] = { ...last, text };
            return updated;
          }
          return [...filtered, { role: "assistant", text, id: bubbleId++ }];
        });
      } else if (newStage === "error") {
        addBubble("status", text);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<AudioChunk>("play_audio_chunk", (event) => {
      const { index, audio } = event.payload;
      const audioBytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
      const audioBlob = new Blob([audioBytes], { type: "audio/wav" });
      const url = URL.createObjectURL(audioBlob);
      audioQueueRef.current.push({ index, url });
      playNext();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<number>("play_audio_done", (event) => {
      totalChunksRef.current = event.payload;
      if (playedCountRef.current >= event.payload && !isPlayingRef.current) {
        setStage("idle");
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("messages_cleared", () => { setBubbles([]); setStage("idle"); });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const orbClass = [
    "orb-container",
    stage === "listening" && "orb-listening",
    stage === "transcribing" && "orb-processing",
    stage === "transcribed" && "orb-processing",
    stage === "thinking" && "orb-thinking",
    stage === "tool_call" && "orb-toolcall",
    stage === "speaking" && "orb-speaking",
    stage === "error" && "orb-error",
  ].filter(Boolean).join(" ");

  // Glow animation class based on state
  const glowAnim =
    stage === "listening" ? "animate-pulse-slow" :
    stage === "speaking" ? "animate-speak-pulse" :
    stage === "tool_call" ? "animate-breathe-fast" :
    (stage === "processing" || stage === "transcribing" || stage === "transcribed") ? "animate-breathe-fast" :
    stage === "thinking" ? "animate-breathe" :
    stage === "error" ? "" :
    "animate-breathe";

  // Ring animation based on state
  const ringAnim =
    stage === "listening" ? "animate-ring-pulse" :
    (stage === "transcribing" || stage === "transcribed" || stage === "processing") ? "animate-spin-medium" :
    stage === "thinking" ? "animate-spin-slow" :
    stage === "tool_call" ? "animate-spin-fast" :
    "";

  return (
    <div className="flex flex-col h-screen orb-bg px-5 py-4">
      {/* Conversation bubbles */}
      <div className="flex-1 overflow-y-auto flex flex-col justify-end px-3.5 pt-4 pb-2.5 gap-2 no-scrollbar bubble-mask">
        {bubbles.map((b) => (
          <BubbleComponent key={b.id} bubble={b} />
        ))}
        {(stage === "listening" || stage === "transcribing" || stage === "thinking") && (
          <div className="self-center animate-fade-in px-3 py-1 text-white/25 text-[11px] font-medium">
            {stage === "listening" ? "Listening..." : stage === "transcribing" ? "Transcribing..." : "Thinking..."}
          </div>
        )}
        <div ref={bubblesEndRef} />
      </div>

      {/* Orb */}
      <div className="flex justify-center pb-5 pt-2 shrink-0">
        <div className={`${orbClass} relative w-20 h-20`}>
          <div className={`orb-glow absolute -inset-[5%] rounded-full blur-[14px] z-[1] ${glowAnim}`} />
          <div className="orb-core absolute inset-[18%] rounded-full z-[2]" />
          <div className={`orb-ring absolute inset-[8%] rounded-full border-[1.5px] z-[3] ${ringAnim}`} />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Bubble Component ─────────────────────────── */

function BubbleComponent({ bubble }: { bubble: ChatBubble }) {
  if (bubble.role === "user") {
    return (
      <div className="self-end max-w-[85%] animate-bubble-in">
        <div className="px-3.5 py-2.5 rounded-2xl rounded-br-md bg-[#1c2044] text-white/90 text-[13px] leading-relaxed">
          {bubble.text}
        </div>
      </div>
    );
  }

  if (bubble.role === "assistant") {
    return (
      <div className="self-start max-w-[85%] animate-bubble-in">
        <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-[#252529] text-white/85 text-[13px] leading-relaxed">
          {bubble.text}
        </div>
      </div>
    );
  }

  if (bubble.role === "tool") {
    const label = TOOL_LABEL_MAP[bubble.text] || bubble.text;
    return (
      <div className="self-center animate-fade-in">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#222228] text-white/40 text-[11px] font-medium">
          <span className="text-[10px] animate-gear-spin">&#9881;</span>
          {label}
        </div>
      </div>
    );
  }

  // status
  return (
    <div className="self-center animate-fade-in">
      <div className="px-3 py-1 text-white/25 text-[11px] font-medium">
        {bubble.text}
      </div>
    </div>
  );
}

/* ─────────────────────────── App ─────────────────────────── */

function App() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");

  if (view === "settings") {
    return <Settings />;
  }
  return <Orb />;
}

export default App;
