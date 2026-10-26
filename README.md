# DeepSeek Harness Control

一个让 Codex 操作**本机 DeepSeek Harness Web 会话**的 skill。通过 Node.js 内置模块调用 Harness 的本地认证 API，无需注册 MCP，也无需安装 Harness 插件。

An unofficial Codex skill for controlling local DeepSeek Harness Web sessions through its authenticated API. No MCP registration or third-party runtime dependencies required.

## 能做什么

- 查询连接状态、查找已有会话。
- 新建会话并提交任务，或继续已有会话；支持 queue / steer。
- 读取有长度限制的用户和助手正文、向前翻页、等待任务结束。
- 取消执行或修改会话标题。

Skill 是按需调用的，不会常驻监听，也不会在对话结束后自动唤醒 Codex。

## 前置条件

- Node.js **22.19.0 或更高版本**。
- 已安装并配置模型的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，Web 服务在本机运行。
- 可用的 Harness **启动认证 URL 文件**。本项目默认读取 `~/.dsh/launcher/dsh-web-3081.ready`，其中必须是本次服务启动输出的完整认证 URL。

**本项目不附带 Harness 启动器。** 默认文件约定适配已有的本机 launcher，并非所有官方安装都会生成该文件。若你的启动器没有生成它，将 Harness 打印的完整认证 URL 保存在本机文件中，再设置 `DSH_CONTROL_READY_FILE`。不要将该文件、URL 中的 token 或模型 API key 提交到 GitHub。

当前默认端口为 **3081**。其他端口通过环境变量设置，认证 URL 必须与服务地址同源。

## 安装为 skill

PowerShell：

```powershell
git clone https://github.com/Takiyu0928/deepseek-harness-control.git "$env:USERPROFILE\.codex\skills\deepseek-harness-control"
```

macOS / Linux 的技能目录安装命令：

```sh
git clone https://github.com/Takiyu0928/deepseek-harness-control.git "$HOME/.codex/skills/deepseek-harness-control"
```

以上命令要求目标目录不存在。自定义技能目录的用户应使用自己的目录。安装后新开 Codex 聊天，调用：

```text
使用 $deepseek-harness-control 检查本机 Harness 的连接状态。
```

也可以请求它在明确的工作目录中提交一个有边界的任务，并读取、验证执行结果。

## 命令行使用

在仓库目录执行，无需 `npm install`：

```powershell
node scripts/dsh.mjs dsh_status
node scripts/dsh.mjs --help
node scripts/dsh.mjs --describe dsh_run_prompt
node scripts/dsh.mjs dsh_run_prompt --input "C:\Work\task-input.json"
```

输入文件是 JSON 对象，示例：

```json
{
  "cwd": "C:\\Work\\project",
  "title": "检查 CSV 解析",
  "prompt": "检查 src/csv.ts 对带引号换行字段的处理。仅分析并报告发现，不修改文件。"
}
```

将用户任务写入 JSON 文件，再通过 `--input` 传入，可以避免 shell 转义问题。也支持 `--input -` 从标准输入读取 JSON；输入文件支持 UTF-8 BOM。

| 动作 | 用途 |
| --- | --- |
| `dsh_status` | 连接状态 |
| `dsh_list_sessions` | 会话摘要与筛选 |
| `dsh_run_prompt` | 新建会话并提交任务 |
| `dsh_continue_session` | 继续已有会话 |
| `dsh_read_session` | 读取正文、状态及历史决策事件标记 |
| `dsh_wait_session` | 有时限地等待执行结束 |
| `dsh_cancel_session` | 停止当前执行 |
| `dsh_rename_session` | 修改标题 |

各动作的必填参数和范围以 `--describe 动作名` 输出为准。

## 配置

| 环境变量 | 默认值 |
| --- | --- |
| `DSH_CONTROL_URL` | `http://127.0.0.1:3081` |
| `DSH_HOME` | `~/.dsh` |
| `DSH_CONTROL_READY_FILE` | `<DSH_HOME>/launcher/dsh-web-<端口>.ready` |

例如在当前 PowerShell 进程中指定自己的认证文件：

```powershell
$env:DSH_CONTROL_URL = 'http://127.0.0.1:3080'
$env:DSH_CONTROL_READY_FILE = 'C:\Work\private\harness.ready'
node scripts/dsh.mjs dsh_status
```

仅允许 HTTP 回环地址；不提供公网或局域网远程连接。

## 权限与执行结果

- 使用启动 URL 换取 Cookie，Cookie 仅存在于当前进程内存，不读取模型 API key。
- 新会话继承 Harness 中已有的模型、preset 和文件权限。委派的工作可能写文件或执行命令，具体由 Harness 的配置和任务决定。此 skill 不修改权限、不自动批准请求。
- `submitted` 只表示请求被接受；`settled` 只表示回合结束。检查实际回复及 `lastTurn.reason` 后再判断任务是否完成。
- 等待超时不会取消任务；取消也不会回滚已发生的文件修改。
- 网络失败不会自动重放可能已接受的写操作。先检查返回的会话 ID，确认执行情况后再决定是否重试。
- 返回的记录过滤 reasoning、内部注入消息和工具输出，只保留用户来源及助手的 text 内容。审批事件是历史标记，实际审批与问答在 Harness 界面处理。

## 验证与兼容性

```powershell
npm test
```

测试使用本地 HTTP fixture，无需运行 Harness、模型账户或 API key，不产生模型请求。

此前在 Windows 及本机 Harness 上验证过连接认证、新建/继续会话、读取真实模型回复、重命名和分页。空闲会话的取消接口已验证；未验证运行中任务中断。macOS / Linux 安装命令使用标准目录格式，尚不代表完成了这两个平台的真实 Harness 验收。

仅支持普通会话；子 agent 会话需通过父会话管理。DSH 处于开发预览，其 `/api/session/*` 接口可能变化。本实现针对实际观察到的接口编写，遇到不兼容会明确报错，不自动尝试替代写接口。

本项目为独立开发，与 DeepSeek、OpenAI 均无隶属或官方认可关系。

## License

[MIT](LICENSE)
