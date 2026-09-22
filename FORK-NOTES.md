# Fork 分支说明：AuthMe 6.x 对话框登录（适配 DSH 0.1.7）

> 本分支是 [yzi1b/whale-craft](https://github.com/yzi1b/whale-craft) 的 fork，
> 基线为上游 `aac3130`（whale_craft **0.1.7**）。
> 相对上游只改了两个源码文件，**不含任何密码、账户名或服务器地址**。

---

## 一、适配了什么

| 项 | 版本 |
|---|---|
| **DSH（DeepSeek Harness）** | **`0.1.7-alpha.1`** |
| whale_craft 上游基线 | **0.1.7**（commit `aac3130`） |
| Minecraft 服务端 | **EtheriumMC 26.2 / Paper 26.2**（Folia 调度器），协议号 **775** |
| AuthMe | **6.x**（`preJoin` 对话框登录流程） |
| mineflayer | 实测 4.39.0（上游声明 `^4.37.1`） |
| Node.js | `>= 22`（上游要求） |

---

## 二、新增了什么

### 1. AuthMe 6.x 对话框登录（`src/core.mjs`，+91 行）

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

### 2. webServer 懒注入（`index.js`，+10/-4）

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

---

## 三、相对上游改了什么

| 文件 | 变化 |
|---|---|
| `src/core.mjs` | +91 / -1（4 处 hunk） |
| `index.js` | +10 / -4 |
| `package-lock.json` | +2 / -2（只把 lockfile 里的版本号从 `0.1.4` 同步到 `0.1.7`，与 `package.json` 一致） |

**没有改**：`cordis.patch.yml` 保持上游默认（只有 `autoConnect: false`，**没有任何密码**）；
`package.json`、README、其余源码都未动。**没有新增依赖。**

---

## 四、怎么用

### 1. 安装

按上游 README 的方式装即可，例如：

```bash
dsh plugin --profile <你的 profile> add link:/path/to/whale-craft
```

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

---

## 五、已知限制

- 对话框解析依赖 AuthMe 的默认 action id（`*/submit`）和输入框 key（`password`）；
  自定义过对话框布局的服务器可能解析不到 —— 这时日志里会写 `AuthMe 对话框提交失败：…`。
- 只在 **EtheriumMC 26.2 / AuthMe 6.x** 上实测过。更老的 AuthMe（1.20.x 那批）走的是聊天命令
  `/login`，本分支补的那条命令能覆盖，但对话框那段不会触发。
- 需要 **DSH 0.1.7-alpha.1**（懒注入那段是为它改的）；更早的 DSH 两种写法应该都能跑，未实测。
