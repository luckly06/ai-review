# 飞书机器人职责边界

> **核心原则：各司其职，互不越界。选机器人前先问自己：这件事归谁管？**

---

## 机器人总览

| 机器人 | App ID | 主群 | 身份 |
|--------|--------|------|------|
| **ai-review** | `cli_aab1fae329b99bb4` | `group-learn` (`oc_e98c804bce08a68b7b6b841545da4441`) | 业务机器人 |
| **GitHub通知Bot** | `cli_aab1c52bbdb85bd6` | `group-github` (`oc_2392f68ca918e85bb2a7ea880eb16b57`) | 事件通知机器人 |
| **请假交接Bot** | `cli_aab611ea27f8dbe2` | `group-learn` (`oc_e98c804bce08a68b7b6b841545da4441`) | 请假解析+任务交接 |

---

## ai-review（业务机器人）

### 职责范围

| 能力 | 方向 | 说明 |
|------|------|------|
| GitHub 看板 | 读 | 查询 Project 看板状态、获取 Issue/PR 列表 |
| GitHub Issue | 写 | 创建、关闭、更新 Issue |
| AI 代码审查 | → 飞书 | PR 审查完成后，自动推送审查结果卡片到 group-learn |
| 飞书群组 | 读+写 | 读取群消息、发送项目进展汇报、@成员 |
| 进度同步 | → 飞书 | 把 GitHub 看板进展主动推送给 group-learn 组员 |

### 典型场景

```
✅ "帮我看一下看板上还有哪些 Issue 没关"        → 用 ai-review 查
✅ "在仓库里开个 Issue 记录这个 bug"            → 用 ai-review 创建
✅ "把今天的开发进展发到 group-learn"           → 用 ai-review 发
✅ "读取 group-learn 里最新的消息"              → 用 ai-review 读
✅ PR 审查完成后 group-learn 收到紫色审查卡片    → ai-review 自动推送（ai-review.yml 触发）
```

### 使用方式

```bash
# 切换到 ai-review 身份
lark-cli config init --app-id cli_aab1fae329b99bb4 --app-secret-stdin --brand feishu
# 或直接指定 --as bot（需先配置好该 app）
lark-cli im +messages-send --chat-id oc_e98c804bce08a68b7b6b841545da4441 ...
```

---

## GitHub通知Bot（事件通知机器人）

### 职责范围

| 能力 | 方向 | 说明 |
|------|------|------|
| push 事件 | → 飞书 | 代码提交后自动推送卡片到 group-github |
| issues 事件 | → 飞书 | Issue 创建/关闭时自动推送卡片到 group-github |
| pull_request 事件 | → 飞书 | PR 创建/审查/合并时自动推送卡片到 group-github |

### 触发机制

**仅通过 GitHub Actions workflow 自动触发**，不手动调用：

```yaml
# .github/workflows/notify-feishu.yml
on:
  push:
    branches: [main]
  issues:
    types: [opened, closed]
  pull_request:
    types: [opened, closed, ready_for_review]
```

### 典型场景

```
✅ push 到 main 后 group-github 收到蓝色卡片     → GitHub通知Bot 自动触发
✅ 开 Issue 后 group-github 收到橙色卡片         → GitHub通知Bot 自动触发
❌ 手动调用 GitHub通知Bot 往 group-learn 发消息   → 违规！这是 ai-review 的活
❌ 用 GitHub通知Bot 的凭证读取飞书群消息          → 违界！它只负责单向推送
```

---

## 请假交接Bot（请假解析+任务交接）

### 职责范围

| 能力 | 方向 | 说明 |
|------|------|------|
| 群消息监听 | 读 | 实时监听群内 @机器人 的消息（`lark-cli event consume`） |
| 请假解析 | — | 从消息中提取请假人、时间、待交接内容、指定交接人 |
| 风险评级 | — | P0(红)/P1(橙)/P2(黄)/P3(绿) 四级评估 |
| 交接卡片 | → 飞书 | 发送交互式卡片到群聊（含认领按钮） |
| 飞书任务 | 写 | P0/P1 创建飞书任务并分配给交接人 |
| @Leader | → 飞书 | P0 级别额外 @Leader 提醒 |

### 触发机制

**本地常驻进程实时监听**，非 GitHub Actions：

```bash
# 启动机器人（本地运行）
node scripts/leave-bot/start.js
# 底层调用：lark-cli event consume im.message.receive_v1 --as bot
```

### 典型场景

```
✅ @请假交接Bot 我明天发烧请假，手里 P1 Bug 没改完   → P1 橙色卡片 + 创建任务
✅ @请假交接Bot 后天年假，已交接完毕               → P3 绿色卡片
✅ @请假交接Bot 明天事假，线上有个故障没修         → P0 红色卡片 + 创建任务 + @Leader
❌ 用请假交接Bot 发非请假相关消息                  → 违规！它只处理请假交接
```

---

## 边界红线（绝对不能做的事）

| # | 错误行为 | 正确做法 |
|---|---------|---------|
| 1 | ai-review 往 group-github 发 GitHub 事件通知 | 只有 GitHub通知Bot 能发事件通知 |
| 2 | GitHub通知Bot 往 group-learn 发任何消息 | group-learn 归 ai-review 管 |
| 3 | GitHub通知Bot 用于读取群消息或 @成员 | 它是只读事件→飞书的单向通道 |
| 4 | 用 GitHub通知Bot 的 App ID/Secret 做 AI 对话类操作 | 对话类用 ai-review |
| 5 | workflow 中混用两套凭证 | notify-feishu.yml 只用 `FEISHU_GITHUB_BOT_*` 前缀的 Secret |
| 6 | 请假交接Bot 发非请假相关消息 | 它只处理 @机器人 的请假交接 |
| 7 | 请假交接Bot 用其他机器人的凭证 | 请假Bot 只用 `FEISHU_LEAVE_BOT_*` 前缀的 Secret |

---

## 凭证引用对照

| 场景 | Secret 前缀 | 机器人 |
|------|------------|--------|
| GitHub Actions 自动通知 | `FEISHU_GITHUB_BOT_APP_ID/SECRET/CHAT_ID` | GitHub通知Bot |
| AI Agent 主动操作（读看板、发进展） | `FEISHU_AI_REVIEW_APP_ID/SECRET/CHAT_ID` | ai-review |
| 请假交接（本地常驻进程） | `FEISHU_LEAVE_BOT_APP_ID/SECRET/CHAT_ID` | 请假交接Bot |

> 如果后续在 workflow 或脚本中需要用到 ai-review 的能力，Secret 命名必须带 `AI_REVIEW` 前缀，与 `GITHUB_BOT` 严格区分。请假交接Bot 的 Secret 必须带 `LEAVE_BOT` 前缀。
