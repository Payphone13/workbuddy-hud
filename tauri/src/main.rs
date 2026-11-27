// WorkBuddy 状态面板 — Tauri 外壳
//
// 只做外壳该做的事：开一个无边框置顶小窗、挂托盘、管全局热键、拉起 node 后端。
// 数据、判断、权限代答全部留在 src/service 里，与 Electron 版共用同一份代码。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod prefs;
mod sys;

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use prefs::{Prefs, WinState, FOLDED_HEIGHT, HEIGHT, MIN_HEIGHT, MIN_WIDTH, SHEET_HEIGHT, WIDTH};

/// 后端脚本内嵌进 exe，运行时解到 ~/.workbuddy-hud/runtime/
/// 好处是只有一个文件要发，且后端版本永远和外壳对得上。
const BACKEND: &[(&str, &[u8])] = &[
    ("server.js", include_bytes!("../../src/service/server.js")),
    ("config.js", include_bytes!("../../src/service/config.js")),
    ("store.js", include_bytes!("../../src/service/store.js")),
    ("transcript.js", include_bytes!("../../src/service/transcript.js")),
    ("credit.js", include_bytes!("../../src/service/credit.js")),
    ("permissions.js", include_bytes!("../../src/service/permissions.js")),
    ("risk.js", include_bytes!("../../src/service/risk.js")),
];

/// 钩子安装脚本也内嵌：托盘里的「修复 / 撤销对接」直接跑它，
/// 不依赖源码目录还在不在（便携版只有这一个 exe）
const HOOK_TOOLS: &[(&str, &[u8])] = &[
    ("tools/install-hooks.js", include_bytes!("../../tools/install-hooks.js")),
    ("hooks/hud-hook.js", include_bytes!("../../hooks/hud-hook.js")),
];

const SHIM: &str = include_str!("../shell/shim.js");
const PREFERRED_PORT: u16 = 47821;

/// 无控制台的程序看不到 stderr，启动阶段的关键信息写文件
fn log(msg: &str) {
    let dir = prefs::hud_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tauri.log"))
    {
        let _ = writeln!(f, "{}", msg);
    }
}

pub struct St {
    port: Mutex<u16>,
    prefs: Mutex<Prefs>,
    ws: Mutex<WinState>,
    child: Mutex<Option<Child>>,
    folded: AtomicBool,
    sheet: AtomicBool,
    sheet_back: Mutex<f64>,
    /// 程序自己改窗口尺寸期间不记位置，避免把中间态写进 window.json
    guard_until: Mutex<Instant>,
    /// 页面报上来的 devicePixelRatio：CSS 像素 × 它 = 物理像素
    dpr: Mutex<f64>,
    quitting: AtomicBool,
    shortcut_off: AtomicBool,
    /// 和 WorkBuddy 的钩子对接状态，决定托盘里那个「修复」项出不出现
    hooks: Mutex<HookState>,
}

fn main() {
    // 卸载走命令行，不建窗口：给「卸载.bat」用
    if std::env::args().skip(1).any(|a| a == "--uninstall") {
        let auto = std::env::args().any(|a| a == "--yes");
        std::process::exit(cli_uninstall(auto));
    }
    // 必须在任何窗口创建之前
    sys::set_dpi_aware();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            toggle_window(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            hud_fold,
            hud_hide,
            hud_quit,
            hud_info,
            hud_copy,
            hud_logs_info,
            hud_logs_clear,
            hud_autoheight,
            hud_sheet,
            hud_alert,
            hud_prefs_get,
            hud_prefs_set,
            hud_prefs_reset,
            hud_shortcut_set,
            hud_shortcut_suspend,
            hud_shortcut_resume,
            hud_dpr,
            hud_hooks,
        ])
        .setup(|app| {
            log("--- 启动 ---");
            let handle = app.handle().clone();
            let port = start_backend(&handle);
            log(&format!("后端端口 = {port}"));
            let prefs = Prefs::load();
            let ws = WinState::load();

            app.manage(St {
                port: Mutex::new(port),
                prefs: Mutex::new(prefs.clone()),
                ws: Mutex::new(ws.clone()),
                child: Mutex::new(PENDING.lock().unwrap().take()),
                folded: AtomicBool::new(false),
                sheet: AtomicBool::new(false),
                sheet_back: Mutex::new(0.0),
                guard_until: Mutex::new(Instant::now()),
                dpr: Mutex::new(1.0),
                quitting: AtomicBool::new(false),
                shortcut_off: AtomicBool::new(false),
                hooks: Mutex::new(HookState::default()),
            });

            create_window(&handle, &prefs, &ws, port)?;
            log("窗口已创建");
            build_tray(&handle, &prefs)?;
            log("托盘已创建");
            apply_shortcut(&handle, &prefs.shortcut);
            log("快捷键已注册");
            startup_hook_check(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                log("退出");
                stop_backend(app);
            }
        });
}

/* ---------------- 命令行卸载 ---------------- */

