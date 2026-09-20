# Whale Craft

**[English ↓](#english)** · 中文 · [![CI](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml/badge.svg)](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml)

**让 AI Agent 真的进 Minecraft 里玩** —— 一个 DSH（DeepSeek Harness）原生插件：
把一台无头 Minecraft 机器人（mineflayer）跑在 DSH 进程里，给模型一套 `mc_*` 工具去走路、挖建、说话、
看图、记事，并在"值得你注意"的时候把它叫醒。

- 🎮 **每会话一个独立机器人**：不同对话可以连不同服务器、用不同账号，互不干扰
- 👀 **能看世界**：字符地形图（省 token、坐标精确）与**真图像**（`mc_map{format:"image"}`）双通道
- 🔔 **单脑看门狗**：事件只走 `mc_watch` 一条通道 —— 空闲时唤醒、生成中插话（**提示词注入，不模拟用户发言**）。
  玩家说话**不论走签名聊天、未签名聊天，还是被服务端塞进 system 位置**都认得出来
- 🧠 **长期记忆**：`<工作区>/.whale-craft/` 文档树，索引由 AI 维护，**会话开始时**自动带进上下文
- 🖥️ **自带浏览器 UI**：状态条（显示连的哪个服）+「强制停止」+「MC设置」（账户 / 指令白名单 / 提示词）
- 🔒 **密码不进模型上下文**：凭据只写宿主凭据库；账户在「MC设置」里维护
- 📢 **版本硬提示词**：随插件版本发布的固定提示（"本版本哪些工具还不成熟、怎么把文件给用户看"），
  不可编辑、也不用配 —— 在「MC设置 → 提示词」里可以展开看原文

---

## 使用

1. 创建新对话，选中「MC模式」。
2. **选中或新建一个工作区**（记忆与提示词都放在它的 `.whale-craft/` 里）。
3. 如有必要，进入「MC设置」修改玩家名称，或使用第三方皮肤站登录。
4. 对你的 AI 说「进 xx 服务器」。
5. 在对话窗口下命令，或直接在游戏里聊天。

> 想让 AI 进**局域网房间**？直接说"找个局域网服务器"——它用 `mc_lan` **只听**原版那个局域网公告
> （`224.0.2.60:4445`，恒定几秒返回），拿到地址后用 `mc_connect` 进去（对方要先在游戏里「对局域网开放」）。

> 🔴 **必须选工作区**：每个会话都要在**工作区**里跑 —— `.whale-craft/`（记忆 + 提示词）就建在那儿。
> 插件只在两个时刻去备好它：**首次进入 MC 模式会话**、或**点开「MC设置」**（不会在你没玩 MC 的普通会话里乱建目录）。
> **没有选中工作区时**：服务端**不把该会话当 MC 模式**（不套工具隔离、不注入专属提示词、不建 `.whale-craft/`），
> 「MC设置」的接口也会拒绝并说明原因。界面上的表现是：**新对话页还没连接工作区时（此时还没有会话）
> 不显示「MC设置」按钮**；一旦有了会话，按钮只按"是不是 MC 模式"显示，工作区是在**点它的那一刻**才检查的
> （没选就提示你先选）。

---

## 要求

| 项 | 要求 |
| --- | --- |
| DSH | 已发布在 npm（`@deepseek-ai/dsh`）；本插件只用公开契约（`dsh.bundle.patch` + `exports["./client"]`） |
| Node | ≥ 22（跟 DSH 一致） |
| Minecraft 机器人 | `mineflayer`，插件的**直接依赖** —— 跟着一起装好，不用你动手 |
| 可选 | `sharp`（SVG→PNG 光栅化）—— 装不上只影响 `mc_kit_image` 的渲染，其它功能照常 |

---

## 安装

> 对你的 AI 说：`帮我安装插件 https://github.com/yzi1b/whale-craft`

### 手动安装

whale_craft 是**标准 DSH 插件**：包自带 `cordis.patch.yml`（`package.json` 里声明了 `dsh.bundle.patch`），
只要把包名列进 profile 的 `dsh.profile.bundles` 即生效，**不需要手改 profile 的补丁文件**。

```bash
# 从 GitHub 装（npm 上的包名是 whale_craft，仓库名是 whale-craft）
dsh plugin --profile web add github:yzi1b/whale-craft
dsh plugin --profile web add whale_craft          # 发布到 npm 之后

# 或从本地目录装
dsh plugin --profile web add link:/path/to/whale-craft
```

这条命令把包装进 profile，并把 `whale_craft` 加进 `dsh.profile.bundles`。
**然后重启 DSH**（服务端插件不热重载；浏览器端 bundle 是热重载的）。

---

## 落盘位置

| 东西 | 位置 |
| --- | --- |
| 全局配置 | `$DSH_HOME/whale_craft/config.json` |
| 账户元数据 | `$DSH_HOME/whale_craft/accounts.json` |
| 插件日志 | `$DSH_HOME/whale_craft/logs/whale-craft.log`（可用 `MC_LOG` 覆盖） |
| 会话锁（连服期间） | `$DSH_HOME/whale_craft/.instance.<会话>.json` |
| **记忆 / 提示词** | **`<会话工作区>/.whale-craft/`**：`README.md`（AI 维护的总索引）+ `RULES.md`（行事准则）+ 任意文档/图片 |
| 出图与发布 | `<会话工作区>/.whale-craft/.out/`（**不对外**）· `<会话工作区>/.whale-craft/.express/`（可访问，见下） |

> 记忆是**按会话工作区**的，与插件装在哪、DSH 装在哪都无关。
> `.whale-craft/` 里的东西**只读写文件，不执行任何东西**。

---

## 配置

「MC设置」入口有**两个，按会话状态互斥**（任何时刻只出现一个）：**新会话页**上贴在**模式芯片的右边**；
**已有会话**时落在**对话标题条的操作区**。点开就是账户 / 指令白名单 / 提示词 / 文件分享四个标签页。
配置落在 `$DSH_HOME/whale_craft/config.json`，改完立即生效。

非 MC 模式下的 AI 可以用 `mc_admin_config` 工具改这些键（**MC 模式会话看不见、也调不动它**）：

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `commandWhitelist` | `mc_command` 放行的服务器指令。支持精确名 `"tp"`、正则 `"/^gi.+/"`、`"*"` 全放行 | tp/give/time/… |
| `allowAllCommands` | 指令白名单页那个总开关 | `false` |
| `mcModePresets` | 哪些 preset 算"MC 模式"（权限隔离的判据） | `["minecraft","whale_craft"]` |
| `mcMode.allowOtherTools` | MC 模式白名单里**额外**放行的其它工具（默认只给 `mc_*` / `mc_kit_*` / 文件工具 / `present`） | `[]` |
| `mcMode.hideAdminTools` | 是否把 `mc_admin_*` 也放进白名单（默认隐藏，另有 guard 硬拒） | `true` |
| `injectWhaleCraftAgentsMd` | 是否把 `.whale-craft/RULES.md`（行事准则）注入 MC 模式会话 | `true` |
| `injectWorkspaceAgentsMd` | 是否**额外**注入工作区根上的 `AGENTS.md` | `false` |
| `rulesFollowVersion` | 「提示词」页的「随版本更新」：插件版本一变，就用新版本默认准则**替换** `.whale-craft/RULES.md` | `true` |
| `expressMode` | 文件分享：「文件分享」页选的模式：`off` 关闭 / `online` 在线 | `"off"` |
| `expressBase` | 在线模式的 base（你访问这台 DSH 的地址，可带路径前缀） | `""` |
| `memoryDir` | 记忆根目录（`null` = 用会话工作区的 `.whale-craft/`） | `null` |
| `ensureMcPreset` | 启动时若 `mcModePresets` 里**一个 preset 都不存在**，就复制官方 `minimal` 建一个「MC模式」（已存在则绝不动） | `true` |

---

## 账户与凭据

「MC设置 → 账户」支持三种类型，**新建/编辑各是独立界面**：

| 类型 | 登录方式 | 说明 |
| --- | --- | --- |
| **离线** | 无 | 名字即身份；可自定义 UUID（留空按 `OfflinePlayer:<名字>` 派生） |
| **第三方（皮肤站）** | Yggdrasil 外置登录 | 先填认证服务器（已缓存的服务器是**可点选、可 × 删除**的标签），再填账号密码；**服务器名字**留空就用域名 |
| Mojang 官方（微软账号） | —— | **未实现** |

列表每行是**类型气泡 + 游戏 ID**（皮肤站账户登录成功后回写的档案名），下面一行小灰字是
**`你输入的账号（服务器名）`** —— 输入的是邮箱、游戏里叫角色名，两者不一样时都看得见。

🔒 **边界**：密码/token 只写进宿主凭据服务（`$DSH_HOME/.credentials.yaml`，目录 owner-only）；
密码和 token 不会出现在工具返回值、HTTP 响应或模型上下文里；凭据服务不可用时不会降级写明文。

---

## 工具（29 个，三层命名空间）

| 层 | 数量 | 工具 |
| --- | --- | --- |
| **游戏内** `mc_*` | 25 | `mc_status` `mc_ping` `mc_connect` `mc_lan` `mc_accounts` `mc_capabilities` `mc_disconnect` `mc_stop` `mc_config` `mc_sessions` `mc_diag` `mc_say` `mc_events` `mc_watch` `mc_map` `mc_scan` `mc_entities` `mc_inventory` `mc_move` `mc_act` `mc_dig` `mc_build` `mc_give` `mc_sequence` `mc_command` |
| **游戏外辅助** `mc_kit_*` | 3 | `mc_kit_memory`（记忆树：按服/主题定位、`key` 覆盖、搜索、删除、把文件与图片**存进记忆**）· `mc_kit_image`（SVG→PNG / 引图 / 拼网格）· `mc_kit_express`（把发布区里的文件按「文件分享」模式换成路径 / URL / 一句提示） |
| **管理** `mc_admin_*` | 1 | `mc_admin_config`（读写全局配置；**MC 模式看不见、也调不动**） |

几个设计点：

- `mc_give` 走**协议级** `set_creative_slot`（创造模式即可，**不需要 OP**）；
- `mc_sequence` 给"连串动作"（最多 64 步），比让模型写脚本稳；
- `mc_command` 是**最后手段**（要 OP，且受白名单限制）；
- `mc_map` 的 `format:"image"` 会渲染一张真地形图：作为**图片附件**回给模型，同时落盘到 `.whale-craft/.out/`；
- `mc_lan` 找**局域网房间**：只做原版那一件事 —— 听 `224.0.2.60:4445` 上"对局域网开放"的公告
  （`[MOTD]…[/MOTD][AD]端口[/AD]`，重发周期 1.5 秒），听到就拿到 host/端口/MOTD。🔴 **不扫端口**，
  所以恒定在 `seconds` 秒内返回（默认 3、上限 15）；多播被挡的网络里看不见，直接问对方地址；
- `mc_ping` 是**已知地址**时的探路工具：发一次 STATUS ping（握手 + 状态请求），拿
  **通不通 / 版本 / 协议号 / MOTD / 人数 / 延迟**——🔴 **不登录、不用账户、不进服**，拿到就断；
  超时自己兜（默认 5 秒、上限 30 秒），连不上时把原因说成人话
  （`ECONNREFUSED`=端口没人听 · `ENOTFOUND`=域名拼错 · 超时=防火墙或服务端 `enable-status=false`）。
  与 `mc_lan` 正好互补：**不知道地址**听公告，**知道地址**用它探一次，再用 `mc_connect` 真进服；
- `mc_events` 与看门狗**分工明确**：**"该不该醒"由看门狗判断**（有人叫它 / 受击 / 死亡 / 断线…会主动唤醒），
  **"发生过什么"由 `mc_events` 提供**（聊天、系统消息、受伤、上线/死亡/重连/断线；⚠️ 被传送 / 捡物 /
  其他玩家上下线只在看门狗留档里，用 `mc_watch {action:"log"}` 看）。
  `waitSec` 只是兜底：**看门狗要唤醒时会打断这个等待**（返回 `interrupted:true`），
  否则一次长等待会把唤醒文案压到等待结束才投递；
- **断线会主动播报**：掉线会通知 AI（并进事件队列），自动重连期间顶部状态条显示**「重连中…」**、
  `mc_status` 回 `reconnecting`，重连成功也会说一声——**不会出现"断了却还显示在游戏中"**；
- 记忆是**语义层**不是文件别名：`topic`/`server` 自动定位路径、`append` 带 `key` 覆盖同 key 那条、
  跨文件 `search`、删除、把任意文件（含图片）`put` 进记忆再当**图片附件**读回来。

---

## MC 模式与权限隔离

> 不止是权限隔离，有限的工具暴露可以让 AI 更专注于 MC 交互。

把会话的 preset 设成 `mcModePresets` 里的一员（默认 `minecraft` / `whale_craft`），该会话就会：

1. **只看得见白名单里的工具**（`tools.restrict({allow})`，无条件生效）：
   `mc_*` / `mc_kit_*` + **文件工具**（`read` / `write` / `edit` / `glob` / `grep` / `read_image`）
   + `present`（宿主有就放行）+ 你在 `mcMode.allowOtherTools` 里额外点名的。
   宿主的 `pwsh` / `subagent` / `workflow` / `serve_*` 之类**一个都看不见**。
2. **文件工具被关进记忆文件夹**：它们的路径由全局 `guard` 硬限在 `<工作区>/.whale-craft/` 内
   （**不给路径**也算越界 = 拒绝；`.dsh` 凭据、`secrets/`、行事准则另有硬拒）。
3. **管理工具看不见也调不动**（白名单 + `guard` 双保险）。
4. 收到几条**插件提示行**（在对话里看得见、可折叠，**不是**用户发言）：见下一节。
5. 系统提示词 = preset 自己的 persona（**宿主按 preset 自动注入，插件不插手**）。

---

## 提示词是怎么进去的

本插件**不往系统提示词里塞任何东西**（那样既冗余、又会被 preset 的 persona 压制）。
注入只有一条通道 —— 学 DSH 原生注入 `AGENTS.md` 的做法，把内容当**插件提示行**投进会话：

| 顺序 | 内容 | 开关 |
| --- | --- | --- |
| 1 | 工作区根上的 `AGENTS.md`（DSH 原生那份文件） | `injectWorkspaceAgentsMd`（默认**关**） |
| 2 | `.whale-craft/RULES.md`：本模式的行事准则（称呼 / 记忆 / 看门狗 / 登服 / 聊天 / 硬规矩） | `injectWhaleCraftAgentsMd`（默认**开**） |
| 3 | **版本硬提示词**：硬编码、随插件版本发布，说明"本版本哪些工具还不成熟、优先用什么、怎么把文件给用户看" | 无开关（版本的一部分） |
| 4 | 记忆总索引：`.whale-craft/README.md` 的正文 + 一份**自动目录树** | 无开关 |

- 每条都写明**出自哪个文件**（首行 `Instructions from: …`），在对话里是可折叠的一行提示；
- **为什么行事准则叫 `RULES.md` 而不是 `AGENTS.md`**：DSH 会把 `AGENTS.md` / `CLAUDE.md` 当"工作区指令"自动注入
  —— 任何会话只要读过/写过 `.whale-craft/` 下的文件，宿主就会把那份注入**该会话**（包括非 MC 会话），
  而且不受本插件的开关控制。改成不在候选名单里的名字，注入就只剩我们这一条、且只对 MC 模式生效。
  老工作区里若已有 `.whale-craft/AGENTS.md`，插件会**自动搬进 `RULES.md`** 并把老文件改名备份
  （`AGENTS.md.bak-<时间>`）。
- 行事准则**只有你能改**：AI 不能读写它（工具与记忆工具两条路都挡），要改就在「MC设置 → 提示词」里编辑，
  那里也能一键**恢复默认**。
- **「随版本更新」（默认开）**：插件升级后，用新版本的默认准则**替换**当前内容（**会覆盖你的修改**）；
  判定靠记忆目录里的 `.rules-version` 标记。想长期维持自己那份就把它**关掉** —— 关掉后插件永不动它，
  且关着期间不会"攒着"：以后再打开也不会突然覆盖。

---

## 把文件给用户看（发布区 + 「文件分享」开关）

> 让 AI「画了图给你看」这件事，插件自带一条最小通道：**目录即白名单**，不依赖任何外部图床/文件服务。
> 分享方式由你在「MC设置 → 文件分享」里选（默认**关闭**）。

| 目录 | 谁能拿到 | 用途 |
| --- | --- | --- |
| `<工作区>/.whale-craft/.out/` | **谁都拿不到** | 默认输出（草稿、中间产物） |
| `<工作区>/.whale-craft/.express/` | 取决于分享模式 | 发布区：要给你看的图/文件（**支持子目录**） |

两种模式（`expressMode`）：

| 模式 | `mc_kit_express` 返回什么 | 那条访问服务 |
| --- | --- | --- |
| **关闭（默认）** | 恒回一句「文件分享已关闭，请告知用户文件绝对路径，让用户自行打开」——AI 把文件的**绝对路径**给你，你自己打开 | **不开**（访问即 404） |
| **在线** | `base` + `/api/whale-craft/express/<工作区 uuid>/<相对路径>` 的**完整 URL**（图片能直接在对话里内联显示） | **只在**这个模式开 |

**在线模式**要填 `base` = 你访问这台 DSH 用的地址（如 `https://dsh.example.com`，可带路径前缀）；
设置页有「获取当前」，也可以直接切到在线 —— base 为空时会**自动**用当前访问地址填上。
（精度：浏览器把**自己正在用的** `location.origin` 报给服务端 → 否则看 `Origin` 头 → 同源 `Referer`
→ `X-Forwarded-Proto` + `Host` → `Host`。注意 `location.origin` **不含路径**，所以反代额外加的
路径前缀得你自己补 —— DSH 本身没有"挂载前缀"概念。）

**两种模式都只认发布区**：文件得先放进 `.express/` 或其子目录（出图时把 `out` 写成那里，
或用 `mc_kit_memory {action:"put"}` 复制过去），再让 AI 调 `mc_kit_express` 取那一行。

- 服务端地址：`GET|HEAD /api/whale-craft/express/<工作区 uuid>/<剩余路径>`（自己的顶层前缀路由，
  自带同一道信任栅栏）。**uuid 是 DSH 工作区注册表里那个稳定 id** —— 不同父目录下的同名工作区不会撞，
  目录改名链接也不失效；查不到对应工作区就 404（不退回目录名）。
- 安全：**只用纯文件名逐段拼接**（`..`、`.`、空段、段内分隔符、盘符、`~` 一律拒），拼完再 `realpath` 复查
  "真实路径仍在发布区里" ⇒ **路径穿越与符号链接都出不去**；不列目录；单文件上限 32 MB；
  所有扩展名放行，只给 svg/html 这类"被当文档打开会执行脚本"的加一个 `Content-Security-Policy: sandbox` 头。
- 设置页还有 **「清除分享数据」**：**与模式无关、随时可点**（二次确认后删掉当前工作区 `.express/` 里的
  所有文件，目录本身重建）。
- ⚠️ 前端渲染只认**绝对 http(s)** 图片地址 ⇒ 只有**在线**模式的 URL 能内联显示；关闭模式本来就是"给你路径自己开"。

---

## 「MC模式」preset 会自己长出来

**第一次装好没有「MC模式」？** 插件会**自己建一个**：启动时发现 `mcModePresets`（默认 `minecraft` / `whale_craft`）
里一个都不存在，就调用 DSH 官方接口 `agentPresets.copy('minimal', 'minecraft', 'MC模式')`
—— **整目录复制官方极简模式**（DSH 的 authoring 只允许这样建），然后：

- **persona 换成一句**："你在一台真实的 Minecraft Java 版服务器里扮演一名玩家：你的"身体"是一台无头机器人，
  能观察世界、移动、挖掘和建造。"（官方 `minimal` 那句"helpful software engineer assistant"、以及它的
  `complete: true` / `includeRuntimeContext: false` 都会被去掉 —— 后者会压掉所有其它提示段）；
- **关掉持久 shell**（本模式没有 shell，别让模型看见 `pwsh`）；
- **补齐本模式需要的工具组**：`tool-fs`（文件工具）· `tool-jobs`（后台任务控制器，看门狗要挂 job）·
  `present`（显式文件交付）—— 官方 `minimal` 里一个都没有。🔴 加之前会先探"这个部署里到底有没有那个包"
  （看随附 preset 有没有人引用它），探不到就绝不加，免得把 preset 弄挂。
- **已经有一个就绝不动它**；不想要这个行为就把 `ensureMcPreset` 关掉。
- 每次启动还会**自检那个自建的 preset**（插件升级 / DSH 升级后它可能过期）：显示名/简介/排序不对 → 只修显示文本；
  组成还是"我们当初复制的那份"而官方源变了（或自建规格变了）→ **重新复制一遍**（旧目录先备份成
  `<id>.bak-<时间>`）。**只要你动过组成，就一律不碰** —— 它靠一个 `.whale-craft.json` 自建标记判断
  "这份是不是我建的、有没有被改过"。

---

## 安全边界

- **HTTP 接口**（`/api/mc/*`：状态、强制停止、账户、配置、提示词、发布区文件）有**信任栅栏**：
  非回环且不在 `webRuntime.trustedHosts` 的 Host 一律 403；`Sec-Fetch-Site: cross-site` 403；外来 Origin 403。
- **AI 拿不到密码**（见上）。
- **AI 不能改行事准则**，也不能用文件工具或记忆工具读写它。
- **`mc_command`** 默认只放行一份白名单，且需要 OP；`allowAllCommands` 才全放开（自己负责）。
- **归档保护**：归档一个正在玩 MC 的会话时，先踢下线 + 关看门狗 + 清后台任务，再放行归档。
  它接替了宿主的一个内部方法（不是公开扩展点），DSH 升级后可能需要跟着调整。
- **不碰别人的建筑**：这是给 Agent 的准则，不是技术限制 —— 请在自己的服 / 授权范围内玩。

---

## 开发与自检

```bash
node tools/check-core.mjs     # 全树语法 + 动态 import + 私有字段一致性（改 core.mjs 必跑）
node selfcheck.mjs            # 726 条离线断言（假 ctx，不需要 MC 服务器、不连网）
# 起一个隔离 DSH 实例验证"整树加载"（需要一份 DSH checkout）：
DSH_ROOT=/path/to/deepseek-harness node tools/isolate.mjs start
```

`selfcheck.mjs` 覆盖：工具面与参数、每会话实例隔离、超时/中断、放置判据（与 `minecraft-data` 真值表比对）、
看门狗唤醒投递与 job 结算、未签名/系统位置聊天的识别、记忆树读写与路径穿越防护、**发布区的防穿透与真路由**、
**「文件分享」两种模式与 base 推导**（含反代 `Referer` 一档）、账户库与凭据隔离、配置校验、
提示词注入去重与版本提示、preset 自检与重建、**强制停止的四步顺序**、
依赖面（含"`vec3` 与 `mineflayer` 必须是同一份"这类运行时断言），以及客户端 bundle 的静态检查。

CI 跑的就是这两条（`.github/workflows/ci.yml`）：**ubuntu（Node 22 / 24）+ windows（Node 22）**；
另有一个「打包产物」job，`npm pack` 之后核对 tarball 里该有的文件都在、且没混进 `node_modules` / 日志 / 账户。

发布走 tag（`.github/workflows/release.yml`）：`git tag v0.1.7 && git push origin v0.1.7` →
先跑上面两条 + 校验 tag 与 `package.json` 版本一致，再 `npm pack` 并把 zip 挂到 GitHub Release
（正文取 `CHANGELOG.md` 里本版本那一节），最后**发 npm**（用仓库 secret `NPM_TOKEN`）。
`npm publish` 前还会自动跑一遍上面两条（`prepublishOnly`）—— **坏树发不出去**。

- 🔴 **npm 那步是"先探再发"**：仓库里配了 `NPM_TOKEN` 才发；**没配就明确跳过**（只发 Release，工作流照样绿）。
  加 secret 的位置：仓库 **Settings → Secrets and variables → Actions → New repository secret**，
  名字必须是 `NPM_TOKEN`，值是 npm 的 Automation token。
- 也可以**在本机手动发**（不依赖任何 secret）：`npm login` 后跑 `npm run publish:npm`
  —— 前置校验、失败即停、默认要确认，细则见 `RELEASING.md`。
- **每个版本改了什么**见 [`CHANGELOG.md`](CHANGELOG.md)（`0.1.7`：修 1.21/1.21.1 进服掉线、
  断线状态不同步、`mc_events` 的等待堵住唤醒；`0.1.6`：修皮肤站登录 400；`0.1.5`：修"连不存在的服
  把整个 DSH 搞崩"、`mc_lan` 只留局域网公告、新增 `mc_ping`、默认行事准则第五版）。

---

## 已知限制

- **微软正版登录未实现**（只有离线 / Yggdrasil 皮肤站）。
- **文件分享默认是关的**（`expressMode: "off"`）：AI 画了图只会把**绝对路径**给你，要让它直接在对话里显示，
  得在「MC设置 → 文件分享」里切到**在线**并填好 `base`。前端只认绝对 http(s) 图片地址，所以关闭模式下的
  本地路径**不会**内联成图（这是设计如此，不是 bug）。
- 在线模式的 `base` **不做连通性自检**：填错了只有你自己能发现（AI 拿到的 URL 打不开）。
- 🔴 **行事准则为什么叫 `RULES.md`**（见上）：`AGENTS.md` 会被 DSH 当工作区指令自动注入到任何碰过该目录的会话，
  与 MC 模式无关 —— 所以这个名字是刻意的。
- 工具描述与文档目前是**中文**。
- **能连的 MC 版本取决于依赖里的 `mineflayer`**；想连官方还没支持的新版本，可以自行替换 profile 里的那一份。
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
  Player chat is recognised whether the server sends it signed, unsigned, or in the system slot.
  A blocking `mc_events {waitSec}` wait is **interrupted** when the watchdog wants to wake the agent,
  so a long wait can never delay a wake-up.
- **Honest connection state** — a dropped connection is announced (to the agent and to the UI: the
  status chip shows *reconnecting…*), and the watcher disarms when there is nothing left to watch.
  No more "in game" while the socket is already dead.
- **Long-term memory** — a plain document tree under `<workspace>/.whale-craft/`, indexed by the agent
  and injected as a plugin notice when the session starts.
- **A per-release built-in prompt** — a hard-coded, non-editable note that ships with each version
  ("which tools are still immature, how to hand files to the user").
- **File sharing switch** — per-workspace publish area (`.whale-craft/.express/`, "the directory *is* the
  allow-list"), two modes: **off** (default — the agent just hands you an absolute path) or **online**
  (the agent hands back a full URL built from your `base`, and images render inline in the chat).
  The HTTP route that serves those files exists **only** in online mode.
- **Passwords never reach the model** — credentials live in the host credential store; accounts are
  managed from the in-app **MC Settings** dialog.
- **Offline regression suite** — 726 assertions, no Minecraft server required.

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
| Config · accounts · logs · lock | `$DSH_HOME/whale_craft/` |
| Memory · prompt · output · published files | `<workspace>/.whale-craft/` (`README.md` · `RULES.md` · `.out/` · `.express/`) |

Passwords and tokens go to the host credential store only — they never show up in tool output,
HTTP responses, or the model context.

### Verify offline

```bash
node tools/check-core.mjs && node selfcheck.mjs   # 686 assertions, no MC server needed
```

CI runs exactly this on Linux (Node 22 and 24) and Windows (Node 22), and packs the tarball on every push.
Push a `v*` tag to get a GitHub Release with the zip, plus an **npm publish** when the repository has an
`NPM_TOKEN` secret (without it, the npm step is skipped with a notice — the workflow still succeeds).

MIT licensed. Third-party notices in `THIRD_PARTY_NOTICES.md`.
