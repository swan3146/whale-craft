/**
 * whale_craft —— 浏览器半端（client bundle）
 * ============================================================================
 * 会话标题旁的状态条 + **一个**「强制停止」按钮 + 「MC设置」按钮与其模态框。
 *
 * 设计约束：
 *   1. **只在真正进了游戏的那个会话显示**（`/api/mc/status` 说 active 才渲染）；
 *      没连游戏时返回 null，完全不占位、不干扰其他会话。
 *   2. **只有强制停止**（用户 2026-09-16：移除普通停止）。点下去后端按这个顺序做：
 *        ① 先停 LLM（如果正在输出） ② 先尝试优雅退出游戏 ③ 再清空该会话全部后台任务
 *        ④ 最后再停一次 LLM（避免②③期间的事件/注入把会话留在异常状态）
 *   3. 插槽用 `conversation.session.header.actions`（list/session，增量安全），
 *      **不**替换 `conversation.session.header`（single，会 shadow 掉官方 UI）。
 *   4. 「MC设置」入口有**两个，按会话是否 blank 互斥**（任何时刻只有一个）：
 *      · **新会话页** → 插到 hero 行里**模式选择芯片的正右边**
 *        （锚点 `[data-slot="conversation.hero.agentPreset"]`，只在 hero 相位存在）；
 *      · **已有会话** → `conversation.session.header.actions`（order 45，状态条左边）。
 *      两者都**只在 MC 模式**渲染，判据是**本地的**会话 preset（见 useMcSettingsGate）。
 *
 * 🔴 2026-09-16 真机事故（别再犯）：早先为了在新对话页放按钮，用
 *    `MutationObserver(document.body)` + `[data-composer-card]` 往上找"卡片前面的兄弟"，
 *    于是**模型生成时**输入框那片 DOM 一变动，按钮就被插到输入框上方、渲染成**全宽长条**
 *    （位置全靠猜、时有时无，且普通会话也有）。
 *    ⇒ 结论：**锚点必须只在该出现的地方存在**，观察范围**只限作曲器卡片**，且必须**门控**。
 *      （现在唯一一处 DOM 注入就是 `mountHeroChipButton`，它满足这三条：
 *        锚点 `[data-slot="conversation.hero.agentPreset"]` 只在 hero 相位存在、
 *        观察范围限于 `[data-composer-card]`、并且只在"blank + MC 模式"时挂载。）
 *
 * 2026-09-16 改版（用户："UI 被你搞得乱七八糟" → 重构）：
 *   模态框从**一页长滚动**改成**两栏**：左侧竖排标签（账户 / 指令白名单 / 提示词），
 *   右侧**一次只渲染当前那一页**。旧版那一坨账户界面**原样搬进「账户」页**（字段/请求都没改）。
 *
 * 🔴 文案规矩（用户 2026-09-16）：**UI 里只写用户需要的信息**。
 *    不要出现实现细节/AI 味的话——例如"账号密码只保存在你本机的 DSH 凭据库里，AI 看不到"、
 *    "这个开关一拨就生效（即时保存）"、"当前来源：默认版"、凭据库/接口/令牌之类的词。
 *    那一页就叫**「提示词」**，不要叫"行事准则"（"行事准则"只是那份正文自己的标题）。
 *
 * 🔴 凭据边界：密码/token **只进宿主凭据库**。本文件的 password 输入框是**非受控**的，
 *    值从不进 props/state/data-*，也从不 console.log；接口响应里本来就没有密码。
 *
 * 这是手写 factory bundle：无需构建，`exports["./client"]` 直接指向本文件。
 * 改本文件后由 @deepseek-ai/dsh-client-hmr 自动热换，**不需要** pnpm run dev:web。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'whale_craft',
  factory(require) {
    const React = require('react')

    const CSS = `
[data-mc-status]{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 6px 0 10px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;white-space:nowrap;
  box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.12));}
[data-mc-status][data-mc-busy]{opacity:.6;pointer-events:none;}
[data-mc-dot]{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none;}
[data-mc-dot][data-mc-warn]{background:var(--dsw-alias-state-warn-primary);}
[data-mc-text]{color:var(--dsw-alias-label-secondary);}
[data-mc-sub]{color:var(--dsw-alias-label-tertiary);max-width:24ch;overflow:hidden;text-overflow:ellipsis;}
[data-mc-btn]{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 9px;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);font-family:inherit;}
[data-mc-btn]:hover{background:var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary);}
[data-mc-btn][data-mc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-mc-btn][data-mc-danger]:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}

/* ── 「MC设置」按钮：普通次级按钮（**不**照搬状态条药丸外形）──────────────────
   只由 React 插槽渲染（标题条），**没有任何 DOM 注入**。 */
[data-wc-btn]{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  border-radius:8px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  font-family:inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
[data-wc-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-btn]:disabled{opacity:.5;cursor:default;}
[data-wc-btn][data-wc-primary]{border-color:transparent;background:var(--dsw-alias-button-info-fill);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-primary]:hover{background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill));}
[data-wc-btn][data-wc-primary]:disabled{opacity:.5;}
[data-wc-btn][data-wc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-wc-btn][data-wc-danger]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-tiny]{height:24px;padding:0 9px;font-size:11px;}
/* 新会话页那个按钮是插进 hero 行、贴在模式芯片右边的（那一行 gap:2px，这里再给点间距） */
[data-whale-craft-mc-settings]{margin-left:6px;}
[data-slot="conversation.session.header.actions"] [data-wc-btn]:first-child{margin-left:8px;}

/* ── 模态框 ────────────────────────────────────────────────────────────── */
[data-wc-overlay]{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));
  display:flex;align-items:center;justify-content:center;padding:24px;}
/* 🔴 **固定尺寸**（用户 2026-09-16）：切换标签页时卡片不许忽大忽小——
   内容少了就下面留空（内容本身居上），内容多了由右侧内容区自己滚动。 */
[data-wc-card]{position:relative;display:flex;flex-direction:column;width:min(760px,100%);
  height:min(86vh,860px);overflow:hidden;border-radius:24px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));}
[data-wc-head]{display:flex;align-items:center;gap:12px;height:52px;flex:none;padding:0 16px 0 20px;
  border-bottom:1px solid var(--dsw-alias-border-l2,transparent);}
[data-wc-titlewrap]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-wc-title]{font-size:14px;font-weight:600;line-height:1;}
[data-wc-subhead]{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);}
[data-wc-grow]{flex:1;min-width:0;}

/* —— 两栏：左标签页 + 右内容区（一次只渲染一页）—— */
[data-wc-panes]{display:flex;flex:1;min-height:0;}
[data-wc-side]{flex:none;width:132px;padding:12px 8px;overflow:auto;
  border-right:1px solid var(--dsw-alias-border-l2,transparent);
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));
  display:flex;flex-direction:column;gap:2px;}
[data-wc-tab]{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:8px;
  background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);}
[data-wc-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-tab][data-wc-tab-on]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-overlay));
  color:var(--dsw-alias-label-primary);font-weight:600;}
[data-wc-pane]{flex:1;min-width:0;overflow:auto;padding:16px 20px 24px;}

[data-wc-sec]{margin-bottom:22px;}
[data-wc-sec]:last-child{margin-bottom:0;}
[data-wc-h]{margin:0 0 10px;font-size:12px;font-weight:600;line-height:1.4;
  color:var(--dsw-alias-label-secondary);}
[data-wc-note]{margin:0 0 12px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-alert]{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;
  word-break:break-word;background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-ok]{margin:0 0 12px;padding:6px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary);}
[data-wc-dim]{color:var(--dsw-alias-label-tertiary);}

/* ── 账户页：抬头（右上角「添加」）+ 横条 + 类型气泡 ─────────────────────── */
[data-wc-panehead]{display:flex;align-items:center;gap:10px;margin:0 0 12px;}
[data-wc-panehead] [data-wc-h]{margin:0;}
[data-wc-spacer]{flex:1;min-width:0;}
[data-wc-acct]{display:flex;align-items:center;gap:8px;height:44px;padding:0 8px 0 12px;margin-bottom:6px;
  border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));}
