# llm-server Electron GUI

这是一个独立的桌面管理器，用来省掉手动改 JSON、手动下载 runtime、手动启动脚本这些步骤。

它负责：

- 自动检测/安装 `llama-app` CLI
- 通过 `llama-app` 下载并启动模型
- 保存模型预设和端口配置
- 写入 `../llm-server/config/server.json`
- 启动/停止 `llm-server` adapter
- 查看 runtime 和 adapter 日志
- 做健康检查

## 推荐使用方式

```bash
cd llm-server-electron-gui
npm install
npm run dev
```

打开后：

1. 选择模型预设
2. 点击「一键启动本地服务」
3. 等待 GUI 自动安装 runtime、下载模型、启动 adapter
4. 在原 Electron 实时识别页连接：

```text
ws://127.0.0.1:8765/v1/realtime?mode=video
```

也可以分步操作：

```text
自动安装 llama-app -> 下载/预热所选模型 -> 启动模型 -> 启动 adapter
```

## 模型预设

当前内置：

- `Qwen2.5-VL 3B Q4_K_M`
- `Qwen2.5-VL 7B Q3_K_M`
- `Qwen2.5-VL 7B Q4_K_M`
- `MiniCPM-o 4.5 Q4_K_M`

GUI 会通过：

```bash
llama serve -hf <repo:quant>
```

触发模型下载和启动。

## 跨平台 runtime 方案

默认方案是 `llama-app CLI`。

安装命令：

macOS/Linux：

```bash
curl -LsSf https://llama.app/install.sh | sh
```

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://llama.app/install.ps1 | iex"
```

如果某个平台上 `llama-app` 不可用，可以在 GUI 里手动填写自定义 runtime 路径：

- macOS/Linux：`llama` 或 `llama-server`
- Windows：`llama.exe` 或 `llama-server.exe`

要求这个 runtime 支持：

```bash
llama serve -hf <model> --host 127.0.0.1 --port 8080
```

或者兼容同等的 OpenAI-compatible `/v1/chat/completions` 服务。

## 端口

默认端口：

```text
模型 runtime: 127.0.0.1:8080
llm-server adapter: 127.0.0.1:8765
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8765/health
```

## 当前边界

- 下载进度来自 `llama serve` 的 stdout/stderr 日志。不同版本 runtime 的输出格式不同，GUI 会显示实时日志，并尽量解析百分比。
- `下载/预热所选模型` 会临时启动模型 runtime，等待健康检查成功后停止；这相当于确保模型已下载并可启动。
- `llm-server` adapter 仍然需要本仓库的 `../llm-server` 目录存在。
