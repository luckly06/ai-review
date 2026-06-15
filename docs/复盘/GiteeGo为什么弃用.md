# Gitee Go 为什么不接了 — 复盘

项目：`learn-externe`（pnpm monorepo），目标：在 PR 流水线里调 MiniMax 审查 + 回写评论。
结论：**弃用 Gitee Go，改用 GitHub Actions**。本文列具体原因（不只是"踩坑"，是"为什么这个平台不该用"）。

---

## 一、耗时

GitHub Actions：从零到端到端跑通 ≈ 10 分钟（含一次 ESM/require bug）。
Gitee Go：从建流水线到能稳定触发 PR + 写评论，**两小时还没修干净**。

差距 12 倍。不是脚本复杂度的差距，是平台基础设施可靠性的差距。

---

## 二、核心缺陷（按踩坑顺序）

### 缺陷 1：PR 触发器是黑盒，文档=误导

**症状**：创建 PR `frozen → master` 后，流水线有时不跑；手动 `Run` 又跑，但 PR_ID 永远是空。

**文档说**："创建 PR 到 master 时自动触发"。
**实际**：触发器和文档描述严重不符。要搞清楚"到底什么事件会触发"，只能靠一次次试。

**结果**：浪费 1 小时在 "是不是 yaml 写错了 / 是不是 PR 没真的创建 / 是不是要用 push 触发" 之间反复横跳。

**对比 GitHub Actions**：`on: pull_request` 行为是合约，文档=实际。

---

### 缺陷 2：手动 Run 不注入 PR 上下文

**症状**：用 UI 的 "Run" 按钮跑流水线，`PR_ID` 等 PR 相关环境变量全是空字符串。

**原因**：Gitee Go 的 "Run" 等价于 `workflow_dispatch`，本来就不该有 PR 上下文。但**文档没说清楚**，让人误以为是 PR 触发的 debug 入口。

**结果**：所有"反查 PR ID"的垃圾方案都从这里来的。

---

### 缺陷 3：runner 镜像里 python3 都没有

**症状**：想用 python 调 MiniMax API，脚本 `#!/usr/bin/env python3` 报 command not found。

**原因**：默认 `build@nodejs` 镜像只装 Node，没 Python。

**结果**：被迫用 Node 写 API 调用，多绕一圈。

**对比 GitHub Actions**：ubuntu-latest 啥语言都预装。

---

### 缺陷 4：nodeVersion 下拉选项不全

**症状**：想用 Node 20.18.0，下拉里没有，只能选 20.10.0。

**原因**：镜像版本和官方 Node 版本脱节。

**结果**：要么降版本，要么手动装 nvm。多一次折腾。

---

### 缺陷 5：默认 pipeline 模板的 `name` 会冲突

**症状**：创建第二条流水线，UI 报"名称重复"。

**原因**：默认模板有个固定名字，所有新流水线如果没改名就会撞。

**结果**：第一次建流水线就踩。

---

### 缺陷 6：Secret 命名空间绕

**症状**：`MY_GITEE_TOKEN` 要在流水线配置里**显式列出来**才能用，光在 repo Settings 配不够。

**原因**：Gitee Go 的 Secret 是流水线级 + 命名空间，不在流水线 yml 里引用就拿不到。

**对比 GitHub Actions**：`secrets.X` 自动注入，yml 里直接 `${{ secrets.X }}` 即可。

---

### 缺陷 7：YAML 解析器坑多

**症状**：
- `#` 开头的列表项被当成注释吃掉
- ASCII `:` + 空格 在字符串里被当 key-value 截断
- `*` 乘法符号在单引号字符串里被当锚点

**原因**：Gitee Go 用了一个老版本的 YAML 解析器，比 GitHub Actions 那个严苛。

**结果**：3 次踩，每次都要换写法（用单引号包、避开特殊字符）。

---

## 三、垃圾方案清单（不要做）

以下都是当时绕缺陷 1 + 缺陷 2 想出来的 workaround，**全部不要做**——它们掩盖问题，不是解决问题：

| 垃圾方案 | 为什么是垃圾 |
| --- | --- |
| **反查 PR ID**：跑完流水线后，调 Gitee API 反查 "当前分支的 open PR" | 手动 Run 时根本没有 PR，反查拿到 null 又要写 fallback，无限套娃 |
| **push 兜底触发**：commit 一行空到 PR source 分支，希望重触发 | 把"为什么 PR 不触发"这个问题彻底埋掉，永远不知道根因 |
| **跳过 PR 触发，改成定时轮询** | CI 失去"PR 提交即审查"的实时性，审查价值归零 |
| **把 AI 评论写到 repo 文件而不是 PR** | 偏离目标。目标就是 post 评论 |

**判断标准**：如果一个 workaround 让"流水线跑起来了但你不知道为啥"，就是垃圾方案。停下来找根因。

---

## 四、和 GitHub Actions 的 1 张对比表

| 维度 | Gitee Go | GitHub Actions |
| --- | --- | --- |
| PR 触发可靠性 | 黑盒，文档不符 | 合约，文档=实际 |
| 手动 Run | 不注入 PR 上下文 | 也不注入，但文档明确 |
| Runner 镜像 | 缺 python3，要绕 | 全语言预装 |
| Node 版本 | 下拉缺版本 | 任意指定 |
| Secret | 流水线级 + 显式列 | repo 级 + 自动注入 |
| YAML 解析 | 严苛（`#`、`:`、`*`） | 标准 |
| 写评论 token | 手申请 PAT | 内置 `GITHUB_TOKEN` |
| 文档质量 | 差，关键行为靠猜 | 准，按 events 分类清楚 |
| 端到端耗时 | 2h+ 没修干净 | 10min 跑通 |

---

## 五、决策

- **新项目**：默认走 GitHub Actions。
- **已上 Gitee Go 的旧项目**：触发器能稳定工作的留着；不稳定的，迁 GitHub。
- **私有仓库且必须留 Gitee**：接受踩坑成本 + 把所有 PR 触发相关逻辑做幂等（多次跑结果一样），避免漏触发。