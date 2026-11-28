# 第三方代码声明

本项目的绝大部分代码为本项目原创。以下部分包含外部来源，按原许可要求在此声明。

---

## 1. `src/service/auth-helper.js`（凭据解密助手）

**来源**：[88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)
**许可**：MIT License
**用途**：读取本机 WorkBuddy 客户端 `workbuddy-desktop.info` 里的加密凭据
**移植方式**：原样移植，未改动算法本体（AES-256-GCM 信封解析、AAD 构造、
`electron_browser_workbuddy_storage` binding 调用）。仅在文件头补充了中文说明。

**为什么不自己重写**：AAD（附加认证数据）的字节序列是硬协议 ——

```js
aad = 'WB-AAD\0' | 0x01 | lp('WBEV1') | lp('sym-v1') | [0, 0, 0, 1] | lp(keyId) | [2, 0, 0]
```

其中 `lp()` 是"4 字节大端长度 + UTF-8 字节"。这类构造差一个字节就解不开，
且没有任何文档可查。改写没有收益，只会引入难以定位的失败。

**该文件做什么、不做什么**：

| 做 | 不做 |
|---|---|
| 从 stdin 读一个 JSON 请求 | 不读磁盘（除了 Node 自身的模块加载） |
| 往 stdout 写一个 JSON 响应 | 不联网 |
| 用客户端持有的密钥解一个信封 | 不写文件、不写注册表 |
| 进程退出即消失 | 不接收命令行参数 |

调用方式：`WorkBuddy.exe -e <本文件内容>`，环境变量 `ELECTRON_RUN_AS_NODE=1`。
也就是说它把客户端本体当 Node 解释器用一次，不进 Electron 主流程，
因此不会触发客户端的单实例检查。

---

## 2. 协议信息来源

积分与签到三个接口（`checkin-activity-status`、`daily-checkin`、
`get-user-resource-summary`）以及请求头字段，来自上述项目的实现与本机
WorkBuddy 客户端资源文件（`resources/app.asar`）中的前端代码。

这些是**逆向所得、非官方公开接口**。服务端字段或路径随时可能变化，
本项目按"字段缺失即降级、失败绝不当成未领取"处理，但不保证长期可用。

---

## 3. 本项目自身的许可

本项目其余部分（面板、后端服务、钩子、构建脚本、文档）的许可，
以仓库根目录的 LICENSE 为准。
