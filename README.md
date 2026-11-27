# WorkBuddy 状态面板

一个放在桌面角落的悬浮小窗口，用来随时看 WorkBuddy 在后台干什么。

你在写文档、看视频或者逛网页时，不用来回切回 WorkBuddy 窗口，扫一眼就能看到它现在在想什么、做到哪一步、花了多少点数；遇到需要你点「允许」的危险操作，它会直接响铃提醒并弹出卡片。

- 仅支持 **Windows 10 / 11（64 位）**，电脑需已安装并登录 WorkBuddy 桌面版
- 单文件约 3.5MB，解压双击就能用，不需要安装
- 纯本地运行，**不联网、不上传任何数据**

---

## 怎么用（3 步上手）

1. 点右侧 [**Releases**](https://github.com/Payphone13/workbuddy-hud/releases) 下载最新的 `WorkBuddy面板-x.x.x-win-x64.zip`，解压到任意文件夹。
2. 双击 **`WorkBuddy面板.exe`**（首次运行如出现 Windows 安全提示，点「更多信息 → 仍要运行」即可）。
3. 第一次打开会自动对接 WorkBuddy，按提示**完全退出并重开一次 WorkBuddy**，之后随便发个任务，面板就会实时显示进度。

> 解压后的文件夹里有一份 `使用说明.txt`，平时忘记快捷键或颜色含义随时翻一下就行。

---

## 常用操作

| 操作 | 效果 |
|---|---|
| `Ctrl + Alt + W` | 随时显示 / 隐藏面板（可在设置里改键） |
| 拖动顶部栏 | 移动位置（自动记住） |
| 点右上角 `—` | 折叠成一行 |
| 点右上角 `×` | 收进右下角托盘（仍在后台运行与提醒） |
| 右键托盘图标 | 显示/隐藏、总在最前、设置、修复连接、退出 |

---

## 怎么彻底删掉

不要直接删文件夹，先双击文件夹里的 **`卸载.bat`**，按提示输 `Y` 回车即可。它会自动摘掉写进 WorkBuddy 的钩子（删除前会自动备份原配置）并清理数据目录，然后重开一次 WorkBuddy，最后把整个文件夹删掉就行。

---

## 隐私说明

- 只读取本机的 WorkBuddy 会话数据，仅在首次对接时往 `%USERPROFILE%\.workbuddy\settings.json` 写入钩子（写前自动备份，不动你的其他设置）。
- 只监听 `127.0.0.1` 本机回环地址，不联网、无统计、不上传任何内容。

---

## 给开发者：从源码编译

需要 Rust（MSVC 工具链）与 Node.js 22+：

```bash
git clone https://github.com/Payphone13/workbuddy-hud.git
cd workbuddy-hud
bash tauri/build.sh
node tools/build-portable.js --zip
```

---

## 声明与许可

个人开源小工具，非 WorkBuddy 官方出品。采用 [MIT License](LICENSE)，可自由使用、修改与分发。
