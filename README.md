# Whale Craft

**[English ↓](#english)** · 中文 · [![CI](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml/badge.svg)](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml)

**让 AI Agent 真的进 Minecraft 里玩** —— 一个 DSH（DeepSeek Harness）原生插件：
把一台无头 Minecraft 机器人跑在 DSH 进程里，给模型一套 `mc_*` 工具去走路、挖建、说话、看图、记事，
并在"值得你注意"的时候把 Agent 叫醒。

- 🎮 **每会话一个独立机器人**：不同对话可以连不同服务器、用不同账号，互不干扰
- 👀 **能看世界**：字符地形图（省 token、坐标精确）与**真图像**（`mc_map{format:"image"}`）双通道
- 🔔 **单脑看门狗**：事件只走 `mc_watch` 一条通道，空闲时唤醒、生成中插话（提示词注入，不模拟用户发言）；
  玩家说话**不论走签名聊天、未签名聊天还是被服务端塞进 system 位置**都认得出来（按 translate + `<名字> 正文` 形状兜底）
- 🧠 **长期记忆**：`<工作区>/.whale-craft/` 文档树，索引由 AI 维护，会话开始时自动带进上下文
- 🔒 **密码不进模型上下文**：凭据只存宿主凭据库；账户走「MC设置」UI
- 🖥️ **自带浏览器 UI**：状态条 +「强制停止」按钮 + 「MC设置」模态框（账户 / 指令白名单 / 提示词）

---

## 使用

1. 创建新对话，选中「MC模式」。
2. **选中或新建一个工作区**（记忆与提示词都放在它的 `.whale-craft/` 里）。
3. 如有必要，进入「MC设置」修改玩家名称，或使用第三方皮肤站登录。
4. 对你的 AI 说「进 xx 服务器」。
5. 在对话窗口下命令，或直接在游戏里聊天。

> 想让 AI 进**局域网房间**？直接说"找个局域网服务器"——它用 `mc_lan` 听广播 + 扫本机网段，
> 拿到地址后用 `mc_connect` 进去（对方要先在游戏里「对局域网开放」）。

> **第一次装好没有「MC模式」？** 插件会**自己建一个**：启动时发现 `mcModePresets`
> （默认 `minecraft` / `whale_craft`）里一个都不存在，就调用 DSH 官方接口
> `agentPresets.copy('minimal', 'minecraft', 'MC模式')` —— **整目录复制官方极简模式**，不是手搓配置
> （DSH 的 authoring 只允许这样建）。**已经有一个就绝不动它**；不想要这个行为就把
> `ensureMcPreset` 关掉。
>
> **每次启动还会自检那个自建的 preset**（插件升级 / DSH 升级后它可能过期）：
> 显示名/简介/排序不对 → 只修显示文本；组成还是"我们当初复制的那份"而官方源变了（或自建规格变了）
> → **重新复制一遍**（旧目录先备份成 `<id>.bak-<时间>`）。**只要组成被改过（你自己动过），就一律不碰** ——
> 它靠一个 `.whale-craft.json` 自建标记判断"这份是不是我建的、有没有被改过"。

> 🔴 **必须选工作区**：每个会话都要在**工作区**里跑 —— `.whale-craft/`（记忆 + 提示词）就建在那儿。
> 插件只在两个时刻去备好它：**首次进入 MC 模式会话**、或**点开「MC设置」**（不会在你没玩 MC 的
> 普通会话里乱建目录）。**没有选中工作区的会话会被拒绝**：不进入 MC 模式（没有按钮、没有隔离、
> 没有专属提示词），「MC设置」的接口也一律拒绝并说明原因。

---

## 要求

| 项 | 要求 |
| --- | --- |
| DSH | 已在 npm 发布（`@deepseek-ai/dsh`）；本插件用的是公开的插件契约（`dsh.bundle.patch` + `exports["./client"]`） |
| Node | ≥ 22（跟 DSH 自身一致） |
| Minecraft 机器人 | `mineflayer`，是插件的**直接依赖**——跟着一起装好，不用你动手 |

---

## 安装

> 对你的 AI 说：`帮我安装插件 https://github.com/yzi1b/whale-craft`

### 手动安装

whale_craft 是**标准 DSH 插件**：包自带 `cordis.patch.yml`（`package.json` 里声明了 `dsh.bundle.patch`），
只要把包名列进 profile 的 `dsh.profile.bundles` 即生效，**不需要手改 profile 的补丁文件**。

```bash
# 本地目录（link: 后面是仓库/目录路径）
dsh plugin --profile web add link:/path/to/whale-craft

# 或从 GitHub / npm 装（发布后；npm 上的包名是 whale_craft，仓库名是 whale-craft）
dsh plugin --profile web add github:yzi1b/whale-craft
dsh plugin --profile web add whale_craft
```

上面这条命令做两件事：把包装进 profile，并把 `whale_craft` 加进 `dsh.profile.bundles`。
**然后重启 DSH**（服务端插件不热重载；浏览器端 bundle 是热重载的）。

`mineflayer` 会作为依赖一起装好，**不需要你单独安装**；`sharp`（图像引擎）是可选依赖，装不上也不影响其它功能。
宿主包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`）由 **DSH 自己提供**，插件不会再装一份——
避免出现两份 `Tool` 类互相不认识。

---

## 落盘位置

| 东西 | 位置 |
| --- | --- |
| 全局配置 | `$DSH_HOME/whale_craft/config.json` |
| 账户元数据 | `$DSH_HOME/whale_craft/accounts.json` |
| 插件日志 | `$DSH_HOME/whale_craft/logs/whale-craft.log`（可用 `MC_LOG` 覆盖） |
| **记忆 / 提示词** | **`<会话工作区>/.whale-craft/`**（`README.md` 总索引 + `AGENTS.md` 提示词 + 任意 `.md` / 图片等文档） |

> 记忆是**按会话工作区**的，与插件装在哪、DSH 装在哪都无关。

---

## 配置

选中 MC 模式后，模式选择器右侧或对话标题条中会出现「MC设置」按钮，点击即可进入设置界面。

### 工具调用

非 MC 模式下的 AI 可以使用 `mc_admin_config` 工具。

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `commandWhitelist` | `mc_command` 放行的服务器指令。支持精确名 `"tp"`、正则 `"/^gi.+/"`、`"*"` 全放行 | tp/give/time/… |
| `allowAllCommands` | 白名单页那个总开关 | `false` |
| `mcModePresets` | 哪些 preset 算"MC 模式"（权限隔离的判据） | `["minecraft","whale_craft"]` |
| `mcMode.allowOtherTools` | MC 模式白名单里**额外**放行的其它工具（默认只给 `mc_*` / `mc_kit_*` / 文件工具） | `[]` |
| `mcMode.hideAdminTools` | 是否把 `mc_admin_*` 也放进白名单（默认隐藏，另有 guard 硬拒） | `true` |
| `injectWhaleCraftAgentsMd` | 是否把 `.whale-craft/AGENTS.md` 注入 MC 模式会话 | `true` |
| `injectWorkspaceAgentsMd` | 是否**额外**注入工作区的 `AGENTS.md` | `false` |
| `memoryDir` | 记忆根目录（`null` = 会话工作区的 `.whale-craft/`） | `null` |
| `ensureMcPreset` | 启动时若 `mcModePresets` 里**一个 preset 都不存在**，就复制官方 `minimal` 建一个「MC模式」（已存在则绝不动） | `true` |

---

## 账户与凭据

「MC设置 → 账户」支持三种类型，**新建/编辑各是独立界面**：

| 类型 | 登录方式 | 说明 |
| --- | --- | --- |
| **离线** | 无 | 名字即身份；可自定义 UUID（留空按 `OfflinePlayer:<名字>` 派生） |
| **第三方（皮肤站）** | Yggdrasil 外置登录 | 先填认证服务器（已缓存的服务器是**可点选、可 × 删除**的标签），再填账号密码；**服务器名字**留空就用域名，填了它缓存标签里才看得懂（也能改已缓存的名字） |
| Mojang 官方（微软账号） | —— | **未实现** |

列表每行是**类型气泡 + 游戏 ID**（皮肤站账户登录成功后回写的档案名），下面一行小灰字是
**`你输入的账号（服务器名）`** —— 输入的是邮箱、游戏里叫角色名，两者不一样时都看得见。

🔒 **边界**：密码/token 只写进宿主凭据服务（`$DSH_HOME/.credentials.yaml`，目录 owner-only）；
密码和 token 不会出现在工具返回值、HTTP 响应或模型上下文里；凭据服务不可用时不会降级写明文。

---

## 工具（27 个，三层命名空间）

| 层 | 数量 | 工具 |
| --- | --- | --- |
| **游戏内** `mc_*` | 24 | `mc_status` `mc_connect` `mc_lan` `mc_accounts` `mc_capabilities` `mc_disconnect` `mc_stop` `mc_config` `mc_sessions` `mc_diag` `mc_say` `mc_events` `mc_watch` `mc_map` `mc_scan` `mc_entities` `mc_inventory` `mc_move` `mc_act` `mc_dig` `mc_build` `mc_give` `mc_sequence` `mc_command` |
| **游戏外辅助** `mc_kit_*` | 2 | `mc_kit_memory`（记忆树：按服/主题定位、`key` 覆盖、搜索、删除、把文件与图片**存进记忆**）· `mc_kit_image`（SVG→PNG / 引图 / 拼网格） |
| **管理** `mc_admin_*` | 1 | `mc_admin_config`（读写全局配置；**MC 模式看不见、也调不动**） |

几个设计点：

- `mc_give` 走**协议级** `set_creative_slot`（创造模式即可，**不需要 OP**）；
- `mc_sequence` 给"连串动作"（最多 64 步），比让模型写脚本稳；
- `mc_command` 是**最后手段**（要 OP，且受白名单限制）；
- `mc_map` 的 `format:"image"` 会渲染一张真地形图并作为**图片附件**回给模型（同时落盘到工作区 `out/`）；
  想让**用户**看到它，用 DSH 自带的 **`present`** 交付（见下条）——本插件不提供任何上传/图床工具。
- `mc_lan` 找**局域网房间**：听 `224.0.2.60:4445` 的"对局域网开放"广播，再扫本机所在网段
  （自己手写的 STATUS ping，拿版本 / MOTD / 人数）。🔴 **只允许内网网段**，公网直接拒；
  主机数 / 端口数 / 并发 / 超时全有上限——它是"看看谁开了房间"，不是扫描器。

---

## MC 模式与权限隔离

> 不止是权限隔离，有限的工具暴露可以让 AI 更专注于 MC 交互。

把会话的 preset 设成 `mcModePresets` 里的一员（默认 `minecraft` / `whale_craft`），该会话就会：

1. **工具白名单**（`tools.restrict({allow})`，无条件生效）：只看得见
   `mc_*` / `mc_kit_*` 自己的工具 + **文件工具**（`read` / `write` / `edit` / `glob` / `grep` / `read_image`）
   + **`present`**（显式文件交付，见下条）+ 配置里额外允许的其它工具。
   宿主的 `pwsh` / `subagent` / `workflow` / `serve_*` 之类**一个都看不见**
   （早期版本用的是"只 deny 自家管理工具"的黑名单，等于没隔离——已修）。
2. **文件工具被关进记忆文件夹**：`read`/`write`/`edit`/`glob`/`grep`/`read_image` 的路径由全局 `guard`
   硬限在 `<工作区>/.whale-craft/` 内（不给路径 = 扫整个工作区 = 拒绝）。
3. **交付产出文件走 DSH 自带的 `present`**：它会把文件声明成"本轮交付"，Web 端在轮末渲染**文件卡片**
   （可预览、可打开），正文里写成行内代码的文件名也会变成可点链接。路径由 `guard` 限在**本会话工作区**内
   （`out/` 与 `.whale-craft/` 都在里面）。插件**不提供**任何上传/图床工具，也不依赖任何外部文件服务；
   如果这份 DSH 里没有 `@deepseek-ai/dsh-tool-present`（随附 preset 里没人引用它），插件**不会**往 preset 里加它。
4. **`mc_admin_*` 看不见也调不动**（白名单 + `guard` 硬拒）。
5. 收到 2–3 条**插件提示行**（在对话里看得见、可折叠，**不是**用户发言）：
   `.whale-craft/AGENTS.md`（行事准则，可在「MC设置 → 提示词」里改）、`.whale-craft/README.md`（记忆总索引）、
   以及可选的（默认关）工作区 `AGENTS.md`。
6. 系统提示词 = preset 自己的 persona（宿主按 preset 自动注入，**插件不插手**）。

> 插件本身**不带 preset 目录**（`~/.dsh/.agent-presets/<名字>/` 需要你自己放一份 persona）。
> 只要 preset id 落在 `mcModePresets` 里，隔离就生效；缺失时插件会照官方 `copy()` 建一个「MC模式」、
> 写好 persona，并**补齐 MC 模式需要的工具组**（`tool-fs` / `tool-jobs` / `present` —— 官方 `minimal`
> 里一个都没有，不补的话既没有文件工具、也没有 job controller）。
> 🔴 补之前会先探"这个部署里有没有那个包"（看随附 preset 有没有人引用它），探不到就绝不加，
> 免得把那份 preset 弄挂。

---

## 安全边界

- **HTTP 接口**（`/api/mc/*`：状态、强制停止、账户、配置、提示词）有**信任栅栏**：非回环且不在
  `webRuntime.trustedHosts` 的 Host 一律 403；`Sec-Fetch-Site: cross-site` 403；外来 Origin 403。
- **AI 拿不到密码**（见上）。
- **`mc_command`** 默认只放行一份白名单，且需要 OP；`allowAllCommands` 才全放开（自己负责）。
- **归档保护**：归档一个正在玩 MC 的会话时，先踢下线 + 关看门狗 + 清后台任务，再放行归档。
  它的实现方式是**接替宿主的一个内部方法**（不是公开扩展点），所以宿主升级后可能需要跟着调整。
- **不碰别人的建筑**：这是给 Agent 的准则，不是技术限制——请在自己的服/授权范围内玩。

---

## 开发与自检

```bash
node tools/check-core.mjs     # 语法 + 动态 import + 私有字段一致性（改 core.mjs 必跑）
node selfcheck.mjs            # 280+ 条离线断言（假 ctx，不需要 MC 服务器、不连网）
# 起一个隔离 DSH 实例验证"整树加载"（需要一份 DSH checkout）：
DSH_ROOT=/path/to/deepseek-harness node tools/isolate.mjs start
```

`selfcheck.mjs` 覆盖：工具面与参数、每会话实例隔离、超时/中断、放置判据（与 `minecraft-data` 真值表比对）、
看门狗唤醒投递、记忆树读写与路径穿越防护、账户库与凭据隔离、配置校验、提示词注入去重、
**强制停止的四步顺序**、依赖面（含"vec3 与 mineflayer 必须是同一份"这类运行时断言）、以及客户端 bundle 的静态检查。

CI 跑的就是这两条（`.github/workflows/ci.yml`）：**ubuntu + windows**、**Node 22 / 24**；
另有一个「打包产物」job，`npm pack` 之后会核对 tarball 里该有的文件都在、且没混进 `node_modules` / 日志 / 账户。

发布走 tag（`.github/workflows/release.yml`）：`git tag v0.1.0 && git push --tags` →
先跑上面两条 + 校验 tag 与 `package.json` 版本一致，再 `npm pack` 并把 tarball 挂到 GitHub Release；
仓库里配了 `NPM_TOKEN` secret 的话顺带发 npm（没配就只发 Release，不会失败）。
`npm publish` 前还会自动跑一遍 `node tools/check-core.mjs && node selfcheck.mjs`（`prepublishOnly`）——**坏树发不出去**。

---

## 已知限制

- **微软正版登录未实现**（只有离线 / Yggdrasil）；
- 工具描述与文档目前是**中文**；
- **能连的 MC 版本取决于依赖里的 `mineflayer`**；想连官方还没支持的新版本，可以自行替换 profile 里的那一份；
- 归档保护依赖宿主内部方法，DSH 升级后可能需要跟进。

## AI 使用

本项目代码由 AI 生成，可能存在未知风险，请谨慎使用。

- 工具：DeepSeek Harness
- 模型：DeepSeek V4 Flash

## 许可

MIT（见 `LICENSE`）。第三方组件与许可见 `THIRD_PARTY_NOTICES.md`。

---

## English

**[↑ 中文版](#whale-craft)**

**Whale Craft** is a native DSH (DeepSeek Harness) plugin that runs a headless Minecraft bot
(mineflayer) inside the harness process, so an agent can actually *play*: walk, mine, build, chat,
read the world and keep notes — and wake itself up when something worth noticing happens.

- **One bot per conversation** — different chats can play on different servers with different accounts.
- **It can see** — exact ASCII terrain maps (cheap in tokens) *and* real rendered images.
- **A single-channel watchdog** — events reach the model through one tool (`mc_watch`) only: it wakes
  the agent when idle and injects a note mid-generation when busy. It never fakes a user message.
- **Long-term memory** — a plain document tree under `<workspace>/.whale-craft/`, indexed by the agent
  and re-injected every turn.
- **Passwords never reach the model** — credentials live in the host credential store; accounts are
  managed from the in-app **MC Settings** dialog.
- **Offline regression suite** — 280+ assertions, no Minecraft server required.

### Install

The easy way: tell your agent *"install the plugin from https://github.com/yzi1b/whale-craft"*.

Or manually:

```bash
# from GitHub (or npm, once published — package name is whale_craft)
dsh plugin --profile web add github:yzi1b/whale-craft
dsh plugin --profile web add whale_craft

# or from a local checkout
dsh plugin --profile web add link:/path/to/whale-craft

# then restart DSH (host plugins are not hot-reloaded; the browser bundle is)
```

This installs the package and appends `whale_craft` to `dsh.profile.bundles`.
`mineflayer` ships as a regular dependency — **you do not need to install it yourself**.

### Use

1. Start a new conversation and pick the **MC mode** preset.
2. **Pick or create a workspace** — memory and the prompt live in its `.whale-craft/`.
3. Optionally set the player name in **MC Settings**, or sign in with a third-party (Yggdrasil) account.
4. Tell your agent which server to join.
5. Give orders in the chat, or talk to the bot directly in game.

### Where things live

| What | Where |
| --- | --- |
| Config · accounts · logs | `$DSH_HOME/whale_craft/` |
| Memory & prompt (per session workspace) | `<workspace>/.whale-craft/` |

Passwords and tokens go to the host credential store only — they never show up in tool output,
HTTP responses, or the model context.

### Verify offline

```bash
node tools/check-core.mjs && node selfcheck.mjs   # 280+ assertions, no MC server needed
```

CI runs exactly this on Linux and Windows with Node 22 and 24, and packs the tarball on every push.
Push a `v*` tag to get a GitHub Release with the tarball (and an npm publish too, if you configure `NPM_TOKEN`).

MIT licensed. Third-party notices in `THIRD_PARTY_NOTICES.md`.
Heads-up: this code was written by an AI — review it before you trust it.