[data-wc-acct]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}
[data-wc-acctname]{font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-primary);}
/* 第三方账户的服务器名（小字号灰字；没有名字就显示 url） */
/* 「提示词」页顶部的注入状态（2026-09-16）：一眼看出会不会注入、为什么不会 */
[data-wc-injectstatus]{font-size:12px;line-height:18px;color:var(--dsh-text-2,#9aa0a6);margin:0 0 8px;}
[data-wc-injectstatus] [data-wc-note]{font-size:11px;line-height:16px;color:var(--dsh-text-3,#7a8085);margin-top:2px;}
[data-wc-modes]{display:flex;gap:8px;margin:0 0 8px;}
[data-wc-mode]{flex:1;display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-family:inherit;line-height:1;cursor:pointer;
  transition:background .12s,border-color .12s;}
[data-wc-mode]:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4a8cff);}
[data-wc-mode][data-wc-mode-on]{border-color:transparent;font-weight:600;
  background:var(--dsw-alias-state-business-primary,rgba(74,140,255,.22));}
[data-wc-mode]:disabled{opacity:.5;cursor:default;}
[data-wc-hint] strong{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);}
[data-wc-verprompt]{margin:0 0 10px;font-size:12px;color:var(--dsh-text-2,#9aa0a6);}
[data-wc-verprompt] summary{cursor:pointer;}
[data-wc-verprompt] pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;
  background:var(--dsw-alias-bg-overlay);color:var(--dsh-text-1,#e6e6e6);font:inherit;font-size:11px;line-height:16px;}
[data-wc-acctsub]{font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-tertiary);}
[data-wc-acctacts]{flex:none;display:flex;align-items:center;gap:2px;}
[data-wc-chip]{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 9px;border-radius:999px;
  font-size:11px;line-height:1;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary);}
[data-wc-chip][data-wc-chip-offline]{background:var(--dsw-alias-state-business-primary,rgba(64,128,255,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ygg]{background:var(--dsw-alias-state-success-primary,rgba(0,180,120,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ms]{background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-default]{background:transparent;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));}

/* ── 新建/编辑：类型选择 / 字段 / 已缓存服务器标签 ─────────────────────── */
[data-wc-typelist]{display:flex;flex-direction:column;gap:8px;}
[data-wc-type]{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:12px;text-align:left;
  cursor:pointer;font-family:inherit;border:1px solid transparent;
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-label-primary);}
[data-wc-type]:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);}
[data-wc-type]:disabled{opacity:.5;cursor:not-allowed;}
[data-wc-typename]{font-size:13px;font-weight:600;line-height:18px;}
[data-wc-typedesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-field]{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;}
[data-wc-label]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}
[data-wc-field] [data-wc-in]{width:100%;height:32px;box-sizing:border-box;}
[data-wc-tags]{display:flex;flex-wrap:wrap;gap:6px;}
/* 拽托接受区（authlib-injector 卡片）：**要看得见**——老版有一块虚线区，别偷偷摸摸只挂在输入框上 */
[data-wc-drop]{display:flex;align-items:center;justify-content:center;height:36px;margin-top:6px;
  border-radius:8px;font-size:11px;line-height:16px;text-align:center;
  color:var(--dsw-alias-label-tertiary);
  border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.4)));}
[data-wc-drop][data-wc-drag]{border-color:var(--dsw-alias-state-business-primary);
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));
  color:var(--dsw-alias-label-primary);}
/* 开关放进动作行时不要它自带的下边距 */
[data-wc-acts] [data-wc-switchrow]{margin:0;}
[data-wc-tag]{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 10px;border-radius:999px;
  font-size:12px;line-height:1;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));
  background:transparent;color:var(--dsw-alias-label-secondary);}
[data-wc-tag][data-wc-tag-on]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);}
[data-wc-tagpick]{display:inline-flex;align-items:center;height:24px;padding:0 2px;border:0;background:transparent;
  cursor:pointer;font-family:inherit;font-size:12px;line-height:1;color:inherit;max-width:190px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-tagx]{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-tagx]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-acts]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;}
[data-wc-val]{word-break:break-all;user-select:text;}

/* ── 表单控件 ──────────────────────────────────────────────────────────── */
[data-wc-in]{height:28px;padding:0 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;min-width:0;}
[data-wc-in]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-in]::placeholder{color:var(--dsw-alias-label-tertiary);}
select[data-wc-in]{appearance:none;padding-right:22px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 12px,calc(100% - 9px) 12px;background-size:5px 5px,5px 5px;
  background-repeat:no-repeat;}
[data-wc-w-name]{width:130px;}
[data-wc-w-uuid]{width:250px;}
[data-wc-w-grow]{flex:1;min-width:150px;}
[data-wc-form]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px;}
[data-wc-textarea]{display:block;width:100%;min-height:150px;padding:10px;border-radius:8px;
  font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  resize:vertical;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;}
[data-wc-textarea]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-textarea][data-wc-tall]{min-height:300px;}
/* 「已允许所有指令」时白名单框：仍可编辑，但灰掉表示暂不生效 */
[data-wc-textarea][data-wc-dimmed]{opacity:.45;cursor:not-allowed;}
[data-wc-hint]{margin:8px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
[data-wc-hint][data-wc-dirty]{color:var(--dsw-alias-state-warn-primary,rgba(255,180,0,1));}
[data-wc-code]{padding:0 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-wc-warnnote]{margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
/* ── 开关（用于「允许所有指令」/「注入 AGENTS.md」）───────────────────── */
[data-wc-switchrow]{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;}
[data-wc-switchmain]{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
[data-wc-switchlabel]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}
[data-wc-switchdesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-switch]{flex:none;position:relative;width:34px;height:20px;margin-top:2px;padding:0;
  border:0;border-radius:999px;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.3));transition:background .15s ease;}
