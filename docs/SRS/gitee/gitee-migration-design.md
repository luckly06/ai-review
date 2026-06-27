# Gitee 迁移详细设计文档（方案A：导入仓库 + 改造）

## 1. 概述

### 1.1 方案选型结论

**方案A**：利用 Gitee「从 GitHub 导入仓库」功能将 `https://github.com/luckly06/ai-review` 导入 Gitee，导入后删除 `.github/` 目录及相关 CI/CD 设施，在此基础上开发 Gitee 版飞书机器人。

### 1.2 迁移目标

全量迁移，范围覆盖：

| 模块 | 说明 |
|------|------|
| 飞书对话机器人 | Issue/PR 查询、看板查看、AI 问答 |
| CI/CD 事件通知 | push / Issue / PR 事件 → 飞书群推送 |
| AI 代码审查 | PR 触发 → MiniMax 审查 → 回写 PR 评论 + 飞书通知 |

GitHub 侧在迁移完成后逐步下线。

### 1.3 前提条件

- Gitee 账号已创建，已获取私人令牌（`https://gitee.com/personal_access_tokens`）
- Gitee 私人令牌具备 `projects`、`repo`、`webhooks` 权限
- 目标 Gitee 仓库空间充足，无同名仓库冲突
- 飞书应用凭证（App ID / App Secret）不变，无需重新申请

---

## 2. 架构设计

### 2.1 整体架构

```
飞书群消息 → lark-cli event consume → 命令路由 → Gitee OpenAPI (/api/v5)
                                           ↓
                                    MiniMax AI（不变）
                                           ↓
                                    飞书交互卡片回复（不变）
```

### 2.2 各层改动范围

| 层次 | 改动量 | 说明 |
|------|--------|------|
| 消息监听（lark-cli） | **零改动** | 飞书事件订阅逻辑完全复用 |
| 命令路由（routeCommand） | **零改动** | 关键词匹配和分发逻辑不变 |
| 卡片构造（buildXxxCard） | **零改动** | 飞书交互卡片 JSON 结构不变 |
| AI 问答管道（fetchAnswer） | **零改动** | MiniMax API 调用完全复用 |
| API 层 | **重写** | GitHub REST/GraphQL → Gitee OpenAPI REST |
| CI/CD 层 | **重做** | GitHub Actions → Gitee Webhook + 自建 HTTP 服务 |

### 2.3 技术栈不变项

| 项目 | 值 |
|------|-----|
| 运行时 | Node.js（ESM，`"type": "module"`） |
| HTTP 库 | 原生 `https` 模块（零第三方 SDK） |
| 认证方式 | Bearer Token |
| AI 模型 | MiniMax-M3（`api.minimaxi.com/v1/chat/completions`） |
| 飞书 SDK | lark-cli（`event consume` 子进程模式） |

---

## 3. 仓库初始化步骤

### 3.1 导入仓库

```
第1步：登录 Gitee，进入"新建仓库" → "从 GitHub 导入仓库"
       源地址：https://github.com/luckly06/ai-review
       仓库名称：ai-review
       可见性：根据团队需求选择（建议私有）
       勾选"导入后自动同步"（可选，初始导入后可关闭）

第2步：等待导入完成，确认所有分支和提交历史已同步
```

### 3.2 本地清理

```bash
# 克隆 Gitee 仓库到本地
git clone https://gitee.com/{owner}/ai-review.git
cd ai-review

# 删除所有 GitHub Actions 工作流和相关脚本
git rm -r .github/

# 保留核心代码（以下目录不受影响）
#   scripts/ai-review-bot/   — 飞书对话机器人源码
#   docs/                    — 设计文档
#   package.json             — 依赖配置
#   .gitignore               — Git 忽略规则

# 提交清理
git commit -m "chore: 移除 GitHub Actions，迁移至 Gitee"
git push origin main
```

### 3.3 初始化后仓库结构

