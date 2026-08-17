# codex-wechat 中文介绍

[English README](./README.md) · 中文

`codex-wechat` 是一个运行在你自己电脑或 VPS 上的微信远程 Codex 工具。你可以直接在微信里向 Codex 发送任务、切换项目和会话、上传文件、审批命令，也可以在一台常驻网关后连接多台执行机器。

项目通过腾讯 iLink（`@wechatbot/wechatbot`）接收微信消息，通过 `codex app-server` 的 stdio JSON-RPC 接口驱动 Codex。微信侧不需要暴露公网聊天 Webhook。

> 本项目适合个人开发环境。绑定成功的微信账号能够驱动 Codex 读取文件、修改代码和执行命令，请只绑定自己的账号，并保持最小权限配置。

## 适合哪些场景

- 离开电脑后，通过微信查看或继续 Codex 任务。
- 在手机上审批 Codex 请求执行的命令。
- 用一台常驻 VPS 接收微信消息，把任务分发到 Mac、Linux 或其他 Agent。
- 在不同项目、Codex 会话、模型和推理强度之间快速切换。
- 接收从终端或其他入口启动的 Codex 任务完成通知。

## 核心能力

- **微信远程交互**：支持文本、图片、文件和视频消息。
- **单机与多机模式**：既可以让微信和 Codex 运行在同一台机器，也可以使用一个 Gateway 管理多个 Agent。
- **按 Host 自动排队**：执行机器忙碌时保存后续请求，按 FIFO 顺序继续执行，不需要手动重发。
- **会话与项目管理**：列出项目、切换工作目录、新建或恢复 Codex 会话。
- **模型控制**：查询和切换当前执行机器的模型及推理强度。
- **安全审批**：危险命令通过 `/ok` 或 `/no` 在微信中确认，审批会自动超时拒绝。
- **主动通知**：Codex 任务结束后可向微信推送完成摘要。
- **文件边界**：项目切换和文件发送受 `default_cwd`、`allowed_roots` 与真实路径检查约束。

## 工作方式

### 单机模式

```text
手机微信
   │ iLink 长轮询
   ▼
codex-wechat Gateway
   ├─ 身份绑定、命令与审批
   └─ 本机 codex app-server
```

### 多机模式

```text
手机微信 ──仅扫码一次──► Gateway（建议部署在常驻 VPS）
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
                Mac Agent  VPS Agent  其他 Agent
```

Gateway 是唯一登录微信的入口；Agent 不扫码，只运行 Codex 并通过带 Token 的 HTTP 接口接受 Gateway 请求。在微信中使用 `/hosts` 查看准确的 Host ID，再用 `/m <id>` 切换执行机器。

## 环境要求

- Node.js 22 或更高版本
- 已安装并登录的 [Codex CLI](https://github.com/openai/codex)
- 一个用于扫码和绑定的微信账号
- macOS、Linux 或 Windows

安装 Codex CLI：

```bash
npm install -g @openai/codex
codex login
```

## 快速开始

```bash
git clone https://github.com/yese456/codex-wechat.git
cd codex-wechat
npm install
npm run typecheck
npm start
```

首次运行会进入交互式配置向导，依次选择：

1. 当前机器作为 Gateway 还是 Agent。
2. 默认项目目录。
3. Codex 沙箱和审批策略。

Gateway 启动后会显示微信二维码。扫码登录后，另开一个终端生成绑定码：

```bash
npx tsx src/cli.ts bind
```

然后在微信中发送：

```text
/bind <绑定码>
```

建议先执行以下命令确认状态：

```text
/status
/projects
/permissions
```

## 常用微信命令

| 命令 | 用途 |
|------|------|
| `/help` | 查看帮助 |
| `/status` | 查看机器、项目、会话和 Codex 状态 |
| `/projects` | 列出允许范围内的项目 |
| `/project <序号或名称>` | 切换项目 |
| `/cwd [路径]` | 查看或切换工作目录 |
| `/new [任务]` | 新建 Codex 会话 |
| `/sessions` | 列出最近会话 |
| `/use <序号或 ID>` | 恢复指定会话 |
| `/hosts` | 列出执行机器 |
| `/m <Host ID>` | 切换执行机器 |
| `/model`、`/models` | 查看当前模型或可用模型 |
| `/think <级别>` | 调整推理强度 |
| `/permissions` | 查看沙箱和审批策略 |
| `/ok <审批码>` | 批准待执行操作 |
| `/no <审批码>` | 拒绝待执行操作 |
| `/approvals` | 查看所有待审批项 |
| `/get <路径>` | 把当前项目范围内的文件发送到微信 |

普通文本会作为任务发送给当前 Host。当前 Host 忙碌时，新请求会显示排队位置，并在上一项完成后自动继续。

## 多机部署要点

每台执行机器运行 Agent，并使用 `codex-wechat agent-token` 生成独立的高强度 Token。Agent 默认监听 `127.0.0.1:18765`，建议通过 SSH 隧道、Tailscale、WireGuard 或 TLS 与 Gateway 连接。

不要把未加密的 Agent HTTP 端口直接暴露到公网。明文 HTTP 只有在可信加密私网中显式设置 `allow_insecure_http: true` 后才应使用。

同一个微信账号不要在多台机器上分别运行完整 Gateway。推荐只保留一个 Gateway，其余机器全部使用 Agent 模式。

完整的多机配置、反向 SSH 隧道和故障排查方法请参阅 [英文 README 的 Multi-host setup](./README.md#multi-host-setup-one-wechat)。

## 安全设计

- 默认使用 `read-only` 沙箱和 `on-request` 审批策略。
- 降低保护级别需要在 60 秒内再次发送带 `confirm` 的相同命令。
- 绑定码为高熵短期凭据，连续失败后自动失效。
- Agent 使用 Bearer Token，并拒绝过短或已知占位 Token。
- `/get` 只能发送当前项目允许范围内的文件。
- 本地配置、运行状态、微信登录数据、日志和收件箱均通过 `.gitignore` 排除。

`allowed_roots` 是应用层导航和文件导出边界，不是完整的操作系统读取 ACL。需要隔离敏感数据时，应使用专用非 root 账号、容器挂载或操作系统权限控制。

详细安全说明请阅读 [SECURITY.md](./SECURITY.md)。

## 配置文件

首次运行生成的用户配置通常位于：

```text
~/.codex-wechat/config.yaml
```

配置文件优先级为：

```text
CODEX_WECHAT_CONFIG
  > 项目 config.yaml
  > 项目 config.local.yaml
  > ~/.codex-wechat/config.yaml
  > 默认值
```

具体环境变量、完整配置项和 systemd 模板请参阅 [README.md](./README.md) 与 [config.example.yaml](./config.example.yaml)。

## 重要说明

- 项目使用 iLink Bot API，不依赖微信网页版逆向协议；服务条款和可用性可能变化。
- 本项目与腾讯、微信或 OpenAI 没有关联，也不代表这些公司提供官方支持。
- 软件按 MIT 许可证原样提供，不承诺适用于生产或无人值守的高权限环境。
- 如果怀疑凭据已经出现在聊天、日志或截图中，应立即吊销并重新生成，而不是只删除文件。

## 相关文档

- [完整 README](./README.md)
- [安全策略](./SECURITY.md)
- [示例配置](./config.example.yaml)
- [贡献指南](./CONTRIBUTING.md)
- [MIT 许可证](./LICENSE)
