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

/// 设置文件的格式版本。
///
/// 迁移只在 `schema_version < SCHEMA_VERSION` 时跑一次。`Default` 里故意留 0，
/// 是为了让老 prefs.json（没有这个字段）被认出来是旧文件；但「恢复默认设置」
/// 用它重置时必须把当前值写回去，否则下次启动会把刚重置的文件又当成旧文件迁移一遍，
/// 每次启动都打一条误导性的"已迁移"日志。
pub const SCHEMA_VERSION: i64 = 1;

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
    /// 积分区块（剩余总点数 / 每日积分领取状态）。0.6.4 新增，默认显示
    pub credit: bool,
    pub model: bool,
    pub perm: bool,
}

impl Default for Blocks {
    fn default() -> Self {
        Self { thinking: true, steps: true, metrics: true, credit: true, model: true, perm: true }
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
    /// 积分查询（需联网）。默认关闭 —— 关着时后端连凭据文件都不读。
    pub credit_sync: bool,
    /// 每日自动领取 100 积分。仅在 credit_sync 开启时生效。
    pub auto_signin: bool,
    /// 设置文件的版本号。只用来做一次性迁移，不参与界面逻辑。
    /// 0.6.4 起：< 1 表示还带着旧版本写进去的 manual_height 脏值。
    pub schema_version: i64,
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
            credit_sync: false,
            auto_signin: false,
            // 故意留 0：老 prefs.json 里没有这个字段，serde 会取 Default，
            // 取到 0 才能让 migrate() 认出"这是旧文件"
            schema_version: 0,
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

    /// 一次性迁移。返回 true 表示改过，调用方负责 save()。
    ///
    /// 0.6.4 之前，"手动高度"这个开关只在代码里被关掉过（恢复自适应按钮），
    /// 从来没有任何地方把它打开 —— 也就是说 prefs.json 里出现 true 的，
    /// 全是历史版本（Electron 0.5.x 的拖拽处理）写的脏值。
    /// 新规则是"默认自适应、拖动才转手动"，所以升级时先清一次。
    pub fn migrate(&mut self) -> bool {
        if self.schema_version < SCHEMA_VERSION {
            self.manual_height = false;
            self.schema_version = SCHEMA_VERSION;
            return true;
        }
        false
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
                credit: b.get("credit").and_then(|v| v.as_bool()).unwrap_or(d.credit),
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
        if let Some(v) = patch.get("creditSync").and_then(|v| v.as_bool()) {
            self.credit_sync = v;
        }
        if let Some(v) = patch.get("autoSignin").and_then(|v| v.as_bool()) {
            self.auto_signin = v;
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