```
ai-review/
├── scripts/
│   └── ai-review-bot/
│       ├── index.js          # 飞书对话机器人主逻辑（需改造）
│       ├── config.js         # 配置文件（需改造）
│       └── start.js          # 启动入口（不变）
├── docs/
│   └── SRS/
│       └── gitee/
│           ├── gitee-migration-plan.md
│           └── gitee-migration-design.md  # 本文档
├── package.json              # 不变
├── index.js                  # 示例代码（不变）
└── src/                      # 示例代码（不变）
```

---

## 4. 代码改造清单

### 4.1 飞书对话机器人（`scripts/ai-review-bot/index.js`）

#### 4.1.1 安全守卫重写

**改造前（GitHub）**：

```js
function safeGitHubRest(method, path) {
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error(`写操作被安全守卫拦截: ${method} ${path}`);
  }
  return githubRest(method, path);
}

function safeGitHubGraphQL(body) {
  if (typeof body === 'string' && body.includes('mutation')) {
    throw new Error('GraphQL mutation 被安全守卫拦截');
  }
  return githubGraphQL(body);
}
```

**改造后（Gitee）**：

```js
function safeGiteeRest(method, path) {
  // Gitee 只有 REST API，无 GraphQL
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error(`写操作被安全守卫拦截: ${method} ${path}`);
  }
  return giteeRest(method, path);
}
```

> 安全守卫逻辑简化：移除 GraphQL 分支，仅保留 REST 只读拦截。

#### 4.1.2 API 调用函数对照

| 函数 | 改造前 | 改造后 |
|------|--------|--------|
| `fetchIssues()` | `GET /repos/{owner}/{repo}/issues?state=open` | `GET /api/v5/repos/{owner}/{repo}/issues?state=open` |
| `fetchPRs()` | `GET /repos/{owner}/{repo}/pulls?state=open` | `GET /api/v5/repos/{owner}/{repo}/pulls?state=open` |
| `fetchBoard()` | GraphQL `node(id:) { ProjectV2 items }` | REST 标签聚合（见 4.2） |
| 状态变更 | GraphQL `updateProjectV2ItemFieldValue` | `PATCH /api/v5/repos/{owner}/{repo}/issues/{number}`（修改 labels） |

#### 4.1.3 请求构造变更

```js
// 改造前（GitHub）
const options = {
  hostname: 'api.github.com',
  path: `/repos/${config.github.owner}/${config.github.repo}/issues?state=open&per_page=30`,
  headers: {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-review-bot'
  }
};

// 改造后（Gitee）
const options = {
  hostname: 'gitee.com',
  path: `/api/v5/repos/${config.gitee.owner}/${config.gitee.repo}/issues?state=open&per_page=30`,
  headers: {
    Authorization: `Bearer ${config.gitee.token}`,
    'User-Agent': 'ai-review-bot'
  }
};
```

关键差异：
- 域名：`api.github.com` → `gitee.com`
- 路径前缀：无 → `/api/v5`
- 移除 GitHub 专用 Header（`Accept`、`X-GitHub-Api-Version`）
- Auth：Bearer Token 方式不变，Token 换成 Gitee 私人令牌

#### 4.1.4 响应字段映射

Gitee OpenAPI 返回结构与 GitHub 存在差异，需做字段适配：

| 数据项 | GitHub 字段 | Gitee 字段 |
|--------|------------|-----------|
| Issue 编号 | `number` | `number`（一致） |
| Issue 标题 | `title` | `title`（一致） |
| Issue 状态 | `state` | `state`（一致） |
| Issue URL | `html_url` | `html_url`（一致） |
| 创建时间 | `created_at` | `created_at`（一致） |
| 标签列表 | `labels[].name` | `labels[].name`（一致） |
| PR 的 `draft` | `draft` | 无（Gitee 无 draft PR） |
| PR 的合并状态 | `merged_at` | `merged_at`（需确认） |
| 分页 Header | `Link` 头 | 分页参数 `page`/`per_page` |

### 4.2 看板替代方案

