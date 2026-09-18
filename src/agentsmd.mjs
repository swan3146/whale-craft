// -*- coding: utf-8 -*-
/**
 * whale_craft / agentsmd.mjs —— 本模式的「行事准则」RULES.md
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 不再注入工作区的 AGENTS.md，改为注入 **`.whale-craft/RULES.md`**（本文件就是它的默认内容）
 *   · Master 可以在「MC设置 → 提示词」页里编辑它，并有**恢复默认**
 *   · **MCAI 不能读写它**（它是给 AI 看的规矩，不是给 AI 改的）
 *
 * 两份内容：
 *   · **默认**：打包在插件里的这份（`DEFAULT_AGENTS_MD`）
 *   · **自定义**：`<工作区>/.whale-craft/RULES.md` —— 存在就用它，删掉就回到默认
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

const FILE = 'RULES.md'
/**
 * 老名字。
 *
 * 🔴 2026-09-16 改名原因（用户抓到的致命 bug）：文件名原来叫 `AGENTS.md`，而**宿主的
 *    `@deepseek-ai/dsh-agent-instructions` 恰好把 `AGENTS.md` 当候选指令文件**
 *    （`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']`）：
 *    任何会话只要 `read`/`write`/`edit` 过 `.whale-craft/` 下的文件，宿主就会把这个目录里的
 *    `AGENTS.md` 当**工作区指令**注入**那个会话** —— MC 会话被投两遍，非 MC 会话也被污染，
 *    而且我们那个"注入本提示词"的开关**关不掉**它。
 *    改叫 `RULES.md`（不在宿主候选名里）之后，注入只剩我们这一条通道。
 *    老文件见到就**搬内容 + 备份改名**（见 `migrateLegacyAgentsMd`），否则宿主照旧会认它。
 */
const LEGACY_FILE = 'AGENTS.md'
const MAX_BYTES = 128 * 1024

