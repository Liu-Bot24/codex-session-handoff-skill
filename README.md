# Codex Session Handoff Skill

[中文](#中文) | [English](#english)

## 中文

Codex Session Handoff Skill 是一个 Codex Skill，用来把一个快要爆上下文的长期任务，平稳交接到新的 AI session。

它解决的问题很直接：当一个 session 做了很多工作之后，关键信息往往散落在聊天上下文、项目目录、临时文件和用户口头说明里。新 session 如果只靠用户复述，很容易漏掉当前目标、已完成事项、权限缺口、验证状态和下一步。这个 skill 会把这些信息整理成一次不可变的交接快照，并集中存放在本机的 handoff vault 中。

默认情况下，它不会把交接文件写进项目仓库，也不会反复覆盖同一个 `.agent-state` 目录。每次交接都会生成一个独立目录，并返回一段很短的新 session 接手提示词。用户只需要把这段提示词发给新的 AI session，新 session 就能按固定协议读取对应交接资料并继续工作。

### 适合什么场景

- Codex 或其他 AI 编程工具的上下文快满，需要迁移到新 session。
- 一个长期任务需要多次交接，但不希望交接文件污染项目目录。
- 同一个目录下可能处理多个项目或事务，需要避免交接资料互相覆盖。
- 代码项目需要记录 git 状态、未提交改动、验证结果和下一步。
- 非代码长期事务需要记录目标、资源、权限索引、风险和待办。

### 功能

- 使用中心化 handoff vault 管理所有交接快照。
- 每次交接创建唯一目录，旧交接不会被覆盖。
- 支持通用长期事务和代码项目两种 profile。
- 记录项目身份、来源目录、当前状态、上一 session 工作摘要、权限缺口、核验状态和下一步。
- 固定新 session 接手协议，避免每次复制一大段提示词。
- 默认不写入明文 secret，只记录环境变量名、凭证路径、SSH config host、CLI profile、keychain 条目、密码管理器条目、浏览器登录态等安全索引。
- 如果发现明文 secret 或明显临时存放的 secret 文件，会先让用户决定如何交接。

### 安装

让 Codex 从 GitHub 安装这个 skill：

```text
Install the Codex skill from https://github.com/Liu-Bot24/codex-session-handoff-skill/tree/main/skills/session-handoff
```

安装后重启 Codex，让新 skill 生效。

### 使用

当 session 上下文快满、需要迁移时，对 Codex 说：

```text
Use session-handoff to create a handoff for this session.
```

Codex 会创建交接快照，并返回一段给新 session 使用的简短提示词。

新 session 收到提示词后，会先读取固定接手规范和本次交接目录，然后在第一轮回复中汇总：

- 已读取哪些交接文件；
- 上一 session 主要做了什么；
- 当前工作目录是否匹配项目身份；
- 权限、secret、授权文件或登录态是否缺失；
- 哪些信息未核验或可能过期；
- 当前阻塞项；
- 下一步安全动作。

### 配置

| 配置项 | 作用 | 默认值 |
|---|---|---|
| `SESSION_HANDOFF_HOME` | 交接快照和固定协议的存储位置 | `~/.handoffs` |

默认交接库只保存在本机。除非用户后续明确要求写入项目目录，否则该 skill 不会把交接文件写进项目仓库。

### Secret 处理

默认不写入明文 secret。

`access.md` 只记录安全索引，例如环境变量名、凭证路径、SSH config host、CLI profile、keychain 条目、密码管理器条目和浏览器登录态。

如果当前 session 中出现了明文 secret，或某个明显临时的本地 `.md` / `.txt` 文件里保存了 secret，该 skill 会先询问用户如何交接，再决定是否写入任何位置。

## English

Codex Session Handoff Skill is a Codex skill for moving a long-running task from an overloaded AI session into a fresh one.

It solves a practical problem: after a long session, important state is often scattered across chat history, project files, temporary notes, and user instructions. A new session can easily miss the current goal, completed work, access gaps, validation state, or next action if it relies on the user to restate everything. This skill turns that state into an immutable handoff snapshot stored in a local centralized handoff vault.

By default, it does not write handoff files into the project repository, and it does not keep overwriting one `.agent-state` folder. Every handoff gets its own directory. The skill then returns a short prompt that the user can paste into the next AI session so it can read the right handoff files and resume under a fixed protocol.

### Use Cases

- A Codex or AI coding session is running out of context and needs to move to a new session.
- A long-running task needs repeated handoffs without polluting the project directory.
- Multiple projects or tasks may share a workspace, and their handoff files should not overwrite each other.
- A code project needs git state, uncommitted changes, validation results, and next actions recorded.
- A non-code long-running task needs objectives, resources, access indexes, risks, and pending work recorded.

### Features

- Stores all handoff snapshots in a centralized handoff vault.
- Creates a unique directory for every handoff, so older snapshots are not overwritten.
- Supports both general long-running work and code project profiles.
- Records project identity, source directory, current state, previous-session work, access gaps, verification state, and next actions.
- Uses a fixed new-session protocol so users only copy a short resume prompt.
- Does not write plaintext secrets by default. It records safe indexes such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.
- If a plaintext secret or an obvious temporary secret file is found, the skill asks the user how it should be transferred before writing it anywhere.

### Install

Ask Codex to install this skill from GitHub:

```text
Install the Codex skill from https://github.com/Liu-Bot24/codex-session-handoff-skill/tree/main/skills/session-handoff
```

Then restart Codex so the new skill is loaded.

### Use

When a session is getting long, ask Codex:

```text
Use session-handoff to create a handoff for this session.
```

Codex will create the handoff snapshot and return a short prompt for the next session.

The new session will read the fixed resume protocol and the generated handoff directory, then report in its first reply:

- which handoff files were read;
- what the previous session did;
- whether the current working directory matches the project identity;
- missing access, secrets, authorization files, or login state;
- stale or unverified information;
- current blockers;
- the next safe action.

### Configuration

| Setting | Controls | Default |
|---|---|---|
| `SESSION_HANDOFF_HOME` | Handoff snapshot and protocol storage location | `~/.handoffs` |

The default vault is local to the machine. The skill does not write handoff files into the project directory unless the user explicitly asks for project-local changes later.

### Secret Handling

Plaintext secrets are not written by default.

`access.md` records safe indexes only, such as environment variable names, credential paths, SSH config hosts, CLI profiles, keychain items, password manager items, and browser login state.

If a plaintext secret appears in the current session, or if a secret is stored in an obvious temporary local `.md` / `.txt` file, the skill asks the user how it should be transferred before writing it anywhere.