/// `WorkBuddy面板.exe --uninstall`：只做手动做不了的两件事 ——
/// 从 settings.json 摘掉钩子、删掉数据目录。剩下的 exe 和说明文件用户自己删。
///
/// 摘钩子失败时**不删**数据目录：钩子还指着这台机器上的脚本，
/// 先把证据和日志留着，用户下次点「修复」才查得出来。
fn cli_uninstall(auto_yes: bool) -> i32 {
    let dir = prefs::hud_dir();

    println!();
    println!("  WorkBuddy 状态面板 —— 卸载");
    println!("  ==========================================");
    println!("  这一步只做两件手动做不了的事：");
    println!("    1. 从 WorkBuddy 的 settings.json 里删掉本面板登记的钩子");
    println!("       （删之前会自动备份成 settings.json.bak.时间戳）");
    println!("    2. 删掉数据目录 {}", dir.display());
    println!();
    println!("  程序文件不会被删，删完把本文件夹整个删掉就行。");
    println!("  面板要是正开着会先被关掉；删完要完全退出并重开一次 WorkBuddy。");
    println!();

    if !auto_yes {
        print!("确认卸载？输 Y 再回车继续，直接回车取消：");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let ok = std::io::stdin().read_line(&mut line).is_ok();
        if !ok || !line.trim().eq_ignore_ascii_case("y") {
            println!();
            println!("已取消，什么都没改。");
            return 0;
        }
        println!();
    }

    let mut bad = false;
    match run_hook_cli(Some("--uninstall")) {
        Ok(v) => {
            let n = v.get("removed").and_then(|x| x.as_u64()).unwrap_or(0);
            if n > 0 {
                println!("钩子：已从 settings.json 删除 {n} 条（原文件已备份为 settings.json.bak.*）");
            } else {
                let why = v
                    .get("reason")
                    .and_then(|x| x.as_str())
                    .unwrap_or("没有找到属于本面板的钩子");
                println!("钩子：{why}");
            }
        }
        Err(e) => {
            println!("钩子：没能移除（{e}）");
            bad = true;
        }
    }

    if !dir.exists() {
        println!("数据目录：不存在，无需清理");
    } else if bad {
        println!("数据目录：保留在 {}（钩子没摘干净，先留着便于排查）", dir.display());
    } else {
        match std::fs::remove_dir_all(&dir) {
            Ok(_) => println!("数据目录：已删除 {}", dir.display()),
            Err(e) => {
                println!("数据目录：删不掉（{e}），请手动删除 {}", dir.display());
                bad = true;
            }
        }
    }

    if bad {
        println!();
        println!("有一项没做成。可以直接在面板托盘菜单里点「撤销对接」再试，");
        println!("或手动把 %USERPROFILE%\\.workbuddy\\settings.json 里 hooks 段中指向本面板的条目删掉。");
    } else {
        println!();
        println!("完成。请完全退出并重开一次 WorkBuddy（它只在启动时读配置），");
        println!("然后把这个文件夹整个删掉即可。");
    }
    if bad {
        1
    } else {
        0
    }
}

/* ---------------- 后端进程 ---------------- */

fn deploy_backend() -> std::io::Result<std::path::PathBuf> {
    let dir = prefs::hud_dir().join("runtime");
    std::fs::create_dir_all(&dir)?;
    for (name, bytes) in BACKEND.iter().chain(HOOK_TOOLS.iter()) {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 内容没变就不重写，少一次磁盘写
        let same = std::fs::read(&p).map(|cur| cur == *bytes).unwrap_or(false);
        if !same {
            std::fs::write(&p, bytes)?;
        }
    }
    Ok(dir.join("server.js"))
}

fn find_bundled_node_in_home(dir_name: &str) -> Option<String> {
    let profile = std::env::var("USERPROFILE").ok()?;
    let base = std::path::PathBuf::from(profile)
        .join(dir_name)
        .join("binaries")
        .join("node")
        .join("versions");
    let mut dirs: Vec<_> = std::fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name())
        .collect();
    dirs.sort();
    dirs.reverse();
    for d in dirs {
        let p = base.join(d).join("node.exe");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn locate_node() -> String {
    if let Ok(v) = std::env::var("WB_HUD_NODE") {
        if std::path::Path::new(&v).is_file() {
            return v;
        }
    }
    // 安装钩子时记下的路径
    let env_json = prefs::hud_dir().join("env.json");
    if let Ok(txt) = std::fs::read_to_string(env_json) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(p) = v.get("nodePath").and_then(|x| x.as_str()) {
                if std::path::Path::new(p).is_file() {
                    return p.to_string();
                }
            }
        }
    }
    // WorkBuddy 用户目录下的自带 node（~/.workbuddy/binaries/node/versions/<ver>/node.exe）
    for dir_name in [".workbuddy", ".workbuddy-ai"] {
        if let Some(p) = find_bundled_node_in_home(dir_name) {
            return p;
        }
    }
    // WorkBuddy 安装目录下的自带 node（含系统级与用户级安装路径）
    let mut bases = vec![
        r"C:\Program Files\WorkBuddy".to_string(),
        r"C:\Program Files (x86)\WorkBuddy".to_string(),
    ];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        bases.push(format!(r"{local_app_data}\Programs\WorkBuddy"));
    }
    for base in bases {
        for sub in [r"resources\node\node.exe", r"node\node.exe", r"resources\app\node.exe"] {
            let p = format!("{base}\\{sub}");
            if std::path::Path::new(&p).is_file() {
                return p;
            }
        }
    }
    "node".to_string()
}