[data-wc-switch]:disabled{opacity:.4;cursor:not-allowed;}
[data-wc-knob]{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;
  background:var(--dsw-alias-label-primary-foreground,#fff);transition:left .15s ease;}
[data-wc-switch][data-wc-on]{background:var(--dsw-alias-state-business-primary,#4a8cff);}
[data-wc-switch][data-wc-on] [data-wc-knob]{left:16px;}
`

    /* ==================================================================
     * 模块级事件总线
     * ----------------------------------------------------------------
     * hero 那个「MC设置」按钮是**纯 DOM**（宿主没暴露 react-dom，不能 createPortal），
     * 所以它没法直接 setState —— 它只 emit，由 React 侧的 McSettingsHost 订阅并开关模态框。
     * 总线**不传任何凭据**，只传一个空标记。
     * ================================================================== */
    const settingsBus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
        }
      },
    }
    const openSettings = () => settingsBus.emit()

    /* ==================================================================
     * 接口小工具（契约见 index.js 的 /api/mc/accounts 等路由）
     * ================================================================== */

    /** 统一的错误对象：带上后端的 needUserAction / hint，方便前端提示得具体些 */
    function apiError(payload, status) {
      const e = new Error(payload?.error || payload?.message || `请求失败（HTTP ${status}）`)
      if (payload?.needUserAction) e.needUserAction = true
      if (payload?.hint) e.hint = String(payload.hint)
      return e
    }

    /** 拼一行的调试文本（**只放状态码**，绝不回显请求体 —— 里面有密码） */
    const describe = (e, status) => `${e?.message ?? e}${status ? `（HTTP ${status}）` : ''}`

    async function apiFetch(path, opts) {
      const init = Object.assign({ headers: { accept: 'application/json' } }, opts)
      if (init.body !== undefined && init.body !== null) {
        init.method = init.method || 'POST'
        init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' })
        init.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
      }
      let res
      try {
        res = await fetch(path, init)
      } catch (e) {
        throw new Error(`连不上后端：${e?.message ?? e}`)
      }
      let payload = null
      try { payload = await res.json() } catch (e) { payload = null }
      if (!res.ok || !payload || payload.ok !== true) throw apiError(payload, res.status)
      return payload
    }

    const apiGet = (path) => apiFetch(path, { method: 'GET' })
    const apiPost = (path, body) => apiFetch(path, { method: 'POST', body })
    const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', body })
    const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body })
    const apiDelete = (path, body) => apiFetch(path, { method: 'DELETE', body })

    /** 把错误变成模态框顶部红条里的一行字 */
    const errorText = (e) => {
      if (!e) return ''
      const msg = String(e.message ?? e)
      return e.hint ? `${msg}｜${e.hint}` : msg
    }

    const whitelistToText = (arr) => (Array.isArray(arr) ? arr.join('\n') : '')
    const textToWhitelist = (text) =>
      String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

    /* ==================================================================
     * 现有：状态条（3s 轮询 /api/mc/status）
     * ================================================================== */

    /** 轮询本会话的 MC 状态；不在游戏里就不渲染 */
    function useMcStatus(sessionId) {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const tick = () => {
          fetch('/api/mc/status?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (alive) setState(j) })
            .catch(() => { if (alive) setState(null) })
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      return [state, setState]
    }

    /**
     * 状态条上要显示的**服务器地址**：`host[:port]`（非默认端口才带端口），
     * 有子服时再跟一个 `· 子服域名`（Velocity 的 forced-host）。
     *
     * 🔴 用户 2026-09-16："状态条是不是只显示'在游戏中'？应该显示服务器地址，太长则截断。"
     *    地址由 `/api/mc/status` 的 `connection` 给（只有 host/port/subserver，**没有账号**）。
     * @returns {string} 地址；一个都没有就返回空串（此时状态条只显示"在游戏中"）
     */
    function mcAddress(state) {
      const conn = state?.connection ?? null
      const host = String(conn?.host ?? '').trim()
      const port = Number(conn?.port ?? 0) || 0
      const sub = String(conn?.subserver || state?.sub || '').trim()
      const endPoint = host ? (port && port !== 25565 ? host + ':' + port : host) : ''
      if (endPoint && sub && sub !== host) return endPoint + ' · ' + sub
      return endPoint || sub
    }

    function McStatusBar(props) {
      // session scope 的标准 props；兼容 session 对象形态
      const sessionId = props?.sessionId ?? props?.session?.id
      const [state, setState] = useMcStatus(sessionId)
      const [busy, setBusy] = React.useState(false)

      // 只有一个动作：强制停止（用户 2026-09-16："移除停止，只剩强行停止"）。
      // 后端顺序：停 LLM → 优雅退游戏 → 清该会话后台任务 → 再停一次 LLM。
      const stop = React.useCallback(() => {
        if (!sessionId) return
        setBusy(true)
        fetch('/api/mc/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, reason: '用户强制停止' }),
        })
          .catch(() => {})
          .finally(() => { setBusy(false) })
      }, [sessionId])

      // 不在游戏里 → 不占位
      if (!sessionId || !state || state.active !== true) return null

      const online = state.online === true
      const address = mcAddress(state)
      // 太长就截断（完整地址留在 tooltip 里）
      const shown = address.length > 26 ? address.slice(0, 25) + '…' : address
      const timeouts = Number(state.timeouts ?? 0)
      const stale = timeouts > 0

      return React.createElement(
        'div',
        {
          'data-mc-status': '',
          ...(busy ? { 'data-mc-busy': '' } : {}),
          title: online
            ? `${address ? address + '：' : ''}在游戏中${stale ? `（有 ${timeouts} 次操作超时，可能已失步）` : ''}`
            : (address ? `已连接 ${address} 但角色不在线` : '已连接但角色不在线'),
        },
        React.createElement('span', { 'data-mc-dot': '', ...(online && !stale ? {} : { 'data-mc-warn': '' }) }),
        React.createElement('span', { 'data-mc-text': '' }, online ? '在游戏中' : '未上线'),
        address ? React.createElement('span', { 'data-mc-sub': '', title: address }, shown) : null,
        React.createElement('button', {
          type: 'button', 'data-mc-btn': '', 'data-mc-danger': '',
          title: '强制停止：中断当前生成并让机器人退出游戏',
          onClick: () => stop(),
        }, '强制停止'),
      )
    }

    /* ==================================================================
     * 标题条上的「MC设置」按钮 + 模态框（同一个插槽条目）
     * ----------------------------------------------------------------
     * order 45 → 排在状态条（50）左边；官方预设标签是 -10，所以最终是
     *   预设标签 → MC设置 → 状态条
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹；组件返回
     * Fragment（按钮 + 关闭时为 null 的遮罩），关闭状态下 DOM 里只剩按钮。
     *
     * 🔴 **判据必须是本地就有的**：读会话记录的 agent preset
     *    （`props.useSessions` 快照里的 `projectionValues.agentPreset`）——
     *    这正是标题条那个官方「MC模式」标签用的**同一个源**，所以"用户看到什么模式，
     *    按钮就按什么模式显示"，且**不受任何网络请求成败影响**。
     *
     * 🔴 2026-09-16 事故（别再犯）：第一版改成 `fetch('/api/mc/mode')` 问服务端。
     *    浏览器在**新接口上线之前**就通过 HMR 拿到了新客户端 → 那次请求 404 →
     *    组件把它当成"不是 MC 模式"，而且**只问一次、再不重试** ⇒ 重启之后
     *    MC 模式里也永远没有按钮（非得刷新页面）。**门控不许依赖一次性网络请求。**
     *
     * 名单（哪些 preset 算 MC 模式）取服务端 **`/api/mc/presets`**（专门给门控用的极小接口，
     * 不需要 sessionId / 工作区 —— `/api/mc/config` 现在要工作区，用它会被拒而静默退回兜底名单）；
     * 没回来之前先用插件默认值 `['minecraft','whale_craft']`（与后端默认一致）。
     * 服务端 `/api/mc/mode` 仍保留，供排查与测试用，前端不再依赖它。
     * ================================================================== */
    const MC_PRESETS_FALLBACK = ['minecraft', 'whale_craft']
    let mcPresetIds = MC_PRESETS_FALLBACK.slice()
    let mcPresetIdsAsked = false

    function loadMcPresetIds() {
      if (mcPresetIdsAsked) return
      mcPresetIdsAsked = true
      try {
        fetch('/api/mc/presets', { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const list = Array.isArray(j?.mcModePresets) ? j.mcModePresets.map(String).filter(Boolean) : []
            if (list.length) mcPresetIds = list
            else mcPresetIdsAsked = false
          })
          .catch(() => { mcPresetIdsAsked = false })   // 失败允许下次挂载再试
      } catch { mcPresetIdsAsked = false }
    }

    /**
     * 「MC设置」入口的**共用门控**。
     *
     * 判据完全本地：会话记录的 agent preset（`props.useSessions` 快照里的
     * `projectionValues.agentPreset`）——这正是标题条那个官方「MC模式」标签用的**同一个源**，
     * 所以"用户看到什么模式，入口就按什么模式出现"，且不受网络请求成败影响。
     *
     * @param props 插槽 props（宿主会给 session scope 注入 `sessionId` / `useSessions`）
     * @param wantBlank true = 只认**新会话页**（会话还是 blank），false = 只认已有会话
     * @returns 是否渲染入口
     */
    function useMcSettingsGate(props, wantBlank) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const [serverMode, setServerMode] = React.useState(null)

      React.useEffect(() => { loadMcPresetIds() }, [])

      // ⚠️ useSessions 是宿主注入的标准 prop（官方标签也用它），组件生命周期内恒定存在，
      //    所以这两个条件调用不会改变 hook 数量。选择器只返回**原始值**，避免每次渲染造新对象。
      const sess = typeof useSessions === 'function' ? useSessions : null
      const blank = sess
        ? sess((state) => {
          const s = state?.byId?.[sessionId]
          return s === undefined ? undefined : s.blank === true
        })
        : undefined
      const preset = sess
        ? sess((state) => {
          const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' ? value : undefined
        })
        : undefined

      const known = blank !== undefined && preset !== undefined

      // 兜底：**只有本地判不了**（拿不到会话数据）时，且只让标题条那个入口去问服务端，
      // 而且**必须重试**——一次性请求失败 = 入口永久消失，这个坑 2026-09-16 刚踩过。
      const needServer = !known && !wantBlank
      React.useEffect(() => {
        if (!needServer || !sessionId) return undefined
        let alive = true
        let tries = 0
        let timer = null
        const tick = () => {
          fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!alive) return
              if (j?.mcMode === true) setServerMode(true)
              else if (++tries < 20) timer = setTimeout(tick, 3000)
            })
            .catch(() => { if (alive && ++tries < 20) timer = setTimeout(tick, 3000) })
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [needServer, sessionId])

      const localShow = known && blank === wantBlank && mcPresetIds.includes(preset)

      /**
       * 🔴 2026-09-16 用户："没有选中工作区，则拒绝发起 MC 模式会话和设置。"
       * 服务端 `/api/mc/mode` 对"MC 模式但没工作区"会明确回 `{mcMode:false, diag:{reason:'no-workspace'}}`
       * —— 这时**本地 preset 再像 MC 模式也不显示入口**。
       * ⚠️ 只有"服务端**明确因为没工作区**而拒绝"才隐藏：请求失败、或别的 false 一律维持本地判断
       *    （一次性请求失败 = 入口永久消失，这个坑 2026-09-16 刚踩过）。
       */
      const [deniedNoWorkspace, setDeniedNoWorkspace] = React.useState(false)
      React.useEffect(() => {
        if (!localShow || !sessionId) { setDeniedNoWorkspace(false); return undefined }
        let alive = true
        fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (alive) setDeniedNoWorkspace(j?.mcMode === false && j?.diag?.reason === 'no-workspace') })
          .catch(() => { if (alive) setDeniedNoWorkspace(false) })
        return () => { alive = false }
      }, [localShow, sessionId])

      if (localShow) return !deniedNoWorkspace
      if (known) return false
      return !wantBlank && serverMode === true
    }

    /**
     * 当前会话（或新对话页那个 blank 会话）**选中的工作区**。
     * 🔴 2026-09-16：新对话页还没开聊时，会话在服务端可能还没落盘 ——
     *    但**工作区是已经选好了的**，所以把它一起报给服务端（`cwd` 兜底参数），
     *    免得"明明选了工作区却被拒绝"。服务端只认绝对路径且必须真实存在的目录。
     */
    function useWorkspaceCwd(props) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const sess = typeof useSessions === 'function' ? useSessions : null
      return sess && sessionId
        ? sess((state) => {
          const v = state?.byId?.[sessionId]?.cwd
          return typeof v === 'string' && v ? v : undefined
        })
        : undefined
    }

    /**
     * 标题条上的「MC设置」按钮（order 45，落在状态条左边）。
     * 只在**已有会话**里出现；新会话页那个是下面 `McSettingsDockEntry`。
     *
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹。
     *
     * 🔴 两个入口靠 `blank` **互斥**，所以任何时刻只挂一个模态框。
     *    （模态框之间靠 `settingsBus` 广播打开——两个同时挂着会一起弹出来。）
     * ================================================================== */
    function McSettingsEntry(props) {
      const show = useMcSettingsGate(props, false)
      const wsCwd = useWorkspaceCwd(props)
      if (!show) return null

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          'data-wc-mc-settings': '',
          title: 'MC设置：账户、提示词与指令白名单',
          onClick: openSettings,
        }, 'MC设置'),
        React.createElement(McSettingsModal, { ...props, wsCwd }),
      )
    }

    /* ==================================================================
     * 「MC设置」入口②：**新会话页**，贴在**模式选择芯片的正右边**
     * ----------------------------------------------------------------
     * 为什么这里必须碰 DOM：新会话页那一行是宿主**写死的**标记
     * （`ConversationRoot.tsx` 的 `heroWorkspaceRow` = 官方 WorkspaceChip + 两个
     * **single/root** 插槽 `conversation.hero.workspace` / `.agentPreset`），
     * **没有任何 list 插槽**能塞进那一行；注册 single 槽会把官方模式芯片顶掉。
     * 所以只剩一条路：把按钮插到宿主给模式芯片的壳 `[data-slot="conversation.hero.agentPreset"]` 后面
     * （那个壳是宿主自己承诺的稳定锚点：`ui-renderer/.../scoped-slots.tsx` 里
     *   "every slot render site exposes a stable `[data-slot="<key>"]` wrapper"，
     *   且它是 `display:contents`，所以插进去就是那一行 flex 的下一个子项 = 芯片右边）。
     *
     * 🔴 与 2026-09-16 那个"生成时输入框上方冒出全宽长条"的老 bug 的本质区别：
     *    · **锚点只在新会话页存在**——hero 行只在 hero 相位渲染（`{hero && heroWorkspaceRow}`），
     *      普通对话里**根本插不进去**（老代码是从 `[data-composer-card]` 往上找兄弟，找错了行）；
     *    · **门控**：只有"会话 blank + preset ∈ mcModePresets"时这个 React 组件才挂载（见 useMcSettingsGate）；
     *    · **观察范围只在作曲器卡片内**，不是 `document.body`，而且随组件卸载一起消失；
     *    · 组件卸载立刻把按钮摘掉。
     * ================================================================== */
    const HERO_CHIP_ANCHOR = '[data-slot="conversation.hero.agentPreset"]'
    const HERO_BTN_ATTR = 'data-whale-craft-mc-settings'

    /**
     * 把「MC设置」按钮插到 hero 行里模式芯片的右边。
     * @param onClick 点击回调（只 emit 一个空标记，DOM 里不放任何账户/凭据信息）
     * @returns 撤销函数：断开观察者并摘掉按钮
     */
    function mountHeroChipButton(onClick) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute(HERO_BTN_ATTR, '')
      btn.setAttribute('data-wc-btn', '')
      btn.setAttribute('data-wc-tiny', '')
      btn.title = 'MC设置：账户、提示词与指令白名单'
      btn.textContent = 'MC设置'
      btn.addEventListener('click', onClick)

      /** 幂等放置：已经在锚点后面就什么都不做（否则会自己触发自己） */
      const place = () => {
        const anchor = document.querySelector(HERO_CHIP_ANCHOR)
        const row = anchor === null ? null : anchor.parentElement
        if (anchor === null || row === null) return
        if (btn.parentElement === row && btn.previousElementSibling === anchor) return
        anchor.insertAdjacentElement('afterend', btn)
      }

      place()

      // React 重渲染可能把注入的节点冲掉 → 补回。观察目标**只限作曲器卡片**，
      // 且锚点不存在（普通对话）时这里什么也不会发生。
      let observed = null
      let queued = false
      const card = () => document.querySelector('[data-composer-card]')
      const track = () => {
        const target = card()
        if (target === null || target === observed) return
        observer.disconnect()
        observer.observe(target, { childList: true, subtree: true })
        observed = target
      }
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        Promise.resolve().then(() => { queued = false; place(); track() })
      })
      track()
      // 卡片可能比本组件晚挂上（React 提交顺序不保证）→ 补一次
      const retry = setTimeout(() => { place(); track() }, 300)

      return () => {
        clearTimeout(retry)
        observer.disconnect()
        btn.remove()
      }
    }

    /**
     * **新会话页**的「MC设置」驱动组件。
     *
     * 它自己**不渲染任何可见元素**（`return null` / 只挂模态框）：按钮由
     * `mountHeroChipButton` 插到模式芯片右边——也就是用户要的"模式选择右边"。
     * 挂在 `conversation.input.right` 上只是为了拿一个**可靠的挂载时机**
     * （hero 与 composer 都会渲染它；配合 `blank` 门控 ⇒ 只在新会话页挂载）。
     * ⚠️ 它**只**在会话还是 `blank`（还没发过消息）时存在；一旦开聊，入口交给标题条那个。
     */
    function McSettingsDockEntry(props) {
      const show = useMcSettingsGate(props, true)
      const wsCwd = useWorkspaceCwd(props)

      React.useEffect(() => {
        if (!show) return undefined
        return mountHeroChipButton(openSettings)
      }, [show])

      if (!show) return null
      return React.createElement(McSettingsModal, { ...props, wsCwd })
    }

    /* ==================================================================
     * 历史残留清理（只为清掉老 bundle 留在页面上的按钮）
     * ----------------------------------------------------------------
     * 2026-09-16 那个把按钮插到"输入框上方全宽长条"的旧实现可能还在页面里留了节点
     * （改代码当天 HMR 换过好几版）。这里在 apply 时一次性把 `[data-whale-craft-mc-settings]`
     * 全摘掉；新实现自己会按需把按钮插回**正确的位置**（模式芯片右边）。
     * ================================================================== */
    function purgeLegacyInjectedButtons() {
      try {
        for (const el of document.querySelectorAll('[data-whale-craft-mc-settings]')) el.remove()
      } catch (e) { /* 清理失败无所谓，不影响任何功能 */ }
    }

    /* ==================================================================
     * MC设置模态框（两栏：左标签页 + 右内容区）
     * ================================================================== */

    /** 简写：这一段组件比较多，用 h 比 React.createElement 好读 */
    const h = React.createElement

    /**
     * 开关。受控：`on` = 当前值，`onToggle(next)` 由调用方决定发不发请求。
     * `disabled` 时按钮真的禁用（例如工作区没有 AGENTS.md 时）。
     */
    function Switch(props) {
      return React.createElement(
        'div',
        { 'data-wc-switchrow': '' },
        React.createElement(
          'div',
          { 'data-wc-switchmain': '' },
          React.createElement('span', { 'data-wc-switchlabel': '' }, props.label),
          props.desc ? React.createElement('span', { 'data-wc-switchdesc': '' }, props.desc) : null,
        ),
        React.createElement('button', {
          type: 'button',
          'data-wc-switch': '',
          ...(props.on ? { 'data-wc-on': '' } : {}),
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          disabled: props.disabled === true,
          title: props.title || props.label,
          onClick: () => { if (!props.disabled) props.onToggle(!props.on) },
        }, React.createElement('span', { 'data-wc-knob': '' })),
      )
    }

    /** 账号类型（气泡文案 + 配色） */
    const ACCT_TYPE = {
      offline: { label: '离线', chip: 'data-wc-chip-offline' },
      yggdrasil: { label: '第三方', chip: 'data-wc-chip-ygg' },
      microsoft: { label: '微软', chip: 'data-wc-chip-ms' },
    }

    /** 类型气泡 */
    function TypeChip(props) {
      const t = ACCT_TYPE[props.type] ?? { label: props.type || '?', chip: 'data-wc-chip' }
      return h('span', { 'data-wc-chip': '', [t.chip]: '' }, t.label)
    }

    /**
     * 账户**横条**：只有「类型气泡 + 名字」+ 右侧两个动作。
     * 细节（UUID / 服务器 / login / innerID）**都不在这里显示** —— 离线点「编辑」进去看。
     * 离线 = 编辑；其余（第三方 / 微软）= 刷新（用户 2026-09-16 定）。
     */
    function AccountRow(props) {
      const { account: acc, busyKey } = props
      const [pendingDelete, setPendingDelete] = React.useState(false)
      const rowBusy = typeof busyKey === 'string' && busyKey.startsWith('row:' + acc.innerID + ':')
      const offline = acc.type === 'offline'
      // 第三方的小灰字 = **「输入的账号（服务器名）」**。
      // 🔴 用户 2026-09-16：主文本是**游戏 ID**（第三方登录成功后回写的档案名），
      //    它跟你输入的账号通常不是一回事（输入的是邮箱，游戏里叫角色名）→ 两个都得看得见。
      //    两者相同时（登录名本身就是角色名）不重复写，只留服务器名。
      //    服务器名没了就退化成 url；都没有就只剩账号。
      const srvLabel = acc.server?.name || acc.server?.url || ''
      const login = String(acc.login ?? '').trim()
      const sub = offline ? '' : (login && login !== acc.name
        ? (srvLabel ? `${login}（${srvLabel}）` : login)
        : srvLabel)

      return h('div', { 'data-wc-acct': '', 'data-wc-account': acc.innerID },
        h(TypeChip, { type: acc.type }),
        h('span', { 'data-wc-acctname': '', title: acc.name }, acc.name || '(无名)'),
        sub ? h('span', { 'data-wc-acctsub': '', title: acc.server?.url || sub }, sub) : null,
        acc.default ? h('span', { 'data-wc-chip': '', 'data-wc-chip-default': '' }, '默认') : null,
        h('span', { 'data-wc-spacer': '' }),
        h('div', { 'data-wc-acctacts': '' },
          offline
            ? h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
              onClick: () => props.onEdit(acc),
            }, '编辑')
            : h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
              title: '刷新登录状态',
              onClick: () => props.onRefresh(acc),
            }, '刷新'),
          pendingDelete
            ? [
              h('button', {
                key: 'yes', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                disabled: rowBusy, onClick: () => props.onDelete(acc),
              }, '确认删除'),
              h('button', {
                key: 'no', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
                onClick: () => setPendingDelete(false),
              }, '取消'),
            ]
            : h('button', {
              key: 'del', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
              disabled: rowBusy, onClick: () => setPendingDelete(true),
            }, '删除'),
        ),
      )
    }

    /** 表单里的一行（标签 + 控件） */
    function Field(props) {
      return h('div', { 'data-wc-field': '' },
        props.label ? h('span', { 'data-wc-label': '' }, props.label) : null,
        props.children,
      )
    }

    /** 新建账户第一步：选类型（三种账户 = 三个独立界面） */
    function TypePicker(props) {
      const types = [
        { k: 'new-offline', name: '离线账户', desc: '不需要密码，名字就是身份' },
        { k: 'new-yggdrasil', name: '第三方账户', desc: '皮肤站等外置登录' },
        { k: 'microsoft', name: '微软账户', desc: '未实现', off: true },
      ]
      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, '新建账户'),
        ),
        h('div', { 'data-wc-typelist': '' },
          types.map((t) => h('button', {
            key: t.k, type: 'button', 'data-wc-type': '',
            disabled: t.off === true,
            title: t.off === true ? '未实现' : undefined,
            onClick: () => { if (t.off !== true) props.onPick(t.k) },
          },
          h('span', { 'data-wc-typename': '' }, t.name),
          h('span', { 'data-wc-typedesc': '' }, t.desc))),
        ),
      )
    }

    /** 新建 / 编辑**离线**账户（同一个界面，mode 区分；UUID 这类细节在这里看） */
    function OfflineForm(props) {
      const { busyKey, mode = 'new', account } = props
      const editing = mode === 'edit'
      const [name, setName] = React.useState(editing ? (account?.name ?? '') : 'DeepSeek')
      // 只有在"自定义过 UUID"时才把值填出来；派生值不填（填了就等于把它钉成自定义）
      const [uuid, setUuid] = React.useState(editing && account?.uuidSource === 'custom' ? (account.uuid ?? '') : '')
      const [asDefault, setAsDefault] = React.useState(editing ? account?.default === true : false)
      const key = editing ? 'row:' + account.innerID + ':save' : 'new:offline'
      const busy = busyKey === key

      const submit = () => {
        const n = name.trim()
        if (!n) return
        if (editing) {
          props.onPatch(account.innerID, {
            name: n, uuid: uuid.trim() || null, ...(asDefault ? { default: true } : {}),
          }, key).then((ok) => { if (ok) props.onDone() })
        } else {
          props.onCreate({
            type: 'offline', name: n, uuid: uuid.trim() || undefined, default: asDefault,
          }, key).then((ok) => { if (ok) props.onDone() })
        }
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, editing ? '编辑离线账户' : '新建离线账户'),
        ),
        h(Field, { label: '游戏内名字' },
          h('input', {
            'data-wc-in': '', value: name, disabled: busy, autoFocus: true,
            onChange: (e) => setName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h(Field, { label: 'UUID（可留空，留空按名字派生）' },
          h('input', {
            'data-wc-in': '', value: uuid, disabled: busy, spellCheck: false,
            placeholder: editing ? (account?.uuid ?? '') : '',
            onChange: (e) => setUuid(e.target.value),
          })),
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '', disabled: busy || !name.trim(),
            onClick: submit,
          }, busy ? '保存中…' : (editing ? '保存' : '创建')),
        ),
      )
    }

    /**
     * 新建**第三方**账户（皮肤站）：**先填认证服务器，再填账号密码**。
     * 服务器那一块上面是**已缓存的**标签：点一下自动填进输入框，× 从缓存里删掉
     * （LittleSkin 也只是预置的缓存项，一样能删）。
     * 输入框下面有一块**看得见的虚线拽托区**：把 authlib-injector 卡片拖进来即可。
     * 手打一个新地址也行——建账户时后端会顺手把它记住。
     *
     * 🔴 2026-09-16 用户纠正：这里要问的是**认证服务器的名字**（缓存标签里显示它，才看得懂），
     *    **不是**"游戏内名字"——角色名是认证服返回的档案名，问用户填毫无意义（登录后被覆盖）。
     */
    function YggdrasilForm(props) {
      const { servers = [], busyKey } = props
      const [picked, setPicked] = React.useState(null)
      const [url, setUrl] = React.useState('')
      const [srvName, setSrvName] = React.useState('')
      const [login, setLogin] = React.useState('')
      const [asDefault, setAsDefault] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      // 🔴 密码**不进 state**：非受控 input + ref，提交时读一次就丢；也不进任何 data-*
      const passRef = React.useRef(null)
      const busy = busyKey === 'new:yggdrasil'
      const pickedSrv = picked === null ? null : (servers.find((s) => s.id === picked) ?? null)

      /** 拖入 authlib-injector 卡片：交给后端解析、加进缓存，然后自动选中并填进输入框 */
      const onDropCard = (e) => {
        e.preventDefault()
        setDragging(false)
        const dt = e.dataTransfer
        const card = dt ? (dt.getData('text') || dt.getData('text/plain') || '') : ''
        if (!card.trim()) return
        Promise.resolve(props.onAddCard(card)).then((srv) => {
          if (srv?.url) { setUrl(srv.url); setPicked(srv.id ?? null); setSrvName(srv.name || '') }
        })
      }

      const submit = () => {
        const u = url.trim()
        const p = passRef.current ? passRef.current.value : ''
        if (!u || !login.trim() || !p) return
        const nm = srvName.trim()
        // 账户显示名：先按账号名兜一个（登录/刷新成功后会被档案名覆盖）
        const fallback = login.trim().split('@')[0].replace(/[^\w\u4e00-\u9fa5.]/g, '').slice(0, 32) || 'MC'
        props.onCreate({
          type: 'yggdrasil',
          name: fallback,
          login: login.trim(),
          password: p,
          default: asDefault,
          // 选中的就是缓存里那条 → 用 serverId（改了名字才带上 serverName，让后端改名）
          ...(pickedSrv && pickedSrv.url === u
            ? { serverId: pickedSrv.id, ...(nm && nm !== pickedSrv.name ? { serverName: nm } : {}) }
            : { serverUrl: u, ...(nm ? { serverName: nm } : {}) }),
        }, 'new:yggdrasil').then((ok) => { if (ok) props.onDone() })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, '新建第三方账户'),
        ),
        h(Field, { label: '认证服务器' },
          servers.length
            ? h('div', { 'data-wc-tags': '' }, servers.map((s) => h('span', {
              key: s.id, 'data-wc-tag': '', ...(pickedSrv?.id === s.id ? { 'data-wc-tag-on': '' } : {}),
            },
            h('button', {
              type: 'button', 'data-wc-tagpick': '', title: s.url || s.name,
              onClick: () => { setPicked(s.id); setUrl(s.url); setSrvName(s.name || '') },
            }, s.name || s.url),
            h('button', {
              type: 'button', 'data-wc-tagx': '', title: '从缓存里删掉',
              disabled: busyKey === 'server:' + s.id,
              onClick: () => props.onRemoveServer(s),
            }, '×'))))
            : null,
          h('input', {
            'data-wc-in': '', value: url, disabled: busy, spellCheck: false,
            placeholder: 'https://example.com/api/yggdrasil',
            onChange: (e) => { setUrl(e.target.value); setPicked(null) },
            onDragOver: (e) => e.preventDefault(),
            onDrop: onDropCard,
          }),
          // 拽托接受区：老版有，别删（用户 2026-09-16 反馈"怎么没了"）
          h('div', {
            'data-wc-drop': '', ...(dragging ? { 'data-wc-drag': '' } : {}),
            onDragOver: (e) => { e.preventDefault(); if (!dragging) setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: onDropCard,
          }, busyKey === 'server:card' ? '正在解析卡片…' : '把 authlib-injector 卡片拖到这里')),
        // 服务器的**名字**紧随服务器那一栏：留空就用域名；填了它，缓存标签里才看得懂
        // （2026-09-16 用户纠正：这里**不是**"游戏内名字"——角色名由认证服返回，不用问用户）
        h(Field, { label: '服务器名字（留空就用域名）' },
          h('input', {
            'data-wc-in': '', value: srvName, disabled: busy, placeholder: '例如：LittleSkin',
            onChange: (e) => setSrvName(e.target.value),
          })),
        h(Field, { label: '账号（邮箱）' },
          h('input', {
            'data-wc-in': '', value: login, disabled: busy, autoComplete: 'off',
            onChange: (e) => setLogin(e.target.value),
          })),
        h(Field, { label: '密码' },
          h('input', {
            'data-wc-in': '', type: 'password', ref: passRef, disabled: busy, autoComplete: 'off',
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '',
            disabled: busy || !url.trim() || !login.trim(),
            onClick: submit,
          }, busy ? '创建中…' : '创建'),
        ),
      )
    }

    /**
     * 页 1：账户。**列表 + 三个独立的新建/编辑界面**：
     *   · 列表 = 横条（类型气泡 + 名字）+ 右侧「编辑/刷新」「删除」；不显示任何细节、不显示 innerID
     *   · 「添加」在右上角 → 先选类型 → 进对应界面
     *   · 离线能进「编辑」（UUID 等细节在那里看）；第三方只有「刷新」
     */
    function AccountsPane(props) {
      const { accounts = [], servers = [], busyKey } = props
      const [view, setView] = React.useState('list')
      const [editing, setEditing] = React.useState(null)
      const back = () => { setEditing(null); setView('list') }

      if (view === 'pick') return h(TypePicker, { onBack: back, onPick: (k) => setView(k) })
      if (view === 'new-offline' || view === 'edit-offline') {
        return h(OfflineForm, {
          mode: view === 'edit-offline' ? 'edit' : 'new', account: editing, busyKey,
          onBack: back, onDone: back, onPatch: props.onPatch, onCreate: props.onCreate,
        })
      }
      if (view === 'new-yggdrasil') {
        return h(YggdrasilForm, {
          servers, busyKey, onBack: back, onDone: back, onCreate: props.onCreate,
          onRemoveServer: props.onRemoveServer, onAddCard: props.onAddCard,
        })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('div', { 'data-wc-h': '' }, `账户（${accounts.length}）`),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
            onClick: () => setView('pick'),
          }, '＋ 添加'),
        ),
        accounts.length
          ? accounts.map((a) => h(AccountRow, {
            key: a.innerID, account: a, busyKey,
            onEdit: (acc) => { setEditing(acc); setView('edit-offline') },
            onRefresh: props.onRefresh, onDelete: props.onDelete,
          }))
          : h('div', { 'data-wc-dim': '' }, '还没有账户，点右上角「添加」。'),
      )
    }

    /* ---------------------------------------------------------- 页 2：指令白名单 */

    function WhitelistPane(props) {
      const { wlText, allowAll, busyKey, onWlText, onAllowAll, onSave } = props
      const busy = busyKey !== null
      const saveBusy = busyKey === 'wl:save'
      // 开关**一拨就存**（用户 2026-09-16 定）；下面那份白名单仍然要点「保存」
      const allowBusy = busyKey === 'cfg:allowAll'

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'whitelist' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement(Switch, {
            label: '允许所有指令',
            disabled: allowBusy,
            on: allowAll === true,
            onToggle: (next) => onAllowAll(next),
          }),
          React.createElement('div', { 'data-wc-h': '' }, '指令白名单（一行一条）'),
          allowAll
            ? React.createElement('div', { 'data-wc-warnnote': '' }, '已允许所有指令，白名单不再生效。')
            : null,
          React.createElement('textarea', {
            'data-wc-textarea': '',
            ...(allowAll ? { 'data-wc-dimmed': '', readOnly: true } : {}),
            value: wlText,
            spellCheck: false,
            disabled: busy && !allowAll,
            placeholder: 'tp\ngive\n/^gi.+/',
            title: allowAll ? '已允许所有指令，白名单暂不生效（关掉上面的开关才能编辑）' : '一行一条',
            onChange: (e) => { if (!allowAll) onWlText(e.target.value) },
          }),
          React.createElement(
            'p',
            { 'data-wc-hint': '' },
            '精确名 ', React.createElement('code', { 'data-wc-code': '' }, 'tp'),
            ' · 正则 ', React.createElement('code', { 'data-wc-code': '' }, '/^gi.+/'),
            ' · ', React.createElement('code', { 'data-wc-code': '' }, '*'),
            ' 全部放行',
          ),
          React.createElement(
            'div',
            { 'data-wc-acts': '' },
            React.createElement('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
              disabled: busy, onClick: onSave,
            }, saveBusy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ 页 3：提示词 */

    function PromptPane(props) {
      const {
        mdText, wsExists, injectStatus,
        injectWc, injectWs, busyKey, onMdText, onSave, onReset, onInjectWc, onInjectWs,
        followVersion, rulesVersion, pluginVersion, onFollowVersion,
      } = props
      const busy = busyKey !== null
      const [confirmReset, setConfirmReset] = React.useState(false)
      const saveBusy = busyKey === 'md:save'
      const resetBusy = busyKey === 'md:reset'
      const followBusy = busyKey === 'cfg:follow'
      const seg = injectStatus?.segments ?? {}
      const mark = (on) => (on ? '✓' : '✗')

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'prompt' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '提示词'),
          // 🔴 把"到底会不会注入"直接摆给用户看（2026-09-16：真机上反复出现"没注入"，
          //    原因可能有一堆 —— 不是 MC 模式 / 开关关了 / 文件不在 —— 与其让人猜，不如显示判据）
          injectStatus
            ? React.createElement('div', { 'data-wc-injectstatus': '' },
              `本会话注入：MC模式 ${mark(injectStatus.mcMode)} ｜ 本提示词 ${mark(seg['agents-md'])} ｜ 工作区 AGENTS.md ${mark(seg['workspace-agents-md'])}`,
              injectStatus.notes?.length
                ? React.createElement('div', { 'data-wc-note': '' }, injectStatus.notes.join(' ｜ '))
                : null,
            )
            : null,
          React.createElement('textarea', {
            'data-wc-textarea': '', 'data-wc-tall': '', value: mdText, spellCheck: false,
            disabled: busy,
            onChange: (e) => onMdText(e.target.value),
          }),
          React.createElement(
            'div',
            { 'data-wc-acts': '' },
            React.createElement('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
              disabled: busy, onClick: onSave,
            }, saveBusy ? '保存中…' : '保存'),
            confirmReset
              ? React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                title: '再点一次确认',
                onClick: () => { setConfirmReset(false); onReset() },
              }, resetBusy ? '恢复中…' : '确认恢复')
              : React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                title: '恢复默认提示词',
                onClick: () => setConfirmReset(true),
              }, '恢复默认'),
            confirmReset
              ? React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                onClick: () => setConfirmReset(false),
              }, '取消')
              : null,
          ),
        ),
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '注入'),
          // 版本硬提示词：随插件版本发布、不可编辑，但用户有权知道它说了什么
          injectStatus?.versionPrompt
            ? React.createElement('details', { 'data-wc-verprompt': '' },
              React.createElement('summary', {},
                `本版本内置提示（随插件版本更新，不可编辑）：whale_craft v${injectStatus.versionPrompt.version}`),
              React.createElement('pre', {}, String(injectStatus.versionPrompt.text ?? '')))
            : null,
          // 「随版本更新」（默认开）：插件升级时用新版本默认准则替换当前这份（会覆盖你的修改）
          React.createElement(Switch, {
            label: '随版本更新',
            desc: followBusy ? '保存中…' : '插件升级时，用新版本的默认提示词替换当前内容（会覆盖你的修改）',
            disabled: busy,
            on: followVersion === true,
            onToggle: (next) => onFollowVersion(next),
          }),
          React.createElement('p', { 'data-wc-hint': '' },
            `当前内容对应：${rulesVersion ? `v${rulesVersion}` : '未知（还没同步过）'}`,
            `　·　本插件：v${pluginVersion || '?'}`),
          React.createElement(Switch, {
            label: '注入本提示词',
            on: injectWc === true,
            onToggle: (next) => onInjectWc(next),
          }),
          React.createElement(Switch, {
            label: '注入工作区 AGENTS.md',
            desc: wsExists ? undefined : '工作区里没有这个文件',
            disabled: !wsExists,
            on: injectWs === true,
            onToggle: (next) => onInjectWs(next),
          }),
        ),
      )
    }

    /* ------------------------------------------------------------ 页 4：文件分享 */

    /**
     * 「文件分享」页（用户 2026-09-17 定）：两种模式 + 在线 base + 清除分享数据。
     *   关闭（默认）/ 在线 —— 决定 `mc_kit_express` 回什么、以及那条服务开不开：
     *     · 关闭：AI 只会把**绝对路径**告诉用户（服务不开）；
     *     · 在线：回 `base + 路径` 的**完整 URL**（只有这个模式开服务，图能直接在对话里显示）。
     */
    function SharePane(props) {
      const {
        mode, base, share, busyKey,
        onPickMode, onSaveBase, onUseCurrent, onClear,
      } = props
      const busy = busyKey !== null
      const [baseText, setBaseText] = React.useState(base ?? '')
      const [confirmClear, setConfirmClear] = React.useState(false)
      React.useEffect(() => { setBaseText(base ?? '') }, [base])

      const MODES = [
        { id: 'off', name: '关闭', desc: '不分享：AI 只会告诉你文件的绝对路径，让你自己打开' },
        { id: 'online', name: '在线', desc: '回完整 URL：要填 base，图片可以直接在对话里显示' },
      ]
      const online = mode === 'online'
      const activeDesc = MODES.find((m) => m.id === mode)?.desc ?? ''
      const baseBusy = busyKey === 'share:base'
      const clearBusy = busyKey === 'share:clear'
      const dirty = (baseText ?? '') !== (base ?? '')

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'share' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '分享模式'),
          // 两个模式做成一排等宽的按钮（别用账户页那种带 × 的小标签：太窄、字也不居中）
          React.createElement('div', { 'data-wc-modes': '' },
            ...MODES.map((m) => React.createElement('button', {
              key: m.id,
              type: 'button', 'data-wc-mode': '', ...(mode === m.id ? { 'data-wc-mode-on': '' } : {}),
              disabled: busy, title: m.desc,
              onClick: () => { if (mode !== m.id) onPickMode(m.id) },
            }, m.name))),
          React.createElement('p', { 'data-wc-hint': '' }, activeDesc),
        ),
        // base 只属于「在线」模式：关闭时不显示（免得让人以为关闭模式也吃 base）
        online
          ? React.createElement('div', { 'data-wc-sec': '' },
            React.createElement('div', { 'data-wc-h': '' }, '在线 base'),
            React.createElement('div', { 'data-wc-field': '' },
              React.createElement('input', {
                'data-wc-in': '', value: baseText, spellCheck: false, disabled: busy,
                placeholder: 'https://example.com（可以带路径前缀）',
                onChange: (e) => setBaseText(e.target.value),
              }),
            ),
            React.createElement('p', { ...(!base ? { 'data-wc-hint': '', 'data-wc-dirty': '' } : { 'data-wc-hint': '' }) },
              !base
                ? '还没填 base：AI 暂时只能让你去设置。'
                : '填你访问这台 DSH 用的地址。'),
            React.createElement('div', { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy || !dirty, onClick: () => onSaveBase(baseText.trim()),
              }, baseBusy ? '保存中…' : '保存 base'),
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '',
                disabled: busy, title: '用你现在访问这个页面的地址填好并保存',
                onClick: onUseCurrent,
              }, '获取当前')),
          )
          : null,
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '分享数据'),
          React.createElement('p', { 'data-wc-hint': '' },
            share?.dir
              ? `目录：${share.dir}${share.exists ? `　（${share.files} 个文件 / ${fmtBytes(share.bytes)}）` : '　（还没有这个目录）'}`
              : '目录：读取中…'),
          // 清除与分享模式无关：关闭模式下也一样能清（不然关掉分享就没法收拾旧文件）
          React.createElement('div', { 'data-wc-acts': '' },
            confirmClear
              ? [
                React.createElement('button', {
                  key: 'yes', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                  disabled: busy, title: '再点一次确认',
                  onClick: () => { setConfirmClear(false); onClear() },
                }, clearBusy ? '清除中…' : '确认清除'),
                React.createElement('button', {
                  key: 'no', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                  onClick: () => setConfirmClear(false),
                }, '取消'),
              ]
              : React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                disabled: busy,
                title: '删掉上面那个目录里的所有文件',
                onClick: () => setConfirmClear(true),
              }, '清除分享数据')),
          // ⚠️ 这里是 HTML（React 文本节点），不是 markdown —— 别再用 `**` 当粗体（用户指出过一次）
          React.createElement('p', { 'data-wc-hint': '' },
            '「清除分享数据」会把上面那个目录里的文件',
            React.createElement('strong', {}, '全部删掉'),
            '，不可撤销。'),
        ),
      )
    }

    function fmtBytes (n) {
      const v = Number(n ?? 0)
      if (!Number.isFinite(v) || v <= 0) return '0 B'
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(1)} MB`
    }

    const TABS = [
      { id: 'accounts', label: '账户' },
      { id: 'whitelist', label: '指令白名单' },
      { id: 'prompt', label: '提示词' },
      { id: 'share', label: '文件分享' },
    ]

    function McSettingsModal(props) {
      // 🔴 提示词是**按会话工作区**的（`.whale-craft/AGENTS.md`），所以要把本会话 id 带上
      const sessionId = props?.sessionId ?? null
      const agentsMdPath = sessionId
        ? '/api/mc/agents-md?sessionId=' + encodeURIComponent(sessionId)
        : '/api/mc/agents-md'
      /**
       * 「MC设置」这组接口**都要带 sessionId**：服务端拿它定位**工作区**
       * （没有选中工作区就 400 拒绝，见 index.js `settingsGate`）。
       * 统一走 query（GET/POST/PATCH/DELETE 服务端都认），省得每个 body 都塞一遍。
       */
      const wsCwd = props?.wsCwd ?? null
      const withSid = (p) => {
        const q = []
        if (sessionId) q.push('sessionId=' + encodeURIComponent(sessionId))
        if (wsCwd) q.push('cwd=' + encodeURIComponent(wsCwd))
        return q.length ? p + (p.includes('?') ? '&' : '?') + q.join('&') : p
      }
      const [open, setOpen] = React.useState(false)
      const [tab, setTab] = React.useState('accounts')
      const [accounts, setAccounts] = React.useState([])
      const [servers, setServers] = React.useState([])
      const [defaultAccount, setDefaultAccount] = React.useState(null)
      const [wlText, setWlText] = React.useState('')
      const [allowAll, setAllowAll] = React.useState(false)
      const [mdText, setMdText] = React.useState('')
      const [mdSource, setMdSource] = React.useState('default')
      const [mdPath, setMdPath] = React.useState('')
      const [injectWc, setInjectWc] = React.useState(true)
      const [injectWs, setInjectWs] = React.useState(false)
      // 「提示词 → 随版本更新」（默认开）：开关存在全局配置里；marker 是记忆目录里的 .rules-version
      const [followVersion, setFollowVersion] = React.useState(true)
      const [rulesVersion, setRulesVersion] = React.useState(null)
      const [pluginVersion, setPluginVersion] = React.useState('')
      // 「文件分享」：模式（off 关闭 / online 在线）+ base + 发布区现状
      const [shareMode, setShareMode] = React.useState('off')
      const [shareBase, setShareBase] = React.useState('')
      const [shareInfo, setShareInfo] = React.useState(null)
      const [wsPath, setWsPath] = React.useState('')
      const [wsExists, setWsExists] = React.useState(false)
      const [injectStatus, setInjectStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [busyKey, setBusyKey] = React.useState(null)

      // 关闭函数（点遮罩 / × / Esc 共用；也供下面的订阅使用）
      const close = React.useCallback(() => { setOpen(false) }, [])
      // 模块级总线订阅：hero 那个 DOM 按钮没有 React 上下文，只能靠它叫醒这里。
      // 用 ref 存最新函数，订阅只建一次，避免重复订阅/闭包过期。
      const openRef = React.useRef(null)
      openRef.current = () => { setError(''); setSaved(''); setOpen(true) }
      React.useEffect(() => settingsBus.subscribe(() => { openRef.current?.() }), [])

      /**
       * 一次读齐三页要的东西：账户 / 配置（白名单+注入开关）/ 提示词。
       * 账户接口是**必需**的（读不到就没法用）；config 与 agents-md 单独容错，
       * 免得一个接口挂了整页空掉。
       */
      const load = React.useCallback(() => {
        setLoading(true)
        setLoadError('')
        return Promise.all([
          apiGet(withSid('/api/mc/accounts')).then((a) => {
            setAccounts(Array.isArray(a.accounts) ? a.accounts : [])
            setServers(Array.isArray(a.authServers) ? a.authServers : [])
            setDefaultAccount(a.defaultAccount ?? null)
          }),
          apiGet(withSid('/api/mc/config')).then((c) => {
            setWlText(whitelistToText(c.commandWhitelist))
            setAllowAll(c.allowAllCommands === true)
            setInjectWc(c.injectWhaleCraftAgentsMd !== false)
            setInjectWs(c.injectWorkspaceAgentsMd === true)
            setShareMode(c.expressMode === 'online' ? 'online' : 'off')
            setShareBase(String(c.expressBase ?? ''))
          }).catch((e) => { setError(errorText(e)) }),
          apiGet(withSid('/api/mc/express')).then((s) => {
            setShareInfo(s ?? null)
          }).catch((e) => { setError(errorText(e)) }),
          apiGet(agentsMdPath).then((m) => {
            setMdText(String(m.text ?? ''))
            setMdSource(m.source === 'custom' ? 'custom' : 'default')
            setMdPath(String(m.path ?? ''))
            setWsPath(String(m.workspacePath ?? ''))
            setWsExists(m.workspaceExists === true)
            setInjectStatus(m.injection ?? null)
            setFollowVersion(m.followVersion !== false)
            setRulesVersion(m.rulesVersion ?? null)
            setPluginVersion(String(m.pluginVersion ?? ''))
          }).catch((e) => { setError(errorText(e)) }),
        ])
          .then(() => { setLoaded(true) })
          .catch((e) => { setLoaded(false); setLoadError(errorText(e)) })
          .finally(() => { setLoading(false) })
      }, [agentsMdPath])

      React.useEffect(() => { if (open) load() }, [open, load])

      // Esc 关闭 + 打开时锁住 body 滚动（关闭/卸载都还原）
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('keydown', onKey)
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = prev
        }
      }, [open, close])

      /** 所有动作的统一出口：置忙 → 跑 → 刷新 → 归一化错误 */
      const run = React.useCallback((key, fn, okMsg) => {
        setBusyKey(key)
        setError('')
        setSaved('')
        return Promise.resolve()
          .then(fn)
          .then(() => {
            setSaved(okMsg || '已保存')
            return load().then(() => true)
          })
          .catch((e) => {
            setError(errorText(e))
            // 出错时也刷新——后端可能已经改了一半（例如"设为默认"成功但回读失败）
            return load().then(() => false, () => false)
          })
          .finally(() => { setBusyKey(null) })
      }, [load])

      const patchAccount = React.useCallback((innerID, patch, key) =>
        run(key, () => apiPatch(withSid('/api/mc/accounts'), { innerID, ...patch }), '账户已更新'), [run])

      const refreshAccount = React.useCallback((acc) =>
        run('row:' + acc.innerID + ':refresh',
          () => apiPost(withSid('/api/mc/accounts/refresh'), { innerID: acc.innerID }),
          `「${acc.name}」刷新完成`), [run])

      const deleteAccount = React.useCallback((acc) =>
        run('row:' + acc.innerID + ':delete',
          () => apiDelete(withSid('/api/mc/accounts'), { innerID: acc.innerID }),
          `已删除「${acc.name}」`), [run])

      const createAccount = React.useCallback((body, key) =>
        run(key, () => apiPost(withSid('/api/mc/accounts'), body), '账户已新建'), [run])

      const addServer = React.useCallback((body) =>
        run('server:add', () => apiPost(withSid('/api/mc/authservers'), body), '认证服务器已添加'), [run])

      // 拖放来的卡片：原样把文本交给后端解析（前端不解析、不落任何副本）。
      // ⚠️ 要把**新加的服务器**回传给调用方（「新建第三方账户」拖完要自动选中 + 填进输入框）。
      const addServerCard = React.useCallback(async (card) => {
        let created = null
        await run('server:card',
          () => apiPost(withSid('/api/mc/authservers'), { card }).then((r) => { created = r?.server ?? null; return r }),
          '已从卡片解析并添加认证服务器')
        return created
      }, [run])

      const removeServer = React.useCallback((srv) =>
        run('server:' + srv.id, () => apiDelete(withSid('/api/mc/authservers'), { id: srv.id }), `已移除「${srv.name}」`), [run])

      /* ── 页 2：白名单 ──
       * 「允许所有指令」开关**一拨就存**（用户 2026-09-16 定），失败把开关拨回去；
       * 白名单文本仍由「保存」提交（只发 commandWhitelist）。 */
      const toggleAllowAll = React.useCallback((next) => {
        const prev = allowAll === true
        const want = next === true
        if (want === prev) return Promise.resolve(true)
        setAllowAll(want)                                    // 乐观更新，拨动立刻有反应
        return run('cfg:allowAll', () => apiPatch(withSid('/api/mc/config'), { allowAllCommands: want }),
          want ? '已打开：允许所有指令' : '已关闭：只放行白名单')
          .then((ok) => { if (!ok) setAllowAll(prev); return ok })   // 失败回滚
      }, [run, allowAll])

      const saveWhitelist = React.useCallback(() =>
        run('wl:save', () => apiPatch(withSid('/api/mc/config'), {
          commandWhitelist: textToWhitelist(wlText),
        }), '指令白名单已保存'), [run, wlText])

      /* ── 页 3：提示词：保存 / 恢复默认 / 两个注入开关 ── */
      const saveAgentsMd = React.useCallback(() =>
        run('md:save', () => apiPut('/api/mc/agents-md', { text: mdText, sessionId }), '已保存'), [run, mdText, sessionId])

      const resetAgentsMd = React.useCallback(() =>
        run('md:reset', () => apiDelete('/api/mc/agents-md', { sessionId }), '已恢复默认'), [run, sessionId])

      const toggleInjectWc = React.useCallback((next) =>
        run('cfg:wc', () => apiPatch(withSid('/api/mc/config'), { injectWhaleCraftAgentsMd: next === true }),
          next ? '已开启提示词注入' : '已关闭提示词注入'), [run])

      const toggleInjectWs = React.useCallback((next) =>
        run('cfg:ws', () => apiPatch(withSid('/api/mc/config'), { injectWorkspaceAgentsMd: next === true }),
          next ? '已开启工作区 AGENTS.md 注入' : '已关闭工作区 AGENTS.md 注入'), [run])

      /** 「随版本更新」：一拨就存；**打开时不会立刻覆盖**（只在插件版本变化时才替换） */
      const toggleFollowVersion = React.useCallback((next) => {
        const prev = followVersion
        setFollowVersion(next === true)
        return run('cfg:follow', () => apiPatch(withSid('/api/mc/config'), { rulesFollowVersion: next === true }),
          next ? '已开启：插件升级时用新版本默认提示词替换' : '已关闭：保留你自己改的内容')
          .then((ok) => { if (!ok) setFollowVersion(prev); return ok })
      }, [run, followVersion])

      /* ── 页 4：文件分享 ──
       * 模式**一点就存**（同"允许所有指令"那个开关：错了回滚）；base 走「保存」按钮；
       * 「获取当前」= 用**你现在访问这个页面的地址**填好并保存；
       * 🔴 切到「在线」而 base 还没设时，自动做一次"获取当前"（不然在线模式当场没用）；
       * 但**不去调就不写**：不切到在线、不点按钮，base 永远保持原样。
       * 清除分享数据**必须确认**（不可撤销）。
       * ⚠️ 输入框的文本状态在 SharePane 内部（`baseText`），这里**不能**去 setBaseText：
       *    保存完 `load()` 会刷新 `shareBase`，pane 的 useEffect（+ key 变化）会自己同步回输入框。 */
      /** 向服务端要「当前地址」：把浏览器**自己正在用的** origin 一起报上去（最精准）。 */
      const fetchCurrentBase = React.useCallback(() => {
        const here = (typeof location !== 'undefined' && location.origin) ? location.origin : ''
        const q = here ? '&clientOrigin=' + encodeURIComponent(here) : ''
        return apiGet(withSid('/api/mc/express') + q).then((s) => String(s?.currentBase ?? ''))
      }, [withSid])

      const pickShareMode = React.useCallback((next) => {
        const prev = shareMode
        if (next === prev) return Promise.resolve(true)
        setShareMode(next)                                           // 乐观更新
        // 切到在线且还没 base → 顺手把当前地址一起保存（一次动作，别让用户自己去找地址）
        const autoBase = next === 'online' && !shareBase
        return run('share:mode', () => (autoBase
          ? fetchCurrentBase().then((cur) => apiPatch(withSid('/api/mc/config'),
            cur ? { expressMode: next, expressBase: cur } : { expressMode: next }))
          : apiPatch(withSid('/api/mc/config'), { expressMode: next })),
        next === 'online'
          ? (autoBase ? '已切到在线，base 用当前地址填好了' : '文件分享：在线')
          : '文件分享：已关闭')
          .then((ok) => { if (!ok) setShareMode(prev); return ok })   // 失败回滚
      }, [run, shareMode, shareBase, fetchCurrentBase])

      const saveShareBase = React.useCallback((text) =>
        run('share:base', () => apiPatch(withSid('/api/mc/config'), { expressBase: String(text ?? '') }),
          'base 已保存'), [run])

      /** 「获取当前」：填进输入框并立即保存（拿不到就明确报错，别存一个空值） */
      const useCurrentBase = React.useCallback(() =>
        run('share:base', () => fetchCurrentBase().then((cur) => {
          if (!cur) throw new Error('拿不到当前地址：请手动填写（例如 http://127.0.0.1:14640）')
          return apiPatch(withSid('/api/mc/config'), { expressBase: cur })
        }), '已用当前地址填好'), [run, fetchCurrentBase])

      const clearShare = React.useCallback(() =>
        run('share:clear', () => apiDelete(withSid('/api/mc/express')), '分享数据已清除'), [run])

      if (!open) return null

      const busy = busyKey !== null
      const stop = (e) => e.stopPropagation()

      const pane = tab === 'whitelist'
        ? React.createElement(WhitelistPane, {
          wlText, allowAll, busyKey,
          onWlText: setWlText, onAllowAll: toggleAllowAll, onSave: saveWhitelist,
        })
        : (tab === 'prompt'
          ? React.createElement(PromptPane, {
            key: 'prompt:' + mdSource + ':' + wsExists,
            mdText, mdSource, mdPath, wsPath, wsExists, injectStatus, injectWc, injectWs, busyKey,
            followVersion, rulesVersion, pluginVersion,
            onMdText: setMdText, onSave: saveAgentsMd, onReset: resetAgentsMd,
            onInjectWc: toggleInjectWc, onInjectWs: toggleInjectWs, onFollowVersion: toggleFollowVersion,
          })
          : (tab === 'share'
            ? React.createElement(SharePane, {
              key: 'share:' + shareMode + ':' + shareBase,
              mode: shareMode, base: shareBase, share: shareInfo, busyKey,
              onPickMode: pickShareMode, onSaveBase: saveShareBase, onUseCurrent: useCurrentBase, onClear: clearShare,
            })
            : React.createElement(AccountsPane, {
            accounts, servers, defaultAccount, busyKey,
            onPatch: patchAccount, onRefresh: refreshAccount, onDelete: deleteAccount,
            onCreate: createAccount, onAddServer: addServer, onAddCard: addServerCard,
            onRemoveServer: removeServer,
          })))

      return React.createElement(
        'div',
        {
          'data-wc-overlay': '',
          role: 'presentation',
          onClick: close,               // 点遮罩关闭
          onMouseDown: (e) => { if (e.target === e.currentTarget) e.preventDefault() },
        },
        React.createElement(
          'div',
          {
            'data-wc-card': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'MC设置',
            onClick: stop,              // 卡片内部点击不关
            ...(busy ? { 'data-wc-busy': '' } : {}),
          },
          React.createElement(
            'div',
            { 'data-wc-head': '' },
            React.createElement(
              'div',
              { 'data-wc-titlewrap': '' },
              React.createElement('span', { 'data-wc-title': '' }, 'MC设置'),
            ),
            React.createElement('span', { 'data-wc-grow': '' }),
            busy ? React.createElement('span', { 'data-wc-dim': '', style: { fontSize: '11px' } }, '处理中…') : null,
            React.createElement('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', title: '关闭（Esc）',
              onClick: close,
            }, '×'),
          ),
          React.createElement(
            'div',
            { 'data-wc-panes': '' },
            React.createElement(
              'div',
              { 'data-wc-side': '', role: 'tablist' },
              TABS.map((t) => React.createElement('button', {
                key: t.id,
                type: 'button',
                'data-wc-tab': '',
                ...(tab === t.id ? { 'data-wc-tab-on': '' } : {}),
                role: 'tab',
                'aria-selected': tab === t.id ? 'true' : 'false',
                onClick: () => setTab(t.id),
              }, t.label)),
            ),
            React.createElement(
              'div',
              { 'data-wc-pane': '' },
              error ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, error) : null,
              saved ? React.createElement('div', { 'data-wc-ok': '' }, saved) : null,
              loadError ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, `读取失败：${loadError}`) : null,
              loading && !loaded
                ? React.createElement('div', { 'data-wc-dim': '' }, '正在读取…')
                : pane,
            ),
          ),
        ),
      )
    }

    /* ==================================================================
     * apply
     * ================================================================== */
    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'whale_craft')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'whale_craft: status bar styles')

        // list/session 插槽：增量安全，不覆盖官方 header
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'whale_craft-status', order: 50 },
          McStatusBar,
        ))

        // 「MC设置」入口①：标题条（**已有会话**时才出现）。
        // 判据 = 会话记录的 agent preset ∈ mcModePresets（本地判定，见 useMcSettingsGate）。
        // order 45 < 50 → 落在状态条**左边**（官方预设标签 -10 更左）。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'whale_craft-mc-settings', order: 45 },
          McSettingsEntry,
        ))

        // 「MC设置」入口②：**新会话页**。注册在这里的组件只当"驱动器"
        // （它自己 return null，按钮由 mountHeroChipButton 插到模式芯片右边）——
        // 借这个插槽拿一个可靠的挂载时机：hero 与 composer 都渲染它，配合 blank 门控
        // 就只在**新会话页**挂载。与入口①按 blank 互斥，所以页面上任何时候只有一个入口/一个模态框。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'whale_craft-mc-settings-hero', order: 20 },
          McSettingsDockEntry,
        ))

        // 只做一次性清理：摘掉历史版本用 MutationObserver 注入的按钮。
        // 🔴 不要再挂 observer / 不要再往宿主 DOM 里插任何东西（见文件头事故记录）。
        purgeLegacyInjectedButtons()
      },
    }
  },
})
