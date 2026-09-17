# 发布流程（RELEASING）

两条渠道，**互不依赖**：

| 渠道 | 谁来做 | 产物 |
| --- | --- | --- |
| **GitHub Release** | CI（打 tag 自动） | `whale_craft-<版本>.zip` + 手写更新日志 |
| **npm** | **你**（本机终端手动） | npm 上的 `whale_craft@<版本>` |

> 🔴 **CI 永远不碰 npm**：`release.yml` 里那段 `npm publish` 已经删掉（以前 token 一失效就红叉，
> 而发布其实早就成功了）。npm 想发就在本机跑下面的脚本。
> 如果你看到的还是旧工作流，先做一次 [§0 落地工作流修复](#0-落地工作流修复一次性)。

---

## 0. 落地工作流修复（一次性）

修好的工作流放在 `scripts/release.workflow.yml`（普通文件，随代码分发）。把它放进
`.github/workflows/release.yml` 并推送需要 token 有 **`workflow`** scope——脚本替你做完：

```bash
node scripts/land-workflow-fix.mjs --dry        # 先看会改什么
GITHUB_TOKEN=<你带 workflow scope 的 token> node scripts/land-workflow-fix.mjs
```

不方便搞 token 也行：把 `scripts/release.workflow.yml` 的内容直接**粘到网页上**的
`.github/workflows/release.yml`（网页编辑不需要那个 scope）。

脚本会校验 scope、复制、提交、推送，并回读确认远端已经**没有** `npm publish` 了。

---

## 1. 发 GitHub Release（CI 自动）

```bash
# 1) 改版本号 + 写更新日志（必做：工作流会拿 CHANGELOG 当正文）
#    package.json 的 version  →  比如 0.1.2
#    CHANGELOG.md 加一节      →  ## [0.1.2] - YYYY-MM-DD
git commit -am "0.1.2：…"
git push

# 2) 打 tag 并推（触发 release.yml）
git tag -a v0.1.2 -m "whale_craft 0.1.2"
git push origin v0.1.2
```

工作流会：跑 `check-core` + `selfcheck` → 校验 tag 与 `package.json` 版本一致 →
`npm pack` 后打 **zip** → 用 `CHANGELOG.md` 里 `## [0.1.2]` 那一节当 Release 正文 → 把 zip 挂上去。

**没有 npm 步骤**，不会再出现"发布成功但红叉"。

---

## 2. 发 npm（本机手动）

```bash
npm login                 # 或设 NODE_AUTH_TOKEN / 在 ~/.npmrc 里放 token（别提交进仓库）

node scripts/publish-npm.mjs --dry     # 先走一遍：干净树 / CHANGELOG / 自检 / whoami / 版本没占 / pack 清单
node scripts/publish-npm.mjs           # 真发（会要你输入 yes 确认）
node scripts/publish-npm.mjs --yes     # 跳过确认
node scripts/publish-npm.mjs --otp 123456      # 有 2FA
node scripts/publish-npm.mjs --tag next        # 发到别的 dist-tag（默认 latest）
```

脚本的前置检查（任一不过就**停**，不会发出半成品）：

1. git 工作树必须干净；
2. `package.json` 的版本必须在 `CHANGELOG.md` 里有一节；
3. `tools/check-core.mjs` + `selfcheck.mjs` 全绿（`--skip-checks` 可跳）；
4. `npm whoami` 拿得到身份（token 不可用就当场停，不会等 publish 才 404）；
5. 该版本**在 npm 上还没发过**（npm 不允许覆盖同版本）；
6. `npm pack --dry-run` 清单里没有 `logs/`、`accounts.json`、`config.json`、`.whale-craft`；
7. 提醒你 GitHub 那边有没有对应 tag（只提醒，不拦）。

发完脚本会打印 `https://www.npmjs.com/package/whale_craft/v/<版本>`。

### token 放哪

- 首选 `npm login`（凭据进 `~/.npmrc`）；
- 或环境变量 `NODE_AUTH_TOKEN`；
- 想写进本仓库的 `.npmrc` 也行——**已在 `.gitignore` 里忽略**，不会被提交。

### 配置（`package.json`）

```json
"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
```

钉死发布目标，避免本机若配了镜像 registry 而把包发错地方。

---

## 3. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 推送被拒：`… without 'workflow' scope` | token 缺 `workflow`：换 token，或改走网页编辑（§0） |
| npm `E404 Not Found - PUT https://registry.npmjs.org/whale_craft` | token 不能发布（过期/只读/非自动化 token）—— 重新 `npm login` 或换 token |
| `npm whoami` 报 401 | token 没配好；先 `npm login` |
| tag 工作流红叉、报 `npm …` 失败 | 工作流还是旧的 → 做 §0 |
| Release 正文是 `Full Changelog: …compare/…` | 工作流还是旧的（`--generate-notes`）→ 做 §0 |
| Release 附件是 `.tgz` | 同上；修好后是 `.zip` |