fn start_backend(_app: &AppHandle) -> u16 {
    let port_file = prefs::hud_dir().join("port.txt");
    let _ = std::fs::remove_file(&port_file);

    let script = match deploy_backend() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("释放后端脚本失败: {e}"));
            return PREFERRED_PORT;
        }
    };

    let node = locate_node();
    log(&format!("node = {node}\n脚本 = {}", script.display()));
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("WB_HUD_PORT", PREFERRED_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别闪黑框
    }

    match cmd.spawn() {
        Ok(child) => {
            // 面板崩溃或被强杀时内核会替我们收掉这个 node，不留孤儿
            {
                use std::os::windows::io::AsRawHandle;
                let ok = sys::child_dies_with_parent(child.as_raw_handle() as *mut _);
                log(&format!("后端 pid={} 绑定父进程={ok}", child.id()));
            }
            if let Some(st) = _app.try_state::<St>() {
                *st.child.lock().unwrap() = Some(child);
            } else {
                // setup 里 St 还没注册，先存到全局待接管
                PENDING.lock().unwrap().replace(child);
            }
        }
        Err(e) => {
            log(&format!("启动后端失败（{node}）: {e}"));
            return PREFERRED_PORT;
        }
    }

    // 等后端把真实端口写出来（端口被占用时会顺延）
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if let Ok(txt) = std::fs::read_to_string(&port_file) {
            if let Ok(p) = txt.trim().parse::<u16>() {
                if p > 1024 {
                    log(&format!("port.txt = {p}"));
                    return p;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    log("等 port.txt 超时，用默认端口");
    PREFERRED_PORT
}

static PENDING: Mutex<Option<Child>> = Mutex::new(None);

fn stop_backend(app: &AppHandle) {
    if let Some(st) = app.try_state::<St>() {
        if let Some(mut c) = st.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/* ---------------- 窗口 ---------------- */

fn create_window(app: &AppHandle, prefs: &Prefs, ws: &WinState, port: u16) -> tauri::Result<()> {
    let shim = SHIM.replace("__PORT__", &port.to_string());
    let (x, y) = initial_position(app, ws);
    // 排障开关：窗口画不出来时用不透明底色确认到底是"没画"还是"透明得看不见"
    let opaque = std::env::var("WB_HUD_OPAQUE").map(|v| v == "1").unwrap_or(false);
    if opaque {
        log("调试：窗口改为不透明");
    }

    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("WorkBuddy 面板")
        .inner_size(ws.width, ws.height)
        .position(x, y)
        .decorations(false)
        .transparent(!opaque)
        .always_on_top(prefs.always_on_top)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(true)
        // 最小高度按"折叠后那一行"算，不是 MIN_HEIGHT：折叠要能把窗口压到 44，
        // 真正的 120 下限由 auto_resize 把关（对应 Electron 的 minHeight: FOLDED_HEIGHT）
        .min_inner_size(MIN_WIDTH, FOLDED_HEIGHT)
        .visible(false)
        .initialization_script(&shim)
        .build()?;

    let h = app.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 点 × 只是收进托盘
            api.prevent_close();
            if let Some(w) = h.get_webview_window("main") {
                hide_panel(&w);
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            persist_bounds(&h);
        }
        _ => {}
    });

    if let Ok(hwnd) = win.hwnd() {
        log(&format!("hwnd = {:#x}，调用 show_inactive", hwnd.0 as isize));
        sys::show_inactive(hwnd.0 as isize);
    } else {
        log("取 hwnd 失败，退回 win.show()");
        let _ = win.show();
    }
    // 非激活显示之后要再压一次置顶：ShowWindow 不改 z 序，
    // 而 builder 里的 always_on_top 是在窗口还没显示时设的，个别情况下会被后面的事件冲掉
    let _ = win.set_always_on_top(prefs.always_on_top);
    log(&format!(
        "visible = {:?}  topmost = {:?}  pos = {:?}  size = {:?}  tauri_scale = {:.3}  win32_dpi = {:.3}",
        win.is_visible(),
        win.is_always_on_top(),
        win.outer_position(),
        win.outer_size(),
        win.scale_factor().unwrap_or(0.0),
        win.hwnd().map(|h| sys::dpi_scale(h.0 as isize)).unwrap_or(0.0)
    ));
    Ok(())
}

fn initial_position(app: &AppHandle, ws: &WinState) -> (f64, f64) {
    let (ax, ay, aw, ah) = match monitor_work_area(app) {
        Some(v) => v,
        None => (0.0, 0.0, 1920.0, 1080.0),
    };
    let w = if ws.width > 0.0 { ws.width } else { WIDTH };
    let h = if ws.height > 0.0 { ws.height } else { HEIGHT };

    let x = if ws.x >= 0.0 && ws.x + w <= ax + aw { ws.x } else { ax + aw - w - prefs::MARGIN };
    let y = if ws.y >= 0.0 && ws.y + h <= ay + ah { ws.y } else { ay + ah - h - prefs::MARGIN };
    (x, y)
}

/// 主显示器可用区域，换算成逻辑像素（与窗口尺寸同一套单位）
fn monitor_work_area(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let sf = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let (x, y, w, h) = sys::work_area(0)?;
    Some((x as f64 / sf, y as f64 / sf, w as f64 / sf, h as f64 / sf))
}

fn scale_of(w: &WebviewWindow) -> f64 {
    w.scale_factor().unwrap_or(1.0)
}

/// 窗口矩形，换算成逻辑像素（与 Electron 的 getBounds 同一套单位）
fn logical_rect(w: &WebviewWindow) -> (f64, f64, f64, f64) {
    let sf = scale_of(w);
    let p = w.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
    let s = w.outer_size().unwrap_or(tauri::PhysicalSize::new(400, 660));
    (p.x as f64 / sf, p.y as f64 / sf, s.width as f64 / sf, s.height as f64 / sf)
}

fn set_rect(w: &WebviewWindow, x: f64, y: f64, width: f64, height: f64) {
    let _ = w.set_size(LogicalSize::new(width.max(MIN_WIDTH), height.max(FOLDED_HEIGHT)));
    let _ = w.set_position(LogicalPosition::new(x, y));
}

fn persist_bounds(app: &AppHandle) {
    let Some(st) = app.try_state::<St>() else { return };
    if Instant::now() < *st.guard_until.lock().unwrap() {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    // 最小化时 Windows 把窗口矩形挪到 (-32000,-32000) 一类哨兵值，
    // 量到的位置尺寸全是垃圾，写盘会把下次启动的位置带偏
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let (x, y, cw, ch) = logical_rect(&w);
    let mut ws = st.ws.lock().unwrap();
    ws.x = x.round();
    ws.y = y.round();
    ws.width = cw.round();
    if !st.folded.load(Ordering::Relaxed) {
        ws.height = ch.round();
    }
    // 只在真的变了的时候写盘
    let snapshot = ws.clone();
    drop(ws);
    snapshot.save();
}

fn auto_resize(app: &AppHandle, raw: f64) {
    let Some(st) = app.try_state::<St>() else { return };
    if st.folded.load(Ordering::Relaxed) || st.sheet.load(Ordering::Relaxed) {
        return;
    }
    if st.prefs.lock().unwrap().manual_height {
        return;
    }
    if !raw.is_finite() || raw < 2.0 {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };

    // 最小化期间页面仍会报高度（WebView2 视口变了就触发一次测量）。
    // 这时读到的 y 是 Windows 给最小化窗口的哨兵值（-32000），
    // 按"底边固定"算出来的新位置会被夹到屏幕顶端 —— 恢复后窗口就跑到上面去了。
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
        return;
    }

    let (x, y, cw, ch) = logical_rect(&w);
    let sf = scale_of(&w);
    let dpr = *st.dpr.lock().unwrap();
    let max_h = match sys::work_area(w.hwnd().map(|h| h.0 as isize).unwrap_or(0)) {
        Some((_, _, _, ah)) => (ah as f64 / sf) - 24.0,
        None => 900.0,
    };

    // 页面报的是 CSS 像素，窗口按物理像素算，中间差一个 dpr
    let want = raw * dpr;
    let next = want.round().clamp(MIN_HEIGHT * dpr, max_h.max(MIN_HEIGHT * dpr));
    if (ch - next).abs() <= 1.0 {
        return;
    }

    // 底边固定：面板贴在右下角，长高时向上长
    let mut ny = y + ch - next;
    if let Some((_, ay, _, ah)) = sys::work_area(w.hwnd().map(|h| h.0 as isize).unwrap_or(0)) {
        let (ay, ah) = (ay as f64 / sf, ah as f64 / sf);
        if ny < ay {
            ny = ay;
        }
        if ny + next > ay + ah {
            ny = ay + ah - next;
        }
    }

    *st.guard_until.lock().unwrap() = Instant::now() + Duration::from_millis(400);
    set_rect(&w, x, ny, cw, next);
}

fn apply_fold(app: &AppHandle, folded: bool) {
    let Some(st) = app.try_state::<St>() else { return };
    st.folded.store(folded, Ordering::Relaxed);
    let Some(w) = app.get_webview_window("main") else { return };
    let (x, y, cw, ch) = logical_rect(&w);
    let dpr = *st.dpr.lock().unwrap();
    if folded {
        *st.guard_until.lock().unwrap() = Instant::now() + Duration::from_millis(400);
        set_rect(&w, x, y, cw, FOLDED_HEIGHT * dpr);
    } else {
        let back = st.ws.lock().unwrap().height.max(MIN_HEIGHT * dpr);
        let h = if back > FOLDED_HEIGHT * dpr { back } else { HEIGHT * dpr };
        *st.guard_until.lock().unwrap() = Instant::now() + Duration::from_millis(400);
        set_rect(&w, x, y + ch - h, cw, h);
        let _ = app.emit("hud:remeasure", ());
    }
}

/// 显示面板。走 Win32 而不是 `w.show()`：后者会激活窗口抢焦点，
/// 而且 tao 内部对可见性的记忆和真实状态不一致（见 sys::hide 注释）。
fn show_panel(w: &WebviewWindow, focus: bool) {
    match w.hwnd() {
        Ok(h) => sys::show_inactive(h.0 as isize),
        Err(_) => {
            let _ = w.show();
        }
    }
    if focus {
        let _ = w.set_focus();
    }
}

/// 隐藏面板（收进托盘）。必须和 show_panel 对称走 Win32。
fn hide_panel(w: &WebviewWindow) {
    match w.hwnd() {
        Ok(h) => sys::hide(h.0 as isize),
        Err(_) => {
            let _ = w.hide();
        }
    }
}

fn toggle_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) {
        hide_panel(&w);
    } else {
        show_panel(&w, true);
    }
}

