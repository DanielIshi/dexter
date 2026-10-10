use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::WebviewWindowBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio_util::sync::CancellationToken;

mod rag;
mod sandbox;
mod tools;
mod voice;

#[derive(Clone, Serialize)]
struct ProcessingState {
    stage: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct AudioChunk {
    index: u32,
    audio: String, // base64 WAV
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    role: String,
    content: String,
    /// Preserved tool_calls from assistant messages (for Ollama protocol).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    tool_calls: Option<Vec<voice::OllamaToolCallOut>>,
}

pub struct AppState {
    messages: Mutex<Vec<ChatMessage>>,
    config: Mutex<VoiceConfig>,
    rag_store: rag::RagStore,
    audit_log: Mutex<sandbox::AuditLog>,
    // Audio samples collected by the recording thread
    recorded_samples: Mutex<Vec<f32>>,
    recording_sample_rate: Mutex<u32>,
    is_recording: Mutex<bool>,
    // Cancellation token for the active pipeline — cancelled when user interrupts
    pipeline_cancel: Mutex<CancellationToken>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ToolsConfig {
    #[serde(default = "default_true")]
    pub search_knowledge: bool,
    #[serde(default = "default_true")]
    pub screenshot: bool,
    #[serde(default = "default_true")]
    pub read_clipboard: bool,
    #[serde(default = "default_true")]
    pub open_url: bool,
    #[serde(default = "default_true")]
    pub get_current_time: bool,
    #[serde(default = "default_true")]
    pub list_apps: bool,
    #[serde(default)]
    pub run_command: bool,
    #[serde(default = "default_true")]
    pub web_fetch: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            search_knowledge: true,
            screenshot: true,
            read_clipboard: true,
            open_url: true,
            get_current_time: true,
            list_apps: true,
            run_command: false, // Off by default — powerful tool
            web_fetch: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    pub whisper_model_path: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub embed_model: String,
    #[serde(default)]
    pub vision_model: String,
    pub chatterbox_url: String,
    pub chatterbox_voice: String,
    pub system_prompt: String,
    #[serde(default)]
    pub tools: ToolsConfig,
    #[serde(default)]
    pub sandbox: sandbox::SandboxConfig,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        let default_model = dirs::home_dir()
            .map(|h| {
                h.join(".cache/whisper/ggml-base.en.bin")
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_default();
        Self {
            whisper_model_path: default_model,
            ollama_url: "http://localhost:11434".to_string(),
            ollama_model: "qwen3:4b".to_string(),
            embed_model: "nomic-embed-text".to_string(),
            vision_model: "llava".to_string(),
            chatterbox_url: "http://localhost:8005".to_string(),
            chatterbox_voice: "Anirban.wav".to_string(),
            system_prompt: "You are a voice assistant running on the user's desktop. The conversation happens entirely through voice — the user speaks into their microphone, their speech is transcribed to text via Whisper (STT), sent to you as a message, and your response is converted back to speech via Chatterbox Turbo (TTS) and played through their speakers. You can hear them and they can hear you — treat this as a natural spoken conversation. If they ask \"can you hear me\" the answer is yes.\n\nKeep responses concise and conversational — 2-3 sentences max. No markdown, no code blocks, no bullet points, no numbered lists, no special formatting. Write exactly as you would speak out loud. Avoid colons in your responses as they cause unnatural pauses in TTS.\n\nYou can express emotions naturally using these paralinguistic tags inline with your speech — use them sparingly and only when they genuinely fit the moment:\n[laugh] [chuckle] [sigh] [gasp] [cough] [clear throat] [sniff] [groan] [shush]\nExample — \"Oh wow, that's actually hilarious [laugh] I didn't expect that at all.\"\nDo NOT overuse them. Most responses need zero tags. Only use them when a human would genuinely make that sound.\n\nWhen you decide to use a tool, ALWAYS say what you're about to do first in a short natural sentence before calling the tool. For example — \"Let me take a look at your screen\" before taking a screenshot, \"Let me search the web for that\" before fetching a page, \"Let me check the time\" before getting the time, \"One sec, let me run that command\" before executing a shell command. This way the user hears what's happening instead of waiting in silence.".to_string(),
            tools: ToolsConfig::default(),
            sandbox: sandbox::SandboxConfig::default(),
        }
    }
}

impl VoiceConfig {
    fn config_path() -> std::path::PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
            .join("voice-assistant")
            .join("config.json")
    }

    fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str(&data) {
                    return config;
                }
            }
        }
        Self::default()
    }

    fn save(&self) {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(data) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&path, data);
        }
    }
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> VoiceConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(state: tauri::State<AppState>, config: VoiceConfig) {
    config.save();
    *state.config.lock().unwrap() = config;
}

