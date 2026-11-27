// Win32 里 Tauri 没有直接对应物的几个调用
#![allow(non_snake_case)]

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_INFO, NIF_STATE, NIIF_INFO, NIM_MODIFY, NIS_HIDDEN, NOTIFYICONDATAW,
    NOTIFYICONDATAW_0,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FlashWindowEx, GetClassNameW, GetWindowThreadProcessId, ShowWindow, FLASHWINFO,
    FLASHW_ALL, FLASHW_TIMERNOFG, SW_HIDE, SW_SHOWNOACTIVATE,
};

// windows-sys 没有导出 MessageBeep，直接声明。
// 走 user32 而不是让页面 play()：面板常常没有焦点，没有焦点时页面的音频会被拦。
#[link(name = "user32")]
extern "system" {
    fn MessageBeep(u_type: u32) -> i32;
    fn SetProcessDpiAwarenessContext(value: isize) -> i32;
}

/// 必须在建窗口之前调用。
///
/// 不声明 DPI 感知时，Windows 会把窗口当成 96 DPI 虚拟化，
/// GetDpiForWindow 返回 96、Tauri 的 scale_factor 返回 1.0，
/// 而 WebView2 内部的 devicePixelRatio 却是真实缩放（本机是 1.18）。
/// 结果就是"页面报 560 高的内容，窗口却只给 560 物理像素"，内容被裁掉。
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;

pub fn set_dpi_aware() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn hwnd(raw: isize) -> HWND {
    raw as HWND
}

/// Electron 的 showInactive()：显示但不抢焦点。
/// Tauri 的 window.show() 会激活窗口，正在打字的焦点会被打断，所以直接调 Win32。
pub fn show_inactive(raw: isize) {
    unsafe {
        ShowWindow(hwnd(raw), SW_SHOWNOACTIVATE);
    }
}

/// 与 show_inactive 配对的隐藏。
///
/// 不能直接用 `window.hide()`：窗口是用 ShowWindow 显示的，tao 内部记的
/// "可见" 标志一直是 false，它据此认为已经隐藏、把 SW_HIDE 跳过去，
/// 结果是点 × 毫无反应（窗口既没消失也没进托盘）。干脆两边都走 Win32，
/// 真实状态与 tao 的判断不一致也没关系 —— 判断可见性用的是 is_visible()，
/// 它查的是 IsWindowVisible，是真实值。
pub fn hide(raw: isize) {
    unsafe {
        ShowWindow(hwnd(raw), SW_HIDE);
    }
}

pub fn beep() {
    unsafe {
        MessageBeep(0xFFFF_FFFF);
    }
}

/* ---------------- 子进程随父进程结束 ---------------- */

/**
 * 把 node 后端挂进一个"父进程一死就全杀"的作业对象。
 *
 * 为什么需要：正常退出走 stop_backend，会 kill + wait，没问题。
 * 但面板要是崩溃、被任务管理器结束、或者被 taskkill /F，就没有机会收尾，
 * node 会留在后台占着端口。下次启动时端口被自己占着，后端顺延到别的端口，
 * 钩子写进 port.txt 的那份地址就和真正在跑的对不上了。
 *
 * 作业对象是 Windows 的标准做法：句柄跟着进程一起关，
 * 关的时候内核替我们把作业里的进程全杀掉，不需要任何收尾代码。
 * 这里的句柄故意不关闭 —— 一关就等于立刻杀掉后端。
 */
pub fn child_dies_with_parent(process: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return false;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0;
        if !ok {
            return false;
        }
        AssignProcessToJobObject(job, process as windows_sys::Win32::Foundation::HANDLE) != 0
    }
}

/// 任务栏闪一下。面板不在任务栏里，这个只在窗口被别的窗口盖住时有点用
pub fn flash(raw: isize) {
    let mut info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd(raw),
        dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
        uCount: 3,
        dwTimeout: 0,
    };
    unsafe {
        FlashWindowEx(&mut info);
    }
}

/// 窗口所在显示器的真实缩放比（1.0 = 100%）。
/// 页面里的 CSS 像素乘上它就是物理像素，用来把页面报的高度换算成窗口高度。
pub fn dpi_scale(raw: isize) -> f64 {
    unsafe {
        let dpi = GetDpiForWindow(hwnd(raw));
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }
}

/// 当前显示器的可用区域（扣掉任务栏），单位是物理像素
pub fn work_area(raw: isize) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let mon = MonitorFromWindow(hwnd(raw), MONITOR_DEFAULTTONEAREST);
        if mon.is_null() {
            return None;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return None;
        }
        let RECT { left, top, right, bottom } = mi.rcWork;
        Some((left, top, right - left, bottom - top))
    }
}

/* ---------------- 托盘气泡 ---------------- */

/**
 * Tauri 的托盘接口没有 displayBalloon（Electron 有）。
 *
 * 但它的托盘底层就是 Shell_NotifyIcon：图标挂在一个类名为 "tray_icon_app"
 * 的隐藏窗口上。所以这里先在自己进程里找到那个窗口，再用同一个 hWnd + uID
 * 发一次 NIF_INFO 修改，效果和 Electron 的 displayBalloon 一致。
 *
 * 为什么不自己建一个托盘图标来实现：那会在通知区多出第二个图标；
 * 为什么不接管整个托盘：那要重写菜单、点击、悬停，几百行只为一个气泡。
 *
 * 返回 false 表示没弹出来（系统关了通知、托盘被资源管理器重启后 ID 变了等），
 * 调用方仍然可以靠响铃兜底。
 */
struct FindTray {
    pid: u32,
    hwnd: HWND,
}

unsafe extern "system" fn find_tray_proc(hwnd: HWND, lparam: isize) -> i32 {
    let found = &mut *(lparam as *mut FindTray);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != found.pid {
        return 1; // 不是自己的窗口，继续找
    }
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return 1;
    }
    if String::from_utf16_lossy(&buf[..n as usize]) == "tray_icon_app" {
        found.hwnd = hwnd;
        return 0; // 找到就停
    }
    1
}

fn copy_wide(dst: &mut [u16], s: &str) {
    let mut n = 0;
    for unit in s.encode_utf16() {
        if n + 1 >= dst.len() {
            break;
        }
        dst[n] = unit;
        n += 1;
    }
    dst[n] = 0;
}

pub fn balloon(title: &str, text: &str) -> bool {
    let mut found = FindTray { pid: std::process::id(), hwnd: std::ptr::null_mut() };
    unsafe {
        EnumWindows(Some(find_tray_proc), &mut found as *mut _ as isize);
        if found.hwnd.is_null() {
            return false;
        }

        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = found.hwnd;
        nid.dwState = 0;
        nid.dwStateMask = NIS_HIDDEN;

        // 图标 ID 由 tray-icon 内部的自增计数器分配，版本一变起点就可能变，
        // 所以逐个试：NIM_MODIFY 只有在对得上已存在的图标时才返回非零。
        let mut id = 0u32;
        for cand in 1..=16u32 {
            nid.uID = cand;
            nid.uFlags = NIF_STATE;
            if Shell_NotifyIconW(NIM_MODIFY, &nid) != 0 {
                id = cand;
                break;
            }
        }
        if id == 0 {
            return false;
        }

        nid.uID = id;
        nid.uFlags = NIF_INFO;
        nid.dwInfoFlags = NIIF_INFO;
        nid.Anonymous = NOTIFYICONDATAW_0 { uTimeout: 8000 };
        copy_wide(&mut nid.szInfoTitle, title);
        copy_wide(&mut nid.szInfo, text);
        Shell_NotifyIconW(NIM_MODIFY, &nid) != 0
    }
}
