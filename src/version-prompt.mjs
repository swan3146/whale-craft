// -*- coding: utf-8 -*-
/**
 * whale_craft / version-prompt.mjs —— **版本硬提示词**（随版本发布，用户在界面上改不了）
 * ============================================================================
 * 用户 2026-09-16 定的：
 *   "我们应该加入'版本硬提示词'，是我们硬编码的、随版本发布的提示词，在 `.whale-craft/AGENTS.md`
 *    注入后固定注入。"
 *
 * 它和另外两份东西的分工：
 *   · `.whale-craft/AGENTS.md` —— **Master 维护**的长期规矩（可编辑、可恢复默认）；
 *   · 本条 —— **这个版本**的时效性事实与劝告（工具成熟度、临时取舍），改版本才改它；
 *   · 记忆（`.whale-craft/README.md` 等）—— 玩出来的经验。
 *
 * 规矩（照用户一贯的要求）：
 *   · 走**插件提示行**注入（`agent.inbox.nextStep` + `source:{kind:'plugin',form:'notice'}`），
 *     **不碰系统提示词**；
 *   · 排在 `.whale-craft/AGENTS.md` **之后**、记忆索引之前 —— 读起来就是"对本版本规则的补充"；
 *   · **不加开关**：它是随版本走的常量，用户不需要也不该改；
 *   · 正文里**必须写清优先级**：用户明确要求 > `.whale-craft/AGENTS.md` > 本条版本提示。
 *     否则会和用户的偏好打架（例如他的偏好文件里写着"不要用指令"）。
 * ============================================================================
 */
import { createHash } from 'node:crypto'

/**
 * 生成本版本的硬提示词正文。
 * @param {string} version 插件版本（`package.json` 的 version，例如 `0.1.0`）
 * @returns {string}
 */
export function versionPromptText (version) {
  const v = String(version ?? '').trim() || 'unknown'
  return [
    `本版本（whale_craft v${v}）的工具成熟度与取舍：`,
    '',
    '1. `mc_move`（walk/fly）、`mc_act`、`mc_build` 这些"自己动手"的工具在本版本里**还不成熟**：',
    '   放置/移动容易失败、超时或失步。需要移动、建造、批量改方块时：',
    '   · **若用户没有明确禁止使用服务器指令**，优先用 `mc_command` 发 `/tp`、`/setblock`、`/fill`、`/clone`',
    '     （这些默认就在白名单里）；被白名单或权限拒绝时，再改用 `mc_move` / `mc_act` / `mc_build`，',
    '     或者向用户申请 OP 权限。',
    '   · 按 `.whale-craft/AGENTS.md` 的规矩：**用指令之前先跟用户确认**。',
    '2. **要让用户看到图/文件，走发布区**：出图时把 `out` 写成',
    `   \`.whale-craft/${'.express'}/<子目录>/x.png\`，工具返回值里会带现成的 \`express.markdown\`（\`![](url)\`）——`,
    '   把那一串**原样粘进你的回复**，用户就能在会话里看到图。',
    '   · 只在磁盘上、没放进发布区的文件（默认输出目录 `.whale-craft/.out/`）**用户看不到**；',
    '     工具返回里的 `attachment` 字段只给**模型**看，不会变成用户界面里的图。',
    '   · 游戏公屏/私聊里看不到图，只能说"图发到会话窗口了"。',
    '3. 用户明确说过"不要用指令"之类的偏好时（他可能写在 AGENTS.md 或记忆里），**以他为先**。',
    '4. 优先级从高到低：**用户当前明确的要求 > `.whale-craft/AGENTS.md` > 本条版本提示**。',
  ].join('\n')
}

/** 正文的短哈希（写进折叠标题，便于在日志/界面上分辨"这条提示是哪一版"）。 */
export function versionPromptHash (version) {
  return createHash('sha256').update(versionPromptText(version)).digest('hex').slice(0, 8)
}

/** 折叠标题：`提示词注入：whale_craft v0.1.0 版本提示（a1b2c3d4）` */
export function versionPromptTitle (version) {
  return `提示词注入：whale_craft v${String(version ?? '').trim() || 'unknown'} 版本提示（${versionPromptHash(version)}）`
}

/** 正文首行那行"来源"（照 DSH 原生 `Instructions from: …` 的形状） */
export function versionPromptSource (version) {
  return `whale_craft@${String(version ?? '').trim() || 'unknown'}（内置版本提示，随插件版本更新）`
}