#[tauri::command]
fn get_messages(state: tauri::State<AppState>) -> Vec<ChatMessage> {
    state.messages.lock().unwrap().clone()
}

#[tauri::command]
fn clear_messages(state: tauri::State<AppState>) {
    state.messages.lock().unwrap().clear();
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

// ── RAG Commands ──

#[tauri::command]
async fn ingest_text(
    app: tauri::AppHandle,
    source: String,
    text: String,
) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    state
        .rag_store
        .ingest(&source, &text, &config.ollama_url, &config.embed_model)
        .await
        .map_err(|e| format!("Ingest failed: {}", e))
}

#[tauri::command]
async fn ingest_file(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Read failed: {}", e))?;
    let source = std::path::Path::new(&path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    state
        .rag_store
        .ingest(&source, &text, &config.ollama_url, &config.embed_model)
        .await
        .map_err(|e| format!("Ingest failed: {}", e))
}

#[tauri::command]
fn list_knowledge_sources(app: tauri::AppHandle) -> Result<Vec<(String, usize)>, String> {
    let state = app.state::<AppState>();
    state
        .rag_store
        .list_sources()
        .map_err(|e| format!("List failed: {}", e))
}

#[tauri::command]
fn delete_knowledge_source(app: tauri::AppHandle, source: String) -> Result<usize, String> {
    let state = app.state::<AppState>();
    state
        .rag_store
        .delete_source(&source)
        .map_err(|e| format!("Delete failed: {}", e))
}

#[tauri::command]
fn start_recording(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Check if already recording
    {
        let is_rec = state.is_recording.lock().unwrap();
        if *is_rec {
            return Ok(());
        }
    }

    // Clear previous samples
    state.recorded_samples.lock().unwrap().clear();
    *state.is_recording.lock().unwrap() = true;

    let app_handle = app.clone();

    // Spawn recording on a dedicated thread (cpal::Stream isn't Send)
    std::thread::spawn(move || {
        if let Err(e) = voice::record_audio(&app_handle) {
            eprintln!("Recording error: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_recording_and_process(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Signal recording to stop
    *state.is_recording.lock().unwrap() = false;

    // Give a moment for the recording thread to finish writing samples
    std::thread::sleep(std::time::Duration::from_millis(100));

    let samples = state.recorded_samples.lock().unwrap().clone();
    let sample_rate = *state.recording_sample_rate.lock().unwrap();
    let config = state.config.lock().unwrap().clone();

    if samples.is_empty() {
        return Err("No audio recorded".to_string());
    }

    // Process in background
    let cancel_token = state.pipeline_cancel.lock().unwrap().clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = process_pipeline(app_handle.clone(), samples, sample_rate, config, cancel_token).await {
            if e != "interrupted" {
                eprintln!("Pipeline error: {}", e);
                let _ = app_handle.emit(
                    "processing",
                    ProcessingState {
                        stage: "error".to_string(),
                        text: e,
                    },
                );
            }
        }
    });

    Ok(())
}

async fn process_pipeline(
    app: tauri::AppHandle,
    samples: Vec<f32>,
    sample_rate: u32,
    config: VoiceConfig,
    cancel: CancellationToken,
) -> Result<(), String> {
    // Stage 1: Transcribe
    app.emit(
        "processing",
        ProcessingState {
            stage: "transcribing".to_string(),
            text: "Transcribing...".to_string(),
        },
    )
    .map_err(|e: tauri::Error| e.to_string())?;

    let model_path = config.whisper_model_path.clone();
    let transcript = tokio::task::spawn_blocking(move || {
        voice::transcribe_audio(&model_path, &samples, sample_rate)
    })
    .await
    .map_err(|e| format!("Transcription task failed: {}", e))?
    .map_err(|e| format!("Transcription failed: {}", e))?;

    if cancel.is_cancelled() { return Err("interrupted".to_string()); }

    if transcript.trim().is_empty() {
        app.emit(
            "processing",
            ProcessingState {
                stage: "idle".to_string(),
                text: String::new(),
            },
        )
        .map_err(|e: tauri::Error| e.to_string())?;
        return Err("No speech detected".to_string());
    }

    app.emit(
        "processing",
        ProcessingState {
            stage: "transcribed".to_string(),
            text: transcript.clone(),
        },
    )
    .map_err(|e: tauri::Error| e.to_string())?;

    // Add user message
    {
        app.state::<AppState>().messages.lock().unwrap().push(ChatMessage {
            role: "user".to_string(),
            content: transcript.clone(),
            tool_calls: None,
        });
    }

    // Stage 2: LLM with tool calling → streaming TTS
    app.emit(
        "processing",
        ProcessingState {
            stage: "thinking".to_string(),
            text: "Thinking...".to_string(),
        },
    )
    .map_err(|e: tauri::Error| e.to_string())?;

    let all_messages = app.state::<AppState>().messages.lock().unwrap().clone();

    let tools = voice::build_tools(&config.tools);
    let max_tool_rounds = 5;

    // Single streaming loop: stream with tools → if model returns tool calls,
    // execute them and stream again. If it returns content, sentences flow to TTS.
    let (sentence_tx, mut sentence_rx) = tokio::sync::mpsc::channel::<String>(16);
    let mut sentence_index: u32 = 0;
    let mut full_text = String::new();

    let app_clone = app.clone();
    let config_clone = config.clone();
    let cancel_llm = cancel.clone();

    let llm_handle = {
        let tools = tools.clone();
        let sentence_tx = sentence_tx.clone();
        let app = app_clone.clone();
        let config = config_clone.clone();

        tokio::spawn(async move {
            let mut all_msgs = all_messages;

            for _round in 0..max_tool_rounds {
                if cancel_llm.is_cancelled() { return Err("interrupted".to_string()); }

                let result = tokio::select! {
                    _ = cancel_llm.cancelled() => { return Err("interrupted".to_string()); }
                    r = voice::chat_streaming(&config, &all_msgs, &tools, &sentence_tx) => {
                        r.map_err(|e| format!("LLM failed: {}", e))?
                    }
                };

                match result {
                    voice::StreamResult::Content(text) => {
                        return Ok::<String, String>(text);
                    }
                    voice::StreamResult::ToolCalls(tool_calls, preamble, xml_parsed) => {
                        if cancel_llm.is_cancelled() { return Err("interrupted".to_string()); }

                        if xml_parsed {
                            // XML-parsed tool calls: model emitted XML as text.
                            // Add the preamble as assistant content, then inject
                            // tool results as a user message (model doesn't understand
                            // native tool protocol).
                            if !preamble.is_empty() {
                                all_msgs.push(ChatMessage {
                                    role: "assistant".to_string(),
                                    content: preamble,
                                    tool_calls: None,
                                });
                            }

                            let mut tool_results = String::new();
                            for tool_call in &tool_calls {
                                if cancel_llm.is_cancelled() { return Err("interrupted".to_string()); }

                                let _ = app.emit(
                                    "processing",
                                    ProcessingState {
                                        stage: "tool_call".to_string(),
                                        text: tool_call.function.name.clone(),
                                    },
                                );

                                let result_text = execute_tool(&app, &config, tool_call).await;
                                tool_results.push_str(&format!(
                                    "[Tool result for {}]: {}\n",
                                    tool_call.function.name, result_text
                                ));
                            }

                            all_msgs.push(ChatMessage {
                                role: "user".to_string(),
                                content: format!(
                                    "Here are the tool results. Use them to answer my previous question naturally. Do NOT call tools again.\n\n{}",
                                    tool_results.trim()
                                ),
                                tool_calls: None,
                            });
                        } else {
                            // Native Ollama tool calls: use proper tool protocol
                            let tool_calls_out: Vec<voice::OllamaToolCallOut> =
                                tool_calls.iter().map(|tc| tc.to_out()).collect();
                            all_msgs.push(ChatMessage {
                                role: "assistant".to_string(),
                                content: preamble,
                                tool_calls: Some(tool_calls_out),
                            });

                            for tool_call in &tool_calls {
                                if cancel_llm.is_cancelled() { return Err("interrupted".to_string()); }

                                let _ = app.emit(
                                    "processing",
                                    ProcessingState {
                                        stage: "tool_call".to_string(),
                                        text: tool_call.function.name.clone(),
                                    },
                                );

                                let result_text = execute_tool(&app, &config, tool_call).await;

                                all_msgs.push(ChatMessage {
                                    role: "tool".to_string(),
                                    content: result_text,
                                    tool_calls: None,
                                });
                            }
                        }

                        let _ = app.emit(
                            "processing",
                            ProcessingState {
                                stage: "thinking".to_string(),
                                text: "Thinking...".to_string(),
                            },
                        );
                    }
                }
            }

            // Hit max rounds — do one final stream without tools
            if cancel_llm.is_cancelled() { return Err("interrupted".to_string()); }

            let result = voice::chat_streaming(&config, &all_msgs, &[], &sentence_tx)
                .await
                .map_err(|e| format!("LLM failed: {}", e))?;

            match result {
                voice::StreamResult::Content(text) => Ok(text),
                voice::StreamResult::ToolCalls(_, _, _) => Err("Model returned tool calls after max rounds".to_string()),
            }
        })
    };

    // Drop our copy of sentence_tx so the channel closes when the spawned task finishes
    drop(sentence_tx);

    // Process sentences as they arrive from the stream → TTS → audio
    // Check cancellation between each TTS synthesis
    while let Some(sentence) = sentence_rx.recv().await {
        if cancel.is_cancelled() { break; }

        full_text.push_str(&sentence);
        full_text.push(' ');

        app.emit(
            "processing",
            ProcessingState {
                stage: "speaking".to_string(),
                text: full_text.trim().to_string(),
            },
        )
        .map_err(|e: tauri::Error| e.to_string())?;

        // Race TTS synthesis against cancellation
        let tts_result = tokio::select! {
            _ = cancel.cancelled() => { break; }
            r = voice::synthesize(&config, &sentence) => r
        };

        match tts_result {
            Ok(audio_base64) => {
                if cancel.is_cancelled() { break; }
                app.emit("play_audio_chunk", AudioChunk {
                    index: sentence_index,
                    audio: audio_base64,
                })
                .map_err(|e: tauri::Error| e.to_string())?;
                sentence_index += 1;
            }
            Err(e) => {
                eprintln!("TTS failed for sentence: {}", e);
            }
        }
    }

    if cancel.is_cancelled() {
        llm_handle.abort(); // kill the LLM task
        return Err("interrupted".to_string());
    }

    let full_response = llm_handle
        .await
        .map_err(|e| format!("LLM task failed: {}", e))?
        .map_err(|e| e)?;

    app.emit("play_audio_done", sentence_index)
        .map_err(|e: tauri::Error| e.to_string())?;

    // Add assistant message to history
    app.state::<AppState>().messages.lock().unwrap().push(ChatMessage {
        role: "assistant".to_string(),
        content: full_response,
        tool_calls: None,
    });

    Ok(())
}

/// Execute a single tool call and return the result text.
async fn execute_tool(
    app: &tauri::AppHandle,
    config: &VoiceConfig,
    tool_call: &voice::OllamaToolCall,
) -> String {
    let rag_store = &app.state::<AppState>().rag_store;

    match tool_call.function.name.as_str() {
        "search_knowledge" => {
            let query = tool_call.function.arguments.get("query")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();

            let results = rag_store
                .search(&query, &config.ollama_url, &config.embed_model, 5)
                .await
                .unwrap_or_default();

            if results.is_empty() {
                "No relevant results found in the knowledge base.".to_string()
            } else {
                results.iter().enumerate()
                    .map(|(i, r)| format!("[{}] (source: {}, relevance: {:.2})\n{}", i + 1, r.source, r.score, r.text))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            }
        }
        "take_screenshot" => {
            let question = tool_call.function.arguments.get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("Describe what you see on this screen in detail.")
                .to_string();
            let monitor = tool_call.function.arguments.get("monitor")
                .and_then(|v| v.as_u64()).map(|n| n as u32);

            let _ = app.emit("processing", ProcessingState {
                stage: "thinking".to_string(),
                text: "Looking at your screen...".to_string(),
            });

            match tools::take_screenshot(monitor) {
                Ok(image_b64) => {
                    let vision_model = if config.vision_model.is_empty() {
                        &config.ollama_model
                    } else {
                        &config.vision_model
                    };
                    match tools::describe_screenshot(&config.ollama_url, vision_model, &image_b64, &question).await {
                        Ok(desc) => desc,
                        Err(e) => format!("Screenshot captured but vision model failed: {}. The model '{}' may not support image inputs — try setting a vision model like 'llava' in settings.", e, vision_model),
                    }
                }
                Err(e) => format!("Failed to capture screenshot: {}", e),
            }
        }
        "read_clipboard" => match tools::read_clipboard() {
            Ok(text) => if text.trim().is_empty() { "The clipboard is empty.".to_string() } else { format!("Clipboard contents:\n{}", text) },
            Err(e) => format!("Failed to read clipboard: {}", e),
        },
        "open_url" => {
            let url = tool_call.function.arguments.get("url")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() { "No URL provided.".to_string() }
            else { match tools::open_url(&url) { Ok(msg) => msg, Err(e) => format!("Failed to open URL: {}", e) } }
        }
        "get_current_time" => tools::get_current_time(),
        "list_running_apps" => match tools::list_running_apps() {
            Ok(apps) => format!("Currently running applications:\n{}", apps),
            Err(e) => format!("Failed to list apps: {}", e),
        },
        "web_fetch" => {
            let url = tool_call.function.arguments.get("url")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() { "No URL provided.".to_string() }
            else { match tools::web_fetch(&url).await { Ok(text) => text, Err(e) => format!("Failed to fetch {}: {}", url, e) } }
        }
        "run_command" => {
            let command = tool_call.function.arguments.get("command")
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            if command.is_empty() {
                "No command provided.".to_string()
            } else {
                let _ = app.emit("processing", ProcessingState {
                    stage: "thinking".to_string(),
                    text: format!("Running: {}", command),
                });
                let audit = &app.state::<AppState>().audit_log;
                match sandbox::execute(&command, &config.sandbox, audit) {
                    Ok(output) => output,
                    Err(e) => format!("Sandbox: {}", e),
                }
            }
        }
        unknown => format!("Unknown tool: {}", unknown),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            messages: Mutex::new(Vec::new()),
            config: Mutex::new(VoiceConfig::load()),
            rag_store: rag::RagStore::new().expect("Failed to initialize RAG store"),
            audit_log: Mutex::new(sandbox::AuditLog::new()),
            recorded_samples: Mutex::new(Vec::new()),
            recording_sample_rate: Mutex::new(44100),
            is_recording: Mutex::new(false),
            pipeline_cancel: Mutex::new(CancellationToken::new()),
        })
        .setup(|app| {
            // Build tray menu
            let show_item =
                MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let settings_item =
                MenuItemBuilder::with_id("settings", "Settings").build(app)?;
            let clear_item =
                MenuItemBuilder::with_id("clear", "Clear Chat").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&settings_item)
                .item(&clear_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Build tray icon
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Voice Assistant — Hold Shift+Z to talk")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "settings" => {
                        // If settings window already exists, just focus it
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            // Create a new settings window
                            let url = tauri::WebviewUrl::App("index.html?view=settings".into());
                            let _ = WebviewWindowBuilder::new(app, "settings", url)
                                .title("Voice Assistant — Settings")
                                .inner_size(720.0, 700.0)
                                .min_inner_size(600.0, 500.0)
                                .resizable(true)
                                .build();
                        }
                    }
                    "clear" => {
                        let state = app.state::<AppState>();
                        state.messages.lock().unwrap().clear();
                        let _ = app.emit("messages_cleared", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Register global shortcut in Rust so it works when window is hidden
            app.global_shortcut().on_shortcut("Shift+Z", |app, _shortcut, event| {
                match event.state {
                    ShortcutState::Pressed => {
                        // Cancel any running pipeline first
                        {
                            let state = app.state::<AppState>();
                            let mut cancel = state.pipeline_cancel.lock().unwrap();
                            cancel.cancel(); // signal the running pipeline to stop
                            *cancel = CancellationToken::new(); // fresh token for next pipeline
                        }

                        // Tell frontend to stop audio and reset
                        let _ = app.emit("pipeline_interrupted", ());

                        // Show window at bottom-right and start recording
                        if let Some(window) = app.get_webview_window("main") {
                            if let Ok(Some(monitor)) = window.current_monitor() {
                                let screen = monitor.size();
                                let scale = monitor.scale_factor();
                                let win_w = 320.0;
                                let win_h = 400.0;
                                let padding = 20.0;
                                let dock_offset = 80.0;
                                let x = (screen.width as f64 / scale) - win_w - padding;
                                let y = (screen.height as f64 / scale) - win_h - padding - dock_offset;
                                let _ = window.set_position(tauri::PhysicalPosition::new(
                                    (x * scale) as i32,
                                    (y * scale) as i32,
                                ));
                            }
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("hotkey_pressed", ());

                        // Start recording
                        let state = app.state::<AppState>();
                        let is_rec = *state.is_recording.lock().unwrap();
                        if !is_rec {
                            state.recorded_samples.lock().unwrap().clear();
                            *state.is_recording.lock().unwrap() = true;
                            let app_clone = app.clone();
                            std::thread::spawn(move || {
                                if let Err(e) = voice::record_audio(&app_clone) {
                                    eprintln!("Recording error: {}", e);
                                }
                            });
                        }
                    }
                    ShortcutState::Released => {
                        let _ = app.emit("hotkey_released", ());

                        // Stop recording and process
                        let state = app.state::<AppState>();
                        *state.is_recording.lock().unwrap() = false;

                        // Grab the current cancel token for this pipeline
                        let cancel_token = state.pipeline_cancel.lock().unwrap().clone();

                        let app_clone = app.clone();
                        // Small delay to let recording thread finish, then process
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(100));

                            let state = app_clone.state::<AppState>();
                            let samples = state.recorded_samples.lock().unwrap().clone();
                            let sample_rate = *state.recording_sample_rate.lock().unwrap();
                            let config = state.config.lock().unwrap().clone();

                            if samples.is_empty() {
                                let _ = app_clone.emit("processing", ProcessingState {
                                    stage: "error".to_string(),
                                    text: "No audio recorded".to_string(),
                                });
                                return;
                            }

                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = process_pipeline(app_clone.clone(), samples, sample_rate, config, cancel_token).await {
                                    if e != "interrupted" {
                                        eprintln!("Pipeline error: {}", e);
                                        let _ = app_clone.emit("processing", ProcessingState {
                                            stage: "error".to_string(),
                                            text: e,
                                        });
                                    }
                                }
                            });
                        });
                    }
                }
            })?;

            // Register Shift+X to hide/dismiss the window
            app.global_shortcut().on_shortcut("Shift+X", |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            })?;

            // Hide dock icon on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Make webview background transparent and hide on launch
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = window.hide();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_messages,
            clear_messages,
            show_window,
            hide_window,
            ingest_text,
            ingest_file,
            list_knowledge_sources,
            delete_knowledge_source,
            start_recording,
            stop_recording_and_process,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
