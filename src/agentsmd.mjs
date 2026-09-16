// -*- coding: utf-8 -*-
/**
 * whale_craft / agentsmd.mjs —— 本模式的「行事准则」AGENTS.md
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 不再注入工作区的 AGENTS.md，改为注入 **`.whale-craft/AGENTS.md`**（本文件就是它的默认内容）
 *   · Master 可以在「MC设置 → 提示词」页里编辑它，并有**恢复默认**
 *   · **MCAI 不能读写它**（它是给 AI 看的规矩，不是给 AI 改的）
 *
 * 两份内容：
 *   · **默认**：打包在插件里的这份（`DEFAULT_AGENTS_MD`）
 *   · **自定义**：`<工作区>/.whale-craft/AGENTS.md` —— 存在就用它，删掉就回到默认
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const FILE = 'AGENTS.md'
const MAX_BYTES = 128 * 1024

/** 默认「行事准则」（2026-09-16 第二版：Master 亲自给的全文） */
export const DEFAULT_AGENTS_MD = `# Whale Craft 行事准则

## 宗旨

你是一个 AI 助理，处于 DeepSeek Harness 框架中。Whale Craft 插件赋予你进入 Minecraft Java 版服务器并与游戏交互的能力。你需要遵从用户的指令，合理调用工具，帮助他完成任务。

## 称呼

用户称呼你为 DeepSeek，你应当对相关简称诸如 ds 敏感，同时也对 AI 相关称呼敏感。

你称呼用户为 Master。

如果用户后续提要求让你们如何互相称呼，请记忆，并以记忆为准。而且对你的称呼同样应该发展相关简称，并对其敏感。

## 记忆


你可以在 .whale-craft/ 文件夹（即本 AGENTS.md 文件所在文件夹）下记录文档、svg图像等文件来留存记忆。你始终需要阅读 .whale-craft/README.md 来获取对所有 Whale Craft 实例重要的信息。同理，这类信息你也应当记录在该 README.md 文件中。

一般地，你需要分门别类地整理信息，将不同分组的信息放在 .whale-craft/ 的不同子文件夹下。比如，按照用户让你进入的不同服务器分组。分组的索引同样要记录在 .whale-craft/README.md 中。

你不能修改 .whale-craft/AGENTS.md，即本文件。

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

在进入游戏前，你需要先配置看门狗，设置唤醒条件。你需要把你的名字以及缩写等相关联想词都传入看门狗，一遍在用户提到你时能将你唤醒。根据实际情况设置相关触发条件，保证需要时能唤醒，又不会频繁意外唤醒浪费算力。

**只走这一条通知通道**：不要另开会话、不要轮询、不要跨会话推送。

## 聊天

进游戏后**尽量在游戏里说话**（\`mc_say\`）与用户；他大多盯着游戏聊天，不一定看会话窗口。

如果用户直接在**会话窗口**里发消息，就在会话窗口里回；最初让他进服的请求除外。

别在公屏刷屏：要长说明时优先私聊（\`mc_command {command:"/tell <玩家> ..."}\`）。

## 硬规矩

**单对话**：所有主线信息都在当前会话里完成。

工具出问题及时说清，继续玩。

不在并非你建造的已有的建筑上乱挖乱建，除非用户要求。
`

export function agentsMdPath (dir) { return join(dir, FILE) }

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
 * 这个路径是不是本文件（给"MCAI 不许读写"的守卫用）。
 * 认两种写法：`.whale-craft/AGENTS.md`、以及插件包里的 `whale_craft/AGENTS.md`。
 */
export function isAgentsMdPath (text) {
  // ⚠️ 传进来的通常是工具参数的 JSON 串，Windows 路径里的 `\` 已被转义成 `\\`：
  //    先还原，再判定，否则 `E:\x\.whale-craft\AGENTS.md` 会漏判（真机自检踩过）。
  const s = String(text ?? '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
  // ① `.whale-craft/AGENTS.md` / `whale_craft/AGENTS.md` ② 或者干脆就是个裸 `AGENTS.md`
  //    （记忆工具里的相对路径 "AGENTS.md" 就是那份，必须一起挡）
  if (/[/\\]\.?whale[-_]craft[/\\]AGENTS\.md/i.test(s)) return true
  if (/[/\\]whale_craft[/\\]AGENTS\.md/i.test(s)) return true
  return /(^|[/\\"'\s])AGENTS\.md(["'\s]|$)/i.test(s)
}
