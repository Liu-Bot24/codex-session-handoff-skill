# Codex Session Handoff Skill

Codex Session Handoff Skill is a Codex skill for moving long-running AI work from one session to the next without losing context, overwriting project notes, or scattering handoff files across repositories.

Codex Session Handoff Skill 是一个 Codex Skill，用于把长期 AI 工作从一个 session 平稳交接到下一个 session，避免上下文丢失、项目内交接文件被覆盖，或交接资料散落在不同仓库里。

It creates a centralized handoff vault, writes an immutable snapshot for the current session, and returns a short prompt that the next AI session can use to resume from the right files.

它会创建一个中心化交接库，为当前 session 写入不可变交接快照，并返回一段简短提示词，让新的 AI session 能直接读取对应交接目录继续工作。

## About / 关于

**English:** A Codex skill for centralized AI session handoff snapshots.

**中文：** 用于集中管理 AI 会话交接快照的 Codex Skill。

## What It Does / 功能

- Stores handoffs in one central location instead of the project directory.
- 将交接资料存放在中心目录，而不是写入项目目录。
- Creates a unique handoff folder for every migration.
- 每次迁移都会创建唯一交接目录，避免覆盖旧交接。
- Supports general long-running work and code project handoffs.
- 同时支持通用长期事务交接和代码项目交接。
- Records project identity, current status, previous-session work, access gaps, verification state, and next actions.
- 记录项目身份、当前状态、上一 session 工作摘要、权限缺口、核验状态和下一步动作。
- Uses a fixed new-session protocol so users only copy a short resume prompt.
- 使用固定的新 session 接手协议，用户只需要复制一段很短的接手提示词。
- Tracks secret handling decisions without writing plaintext secrets by default.
- 跟踪 secret 交接决策，默认不写入明文 secret。

## Install / 安装

Ask Codex to install this skill from GitHub:

让 Codex 从 GitHub 安装这个 skill：

```text
Install the Codex skill from https://github.com/Liu-Bot24/codex-session-handoff-skill/tree/main/skills/session-handoff
```

Then restart Codex so the new skill is loaded.

安装后重启 Codex，让新 skill 生效。

## Use / 使用

When a session is getting long, ask:

当一个 session 上下文快满、需要迁移时，可以说：

```text
Use session-handoff to create a handoff for this session.
```

Codex will create the handoff snapshot and return a short prompt for the next session.

Codex 会创建交接快照，并返回一段给新 session 使用的简短提示词。

## Configuration / 配置

| Setting / 配置项 | Controls / 作用 | Default / 默认值 |
|---|---|---|
| `SESSION_HANDOFF_HOME` | Handoff snapshot and protocol storage location / 交接快照和固定协议的存储位置 | `~/.handoffs` |

The default vault is local to the machine. The skill does not write handoff files into the project directory unless the user explicitly asks for project-local changes later.

默认交接库只保存在本机。除非用户后续明确要求写入项目目录，否则该 skill 不会把交接文件写进项目仓库。

## Secret Handling / Secret 处理

Plaintext secrets are not written by default. The skill records safe indexes such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.

默认不写入明文 secret。该 skill 会记录安全索引，例如环境变量名、凭证路径、SSH config host、CLI profile、keychain 条目、密码管理器条目和浏览器登录态。

If a plaintext secret appears in the current session or in an obvious temporary local file, the skill asks the user how it should be transferred before writing it anywhere.

如果当前 session 中出现了明文 secret，或某个明显临时的本地文件里保存了 secret，该 skill 会先询问用户如何交接，再决定是否写入任何位置。