/* ---------------- 钩子对接 ---------------- */

/// install-hooks.js --check 的结果，字段名与脚本里的 JSON 一一对应
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HookState {
    ok: bool,
    registered: u32,
    total: u32,
    missing: Vec<String>,
    runtime_stale: bool,
    interpreter: String,
    interpreter_ok: bool,
    problem: String,
    /// 最近一次操作给用户看的一句话（纯 check 时为空）
    message: String,
    /// 读配置本身失败了（不是"没配好"）。只有这种情况才不敢替用户自动装
    #[serde(skip)]
    read_error: bool,
}

impl Default for HookState {
    fn default() -> Self {
        Self {
            ok: false,
            registered: 0,
            total: 9,
            missing: Vec::new(),
            runtime_stale: false,
            interpreter: String::new(),
            interpreter_ok: false,
            problem: String::new(),
            message: String::new(),
            read_error: false,
        }
    }
}

/// 用户主动「撤销对接」之后留个记号：否则下次启动看到 0/9 会当成全新安装，
/// 又把钩子偷偷写回去，等于撤销不生效。
fn detached_marker() -> std::path::PathBuf {
    prefs::hud_dir().join("hooks-detached.flag")
}

fn parse_hook_state(v: &serde_json::Value) -> HookState {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let b = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
    HookState {
        ok: b("ok"),
        registered: n("registered"),
        total: if n("total") == 0 { 9 } else { n("total") },
        missing: v
            .get("missing")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|i| i.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        runtime_stale: b("runtimeStale"),
        interpreter: s("interpreter"),
        interpreter_ok: b("interpreterOk"),
        problem: s("problem"),
        message: String::new(),
        read_error: false,
    }
}