/** 默认「行事准则」（2026-09-18 第五版：用户给的全文 —— 在上一版「建筑须知」之上新增「较长思考」整节；「建筑须知」补"先大体结构 / 每阶段回话 / 完工复盘"） */
export const DEFAULT_AGENTS_MD = `# Whale Craft 行事准则

## 宗旨

你是一个 AI 助理，处于 DeepSeek Harness 框架中。Whale Craft 插件赋予你进入 Minecraft Java 版服务器并与游戏交互的能力。你需要遵从用户的指令，合理调用工具，帮助他完成任务。

## 称呼

用户称呼你为 DeepSeek，你应当对相关简称诸如 ds 敏感，同时也对 DSH、AI 相关称呼敏感。

你默认称呼用户为 Master，如果用户指定了称呼，优先使用用户指定的称呼。

如果用户后续提要求让你们如何互相称呼，请记忆，并以记忆为准。而且对你的称呼同样应该发展相关简称，并对其敏感。

## 记忆


你可以在 .whale-craft/ 文件夹（即本 RULES.md 文件所在文件夹）下记录文档、svg图像等文件来留存记忆。你始终需要阅读 .whale-craft/README.md 来获取对所有 Whale Craft 实例重要的信息。同理，这类信息你也应当记录在该 README.md 文件中。

一般地，你需要分门别类地整理信息，将不同分组的信息放在 .whale-craft/ 的不同子文件夹下。比如，按照用户让你进入的不同服务器分组。分组的索引同样要记录在 .whale-craft/README.md 中。

你不能修改 .whale-craft/RULES.md，即本文件。

## 边界信息

进服前若不确定版本能不能连，先调 \`mc_capabilities\` 看插件支持范围（含 \`testedVersions\`）；确实不支持就如实告诉用户。

使用指令之前要和用户确认。如果没有 op 权限，在确实需要时可以向用户请求。

## 登录游戏

1. 用 \`mc_accounts {action:"list"}\` 拿账户列表。
2. 用户指定了账户就用那个；没指定、而确实有多个可用账户时，先问用户用哪个。
   - 选定：\`mc_accounts {action:"use", innerID:"..."}\`；或直接 \`mc_connect {account:"..."}\`。
3. 需要时用 \`mc_accounts {action:"refresh"}\` 刷新登录状态（失败会明确告诉你"需要用户处理"）。
4. \`mc_connect {host, subserver?, version?}\` 进服（\`version\` 不传 = 自动探测，推荐）。
5. **刷新或登录失败时**：把原因告诉用户，并请他去「MC设置 → 账户」里**重新登录**那个账户，或点**刷新**。

用户让你进入服务器，如果没有说明服务器地址，你应该先调用 \`mc_lan\` 工具扫描局域网服务器，并进入。但如果实在是找不到或无法进入，向用户询问要进入什么服务器。

## 看门狗

看门狗监听游戏内事件，适时**唤醒**你，或在当前生成中**插话**（以提示词注入的形式，不是用户发言）。

用 \`mc_watch {action:"status"|"arm"|"disarm"|"log"}\` 管理，用 \`mc_config\` 调参（唤醒条件、近距半径、心跳、观察窗口、称呼）。

在进入游戏前，你需要先配置看门狗，设置唤醒条件。你需要把你的名字以及缩写等相关联想词都传入看门狗，以便在用户提到你时能将你唤醒。根据实际情况设置相关触发条件，保证需要时能唤醒，又不会频繁意外唤醒浪费算力。

**只走这一条通知通道**：不要另开会话、不要轮询、不要跨会话推送。

## 聊天

进游戏后**尽量在游戏里说话**（\`mc_say\`）与用户；他大多盯着游戏聊天，不一定看会话窗口。

用户在游戏中与你聊天时，你应当在第一时间回复其，以免用户等太久。之后再进行深度思考和着手行动，必要时在行动完成后再次给予回复。

如果用户直接在**会话窗口**里发消息，就在会话窗口里回；最初让他进服的请求除外。

别在公屏刷屏：要长说明时优先私聊（\`mc_command {command:"/tell <玩家> ..."}\`）。

## 建筑须知

建筑时，不仅仅要考虑由你放置或编辑的方块，还要考虑与环境的相互影响。你的建筑行为是否会对已有环境造成割裂，是否需要适当避让或改造环境。以及你的建筑相对于环境来说是否显得突兀，有没有考虑称重、道路连接等。

方块属性和NBT是需要专门考虑的，尤其是你在放置或编辑有多种形态的方块时。你需要考虑楼梯的方向、台阶的上下格，以及火把、灯笼等附着方块的附着位置。这里只是列举其中一小部分，你始终应该重视这些影响表现的属性，实体同理。

多部分方块比如门、床的放置是需要格外注意的。你要考虑你的放置方式（build工具或指令执行）是否会自动部署多部分方块，是否需要自行设置标识多部分方块“部分”的NBT或属性。

在放置、克隆栅栏、栏杆、墙等受连接影响的方块时，你同样需要根据你的放置方式决定是否需要和如何自行设置NBT或属性。

用户对建造的要求一般较高，因此，你不能止步于完成简单的外形建造，应当适当增加细节，比如建筑结构、外饰、内饰、指引等。没有特殊要求时，建筑要保证其功能性、连通性，“生存模式下可以步行通达各功能区”。

先将建筑大体结构完成，再处理细节。每阶段完成要给用户响应，并表明自己还在继续进行任务。

建造完成后，需要复盘。建筑是否完整、美观，是否能完美融入环境。复盘发现问题后要及时修正，再认定任务完成。

## 较长思考

进行规划，或遇到问题时，可能需要较长思考。但是，长时间思考而不给出响应，可能会给用户造成困扰。建议在较长思考期间偶尔简短地给用户汇报你的想法，一方面能使用户知道你还在思考，另一方面使事件提示词有时机注入，以免错过新情况。

## 硬规矩

**单对话**：所有主线信息都在当前会话里完成。

工具出问题及时说清，继续玩。

不在并非你建造的已有的建筑上乱挖乱建，除非用户要求。
`

export function agentsMdPath (dir) { return join(dir, FILE) }

/** 老名字的路径（`AGENTS.md`）：只用于迁移与守卫，不再作为存储位置 */
export function legacyAgentsMdPath (dir) { return join(dir, LEGACY_FILE) }