#### 4.2.1 方案选型

GitHub Projects V2（GraphQL 驱动、列视图、拖拽交互）在 Gitee 无直接等效物。采用 **Issue 标签模拟状态机** 替代。

#### 4.2.2 标签状态定义

| 标签 | 含义 | 对应看板列 |
|------|------|----------|
| `Backlog` | 待办 | Backlog |
| `Ready` | 就绪 | Ready |
| `In Progress` | 进行中 | In Progress |
| `In Review` | 审查中 | In Review |
| `Done` | 已完成 | Done |

#### 4.2.3 看板查询实现

```js
async function fetchBoard() {
  const states = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done'];
  const counts = {};

  for (const label of states) {
    const issues = await giteeRest('GET',
      `/api/v5/repos/${config.gitee.owner}/${config.gitee.repo}/issues` +
      `?state=open&labels=${label}&per_page=1`
    );
    // Gitee 返回的 total_count 或分页信息提取总数
    counts[label] = issues.total_count || issues.length;
  }

  return { counts, states };
}
```

#### 4.2.4 状态流转实现

```js
async function updateIssueStatus(issueNumber, newLabel) {
  // 先获取当前 labels
  const issue = await giteeRest('GET',
    `/api/v5/repos/${config.gitee.owner}/${config.gitee.repo}/issues/${issueNumber}`
  );

  // 移除旧状态标签，添加新标签
  const stateLabels = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done'];
  const newLabels = issue.labels
    .filter(l => !stateLabels.includes(l.name))
    .map(l => l.name);
  newLabels.push(newLabel);

  return giteeRest('PATCH',
    `/api/v5/repos/${config.gitee.owner}/${config.gitee.repo}/issues/${issueNumber}`,
    { labels: newLabels.join(',') }
  );
}
```

#### 4.2.5 限制与取舍

| 特性 | GitHub Projects V2 | Gitee 标签方案 |
|------|-------------------|---------------|
| 列视图 | 看板 UI + 拖拽 | 无（Issue 列表过滤标签） |
| CLI 指令 | `@ai-review board` | 同，改动对用户透明 |
| 列排序 | 手动拖拽 | 按 Issue 创建时间 |
| 自定义字段 | 丰富（Text/Date/SingleSelect） | 仅标签 |
| API 复杂度 | GraphQL mutation | REST PATCH labels |

> CLI 指令操作不受影响（用户仍用 `@ai-review board` 查看板），但 Web 端不再有拖拽看板 UX。

### 4.3 CI/CD 替代方案

#### 4.3.1 现有 GitHub Actions 的处理

以下三个 workflow 文件随 `.github/` 目录一并删除：

| 文件 | 功能 | 替代方案 |
|------|------|---------|
| `notify-feishu.yml` | push/Issue/PR 事件 → 飞书卡片通知 | Gitee Webhook → 自建 HTTP 服务 |
| `ai-review.yml` | PR 事件 → MiniMax 审查 → 评论 + 通知 | Gitee Webhook → 自建 HTTP 服务 |
| `project-automation.yml` | Issue/PR 事件 → 自动移动看板卡片 | Gitee Webhook → 自动打标签 |

#### 4.3.2 自建 HTTP 服务架构

```
Gitee Webhook (push/Issue/PR 事件)
       │
       ▼
飞书机器人进程内 HTTP Server (端口 ${config.gitee.webhookPort})
       │
       ├── POST /webhook/push  → 构造推送通知卡片 → 飞书群
       ├── POST /webhook/pr    → 触发 AI 审查 + 回写评论 → 飞书群
       └── POST /webhook/issue → 自动打 labels 实现状态流转
```

#### 4.3.3 HTTP 服务实现要点

- 在 `index.js` 或独立模块中启动 `http.createServer`
- 监听端口通过 `config.gitee.webhookPort` 配置（建议 `31415` 或类似非特权端口）
- 解析 Gitee Webhook 的 JSON payload，提取事件类型（`X-Gitee-Event` Header）
- Webhook Secret 验证（Gitee 支持 `X-Gitee-Token` 签名校验）
- 服务需确保可被 Gitee 外网回调（若本地开发需内网穿透，如 ngrok/frp）