/// 跑一次安装脚本。action 为 None 表示「安装」，另有 --check / --uninstall。
/// 输出走 --json，不用去解析中文标签。
fn run_hook_cli(action: Option<&str>) -> Result<serde_json::Value, String> {
    deploy_backend().map_err(|e| format!("释放安装脚本失败：{e}"))?;
    let script = prefs::hud_dir().join("runtime").join("tools").join("install-hooks.js");
    let node = locate_node();

    let mut cmd = Command::new(&node);
    cmd.arg(&script);
    if let Some(a) = action {
        cmd.arg(a);
    }
    // 把我们自己找到的 node 交给脚本，别让它另猜一个
    cmd.arg("--json")
        .env("WB_HUD_NODE", &node)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let out = cmd.output().map_err(|e| format!("启动 node 失败（{node}）：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    // check 在“不完整”时退出码是 2，但 JSON 已经打出来了，照样解析
    let line = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("")
        .to_string();
    if line.is_empty() {
        return Err(format!("安装脚本没有返回结果（退出码 {:?}）", out.status.code()));
    }
    let v: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("解析安装脚本输出失败：{e}"))?;
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        return Err(err.to_string());
    }
    Ok(v)
}

fn check_hooks(app: &AppHandle) -> HookState {
    let state = match run_hook_cli(Some("--check")) {
        Ok(v) => parse_hook_state(&v),
        Err(e) => {
            let mut s = HookState::default();
            s.problem = e;
            s.read_error = true;
            s
        }
    };
    if let Some(st) = app.try_state::<St>() {
        *st.hooks.lock().unwrap() = state.clone();
    }
    rebuild_tray(app);
    state
}

/// 修复 / 撤销，做完顺手重新自检一遍，返回带 message 的最新状态
fn hooks_action(app: &AppHandle, action: &str) -> serde_json::Value {
    let message = match action {
        "repair" => match run_hook_cli(None) {
            Ok(v) => {
                let n = v.get("events").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
                let node = v.get("node").and_then(|x| x.as_str()).unwrap_or("");
                let src = v.get("nodeSource").and_then(|x| x.as_str()).unwrap_or("");
                let base = node.rsplit(['/', '\\']).next().unwrap_or(node);
                let _ = std::fs::remove_file(detached_marker());
                format!("已登记 {n} 项事件，启动器 {base}（来源：{src}）；原配置已备份。")
            }
            Err(e) => format!("修复失败：{e}"),
        },
        "detach" => match run_hook_cli(Some("--uninstall")) {
            Ok(v) => {
                let n = v.get("removed").and_then(|x| x.as_u64()).unwrap_or(0);
                if n > 0 {
                    let _ = std::fs::write(detached_marker(), b"1");
                    format!("已删除 {n} 条钩子。重启 WorkBuddy 后彻底断开；面板本身可以留着看历史。")
                } else {
                    let why = v
                        .get("reason")
                        .and_then(|x| x.as_str())
                        .unwrap_or("没有找到属于本面板的钩子");
                    format!("未做修改：{why}")
                }
            }
            Err(e) => format!("撤销失败：{e}"),
        },
        _ => String::new(),
    };

    let mut state = check_hooks(app);
    state.message = message;
    serde_json::to_value(state).unwrap_or_else(|_| serde_json::json!({}))
}

/// 托盘气泡 + 日志。面板没开的时候，这是唯一能看见的反馈
fn shout(msg: &str) {
    let shown = sys::balloon("WorkBuddy 面板", msg);
    log(&format!("提示：{msg}（气泡={shown}）"));
}

fn detach_hooks(app: &AppHandle) {
    let yes = app
        .dialog()
        .message(
            "删除后：面板不再看到思考与步骤，也不会再拦任何操作。\n\n\
             settings.json 里你自己的其它设置不会被改动，删除前会再备份一份。\n\
             删完需要重启 WorkBuddy 才彻底生效。",
        )
        .title("撤销对接")
        .buttons(MessageDialogButtons::OkCancelCustom("删除钩子".into(), "取消".into()))
        .blocking_show();
    if !yes {
        return;
    }
    let r = hooks_action(app, "detach");
    let msg = r.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
    shout(&msg);
}

