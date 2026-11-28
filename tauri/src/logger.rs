//! 日志落盘 —— 供用户回传排查。
//!
//! 面板是无控制台程序，stderr 没人看得见。0.6.4 之前日志只写到
//! `%USERPROFILE%\.workbuddy-hud\tauri.log`，用户找不到、也不含服务端信息，
//! 于是"朋友机器上积分未连接"这类问题只能靠猜。这里改成写 exe 同级目录。
//!
//! 目录选择顺序：
//!   1. `<exe 所在目录>\logs` —— 便携版解压到哪就写哪，用户一眼能看见
//!   2. `%LOCALAPPDATA%\workbuddy-hud\logs` —— exe 装在 Program Files 时无写权限
//!   3. `%USERPROFILE%\.workbuddy-hud\logs` —— 兜底
//!
//! 单文件上限 2 MB，超出后改名为 `.1`，只保留一份历史，不会无限长大。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/* ---------------- 本地时间 ---------------- */

#[repr(C)]
struct SysTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    millis: u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLocalTime(out: *mut SysTime);
}

/// `2026-11-28 13:20:41.123`，本地时间。
/// 自己取而不引 chrono：只为一行时间戳加一个依赖不值得，编译时间也是成本。
fn stamp() -> String {
    let mut t = SysTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        millis: 0,
    };
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.year, t.month, t.day, t.hour, t.minute, t.second, t.millis
    )
}

/* ---------------- 目录 ---------------- */

/// 真的能写才算数：只看 `create_dir_all` 成功不够，
/// 受控文件夹重定向（OneDrive / Program Files）会出现"目录建得出来、文件写不进去"。
fn writable(d: &Path) -> bool {
    if fs::create_dir_all(d).is_err() {
        return false;
    }
    let probe = d.join(".probe");
    match fs::write(&probe, b"1") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn pick() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("logs"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            candidates.push(PathBuf::from(&local).join("workbuddy-hud").join("logs"));
        }
    }
    candidates.push(crate::prefs::hud_dir().join("logs"));

    for c in &candidates {
        if writable(c) {
            return c.clone();
        }
    }
    // 三处都写不了：仍返回第一个，让写入静默失败，不影响主流程
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("logs"))
}

pub fn dir() -> &'static Path {
    DIR.get_or_init(pick).as_path()
}

pub fn dir_string() -> String {
    dir().to_string_lossy().into_owned()
}

/* ---------------- 写入 ---------------- */

fn roll(path: &Path) {
    let big = fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    if !big {
        return;
    }
    let old = path.with_extension("log.1");
    let _ = fs::remove_file(&old);
    let _ = fs::rename(path, &old);
}

/// 写一行到 `hud.log`。多行消息按行拆开，每行都带时间戳，方便对齐。
pub fn write(tag: &str, msg: &str) {
    let _guard = LOCK.lock();
    let path = dir().join("hud.log");
    roll(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let now = stamp();
        for line in msg.lines() {
            let _ = writeln!(f, "{} [{}] {}", now, tag, line);
        }
    }
    if cfg!(debug_assertions) {
        eprintln!("[{}] {}", tag, msg);
    }
}

pub fn info(msg: &str) {
    write("外壳", msg);
}

pub fn warn(msg: &str) {
    write("注意", msg);
}

pub fn error(msg: &str) {
    write("错误", msg);
}

/// 清空两份日志。设置面板上那个"清空"按钮走这里。
pub fn clear() -> std::io::Result<()> {
    let _guard = LOCK.lock();
    for name in ["hud.log", "hud.log.1", "service.log", "service.log.1"] {
        let p = dir().join(name);
        if p.exists() {
            fs::remove_file(&p)?;
        }
    }
    Ok(())
}