#### 4.3.4 Webhook 事件映射

| GitHub Actions 事件 | Gitee Webhook 事件 | X-Gitee-Event 值 |
|---------------------|-------------------|-----------------|
| `push` | 代码推送 | `Push Hook` |
| `issues.opened` | Issue 创建 | `Issue Hook` |
| `issues.labeled` | Issue 标签变更 | `Issue Hook`（`action: "update_label"`） |
| `pull_request.opened` | PR 创建 | `Merge Request Hook` |
| `pull_request.synchronize` | PR 更新（新提交） | `Merge Request Hook`（`action: "update"`） |
| `pull_request.closed` | PR 关闭/合并 | `Merge Request Hook`（`action: "merge"` 或 `"close"`） |

#### 4.3.5 AI 审查流程（Webhook 版）

```
Gitee PR Webhook (action=open/update)
       │
       ▼
HTTP 服务接收 → 解析 payload → 获取 PR diff
       │
       ├── Gitee OpenAPI GET /repos/{o}/{r}/pulls/{number}  → 获取 PR 详情
       ├── Gitee OpenAPI GET /repos/{o}/{r}/pulls/{number}.diff → 获取 diff
       │
       ▼
调用 MiniMax API 审查 diff → 生成审查意见
       │
       ├── Gitee OpenAPI POST /repos/{o}/{r}/pulls/{number}/comments → 回写评论
       └── 飞书 OpenAPI POST /im/v1/messages → 发送通知卡片到群
```

### 4.4 配置变更（`scripts/ai-review-bot/config.js`）

```js
// 改造前
export const config = {
  bot: {
    chatId: process.env.FEISHU_CHAT_ID,
  },
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  },
  github: {
    owner: 'luckly06',
    repo: 'ai-review',
    token: process.env.PROJECT_TOKEN,
  },
  ai: {
    apiKey: process.env.MINIMAX_API_KEY,
    model: 'MiniMax-M3',
  }
};

// 改造后
export const config = {
  bot: {
    chatId: process.env.FEISHU_CHAT_ID,
  },
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  },
  // github 段替换为 gitee 段
  gitee: {
    owner: process.env.GITEE_OWNER || 'luckly06',
    repo: process.env.GITEE_REPO || 'ai-review',
    token: process.env.GITEE_TOKEN,
    webhookPort: parseInt(process.env.GITEE_WEBHOOK_PORT || '31415'),
  },
  ai: {
    apiKey: process.env.MINIMAX_API_KEY,
    model: 'MiniMax-M3',
  }
};
```

新增环境变量：

| 变量名 | 说明 |
|--------|------|
| `GITEE_OWNER` | Gitee 用户名或组织名 |
| `GITEE_REPO` | Gitee 仓库名 |
| `GITEE_TOKEN` | Gitee 私人令牌 |
| `GITEE_WEBHOOK_PORT` | 自建 Webhook HTTP 服务端口 |

---

## 5. API 对照表

