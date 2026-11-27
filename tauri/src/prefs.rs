// 面板偏好与窗口位置：文件格式与 Electron 版完全一致，老用户升级后设置不丢
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const WIDTH: f64 = 400.0;
pub const HEIGHT: f64 = 660.0;
pub const FOLDED_HEIGHT: f64 = 44.0;
pub const MIN_HEIGHT: f64 = 120.0;
pub const MIN_WIDTH: f64 = 320.0;
pub const MARGIN: f64 = 16.0;
/// 设置浮层展开时需要的窗口高度
pub const SHEET_HEIGHT: f64 = 560.0;

pub fn hud_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WB_HUD_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join(".workbuddy-hud")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Blocks {
    pub thinking: bool,
    pub steps: bool,
    pub metrics: bool,
    pub model: bool,
    pub perm: bool,
}

impl Default for Blocks {
    fn default() -> Self {
        Self { thinking: true, steps: true, metrics: true, model: true, perm: true }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    pub step_count: i64,
    pub thinking_lines: i64,
    pub blocks: Blocks,
    pub shortcut: String,
    pub always_on_top: bool,
    pub manual_height: bool,
    pub pinned_session: String,
    pub gate: String,
    pub gate_timeout: String,
    pub log_ask: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            step_count: 6,
            thinking_lines: 6,
            blocks: Blocks::default(),
            shortcut: "Control+Alt+W".into(),
            always_on_top: true,
            manual_height: false,
            pinned_session: String::new(),
            gate: "risky".into(),
            gate_timeout: "hold".into(),
            log_ask: "ask".into(),
        }
    }
}

impl Prefs {
    pub fn load() -> Self {
        let p = hud_dir().join("prefs.json");
        std::fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let dir = hud_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(dir.join("prefs.json"), s);
        }
    }

    /// 把页面传上来的补丁合进当前设置。只认已知字段，且做范围钳制，
    /// 与 Electron 版 updatePrefs 的规则保持一致。
    pub fn apply(&mut self, patch: &serde_json::Value) {
        if let Some(v) = patch.get("stepCount").and_then(|v| v.as_i64()) {
            self.step_count = v.clamp(1, 10);
        }
        if let Some(v) = patch.get("thinkingLines").and_then(|v| v.as_i64()) {
            self.thinking_lines = v.clamp(2, 10);
        }
        if let Some(b) = patch.get("blocks") {
            let d = Blocks::default();
            self.blocks = Blocks {
                thinking: b.get("thinking").and_then(|v| v.as_bool()).unwrap_or(d.thinking),
                steps: b.get("steps").and_then(|v| v.as_bool()).unwrap_or(d.steps),
                metrics: b.get("metrics").and_then(|v| v.as_bool()).unwrap_or(d.metrics),
                model: b.get("model").and_then(|v| v.as_bool()).unwrap_or(d.model),
                perm: b.get("perm").and_then(|v| v.as_bool()).unwrap_or(d.perm),
            };
        }
        if let Some(v) = patch.get("alwaysOnTop").and_then(|v| v.as_bool()) {
            self.always_on_top = v;
        }
        if let Some(v) = patch.get("manualHeight").and_then(|v| v.as_bool()) {
            self.manual_height = v;
        }
        if let Some(v) = patch.get("pinnedSession").and_then(|v| v.as_str()) {
            self.pinned_session = v.to_string();
        }
        if let Some(v) = patch.get("gate").and_then(|v| v.as_str()) {
            if matches!(v, "off" | "risky" | "all") {
                self.gate = v.to_string();
            }
        }
        if let Some(v) = patch.get("gateTimeout").and_then(|v| v.as_str()) {
            if matches!(v, "hold" | "deny10" | "pass1") {
                self.gate_timeout = v.to_string();
            }
        }
        if let Some(v) = patch.get("logAsk").and_then(|v| v.as_str()) {
            if matches!(v, "ask" | "never") {
                self.log_ask = v.to_string();
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WinState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub folded: bool,
}

impl Default for WinState {
    fn default() -> Self {
        Self { x: -1.0, y: -1.0, width: WIDTH, height: HEIGHT, folded: false }
    }
}

impl WinState {
    pub fn load() -> Self {
        let p = hud_dir().join("window.json");
        let mut s: WinState = std::fs::read_to_string(p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        // 旧版可能把含隐形边框的宽度存了回来，超出设计宽度的一律回到出厂值
        if !(s.width >= MIN_WIDTH && s.width <= WIDTH + 40.0) {
            s.width = WIDTH;
        }
        s
    }

    pub fn save(&self) {
        let dir = hud_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(dir.join("window.json"), s);
        }
    }
}