/// 启动后自检一次。一条都没注册（全新安装）就替用户接上；
/// 只缺几项时不动配置，只在托盘里亮出「修复」。
fn startup_hook_check(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let st = check_hooks(&app);
        if st.ok {
            log(&format!("连接正常（{}/{}）", st.registered, st.total));
            return;
        }
        log(&format!(
            "连接不完整：{}/{} 缺失={:?} 过期={} 问题={}",
            st.registered, st.total, st.missing, st.runtime_stale, st.problem
        ));

        let untouched = !detached_marker().exists();
        // 全新安装（一条都没有、配置本身读得动）：替用户接上，写前脚本会备份
        if st.registered == 0 && !st.read_error && untouched {
            let r = hooks_action(&app, "repair");
            let msg = r.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
            shout(&format!("{msg}请完全退出并重开 WorkBuddy，连接才会生效。"));
        } else if untouched {
            shout(&format!(
                "和 WorkBuddy 的连接不完整（{}/{}）。右击托盘图标 →「修复与 WorkBuddy 的连接」。",
                st.registered, st.total
            ));
        }
    });
}

/* ---------------- 托盘 ---------------- */

fn hook_fix_label(h: &HookState) -> String {
    let lack = h.missing.len();
    if lack > 0 {
        format!("修复与 WorkBuddy 的连接（缺 {lack} 项）")
    } else if !h.problem.is_empty() {
        "修复与 WorkBuddy 的连接（启动器不对）".to_string()
    } else {
        "修复与 WorkBuddy 的连接（脚本过期）".to_string()
    }
}

fn build_menu(app: &AppHandle, prefs: &Prefs, hooks: &HookState) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let fold = MenuItem::with_id(app, "fold", "折叠 / 展开", true, None::<&str>)?;
    let ontop = CheckMenuItem::with_id(app, "ontop", "总在最前", true, prefs.always_on_top, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let opendir = MenuItem::with_id(app, "opendir", "打开数据目录", true, None::<&str>)?;
    let detach = MenuItem::with_id(app, "detach", "撤销对接（删除本面板的钩子）…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // 只有真的坏了才出现 —— 平时它不该占你一个菜单项
    let repair = if hooks.ok {
        None
    } else {
        Some(MenuItem::with_id(app, "repair", hook_fix_label(hooks), true, None::<&str>)?)
    };

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        vec![&toggle, &fold, &ontop, &settings, &sep1, &opendir];
    if let Some(r) = &repair {
        items.push(r);
    }
    items.push(&detach);
    items.push(&sep2);
    items.push(&quit);
    Menu::with_items(app, &items)
}

fn build_tray(app: &AppHandle, prefs: &Prefs) -> tauri::Result<()> {
    let hooks = app
        .try_state::<St>()
        .map(|s| s.hooks.lock().unwrap().clone())
        .unwrap_or_default();
    let menu = build_menu(app, prefs, &hooks)?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("WorkBuddy 面板")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()))
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "toggle" => toggle_window(app),
        "fold" => {
            let cur = app.state::<St>().folded.load(Ordering::Relaxed);
            do_fold(app, !cur);
        }
        "ontop" => {
            let st = app.state::<St>();
            let mut p = st.prefs.lock().unwrap();
            p.always_on_top = !p.always_on_top;
            p.save();
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(p.always_on_top);
            }
        }
        "settings" => {
            let _ = app.emit("hud:open-settings", ());
            if let Some(w) = app.get_webview_window("main") {
                // 用户主动从托盘点进来的，给焦点，可以直接改设置
                show_panel(&w, true);
            }
        }
        "opendir" => {
            let dir = prefs::hud_dir();
            let _ = Command::new("explorer").arg(&dir).spawn();
        }
        // 下面三项要么会弹对话框、要么要跑 node：都挪到工作线程，
        // 别把主线程卡住（托盘菜单回调本身是在主线程上跑的）
        "repair" => {
            let a = app.clone();
            std::thread::spawn(move || {
                let r = hooks_action(&a, "repair");
                let msg = r.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string();
                shout(&msg);
            });
        }
        "detach" => {
            let a = app.clone();
            std::thread::spawn(move || detach_hooks(&a));
        }
        "quit" => {
            let a = app.clone();
            std::thread::spawn(move || request_quit(&a));
        }
        _ => {}
    }
}

/// 菜单是整块换掉的，不是逐项改文案 —— 这样「修复」项才能真正消失
fn rebuild_tray(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = a.tray_by_id("main") else { return };
        let (prefs, hooks) = {
            let st = a.state::<St>();
            let p = st.prefs.lock().unwrap().clone();
            let h = st.hooks.lock().unwrap().clone();
            (p, h)
        };
        if let Ok(menu) = build_menu(&a, &prefs, &hooks) {
            let _ = tray.set_menu(Some(menu));
            log(&format!(
                "托盘菜单重建：{}",
                if hooks.ok { "连接正常，无修复项".to_string() } else { hook_fix_label(&hooks) }
            ));
        }
        let tip = if hooks.ok {
            "WorkBuddy 面板"
        } else {
            "WorkBuddy 面板 · 连接不完整，右击可修复"
        };
        let _ = tray.set_tooltip(Some(tip));
    });
}

