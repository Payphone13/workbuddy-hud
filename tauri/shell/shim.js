/*
 * 注入到页面里的桥接层，等价于 Electron 版 preload.js 暴露的 window.hud。
 *
 * 两件事：
 *   1. 页面用相对路径请求 /api/*，但页面现在从本地源加载、后端在 127.0.0.1 端口上，
 *      所以在这里把相对路径改写成绝对地址（app.js 一行都不用改）。
 *   2. 把 17 个窗口操作映射到 Tauri 命令，接口形状与 Electron 版保持一致。
 *
 * 占位符 __PORT__ 由 Rust 侧替换成真实端口。
 */
(function () {
  "use strict";

  var PORT = __PORT__;
  var BASE = "http://127.0.0.1:" + PORT;

  /* ---------- 把相对 API 路径改写到后端 ---------- */

  var rawFetch = window.fetch;
  if (rawFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" && input.charAt(0) === "/") {
          input = BASE + input;
        }
      } catch (_) {
        /* 参数异常就交给原函数报错 */
      }
      return rawFetch.call(window, input, init);
    };
  }

  var RawES = window.EventSource;
  if (RawES) {
    var HudES = function (url, cfg) {
      var u = String(url);
      if (u.charAt(0) === "/") u = BASE + u;
      return new RawES(u, cfg);
    };
    HudES.prototype = RawES.prototype;
    window.EventSource = HudES;
  }

  /* ---------- 命令与事件 ---------- */

  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core || typeof t.core.invoke !== "function") {
      return Promise.reject(new Error("Tauri 桥未就绪"));
    }
    return t.core.invoke(cmd, args || {});
  }

  function listen(name, fn) {
    var t = window.__TAURI__;
    if (!t || !t.event || typeof t.event.listen !== "function") return;
    t.event.listen(name, function (e) {
      fn(e.payload);
    });
  }

  window.hud = {
    isElectron: false,
    isTauri: true,
    fold: function (v) {
      return invoke("hud_fold", { folded: !!v });
    },
    hide: function () {
      return invoke("hud_hide");
    },
    quit: function () {
      return invoke("hud_quit");
    },
    info: function () {
      return invoke("hud_info");
    },

    prefs: {
      get: function () {
        return invoke("hud_prefs_get");
      },
      set: function (patch) {
        return invoke("hud_prefs_set", { patch: patch });
      },
      reset: function () {
        return invoke("hud_prefs_reset");
      },
    },

    setShortcut: function (accel) {
      return invoke("hud_shortcut_set", { accel: String(accel == null ? "" : accel) });
    },
    suspendShortcut: function () {
      return invoke("hud_shortcut_suspend");
    },
    resumeShortcut: function () {
      return invoke("hud_shortcut_resume");
    },

    logs: {
      info: function () {
        return invoke("hud_logs_info");
      },
      clear: function () {
        return invoke("hud_logs_clear");
      },
    },

    /* 诊断日志（0.6.5）：外壳 hud.log + 后端 service.log，落在 exe 同级 logs\ */
    diag: {
      info: function () {
        return invoke("hud_diag_info");
      },
      open: function () {
        return invoke("hud_diag_open");
      },
      clear: function () {
        return invoke("hud_diag_clear");
      },
    },

    autoHeight: function (h) {
      return invoke("hud_autoheight", { height: Number(h) || 0 });
    },
    alert: function (p) {
      return invoke("hud_alert", { payload: p || {} });
    },
    sheet: function (open) {
      return invoke("hud_sheet", { open: !!open });
    },
    copyText: function (t) {
      return invoke("hud_copy", { text: String(t == null ? "" : t) });
    },

    onFolded: function (fn) {
      listen("hud:folded", fn);
    },
    onNotice: function (fn) {
      listen("hud:notice", fn);
    },
    onPrefs: function (fn) {
      listen("hud:prefs", fn);
    },
    onRemeasure: function (fn) {
      listen("hud:remeasure", fn);
    },
    onOpenSettings: function (fn) {
      listen("hud:open-settings", fn);
    },
  };

  /* ---------- 把页面像素比报给外壳 ----------
   *
   * 页面用 CSS 像素量内容高度，窗口却按物理像素算尺寸，两者差一个
   * devicePixelRatio。Tauri 的 scale_factor 在本机无论是否声明 DPI 感知
   * 都返回 1.0，靠不住，所以直接由页面自己报。
   */
  function reportDpr() {
    var v = window.devicePixelRatio || 1;
    if (v > 0 && v < 8) invoke("hud_dpr", { value: v }).catch(function () {});
  }
  reportDpr();
  window.addEventListener("resize", reportDpr);
})();
