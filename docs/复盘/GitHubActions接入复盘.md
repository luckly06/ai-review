# GitHub Actions 接入 AI 审查 — 复盘

测试仓库：`luckly06/ai-review`
目标：PR 触发 → 调 MiniMax 审查 → 自动 post 评论

---

## 一、最终跑通的链路

```
PR open/update → .github/workflows/ai-review.yml
              → checkout (fetch-depth: 0)
              → node .github/scripts/ai-review.js
                ├─ git fetch origin <base> && git diff origin/<base>...HEAD
                ├─ POST https://api.minimaxi.com/v1/chat/completions  (model: MiniMax-M3)
                └─ POST /repos/{owner}/{repo}/issues/{pr}/comments    (Authorization: Bearer $GITHUB_TOKEN)
```

---

## 二、踩坑清单

### 坑 1：git 全局代理不通，push 失败

**现象**：
```
fatal: unable to access 'https://github.com/...': Failed to connect to 127.0.0.1 port 10808 after 2056 ms
```

**原因**：`git config --global http.proxy=http://127.0.0.1:10808` 是历史遗留配置，但代理进程没启动。

**解决**：临时绕过代理直连（GitHub 在国内其实可达）：
```bash
git -c http.proxy= -c https.proxy= push -u origin main
```

**教训**：先 `git config --global --get http.proxy` 看一眼，别盲目重试。

---

### 坑 2：`pull_request` 触发必须有 PR，main 直接 commit 不会跑

**现象**：在 main 上 push commit，Actions 页面 0 runs。

**原因**：`on: pull_request` 只在 PR 创建/更新/同步时触发，直接 push 到 base 分支不算 PR。

**解决**：
1. 新建分支：`git checkout -b test/ai-review-trigger`
2. 改文件 + commit + push 分支
3. Web 上开 PR 到 main → workflow 自动跑

**教训**：本地有改动 ≠ workflow 会跑，触发器和 webhook 事件类型绑定。

---

### 坑 3：ESM 文件里写了 `require` → ReferenceError

**现象**（Actions 日志）：
```
ReferenceError: require is not defined
    at readDiff (file:///.../ai-review.js:23:24)
```

**原因**：`package.json` 里有 `"type": "module"`，脚本用了 `import https from 'node:https'`，但我在 `readDiff` 函数里又写了 `const { execSync } = require('node:child_process')` — Node ESM 没有 `require`。

**解决**：
```js
// 顶部统一 import
import https from 'node:https';
import { execSync } from 'node:child_process';
```

**教训**：先确定模块系统（CommonJS / ESM），全文件统一。混用是雷。

---

### 坑 4：Node.js 20 actions 弃用警告（warning，非 error）

**现象**：Annotations 里报：
```
Node.js 20 actions are deprecated. The following actions are running on Node.js 20:
actions/checkout@v4, actions/setup-node@v4.
Node.js 20 will be removed from the runner on September 16th, 2026.
```

**现状**：只是 warning，不影响 run。但 `node-version: '20'` 之后会被强制升 24。

**解决方向**（未做，留作后续）：
- 升 `actions/checkout@v5`（如果已 GA）
- 或显式 `node-version: '24'`

**教训**：GitHub Actions runner 的 Node 版本会轮换，看 changelog 不要等到被强制。

---

### 坑 5：permissions 默认 `GITHUB_TOKEN` 不能写 PR 评论？

**现状**：`pull-requests: write` 显式声明后，post 评论 OK。没踩坑，但必须写。

**反面**：如果不写 `permissions:` 块，默认 read-only，会 403。

---

## 三、最后能跑通的最小配置

`.github/workflows/ai-review.yml`：
```yaml
name: AI Review

on:
  pull_request:
    branches: [main, master]
  workflow_dispatch:

permissions:
  pull-requests: write
  contents: read

jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: AI Review with MiniMax
        env:
          MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
          BASE_REF: ${{ github.event.pull_request.base.ref }}
        run: node .github/scripts/ai-review.js
```

要点：
- `pull_request` + `branches: [main, master]` 限定目标分支
- `workflow_dispatch` 留个手动入口（PR_NUMBER 会为空，脚本里 fail-fast 即可）
- `permissions.pull-requests: write` 是写评论必需
- `secrets.MINIMAX_API_KEY` 必须在 repo Settings → Secrets and variables → Actions 里配

---

## 四、和 Gitee Go 的对比（不重复踩坑）

| 维度       | Gitee Go                               | GitHub Actions                     |
| ---------- | -------------------------------------- | ---------------------------------- |
| 触发器可靠性 | PR open 经常不触发，文档误导              | `pull_request` 稳定触发                |
| Secret 配置 | 流水线级 + 命名空间                     | repo 级 Secrets，标准               |
| Token      | 需要手动申请 Gitee PAT                  | 内置 `GITHUB_TOKEN`                  |
| API 风格    | 私有接口                               | 标准 REST + v3 header               |
| 文档可靠性 | 差，触发器行为和文档不符                  | 一致，按 events 类型走              |

**结论**：如果两者都可用，优先 GitHub Actions。