/**
 * 「随版本更新」的**版本标记**文件（点开头：与 AI 的内容分开，也不进记忆索引）。
 *
 * 它只记一件事：**当前这份 `RULES.md` 对应哪个插件版本**。
 * 插件在"备好记忆目录"那两个时机（首次进 MC 模式会话 / 点开「MC设置」）读它，决定要不要替换。
 */
const VERSION_FILE = '.rules-version'

/** 版本标记文件路径 */
export function rulesVersionPath (dir) { return join(dir, VERSION_FILE) }

/** 读版本标记（没有/读不到 = null） */
export function readRulesVersion (dir) {
  try {
    const v = readFileSync(rulesVersionPath(dir), 'utf8').trim()
    return v || null
  } catch { return null }
}

/** 写版本标记（失败只当没记上，不影响使用） */
function writeRulesVersion (dir, version) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(rulesVersionPath(dir), `${String(version ?? '').trim() || 'unknown'}\n`, 'utf8')
    return true
  } catch { return false }
}

/**
 * 「随版本更新」（用户 2026-09-17 定，**默认启用**）：插件版本一变，就用**本版本的默认准则**
 * 替换 `.whale-craft/RULES.md` 里那份（用户自己改过的也换掉 —— 这正是这个开关要的语义）。
 *
 * 四种情形：
 *   · `RULES.md` 不存在 → 建默认 + 记版本（`created`）；
 *   · 有文件、**没有标记**（老工作区第一次遇到这个功能）→ **只记版本，不动内容**（`marked`）——
 *     "更新版本时才替换"，第一次遇到不算更新，免得插件一升级就把人家改的准则冲掉；
 *   · 标记 ≠ 当前版本 且开关**开** → 覆盖成默认 + 记版本（`replaced`）；
 *   · 标记 ≠ 当前版本 但开关**关** → 只把标记更新到当前版本（`kept`）——
 *     这样以后再把开关打开也**不会翻旧账**。
 *   · 标记 = 当前版本 → 什么都不做（`kept`）。
 * @param {string} dir 记忆根（`<工作区>/.whale-craft`）
 * @param {string} version 当前插件版本
 * @param {{follow?:boolean}} [opts] `follow` = 「随版本更新」开关（缺省视为开）
 * @returns {{action:'created'|'replaced'|'kept'|'marked', from:string|null, to:string, error?:string}}
 */
export function syncRulesVersion (dir, version, { follow = true } = {}) {
  const to = String(version ?? '').trim() || 'unknown'
  const p = agentsMdPath(dir)
  if (!existsSync(p)) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
      writeRulesVersion(dir, to)
      return { action: 'created', from: null, to }
    } catch (e) {
      return { action: 'kept', from: null, to, error: e.message }
    }
  }
  const from = readRulesVersion(dir)
  if (from === to) return { action: 'kept', from, to }
  if (from === null || follow !== true) {           // 第一次遇到 / 开关关着：只记版本，不动内容
    writeRulesVersion(dir, to)
    return { action: from === null ? 'marked' : 'kept', from, to }
  }
  try {
    writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
    writeRulesVersion(dir, to)
    return { action: 'replaced', from, to }
  } catch (e) {
    return { action: 'kept', from, to, error: e.message }
  }
}

/**
 * 把老的 `.whale-craft/AGENTS.md` 迁到新名字（**幂等**，只在需要时动）。
 *
 * 规则（用户 2026-09-16）：
 *   · 新文件不存在、老文件在 → 把老内容写进 `RULES.md`，再把老文件**改名为带时间戳的备份**
 *     （改名而不是删除：内容不丢；而且那个名字只要还在，宿主就还会把它当工作区指令注入）；
 *   · 新文件在、老文件也在 → **以新文件为准**，老的照样备份改名（同样是为了不让宿主认它）；
 *   · 只有老的、内容为空 → 仍然按上面处理（新文件会拿到默认内容，因为 readAgentsMd 对空文件回退默认）。
 * @returns {{migrated:boolean, backup?:string, reason?:string}}
 */