fn do_fold(app: &AppHandle, folded: bool) {
    apply_fold(app, folded);
    let _ = app.emit("hud:folded", folded);
}

fn request_quit(app: &AppHandle) {
    let st = app.state::<St>();
    if st.quitting.swap(true, Ordering::Relaxed) {
        return;
    }
    let ask = st.prefs.lock().unwrap().log_ask != "never";

    if ask {
        let yes = app
            .dialog()
            .message("面板会关掉，WorkBuddy 本体不受影响。\n\n记录会留着；想清空的话，设置页有「现在清空记录」。")
            .title("退出 WorkBuddy 面板")
            .buttons(MessageDialogButtons::OkCancelCustom("退出".into(), "取消".into()))
            .blocking_show();
        if !yes {
            // 取消退出：把闸放回去，否则这次之后再也退不掉
            st.quitting.store(false, Ordering::Relaxed);
            return;
        }
    }
    stop_backend(app);
    app.exit(0);
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
fn hud_fold(app: AppHandle, folded: bool) {
    do_fold(&app, folded);
}

#[tauri::command]
fn hud_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        hide_panel(&w);
        log(&format!("收进托盘：可见 = {:?}", w.is_visible()));
    }
}

#[tauri::command]
fn hud_quit(app: AppHandle) {
    request_quit(&app);
}

#[tauri::command]
fn hud_info(app: AppHandle) -> serde_json::Value {
    let port = *app.state::<St>().port.lock().unwrap();
    serde_json::json!({ "port": port, "version": app.package_info().version.to_string() })
}

#[tauri::command]
fn hud_copy(app: AppHandle, text: String) -> bool {
    app.clipboard().write_text(text).is_ok()
}

#[tauri::command]
fn hud_logs_info(app: AppHandle) -> serde_json::Value {
    let size = spool_size();
    serde_json::json!({
        "size": size,
        "text": fmt_size(size),
        "ask": app.state::<St>().prefs.lock().unwrap().log_ask,
    })
}

#[tauri::command]
fn hud_logs_clear() -> serde_json::Value {
    let ok = truncate_spool();
    let size = spool_size();
    serde_json::json!({ "ok": ok, "size": size, "text": fmt_size(size) })
}

#[tauri::command]
fn hud_autoheight(app: AppHandle, height: f64) {
    auto_resize(&app, height);
}

#[tauri::command]
fn hud_sheet(app: AppHandle, open: bool) {
    let Some(st) = app.try_state::<St>() else { return };
    let Some(w) = app.get_webview_window("main") else { return };
    let (x, y, cw, ch) = logical_rect(&w);
    let dpr = *st.dpr.lock().unwrap();

    if open {
        if st.sheet.swap(true, Ordering::Relaxed) {
            return;
        }
        *st.sheet_back.lock().unwrap() = ch;
        let target = (SHEET_HEIGHT * dpr).max(ch);
        let mut ny = y + ch - target;
        if let Some((_, ay, _, _)) = sys::work_area(w.hwnd().map(|h| h.0 as isize).unwrap_or(0)) {
            let sf = scale_of(&w);
            let ay = ay as f64 / sf;
            if ny < ay {
                ny = ay;
            }
        }
        *st.guard_until.lock().unwrap() = Instant::now() + Duration::from_millis(400);
        set_rect(&w, x, ny, cw, target);
    } else {
        if !st.sheet.swap(false, Ordering::Relaxed) {
            return;
        }
        let back = *st.sheet_back.lock().unwrap();
        if back > MIN_HEIGHT * dpr {
            *st.guard_until.lock().unwrap() = Instant::now() + Duration::from_millis(400);
            set_rect(&w, x, y + ch - back, cw, back);
        }
        let _ = app.emit("hud:remeasure", ());
    }
}

#[tauri::command]
fn hud_alert(app: AppHandle, payload: serde_json::Value) {
    let played = payload.get("soundPlayed").and_then(|v| v.as_bool()) == Some(true);
    if !played {
        sys::beep();
    }

    // 托盘气泡：面板关掉或压在别的窗口后面时，这是唯一能看见的提示
    let title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("WorkBuddy 在等你点头");
    let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let shown = sys::balloon(title, body);
    log(&format!("提醒：页面响铃={played} 气泡={shown}"));

    if let Some(w) = app.get_webview_window("main") {
        if !w.is_visible().unwrap_or(false) {
            show_panel(&w, false);
        }
        if let Ok(h) = w.hwnd() {
            sys::flash(h.0 as isize);
        }
    }
}

#[tauri::command]
fn hud_hooks(app: AppHandle, action: String) -> serde_json::Value {
    match action.as_str() {
        "check" => serde_json::to_value(check_hooks(&app)).unwrap_or_else(|_| serde_json::json!({})),
        "repair" | "detach" => hooks_action(&app, &action),
        _ => serde_json::json!({ "error": "未知动作" }),
    }
}

#[tauri::command]
fn hud_prefs_get(app: AppHandle) -> Prefs {
    app.state::<St>().prefs.lock().unwrap().clone()
}

