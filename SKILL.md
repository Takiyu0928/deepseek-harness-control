---
name: deepseek-harness-control
description: 操作本机 DeepSeek Harness（DSH）的 Web 会话：提交任务、继续对话、查看状态、读取结果、取消执行或重命名。用户要求让 DeepSeek Harness 执行工作，或明确要求控制本机 DSH 时使用。此 skill 调用本地控制脚本，无需 MCP 注册；不用于普通 DeepSeek 网页聊天或直接调用模型 API。
---

# DeepSeek Harness 本机控制

通过随 skill 附带的 Node.js 脚本调用已启动的 Harness Web API。不安装 Harness 插件，不修改 Codex 配置。需要 Node.js >= 22.19.0。

## 执行入口

将下面命令中的路径替换为本 skill 的实际绝对路径；使用本机 `node`，路径不可用时检查 `C:\Program Files\nodejs\node.exe`。

```powershell
node "ABSOLUTE_SKILL_PATH\scripts\dsh.mjs" dsh_status
node "ABSOLUTE_SKILL_PATH\scripts\dsh.mjs" --help
node "ABSOLUTE_SKILL_PATH\scripts\dsh.mjs" --describe dsh_run_prompt
node "ABSOLUTE_SKILL_PATH\scripts\dsh.mjs" dsh_run_prompt --input "ABSOLUTE_WORK_PATH\task.json"
```

用文件工具将参数写入工作区 JSON 文件，再通过 `--input` 传入。不要把任务文本插入 shell 命令字符串。输入文件应是一个 JSON 对象；`--describe 动作名` 输出该动作的准确参数 schema。

默认服务为 `http://127.0.0.1:3081`，认证来自 `~/.dsh/launcher/dsh-web-3081.ready`。本机启动器是 `~/.dsh/launcher/start-dsh-web.ps1`。连接失败时检查服务与启动文件，不猜测其他端口或操作已有会话。若服务未启动，可在用户授权启动应用的范围内运行既有启动器；执行环境无法启动时，请用户按平时方式启动。

其他安装可通过进程环境指定 `DSH_CONTROL_URL`、`DSH_HOME` 或 `DSH_CONTROL_READY_FILE`。仅支持回环 HTTP，启动文件的 URL 必须与配置同源。认证 Cookie 仅存内存，不读取模型 API key，不把 token、Cookie 或 `.ready` 内容写入对话。

## 按任务选择动作

| 动作 | 何时使用 | 主要参数 |
| --- | --- | --- |
| `dsh_status` | 确认服务可用 | 无 |
| `dsh_list_sessions` | 查找用户指定的已有会话 | `query`、`limit`、`running` |
| `dsh_run_prompt` | 用户要求新建或委派任务 | `prompt`，可选 `cwd`、`title`、`agentPreset` |
| `dsh_continue_session` | 向明确选定的会话发送后续要求 | `sessionId`、`prompt`，可选 `mode` |
| `dsh_read_session` | 读取实际回复及执行状态 | `sessionId`，可选 `limit`、`maxChars`、`beforeSeq` |
| `dsh_wait_session` | 等待已提交的工作 | `sessionId`，可选 `timeoutMs`，最大 45000 |
| `dsh_cancel_session` | 用户要求停止会话中的工作 | `sessionId` |
| `dsh_rename_session` | 用户要求更改会话标题 | `sessionId`、`title` |

新任务输入示例：

```json
{
  "cwd": "C:\\Work\\project",
  "title": "修复 CSV 解析",
  "prompt": "修复 CSV 解析器对带引号换行字段的处理。仅修改 src/csv.ts 和现有相关测试；保留其他未提交改动。运行相关测试，报告改动、测试结果及剩余问题。"
}
```

## 结果与后续操作

- 先确认用户所需的操作和目标。明确的新任务使用 `dsh_run_prompt`，不要误用无关的旧会话；继续已有会话时取得准确的 `sessionId`。只为找到目标而读取必要的会话摘要或正文。
- 委派任务时写明目标、相关文件、可写范围及验收标准。只传递完成任务需要的上下文。新会话继承用户在 Harness 中设置的模型、preset 和文件权限；skill 本身不扩大授权范围。
- 提交后保存返回的 `sessionId` 和 `requestId`。`submitted` 只代表接受了请求。用有限时长的 `dsh_wait_session` 等待，再读取实际回复。
- `settled` 仅表示回合结束，结合 `lastTurn.reason` 和实际结果判断成败；必要时在本机检查文件或运行相关验证。向用户说明 DeepSeek 实际执行的工作及验证结果。
- `timedOut` 表示等待结束，任务仍可能运行。需要继续跟踪时再次等待；不要因为超时重新提交同一任务。已有后续检查或新信息时再继续读取，避免无意义轮询。
- 继续会话默认使用 `mode: "queue"`；用户需要改变正在执行的方向时才使用 `steer`。取消不会回滚既有文件修改。
- 网络错误可能发生在写操作已接受之后。错误信息会保留可用的会话/请求 ID；先查看目标会话，确认没有重复工作后才重试。
- 返回正文已过滤内部注入消息、reasoning 和工具输出。`hasMore` 为真时可用 `nextBeforeSeq` 翻页。`decisionEvents` 是历史事件标记，不代表当前仍需审批；审批及用户问答在 Harness 界面处理。
- 本版本支持普通会话；子 agent 通过父会话管理。API 结构不兼容时报告错误并检查版本，不猜测替代写入接口。

这是一个按需调用的 skill，不会持续监听，也不会在当前对话结束后自动唤醒 Codex。
