# codex-session-handoff-skill

![Stars](https://img.shields.io/github/stars/Liu-Bot24/codex-session-handoff-skill?style=flat&label=Stars&cache=20260704) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/codex-session-handoff-skill?style=flat&label=Forks&cache=20260704) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/codex-session-handoff-skill/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/codex-session-handoff-skill/clones14d.svg?v=4)

本仓库提供两个可独立安装和使用的 Codex skill：Session Handoff 把上下文快满的长期任务整理成本机交接快照，交给新的 session 继续；Session Cleanup 安全备份并清理会话中重复的内嵌图片数据，完成后回到原 session 继续。

[简体中文](./README.md) | [English](./README.en.md)

## 安装

把下面这句话发给 Codex：

```text
请安装这个仓库中的 Skills：https://github.com/Liu-Bot24/codex-session-handoff-skill
```

安装内容为 `skills/session-handoff` 和 `skills/session-cleanup`。安装 Session Cleanup 后，Codex 会显示已经创建并验证的实际备份目录，并询问是否修改。安装后重启 Codex，让新 skill 生效。

## Session Handoff

`codex-session-handoff-skill` 解决的是 AI 长会话迁移问题：一个 session 做久之后，当前目标、已完成工作、验证结果、缺少的权限、下一步动作，往往散落在聊天上下文和项目文件里。新 session 如果只靠用户复述，很容易漏信息。

这个 skill 会把当前状态整理成一次独立交接快照，统一保存在本机指定目录中。生成完成后，它会返回一段简短提示词，用户把这段提示词发给新的 AI session，新 session 就能读取对应交接资料并继续工作。

### 你可以用它做什么

- 在 Codex 上下文快满时，为当前任务创建交接快照
- 把多次交接集中保存在本机，避免交接资料散落在不同项目目录
- 通过本机索引记录同一长期任务的多次交接链路
- 为代码项目记录来源目录、git 状态、验证结果和下一步
- 为非代码长期事务记录目标、资源、所需权限和待办
- 让新 session 在第一轮就汇总上一 session 做过什么、缺什么、下一步该做什么

### 工作方式

默认交接目录位于：

```text
~/.handoffs
```

也可以通过环境变量修改：

```bash
export SESSION_HANDOFF_HOME=/path/to/handoffs
```

每次交接都会创建一个新的快照目录。交接资料默认只写入本机交接目录，不写入项目目录。

### 使用

当 session 上下文快满、需要迁移时，对 Codex 说：

```text
使用 session-handoff 为当前 session 创建交接快照。
```

Codex 会创建交接快照，并返回一段给新 session 使用的简短提示词。

新 session 收到提示词后，会读取本次交接资料，并在第一轮回复中说明：

- 读取了哪些交接文件
- 上一 session 主要做了什么
- 当前工作目录是否是同一个项目或任务
- 权限、密钥、授权文件或登录态是否缺失
- 哪些信息还没有确认，或可能已经过期
- 当前阻塞项
- 下一步安全动作

### 密钥与凭证

默认不写入明文密钥。

交接文档只记录安全引用信息，例如环境变量名、凭证路径、SSH config host、CLI profile、keychain 条目、密码管理器条目和浏览器登录态。

如果当前 session 中出现了明文密钥，或某个明显临时的本地 `.md` / `.txt` 文件里保存了密钥，这个 skill 会先询问用户如何交接，再决定是否写入任何位置。

## Session Cleanup

Session Cleanup 用于处理因重复内嵌图片而明显膨胀的 Codex session。它会为每张唯一图片保留一份完整内容，只替换后续重复的长 `data:image` Base64 载荷。

普通文本、工具历史、reasoning summaries、事件、compacted 记录和 `replacement_history` 都会保留。本地图片路径、HTTP/HTTPS URL、文件名和短 `data:image` 代码示例也不会被清理。

### 使用

清理当前 session：

```text
使用 Session Cleanup 清理当前 session。
```

在另一个顶层 session 中清理指定任务：

```text
使用 Session Cleanup 清理任务 <task-id>。
```

从原 session 发起时，Cleanup 会创建一个独立的顶层 session，等待原 session 不再活跃后执行清理；从另一个顶层 session 发起并提供 task ID 时，则直接清理指定任务。

### 备份与安全

首次配置会创建并验证 `<CODEX_HOME>/session-cleanup/backups`，同时显示实际绝对路径并询问是否修改。以后可以直接用自然语言修改默认目录，或为单次清理指定临时目录。

每次写回前都会生成原始备份、SHA256、manifest 和索引。只有独立验证通过后才会报告成功，并在回复中明确显示备份位置。成功清理后，需要完整退出并重启 Codex，再打开原 session。
