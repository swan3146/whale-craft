# Fork 分支说明：AuthMe 6.x 对话框登录 + DSH 0.1.7（v4 会话格式）适配

> 本分支是 [yzi1b/whale-craft](https://github.com/yzi1b/whale-craft) 的 fork，
> 基线为上游 `aac3130`（whale_craft **0.1.7**），**fork 自身版本 `0.1.9`**。
> 相对上游改了 **13 个文件（+888 / -47）**：1 处新增功能、4 处修复、1 处自检夹具、若干文档与配置。
> **不含任何密码、账户名或服务器地址**（AuthMe 密码改由环境变量提供，见第四节）。

---

## 一、适配了什么

| 项 | 版本 |
|---|---|
| **DSH（DeepSeek Harness）** | **`0.1.7-alpha.1`** |
| whale_craft 上游基线 | **0.1.7**（commit `aac3130`） |
| **whale_craft（本 fork 发布的版本）** | **`0.1.9`** |
| Minecraft 服务端 | **EtheriumMC 26.2 / Paper 26.2**（Folia 调度器），协议号 **775** |
| AuthMe | **6.x**（`preJoin` 对话框登录流程） |
| mineflayer | 实测 4.39.0（上游声明 `^4.37.1`） |
| Node.js | `>= 22`（上游要求） |

---

## 二、新增了什么

### 1. AuthMe 6.x 对话框登录（`src/core.mjs`，+90/-1）

**为什么需要**：MC 26.2 上 AuthMe 6.x 不再只靠聊天命令 `/login`。它在 **configuration 阶段**
下发一个 Dialog（`show_dialog` 包），要求客户端回一个 `custom_click_action` 原始包；
`preJoin.enable=true` 时这一步不可跳过，`loginCancelKicks=true` 时没回就会被踢下线。
mineflayer 不处理这个包，所以这部分是手写协议：

- **`writeVarInt()`**（`src/core.mjs:33`）—— 手写 Minecraft 协议的变长整数，用来自己拼包体。
- **加载 `prismarine-nbt`**（`src/core.mjs:33-63`）—— 上游没有这个直接依赖，改为从 mineflayer
  的依赖树里 `createRequire` 解析（解析不到再回退动态 `import`），用来解析 `show_dialog` 的 NBT、
  并构造回包。**不往 `package.json` 里加依赖。**
- **登录块**（`src/core.mjs:751`，+47 行）：在 `connect()` 里监听 `show_dialog` →
  - 从对话框 NBT 里解析**提交按钮的 action id**（找 `*/submit`，兜底 `authme:prejoin-login/submit`）
    和**输入框的 key**（取第一个 input，兜底 `password`）；
  - 用 `prismarine-nbt` 编出 payload，去掉根名做成**匿名 NBT**；
  - 按当前协议阶段选包 id（configuration `0x08` / play `0x44`）；
  - 用 `client.writeRaw()` 发出去，并把结果写进日志。
- **`authmePassword` 配置项**（`src/core.mjs:178`）：`process.env.MC_AUTHME_PASSWORD ?? ''`
  —— **只从环境变量读，不落任何配置文件**。
- **`spawn` 之后补一条 `/login <密码>`**（`src/core.mjs:831`）：`preJoin` 已经成功时这条多余但无害
  （AuthMe 会忽略已登录玩家），用来兼容仍然走 post-join 的服务器。

### 2. webServer 懒注入（`index.js`）

**为什么需要**：在 DSH 0.1.7 上，插件激活顺序会让 `webServer` 还没就绪就被引用，
原来写死的 `export const inject = ['webServer', 'tools']` 会因此报错。改成：

- 硬依赖只留 `['tools']`（`index.js:45`）；
- 两处路由注册改成**懒注入**：

```js
ctx.inject(['webServer'], (scope) => {
  scope.effect(() => scope.webServer.register(apiRoute), 'whale_craft: /api/mc 路由')
})
```

（另一处是发布区的 `/api/whale-craft` 路由，`index.js:1310`。）

### 3. DSH v4 会话格式适配：提示行投递（`src/user-message.mjs` + 2 个调用点）

**为什么需要**：DSH 0.1.7 的会话格式升到 **v4**，其准入检查**点名拒绝** `source.kind === 'plugin'`
（V3 的包装值）。插件原来用它投递"提示行"，于是在 0.1.7 上**整轮运行直接失败**：

```
本轮运行失败 format v4 message requires a producer-owned source kind
```

这个 bug 的症状很有迷惑性 —— **工具全都正常**，只有"注入提示行"这条通道炸，
看起来像是"插件没装提示词"而不是"会话写不进去"。

- 新增 `PLUGIN_SOURCE_KIND = 'plugin:whale_craft'`（`src/user-message.mjs:48`）——
  `kind` 取宿主 `producerKind()` 对第三方插件的规范值 `plugin:<插件名>`；
- 新增统一的 `noticeSource(summary)` 构造器（`src/user-message.mjs:59`），
  返回 `{ kind: 'plugin:whale_craft', plugin: 'whale_craft', form: 'notice', summary }`
  （`summary` 截到 120 字，与宿主 `CONTEXT_SUMMARY_MAX_CHARS` 一致）；
- 两处投递点改用它：`index.js:2774`（版本/规则提示行）、`src/watchdog.mjs:611`（看门狗唤醒）；
- `src/version-prompt.mjs` 里描述这套机制的注释同步订正（避免后人照抄错的 kind）。

### 4. 看门狗后台 job 的 owner 修正（`src/watchdog.mjs` + `index.js`）

**为什么需要**：真机上报

```
挂 job 失败（降级为无 job 模式）：session "[object Object]" has no live agent
(background job owner must be live)
```

看门狗因此降级成"无 job 模式"——还能唤醒，但 `job_list` 里看不到、UI 也停不掉。

**根因**：`jobs` 这一族的 `owner` / `caller` 参数要的是**会话 id 字符串**，插件传的是 **agent 对象**。
宿主 `resolveOwner(session)`（`@deepseek-ai/dsh-jobs-local/lib/index.js:526-533`）拿它去
`agents.get(session)` 查表，而那张表**按会话 id 字符串索引**
（`@deepseek-ai/dsh-agent`：`get(id) { return this.store.get(id)?.agent }`，
且 `enter()` 里断言 `agent.id === agent.session.id`）⇒ 传对象必然查不到，
错误信息里对象被 `String()` 成了 `[object Object]`。

**修法**：新增私有方法 `#ownerId()`（取 `agent?.id ?? sess.agentId`，并校验是非空字符串），
4 处调用点全部改传会话 id：

| 位置 | 旧 | 新 |
|---|---|---|
| `src/watchdog.mjs:389` `jobs.start` | `owner: this.agent` | `owner: ownerId` |
| `src/watchdog.mjs:312` `jobs.kill` | `kill(jobId, this.agent, reason)` | `kill(jobId, this.#ownerId(), reason)` |
| `index.js:761` `jobs.list` | `list(agent)` | `list(jobOwner)` |
| `index.js:765` `jobs.kill` | `kill(id, agent, reason)` | `kill(id, jobOwner, reason)` |

**顺带修掉一个更危险的隐患**：宿主

```js
assertAccess(job, caller) { if (job.owner !== void 0 && job.owner.id !== caller) throw … }
```

对 `owner === undefined` 的"**无主 job**"**完全不设防**。旧代码传 agent 对象时，
`list()` 一个自己的 job 都匹配不到，却把 `owner === undefined` 的**宿主级无主 job 全列出来**，
再因为不设防而全 `kill` 掉 —— 也就是说：点一次「强制停止」，会顺手清掉
跟这个会话**毫无关系**的宿主后台任务。现在改成只杀自己的（`if (j?.owner !== jobOwner) continue`），
并且 `jobOwner` 不是非空字符串时直接跳过。

**另一处防御**：拿不到会话 id 时**不再挂"无主 job"**（`owner` 缺省会让它对所有会话可见、
也能被别的会话的"强制停止"带走），而是照旧降级为"无 job 模式"并记一行日志说明原因。

### 5. 自检夹具补齐（`selfcheck.mjs`，+81/-9）

- **懒注入那次改动（上游已合入的 `074d61f`）之后，自检里所有路由注册相关的断言都是死的**：
  两处假 ctx 的 `inject` 一个是空壳、一个只登记不回调 ⇒ `/api/mc` 与 `/api/whale-craft`
  两条路由**从没注册**，断言全废，脚本还在 `callOn(undefined, …)` 上 `TypeError` 崩掉。
  （**真机不受影响**：真 cordis 的 `inject` 会回调。）已让夹具对 `webServer` 立刻回调。
- 新增 **8 条回归钉子**，把这次两个真机事故钉死：
  - `jobs.list` / `jobs.kill` 收到的必须是**会话 id 字符串**（不是 agent 对象）；
  - 无主 job（宿主自己的）**不许**被顺手杀掉；
  - `jobs.start` 的 `owner` 必须是会话 id 字符串，且 `kind` / `label` 元信息正确；
  - 拿不到会话 id 时**不挂无主 job**、降级为无 job 模式并把原因记进日志。

### 6. 配置示例里不再出现密码（`cordis.patch.yml`，+20）

上游的 `cordis.patch.yml` 是**插件包的一部分**（会被提交、打包、备份、随手分享，
而且模型能直接读到），里面**不该出现任何密码**。本分支在里面加了一段注释，说明
AuthMe 密码改由环境变量 `MC_AUTHME_PASSWORD` 提供，并给出 `export` 与
systemd `EnvironmentFile`（`0600`）两种写法。文件本身仍然只有 `autoConnect: false`。

### 7. MC 模式 preset 补上压缩组（`src/config.mjs` + `selfcheck.mjs`）

**问题**：`/compact` 由 `@deepseek-ai/dsh-command-compact` 提供，它属于 preset 里的**压缩组**：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic            # 压缩服务本体
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact             # /compact 这条斜杠指令
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner          # 超长工具结果裁剪
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

官方 `standard` / `ptc` / `cordis` 三个 preset 都有这一组，**`minimal` 没有** ——
而 whale_craft 建 MC 模式 preset 时是照 `minimal` 复制再补的，只补了 `tool-fs` / `tool-jobs` / `present`，
于是这个 preset **既没有 `/compact`、也没有自动压缩**（用户真机投诉："压缩上下文没了"）。

**修法**：

- `MC_PRESET_TOOL_GROUPS` 增加第 4 个条目，带 **`block` 字段**（整组 YAML 逐字对齐官方那块）；
- `patchToolGroupsIntoComposition()`：有 `block` 就整块追加，否则维持原来的
  "一行 `- id` + 一行 `name`" 简单形式 ⇒ **老的三组输出逐字节不变**（幂等性断言不受影响）；
- `MC_PRESET_SPEC` **6 → 7**：升级时会把 6 建的那些 preset 重建一遍，顺手补上压缩组
  （和 `spec 5 → 6` 修 persona 键名走的是同一条路）。

**⚠️ 关键**：只补 `command-compact` 是**没用**的 —— 压缩服务本体在 `compaction-basic`，
`isolate` 那两个键在别处根本不存在，**必须整组加**。

**自检**：新增 4 条断言 —— 整组结构（`cordis:group` + `group: true` + 两个 `isolate` 键）、
三个 `config` 条目齐全、`tool-result-pruner` 参数与官方一致、`MC_PRESET_SPEC === 7`。

---

## 三、相对上游改了什么

| 文件 | 变化 | 说明 |
|---|---|---|
| `src/core.mjs` | **+90 / -1** | AuthMe 6.x 对话框登录（`writeVarInt` / NBT / 按阶段选包 id） |
| `src/watchdog.mjs` | **+46 / -13** | `#ownerId()`、job owner/caller 修正、v4 `noticeSource` |
| `src/config.mjs` | **+40 / -5** | 压缩组**整组**补进 `MC_PRESET_TOOL_GROUPS`（新增 `block` 字段）、`MC_PRESET_SPEC` 升到 7 |
| `index.js` | **+28 / -10** | webServer 懒注入、job owner/caller 修正、v4 `noticeSource`、工具组注释订正 |
| `selfcheck.mjs` | **+88 / -12** | 夹具补懒注入回调 + 8 条 jobs 回归钉子 + 4 条压缩组断言 |
| `src/user-message.mjs` | **+39 / -1** | `PLUGIN_SOURCE_KIND` + `noticeSource()`（v4 合规） |
| `src/version-prompt.mjs` | **+3 / -2** | 注释订正（kind 不能是 V3 的 `'plugin'`） |
| `cordis.patch.yml` | **+20 / -0** | 加注释说明密码走环境变量（文件本身无密码） |
| `package.json` | **+1 / -1** | 版本号 `0.1.7` → `0.1.9` |
| `package-lock.json` | **+2 / -2** | 同步 lockfile 版本号（`0.1.7` → `0.1.9`，并订正残留的 `0.1.4`） |
| `CHANGELOG.md` | **+86 / -0** | 本分支的变更记录（0.1.8 与 0.1.9 两节） |
| `FORK-NOTES.md` | **+273 / -0** | 本文件（fork 独有，上游没有） |
| `README.md` | **+172 / -0** | 重写为 fork 说明（上游版本 / 上游问题 / 修复 / 新增 / 安装 / 限制），上游原文折叠在文末 |

**没有改**：其余源码。**没有新增依赖。**

---

## 四、怎么用

### 1. 安装

按上游 README 的方式装即可，例如：

```bash
dsh plugin --profile <你的 profile> add link:/path/to/whale-craft
```

fork 也提供打包好的 tgz（见本 fork 的 **Releases** 页，附件 `whale_craft-0.1.8.tgz`）：

```bash
npm install /path/to/whale_craft-0.1.8.tgz
```

> ⚠️ npm 上的 `whale_craft` 属于原作者（`lyricraft <yzi1b@outlook.com>`），
> 所以这个包**没有发到 npm**，只作为 Release 附件提供。

### 2. 提供 AuthMe 密码（不进配置文件）

只有**离线服 + AuthMe** 需要；正版验证服不用。

```bash
export MC_AUTHME_PASSWORD='你的密码'
```

用 systemd 部署时建议走 `EnvironmentFile`（文件权限 `0600`）：

```ini
EnvironmentFile=-/path/to/authme.env
```

```bash
# authme.env
MC_AUTHME_PASSWORD=你的密码
```

**不设这个环境变量时**，对话框登录整段不会启用（`authmePassword` 为空 → 直接跳过），
行为与上游一致。

### 3. 自检

```bash
npm run check        # = node tools/check-core.mjs && node selfcheck.mjs
```

---

## 五、已知限制

- **对话框解析**依赖 AuthMe 的默认 action id（`*/submit`）和输入框 key（`password`）；
  自定义过对话框布局的服务器可能解析不到 —— 这时日志里会写 `AuthMe 对话框提交失败：…`。
- **只在 EtheriumMC 26.2 / AuthMe 6.x 上实测过**。更老的 AuthMe（1.20.x 那批）走的是聊天命令
  `/login`，本分支补的那条命令能覆盖，但对话框那段不会触发。
- **需要 DSH 0.1.7-alpha.1**：懒注入与 v4 `noticeSource` 都是为它改的。
  更早的 DSH 两种写法应该都能跑，未实测。
- **`selfcheck.mjs` 还有 5 条 ❌，都是平台/数据差异，与本分支无关**（`npm run check` 不因 ❌ 退出非零）：
  3 条是夹具里写死了 Windows 路径（`D:\dsh/whale_craft`、`E:\x\README.md` 之类），
  在 Linux 上 `path.resolve()` 会把它们当普通文件名，于是"越界拦截"用例判失败
  （真正的越界如 `/etc/passwd`、`../../x` 仍被正确拒绝）；
  1 条是 `minecraft-data@3.116.0` 的 `dataPaths.json` 里没有 `pc.26.2` 条目
  （磁盘上有 `26.2/` 目录但未被索引）⇒ `#supportsPacket('26.2', …)` 返回 null，
  被当成"不支持"；服务端实际协议号 775 映射到 `26.1`（那个条目是有的）。
- **`jobs` 那两处修正需要在插件代码更新后重启 DSH 才生效**（Node ESM 模块缓存）。
