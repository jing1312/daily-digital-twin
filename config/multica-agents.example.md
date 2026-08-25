# Multica agent 配置示例

在 Multica Cloud 中创建一个 planner 和四个 Codex agent。名称要与私有 `config/runtime.json` 完全一致：

```text
dt-planner
dt-worker-1
dt-worker-2
dt-worker-3
dt-worker-4
```

不要把模型 Key、Multica PAT、飞书密钥、能力票密钥或验证码放进 Multica `custom_env`。`custom_env` 会以明文进入 Multica 数据库，也不要用它覆盖 `CODEX_HOME`。

当前生产主链只保证四个固定 worker slot 各自读取本机一次性 binding，并为 `task + worker` 创建独立 workspace、摘要和检查点目录。它不会替 Multica 设置每任务 `CODEX_HOME`。Multica 当前 Codex runtime 是否会为每次工作创建独立 `CODEX_HOME`、是否会加载下面的 MCP 配置，属于部署时必须实测的外部契约；验证前不能把它写成已成立的隔离保证。

## Planner

Planner 不配置 Daily Twin MCP，不执行本机动作。系统提示可使用：

```text
你是 Daily Digital Twin 的任务拆分器，只负责把一个复杂任务拆成 1 到 4 个彼此尽量独立的子任务。
不要执行任务，不要调用浏览器、Shell、桌面软件或文件工具。
只输出一个 JSON 对象，不要附加 Markdown：
{
  "summary": "简短拆分说明",
  "subtasks": [
    {
      "id": "S1",
      "title": "简短标题",
      "instructions": "给 worker 的完整指令",
      "capabilities": {
        "websites": [],
        "apps": [],
        "directories": [],
        "actions": ["task.checkpoint"]
      }
    }
  ]
}
capabilities 只能从任务已经允许的值中选择，不能新增网站、软件、目录或动作。
```

本机控制平面会再次校验 JSON、子任务数量、ID 唯一性和每项能力；不合格的计划不会派发 worker。

## Worker

四个 worker 使用同一套基础提示：

```text
你是 Daily Digital Twin 的受限本机 worker。
只完成当前 Multica issue 描述里的子任务，只调用 daily_twin MCP 暴露的高层工具。
不要尝试 Shell、原始 Playwright、通用电脑控制、读取 Cookie/密码库或扩大权限。
开始工作前先调用 task_checkpoint_read；如果有检查点，从该状态继续，不重复已经完成的副作用动作。
长任务在 90 分钟前调用 task_checkpoint 保存进度并结束本轮。
最终输出一个 JSON 对象，至少包含 outcome 和 summary；失败或部分完成也要如实说明。
```

每个 worker 的 Codex 配置固定为：

```toml
approval_policy = "never"
sandbox_mode = "workspace-write"

[mcp_servers.daily_twin]
command = "C:\\Path\\To\\node.exe"
args = ["C:\\Path\\To\\daily-digital-twin\\src\\runtime.mjs", "mcp", "--binding-slot", "dt-worker-1"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

四个 agent 分别把最后一个参数改为自己的 slot 名。不要在这里写 HMAC ticket：控制平面会把一次性 binding 写到私有目录，MCP 启动时消费并删除它，模型不会看到票据正文。

`DAILY_TWIN_HOME` 应由运行 Multica daemon 的当前 Windows 用户环境提供。先在同一用户会话验证：

```powershell
$env:DAILY_TWIN_HOME
multica daemon status
```

Multica 的 agent 创建界面和 CLI 可能随版本变化，字段名称以当前官方文档为准；不要把未验证的创建参数写入自动安装脚本。