export function migrateLegacyAgentsMd (dir) {
  const legacy = legacyAgentsMdPath(dir)
  const next = agentsMdPath(dir)
  try {
    if (!existsSync(legacy)) return { migrated: false }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${legacy}.bak-${stamp}`
    if (!existsSync(next)) {
      const raw = readFileSync(legacy, 'utf8')
      const text = raw.trim() ? raw : DEFAULT_AGENTS_MD
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(next, text.endsWith('\n') ? text : text + '\n', 'utf8')
    }
    renameSync(legacy, backup)
    return { migrated: true, backup }
  } catch (e) {
    return { migrated: false, reason: e.message }
  }
}

/**
 * 读当前准则。
 *
 * 🔴 2026-09-16 用户纠正："AGENTS.md 本身不在配置中，不在内存中，就是单纯地编辑这个文件。"
 *    所以 **`source` 由内容判定**（与内置默认逐字相同 = 默认），不再由"文件在不在"判定——
 *    插件初始化会把文件建出来（内容就是默认），那时它不该被标成"Master 自定义版"。
 */
export function readAgentsMd (dir) {
  const p = agentsMdPath(dir)
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8')
      const text = raw.trim() ? raw : DEFAULT_AGENTS_MD
      return { text, source: text.trim() === DEFAULT_AGENTS_MD.trim() ? 'default' : 'custom', path: p }
    }
  } catch { /* 读不了就当没有 */ }
  return { text: DEFAULT_AGENTS_MD, source: 'default', path: p }
}

/** 写入自定义准则（Master 在设置页改） */
export function writeAgentsMd (dir, text) {
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('内容不能为空——想恢复默认请用「恢复默认」')
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`内容太大（上限 ${MAX_BYTES / 1024}KB）`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(agentsMdPath(dir), body.endsWith('\n') ? body : body + '\n', 'utf8')
  return { saved: true, path: agentsMdPath(dir), bytes: Buffer.byteLength(body) }
}

/**
 * 恢复默认：把**默认内容写回文件**（不是删文件）。
 * 🔴 2026-09-16 用户纠正："就是单纯地编辑这个文件" —— 删了文件会让「提示词」页变成
 *    "没有文件、由代码兜底"那套本末倒置的状态；文件永远在，才算真的在编辑一个文件。
 */
export function resetAgentsMd (dir) {
  const p = agentsMdPath(dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
  return { reset: true, path: p, source: 'default', defaultBytes: Buffer.byteLength(DEFAULT_AGENTS_MD) }
}

/**
 * 这个路径是不是本文件（给"AI 不许读写"的守卫用）。
 *
 * 认三类写法：
 *   · 新名字：`.whale-craft/RULES.md`（以及在插件包里的 `whale_craft/RULES.md`）；
 *   · **老名字**：`.whale-craft/AGENTS.md` —— 迁移完成前/用户手放的文件也要挡住，
 *     否则 AI 用老名字写一份出来，宿主又把它当工作区指令注入（正是改名要躲开的那件事）；
 *   · 工作区根上的 `AGENTS.md`（那是给 Master 编辑的、属于 DSH 原生的东西，同样不许 AI 动）。
 */
export function isAgentsMdPath (text) {
  // ⚠️ 传进来的通常是工具参数的 JSON 串，Windows 路径里的 `\` 已被转义成 `\\`：
  //    先还原，再判定，否则 `E:\x\.whale-craft\AGENTS.md` 会漏判（真机自检踩过）。
  const s = String(text ?? '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
  // ① `.whale-craft/RULES.md` / `whale_craft/RULES.md`（含老名字 AGENTS.md）
  if (/[/\\]\.?whale[-_]craft[/\\](?:RULES|AGENTS)\.md/i.test(s)) return true
  if (/[/\\]whale_craft[/\\](?:RULES|AGENTS)\.md/i.test(s)) return true
  // ② 裸文件名（记忆工具里的相对路径就是这种）
  return /(^|[/\\"'\s])(?:RULES|AGENTS)\.md(["'\s]|$)/i.test(s)
}