| 功能 | GitHub | Gitee |
|------|--------|-------|
| 列 Issue | `GET /repos/{o}/{r}/issues` | `GET /api/v5/repos/{o}/{r}/issues` |
| 列 PR | `GET /repos/{o}/{r}/pulls` | `GET /api/v5/repos/{o}/{r}/pulls` |
| 获取 PR diff | `GET /repos/{o}/{r}/pulls/{n}.diff` | `GET /api/v5/repos/{o}/{r}/pulls/{n}.diff` |
| PR 评论 | `POST /repos/{o}/{r}/issues/{n}/comments` | `POST /api/v5/repos/{o}/{r}/pulls/{n}/comments` |
| Issue 评论 | `POST /repos/{o}/{r}/issues/{n}/comments` | `POST /api/v5/repos/{o}/{r}/issues/{n}/comments` |
| 修改 Issue | — | `PATCH /api/v5/repos/{o}/{r}/issues/{n}` |
| 看板查询 | GraphQL `ProjectV2 items` | `GET /api/v5/repos/{o}/{r}/issues?labels=xxx` |
| 状态变更 | GraphQL `updateProjectV2ItemFieldValue` | `PATCH /api/v5/repos/{o}/{r}/issues/{n}` (labels) |
| CI/CD | GitHub Actions YAML | Gitee Webhook → HTTP 服务 |
| 事件通知 | GitHub Actions 内联飞书 API | Gitee Webhook → HTTP 服务构造卡片 |
| 认证 | Bearer Token（PAT） | Bearer Token（私人令牌） |
| API 域名 | `api.github.com` | `gitee.com` |
| API 路径前缀 | 无 | `/api/v5` |

---

## 6. 迁移阶段

| 阶段 | 内容 | 产出物 | 预估工时 |
|------|------|--------|---------|
| **阶段 1** | 仓库导入 + 初始化：执行 Gitee 导入 → clone → 删除 `.github/` → 配置 Gitee Token | Gitee 仓库就绪 | 0.5 天 |
| **阶段 2** | 对话机器人 API 改造：重写 `safeGiteeRest`、`fetchIssues`、`fetchPRs`、`fetchBoard`（标签方案）、状态流转 `PATCH labels`，更新 `config.js` | 对话机器人可用 | 2 天 |
| **阶段 3** | CI/CD 替代：自建 HTTP 服务，配置 Gitee Webhook，实现 push/Issue/PR 事件处理，联调 Webhook 回调 | CI/CD 通知 + 自动化可用 | 3 天 |
| **阶段 4** | AI 审查回写改造：PR Webhook → MiniMax 审查 → 回写 PR 评论 + 飞书通知，全链路联调测试 | 完整迁移 | 2 天 |

**总预估：7.5 天**

---

## 7. 风险与注意事项

### 7.1 技术风险

| 风险项 | 影响 | 缓解措施 |
|--------|------|---------|
| Gitee Issue 标签模拟看板丢失列视图和拖拽 UX | 中 | 对 CLI 指令操作无影响，Web 端通过标签过滤弥补 |
| Gitee Webhook 可靠性待验证（不同于 GitHub Actions 的成熟度） | 高 | 阶段 3 重点测试 Webhook 送达率和延迟，配置重试和告警 |
| Gitee OpenAPI 速率限制策略需确认 | 中 | 查阅 Gitee API 文档确认限制，必要时增加缓存和退避策略 |
| Gitee PR diff 接口返回格式与 GitHub 可能不同 | 低 | 阶段 4 联调时验证，差异通过适配层吸收 |
| 内网穿透依赖（自建 HTTP 服务需外网可达） | 中 | 使用 ngrok/frp 或直接部署在公网可访问的服务器上 |

### 7.2 注意事项

1. **不要使用 Gitee Go**：已有复盘文档（`GiteeGo为什么弃用.md`）明确结论不可用，PR 触发器不可靠、Runner 镜像缺 Python3、YAML 解析器严苛等 7 项缺陷。
2. **GitHub 侧不立即删除**：迁移完成后保留 GitHub 仓库作为只读归档，确认 Gitee 版稳定运行 2 周后再下线。
3. **Webhook Secret 必须配置**：防止未授权的 Webhook 回调触发虚假事件。
4. **标签命名冲突**：Gitee Issue 标签模拟看板时，确保 `Backlog`/`Ready`/`In Progress`/`In Review`/`Done` 标签不与现有业务标签冲突。
5. **Token 权限最小化**：Gitee 私人令牌仅授予 `repo`、`webhooks` 权限，不授予 `user`、`delete_repo` 等非必需权限。
6. **API 版本锁定**：Gitee OpenAPI 当前版本为 v5，后续升级时需关注 Breaking Changes。