#[tauri::command]
fn hud_prefs_set(app: AppHandle, patch: serde_json::Value) -> Prefs {
    let before_top;
    let after_top;
    let mut remeasure = false;
    let snap;
    {
        let st = app.state::<St>();
        let mut p = st.prefs.lock().unwrap();
        before_top = p.always_on_top;
        let was_manual = p.manual_height;
        p.apply(&patch);
        after_top = p.always_on_top;
        if was_manual && !p.manual_height {
            remeasure = true;
        }
        p.save();
        snap = p.clone();
    }
    if before_top != after_top {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(after_top);
        }
    }
    let _ = app.emit("hud:prefs", &snap);
    if remeasure {
        std::thread::spawn({
            let app = app.clone();
            move || {
                std::thread::sleep(Duration::from_millis(80));
                let _ = app.emit("hud:remeasure", ());
            }
        });
    }
    snap
}

#[tauri::command]
fn hud_prefs_reset(app: AppHandle) -> Prefs {
    let snap;
    {
        let st = app.state::<St>();
        let mut p = st.prefs.lock().unwrap();
        *p = Prefs::default();
        p.save();
        snap = p.clone();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(snap.always_on_top);
    }
    let _ = app.emit("hud:prefs", &snap);
    let _ = app.emit("hud:remeasure", ());
    snap
}

#[tauri::command]
fn hud_shortcut_set(app: AppHandle, accel: String) -> serde_json::Value {
    let acc = accel.trim().to_string();
    let prev = app.state::<St>().prefs.lock().unwrap().shortcut.clone();

    let _ = app.global_shortcut().unregister_all();

    if acc.is_empty() {
        {
            let st = app.state::<St>();
            let mut p = st.prefs.lock().unwrap();
            p.shortcut = String::new();
            p.save();
        }
        app.state::<St>().shortcut_off.store(true, Ordering::Relaxed);
        broadcast_prefs(&app);
        return serde_json::json!({ "ok": true, "shortcut": "", "error": null });
    }

    match app.global_shortcut().register(acc.as_str()) {
        Ok(_) => {
            log(&format!("改键成功：{acc}"));
            {
                let st = app.state::<St>();
                let mut p = st.prefs.lock().unwrap();
                p.shortcut = acc.clone();
                p.save();
            }
            app.state::<St>().shortcut_off.store(false, Ordering::Relaxed);
            broadcast_prefs(&app);
            serde_json::json!({ "ok": true, "shortcut": acc, "error": null })
        }
        Err(e) => {
            log(&format!("改键失败：{acc}（{e}）"));
            if !prev.is_empty() {
                match app.global_shortcut().register(prev.as_str()) {
                    Ok(_) => log(&format!("已恢复原快捷键：{prev}")),
                    Err(e2) => log(&format!("原快捷键也恢复失败：{prev}（{e2}）")),
                }
            }
            serde_json::json!({
                "ok": false,
                "shortcut": prev,
                "error": "这个组合键已被系统或其他程序占用，没有生效。已保留原来的设置。"
            })
        }
    }
}

#[tauri::command]
fn hud_shortcut_suspend(app: AppHandle) -> bool {
    let _ = app.global_shortcut().unregister_all();
    app.state::<St>().shortcut_off.store(true, Ordering::Relaxed);
    true
}

#[tauri::command]
fn hud_shortcut_resume(app: AppHandle) -> serde_json::Value {
    let acc = app.state::<St>().prefs.lock().unwrap().shortcut.clone();
    app.state::<St>().shortcut_off.store(false, Ordering::Relaxed);
    if acc.is_empty() {
        return serde_json::json!({ "ok": true, "shortcut": "", "error": null });
    }
    match app.global_shortcut().register(acc.as_str()) {
        Ok(_) => {
            log(&format!("改键成功：{acc}"));
            broadcast_prefs(&app);
            serde_json::json!({ "ok": true, "shortcut": acc, "error": null })
        }
        Err(_) => serde_json::json!({
            "ok": false,
            "shortcut": acc,
            "error": "恢复快捷键失败，组合键可能被别的程序占用了。"
        }),
    }
}

fn apply_shortcut(app: &AppHandle, acc: &str) {
    if acc.trim().is_empty() {
        return;
    }
    match app.global_shortcut().register(acc) {
        Ok(_) => log(&format!("快捷键注册成功：{acc}")),
        Err(e) => {
            log(&format!("快捷键注册失败：{acc}（{e}）"));
            // 看不到日志的人只会觉得"热键没反应"，所以冒个气泡说清楚
            shout(&format!("快捷键 {acc} 没注册上（可能被别的程序占用），可在设置里换一个。"));
        }
    }
}

fn broadcast_prefs(app: &AppHandle) {
    let p = app.state::<St>().prefs.lock().unwrap().clone();
    let _ = app.emit("hud:prefs", &p);
}

#[tauri::command]
fn hud_dpr(app: AppHandle, value: f64) {
    if value > 0.1 && value < 8.0 {
        *app.state::<St>().dpr.lock().unwrap() = value;
    }
}

/* ---------------- 小工具 ---------------- */

fn spool_path() -> std::path::PathBuf {
    prefs::hud_dir().join("events.jsonl")
}

fn spool_size() -> u64 {
    std::fs::metadata(spool_path()).map(|m| m.len()).unwrap_or(0)
}

/// 截成空文件而不是删掉：正在写的钩子手里可能还握着这个路径
fn truncate_spool() -> bool {
    match std::fs::OpenOptions::new().write(true).truncate(true).open(spool_path()) {
        Ok(mut f) => {
            let _ = f.flush();
            true
        }
        Err(_) => !spool_path().exists(),
    }
}

fn fmt_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}
