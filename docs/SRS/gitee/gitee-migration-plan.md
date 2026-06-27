---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: e4fe4c10b6a2b39c74fe8c9585235918_3a006d3d720911f1b2f55254006c9bbf
    ReservedCode1: FOvs/a2PxYDjV3qx2J2hOI9eUnkYbzwjOR+vh4SBW7+aqlEVtE6vcMIqGqVjt9UwgdurHHMLg+95R8r2ZqYk8PxHyELywwuxLgMqFbf+Ey+ZCIUbjC4yhf0FTMSb+lBm3E+g4BHxuRmC96qwdNA7v2j+9yhQ5zZFYTgnUHuy3gwJFGnvuvlM8Jhj4nA=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: e4fe4c10b6a2b39c74fe8c9585235918_3a006d3d720911f1b2f55254006c9bbf
    ReservedCode2: FOvs/a2PxYDjV3qx2J2hOI9eUnkYbzwjOR+vh4SBW7+aqlEVtE6vcMIqGqVjt9UwgdurHHMLg+95R8r2ZqYk8PxHyELywwuxLgMqFbf+Ey+ZCIUbjC4yhf0FTMSb+lBm3E+g4BHxuRmC96qwdNA7v2j+9yhQ5zZFYTgnUHuy3gwJFGnvuvlM8Jhj4nA=
---

# Gitee 迁移方案分析

> 本文档基于当前 `ai-review` 项目的代码实现和踩坑复盘，系统性分析从 GitHub 迁移到 Gitee 的可行路径、改造范围与风险。

---

## 1. 现有方案架构回顾

当前协作平台采用 **飞书群 + 飞书自建应用机器人 + GitHub Projects** 三层架构：

```
┌──────────────────────────────────────────────────────┐
│                    飞书群（交互层）                     │
│   @ai-review board / issue / pr / <自由问答>           │
└──────────────────────┬───────────────────────────────┘
                       │ lark-cli event consume (子进程)
┌──────────────────────▼───────────────────────────────┐
│             飞书对话机器人 ai-review-bot/              │
│  · index.js   — 事件监听 / 命令路由 / 卡片回贴         │
│  · config.js  — Multi-profile 凭证管理                │
│  · 安全守卫    — safeGitHubRest / safeGitHubGraphQL   │
│  · AI 管道    — MiniMax M3 自由问答 + 数据评注         │
└──────┬────────────────────┬──────────────────────────┘
       │ GitHub REST API v3 │ GitHub GraphQL API v4
┌──────▼────────────────────▼──────────────────────────┐
│                 GitHub 平台（数据层）                   │
│  · Issues / Pull Requests  — 任务与代码评审            │
│  · Projects V2 (看板)      — 状态流转可视化            │
│  · GitHub Actions (CI/CD)  — 自动审查 + 通知           │
└──────────────────────────────────────────────────────┘
```

**三大流水线**：

| 流水线 | 触发方式 | 核心脚本 | 职责 |
|--------|---------|----------|------|
| 对话交互 | 飞书群 @机器人 | `index.js` | 查看板 / 列 Issue / 列 PR / AI 问答 |
| 看板自动化 | Issue/PR 事件 | `project-automation.yml` + 内嵌脚本 | 自动将 Issue/PR 移入对应看板列 |
| CI/CD 审查 | PR 同步事件 | `ai-review.yml` + `ai-review.js` | git diff → MiniMax 审查 → 回写 PR 评论 → 飞书通知 |

**技术特征**：所有 GitHub API 调用均使用 Node.js 原生 `https` 模块直调，零第三方 SDK 依赖。认证统一使用 Bearer Token。

---

## 2. Gitee 不需要 CLI 的说明

### 2.1 当前方案的技术栈

当前方案**没有使用** `gh` CLI（GitHub 官方命令行工具）。所有 API 调用均为 Node.js 原生 `https.request()` + 手动构造 HTTP 请求，直接与 GitHub REST/GraphQL 端点交互。

### 2.2 Gitee API 能力对标

Gitee 提供了完整的 **OpenAPI v5**（`https://gitee.com/api/v5`），覆盖 REST 风格的仓库管理、Issue/PR 操作、Webhook 配置等接口，完全具备替代 GitHub REST API v3 所需的能力。

不需要任何 Gitee CLI 工具即可完成迁移，改造范围仅限于：

- API 域名替换（`api.github.com` → `gitee.com/api/v5`）
- 请求头适配（`Accept` 和 `X-GitHub-Api-Version` 删除或替换为 Gitee 对应字段）
- 响应数据结构映射（字段名、嵌套层级差异）

---

## 3. 三层迁移分析

### 3.1 第一层：飞书对话机器人（改造量：小）

**涉及文件**：`scripts/ai-review-bot/index.js`、`config.js`

| 改造点 | GitHub 现状 | Gitee 适配 |
|--------|------------|------------|
| **API 域名** | `api.github.com` | `gitee.com/api/v5` |
| **REST 端点** | `/repos/{o}/{r}/issues` | `/repos/{o}/{r}/issues`（路径一致，参数差异小） |
| **REST 端点** | `/repos/{o}/{r}/pulls` | `/repos/{o}/{r}/pulls`（`state`/`per_page` 参数通用） |
| **PR 评论** | POST `/repos/.../issues/{n}/comments` | POST `/repos/.../pulls/{number}/comments` |
| **看板查询** | GraphQL `node(id:)` + `ProjectV2` | 替换为企业版看板 REST API 或 Issue 标签方案（见 3.2） |
| **认证头** | `Authorization: Bearer <token>` | 相同 |
| **请求头** | `Accept: application/vnd.github+json` | 删除此行 |
| **响应解析** | `json[i].title` / `.html_url` / `.user.login` | 字段名映射（如 `html_url` 仍保留，差异较小） |

**安全守卫重写**：

当前的双层防御机制（`safeGitHubRest` 和 `safeGitHubGraphQL`）直接绑定了 GitHub 域名和 GraphQL mutation 关键词检测。迁移到 Gitee 后需重写为 `safeGiteeRest`，策略不变：

- REST 守卫：仅放行 `GET` / `HEAD` 方法
- GraphQL 守卫在 Gitee 场景下可移除（Gitee 不暴露 GraphQL），或在机器人中保留空壳以备后续扩展

**工作量评估**：1 人天（含测试）

---

### 3.2 第二层：看板自动化（改造量：大——需重新设计）

#### 3.2.1 现状分析

当前看板自动化完全依赖 **GitHub GraphQL API v4** 操作 Projects V2：

- `project-automation.yml` 监听到 Issue/PR 事件后，内嵌 JavaScript 脚本通过 GraphQL mutation 将卡片移入对应看板列
- `index.js` 中 `fetchBoard()` 通过 GraphQL query 查询看板各列卡片数
- 用到 7 种不同的 GraphQL query/mutation

#### 3.2.2 Gitee 看板能力现状

Gitee **没有** Projects V2 等效实现，也**不提供** GraphQL API。其看板能力分为两个层级：

| 层级 | 产品 | API 支持 | 备注 |
|------|------|---------|------|
| 社区版 | Issue 标签 + 里程碑 | REST API 完整 | 免费，所有仓库可用 |
| 企业版 | 项目（Project）看板 | 企业版专属 API | 需付费，功能类似 GitHub Projects V1 |

#### 3.2.3 三种替代方案对比

| 方案 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| **方案 A：企业版看板 API** | 直接调 Gitee 企业版看板 REST API，替换 GraphQL mutation | 体验最接近现状，看板 UI 一致 | 需购买企业版；API 文档和稳定性待验证 |
| **方案 B：Issue 标签 + 里程碑（推荐）** | 用标签（如 `status:待处理` / `status:进行中` / `status:已完成`）模拟看板列，里程碑关联迭代 | 免费、社区版通用、REST API 成熟稳定、标签筛选 UI 即为天然看板 | 没有拖拽看板 UI，需适应标签筛选工作流 |
| **方案 C：外部看板 + Webhook 同步** | 自建或使用第三方看板（如飞书多维表格），通过 Gitee Webhook 事件实时同步 Issue/PR 状态 | 看板 UI 可完全自定义，飞书多维表格零成本 | 需额外维护同步服务，增加运维复杂度 |

**推荐路径**：优先采用**方案 B（Issue 标签 + 里程碑）**，理由：

1. 零成本、通用性强，所有 Gitee 仓库均可用
2. REST API 成熟，`getIssueLabels` / `addIssueLabel` / `deleteIssueLabel` 等端点完整
3. 标签筛选器即可充当"看板视图"，轻量够用
4. `project-automation.yml` 的改造思路：Issue 事件触发 → 调 Gitee API 设置/更新/迁移 Issue 标签 → 完成状态流转

#### 3.2.4 改造范围

| 改造项 | 现状 | 目标 |
|--------|------|------|
| `fetchBoard()` | GraphQL 查 ProjectV2 列计数 | REST 查询各标签下 Issue 数量 |
| `project-automation.yml` | GraphQL mutation 移卡片 | REST 调用 Issue 标签 CRUD |
| `config.js` 看板配置 | `projectId` / `statusFieldId` | 标签名映射表（如 `{open: "status:待处理", in_progress: "status:进行中", done: "status:已完成"}`） |
| `index.js` 看板卡片渲染 | 各列卡片数 | 各标签 Issue 数 + 里程碑进度 |

**工作量评估**：2-3 人天

---

### 3.3 第三层：CI/CD 审查流水线（改造量：中——需替代方案）

#### 3.3.1 现状分析

当前 CI/CD 审查流水线依赖 **GitHub Actions**：

- `ai-review.yml`：PR `synchronize` 事件触发，checkout 代码 → `git diff` → 调 MiniMax API 审查 → POST PR comment → POST 飞书通知
- `notify-feishu.yml`：监听 `push` / `issues` / `pull_request` 多事件，解析后 POST 飞书卡片通知

#### 3.3.2 Gitee Go 弃用事实

根据 `docs/复盘/GiteeGo为什么弃用.md` 的踩坑记录，Gitee Go 存在 **7 项致命缺陷**：

1. PR 触发器不可靠（文档与行为不符，黑盒问题难排查）
2. Runner 镜像缺少 Python3 等常用工具链
3. YAML 解析器过于严苛，语法兼容性差
4. Secret 配置存在绕过风险
5. 调试日志不透明，排错成本极高
6. 社区活跃度低，问题响应慢
7. 官方已事实停止维护更新

**结论：Gitee Go 不可用于生产环境 CI/CD。**

#### 3.3.3 替代方案

| 方案 | 架构 | 适用性 |
|------|------|--------|
| **Webhook + 自建 Jenkins** | Gitee Webhook 推送事件 → Jenkins 拉取代码 → 执行审查脚本 | 适合已有 Jenkins 基础设施的团队 |
| **Webhook + 自建 Node 服务（推荐）** | Gitee Webhook → 独立 Node 服务（复用现有 `ai-review.js` 逻辑）→ 调 MiniMax → 回写 PR 评论 | 与现有 Node.js 技术栈一致，无额外基础设施成本 |
| **Webhook + GitHub Actions（混合）** | 代码同步到 GitHub 镜像仓库 → GitHub Actions 执行审查 | 维护两套仓库，增加同步复杂度 |

#### 3.3.4 推荐方案：Webhook + 自建 Node 服务

```
Gitee PR 事件 → Webhook POST
                 │
                 ▼
        自建 Node 服务（常驻进程）
                 │
        ┌────────┼────────┐
        ▼        ▼        ▼
    git diff   MiniMax   回写 PR 评论
    (本地仓库)  API       (Gitee API)
```

复用要点：
- `ai-review.js` 中的核心逻辑（`git diff` → MiniMax 审查）可直接复用
- 将 `postComment` 的 GitHub API 调用替换为 Gitee API
- 将飞书通知部分提取为公共模块，机器人侧和 CI 侧共享
- `notify-feishu.yml` 的 Webhook 事件解析逻辑可复用，仅需适配 Gitee Webhook 事件结构

#### 3.3.5 Gitee Webhook 事件结构差异

Gitee Webhook 与 GitHub Webhook 的事件结构相似但字段命名不同：

| 字段 | GitHub | Gitee |
|------|--------|-------|
| 事件类型头 | `X-GitHub-Event` | `X-Gitee-Event` |
| PR 对象 | `pull_request` | `pull_request`（结构类似） |
| Issue 对象 | `issue` | `issue`（结构类似） |
| 仓库全名 | `repository.full_name` | `repository.full_name`（一致） |
| 签名验证 | `X-Hub-Signature-256` | `X-Gitee-Token`（简化，仅比对 Secret） |

**工作量评估**：2-3 人天（含自建 Node 服务开发 + Webhook 事件解析适配）

---

## 4. 迁移路线

采用**逐层递进、分批切换**策略，确保每阶段可独立交付、可回滚。

### 阶段一：对话机器人迁移（1 天）

**目标**：飞书机器人的 Issue/PR 查询和 AI 问答功能切换至 Gitee API

**改造清单**：
1. `config.js` 新增 Gitee profile（`apiBase: "gitee.com/api/v5"`，token 字段）
2. `index.js` 中 `fetchIssues()` 和 `fetchPRs()` 的 API 域名和路径替换
3. `safeGitHubRest` → `safeGiteeRest`（仅放行 `GET`/`HEAD`）
4. 删除 `safeGitHubGraphQL`
5. 看板命令 `board` 暂时降级为"迁移中"提示
6. 响应数据结构字段映射调整

**验证方式**：在飞书群中 @机器人执行 `issue` / `pr` / `ask` 命令，确认返回数据正确

---

### 阶段二：看板标签方案实施（2-3 天）

**目标**：用 Issue 标签 + 里程碑方案替代 GitHub Projects V2 看板

**改造清单**：
1. 设计标签命名规范：`status:待处理` / `status:进行中` / `status:待审核` / `status:已完成`
2. Gitee 仓库初始化标签和里程碑
3. 重写 `fetchBoard()`：通过 Gitee REST API 按标签统计 Issue 数量
4. 重写 `project-automation.yml` 等效逻辑：
   - 新建 Issue → 自动打 `status:待处理` 标签
   - Issue 状态变更 → 自动更新标签
5. 机器人看板卡片 UI 适配（标签统计 → 看板视图）

**验证方式**：创建/关闭 Issue，确认标签自动更新；机器人查看看板命令返回正确统计

---

### 阶段三：CI/CD 替代方案搭建（2-3 天）

**目标**：用 Webhook + 自建 Node 服务替代 GitHub Actions

**改造清单**：
1. 搭建独立 Node 服务，集成现有 `ai-review.js` 审查逻辑
2. 配置 Gitee Webhook（PR 事件 → 自建服务地址）
3. 适配 Gitee Webhook 事件结构（字段映射 + X-Gitee-Token 签名验证）
4. PR 评论 API 从 GitHub 切换到 Gitee（`POST /repos/{o}/{r}/pulls/{number}/comments`）
5. 飞书通知模块公共化，机器人侧和 CI 侧共享
6. 配置服务守护进程（PM2 / systemd / Windows Service）

**验证方式**：创建 PR → 确认触发审查 → 审查结果回写到 Gitee PR 评论区 → 飞书收到通知卡片

---

### 阶段四：端到端联调与 AI 审查回写（1-2 天）

**目标**：全链路验证，确保三层协作顺畅

**联调清单**：
1. 端到端流程测试：飞书 @机器人 → 查 Issue → AI 问答 → PR 审查 → 看板标签 → 飞书通知
2. 异常场景测试：API 超时、Token 过期、Webhook 重放
3. 性能基线对比：API 响应延迟（GitHub vs Gitee）
4. 文档更新：SRS 需求文档补充 Gitee 章节

**总预估工期：7-10 人天**

---

## 5. API 对照表

### 5.1 Issue / PR 列表与评论

| 功能 | GitHub REST API v3 | Gitee OpenAPI v5 |
|------|-------------------|------------------|
| 列 open Issue | `GET /repos/{o}/{r}/issues?state=open` | `GET /api/v5/repos/{o}/{r}/issues?state=open` |
| 列 open PR | `GET /repos/{o}/{r}/pulls?state=open` | `GET /api/v5/repos/{o}/{r}/pulls?state=open` |
| 获取单个 Issue | `GET /repos/{o}/{r}/issues/{n}` | `GET /api/v5/repos/{o}/{r}/issues/{number}` |
| 获取单个 PR | `GET /repos/{o}/{r}/pulls/{n}` | `GET /api/v5/repos/{o}/{r}/pulls/{number}` |
| 创建 Issue 评论 | `POST /repos/{o}/{r}/issues/{n}/comments` | `POST /api/v5/repos/{o}/{r}/issues/{number}/comments` |
| 创建 PR 评论 | `POST /repos/{o}/{r}/issues/{n}/comments` | `POST /api/v5/repos/{o}/{r}/pulls/{number}/comments` |
| PR diff | 需自行 `git diff` | 同（Gitee 无直接 diff API 端点） |

### 5.2 Issue 标签操作

| 功能 | GitHub REST API v3 | Gitee OpenAPI v5 |
|------|-------------------|------------------|
| 获取仓库标签 | `GET /repos/{o}/{r}/labels` | `GET /api/v5/repos/{o}/{r}/labels` |
| 为 Issue 添加标签 | `POST /repos/{o}/{r}/issues/{n}/labels` | `POST /api/v5/repos/{o}/{r}/issues/{number}/labels` |
| 删除 Issue 标签 | `DELETE /repos/{o}/{r}/issues/{n}/labels/{name}` | `DELETE /api/v5/repos/{o}/{r}/issues/{number}/labels/{name}` |
| 替换 Issue 所有标签 | `PUT /repos/{o}/{r}/issues/{n}/labels` | —（需先删再加） |

### 5.3 看板操作

| 功能 | GitHub GraphQL API v4 | Gitee 替代方案 |
|------|----------------------|---------------|
| 查看看板状态 | `node(id:) { ProjectV2 { items { fieldValueByName } } }` | 按标签统计 Issue 数量（REST） |
| 添加卡片到看板 | `addProjectV2ItemById` mutation | 为 Issue 添加标签（REST） |
| 移动卡片列 | `updateProjectV2ItemFieldValue` mutation | 更新 Issue 标签（REST） |
| 创建看板 | `createProjectV2` mutation | 标签 + 里程碑组合（REST）或企业版 Project API |

### 5.4 Webhook 事件

| 功能 | GitHub Webhook | Gitee Webhook |
|------|---------------|---------------|
| 事件类型头 | `X-GitHub-Event: pull_request` | `X-Gitee-Event: Pull Request` |
| 签名验证 | `X-Hub-Signature-256: sha256=...` | `X-Gitee-Token: <secret>` |
| PR 事件 payload | `pull_request` + `action` 字段 | 结构类似，字段命名略有差异 |
| Issue 事件 payload | `issue` + `action` 字段 | 结构类似，字段命名略有差异 |
| Push 事件 payload | `ref` / `commits` 数组 | `ref` / `commits` 数组（结构一致） |

### 5.5 认证与请求头

| 项目 | GitHub | Gitee |
|------|--------|-------|
| 认证方式 | `Authorization: Bearer <token>` | `Authorization: Bearer <token>` |
| API 版本头 | `Accept: application/vnd.github+json` | 不需要 |
| API 版本头 | `X-GitHub-Api-Version: 2022-11-28` | 不需要 |
| User-Agent | 建议设置 | 建议设置 |
| Token 申请路径 | Settings → Developer Settings → PAT | 设置 → 私人令牌 |
| Token 权限 scope | `repo`, `project` | `projects`, `issues`, `pull_requests` |

---

## 6. 风险与注意事项

### 6.1 技术风险

| 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|---------|
| Gitee API 稳定性 | 中 | API 限流、偶发 5xx 导致机器人响应失败 | 增加重试机制（指数退避），机器人侧发错误卡片提示 |
| 看板体验降级 | 中 | 从拖拽看板退化到标签筛选，团队适应成本 | 在标签页面固定筛选条件作为快捷入口；若体验不可接受再评估企业版 |
| Webhook 延迟 | 低 | PR 事件到审查触发的延迟可能高于 GitHub Actions | 设置 Webhook 超时告警，自建服务部署在同区域云主机 |
| Token 泄漏风险 | 高 | Gitee Token 落入版本控制或日志 | Token 一律走环境变量，`.gitignore` 严格排除 `config.js`（或敏感字段抽取为 `config.local.js`） |
| 自建服务可用性 | 中 | Node 服务宕机导致审查中断 | PM2 守护进程 + 自动重启 + 健康检查探针 |

### 6.2 功能差异

| 差异点 | 说明 |
|--------|------|
| **Projects V2 缺失** | Gitee 社区版没有看板产品，标签方案是功能降级替代，团队须接受工作流调整 |
| **GraphQL 不可用** | 所有看板查询逻辑需要从 GraphQL 改为 REST 聚合查询（多次 API 调用），增加网络开销 |
| **PR diff 无直读 API** | Gitee 不像 GitHub 提供 `/pulls/{n}/files` 端点，审查脚本必须依赖本地仓库的 `git diff` |
| **Actions 生态缺失** | Gitee Go 不可用，无法享受 Actions Marketplace 生态，所有流水线需自建 |
| **企业版看板 API 不透明** | 企业版看板 API 文档公开度低，选型前需联系 Gitee 商务确认 API 完整性和 SLA |

### 6.3 流程变更

| 变更项 | 现状（GitHub） | 迁移后（Gitee） |
|--------|---------------|----------------|
| 任务状态查看 | 飞书机器人 → GraphQL 查看板列 | 飞书机器人 → REST 统计标签 |
| 任务状态变更 | PR/Issue 事件 → Action 自动移看板 | Webhook → 自建服务 → 更新标签 |
| AI 审查触发 | PR synchronize → GitHub Actions | PR 事件 → Webhook → 自建 Node 服务 |
| 审查结果查看 | GitHub PR 评论区 | Gitee PR 评论区（功能一致） |
| 紧急回滚 | 切回 GitHub Token 即可 | 机器人需切换 profile 配置，CI 需重配 Webhook |

### 6.4 迁移前准备清单

- [ ] 在 Gitee 创建组织/仓库，导入现有代码和历史
- [ ] 在 Gitee 申请 API Token（scopes: `projects`, `issues`, `pull_requests`）
- [ ] 设计 Issue 标签命名规范和状态流转规则
- [ ] 搭建自建 Node 服务的运行环境（服务器 / 云函数）
- [ ] 在 Gitee Webhook 配置中添加自建服务回调地址
- [ ] 飞书机器人 `config.js` 中新增 Gitee profile
- [ ] 准备回滚方案：保留 GitHub 仓库作为备份，机器人支持双 profile 切换

---

## 附录：关键文件改造映射

| 当前文件 | 改造类型 | 目标 |
|---------|---------|------|
| `scripts/ai-review-bot/index.js` | 修改 | API 域名 + 路径替换，安全守卫重写，看板命令改为标签统计 |
| `scripts/ai-review-bot/config.js` | 修改 | 新增 Gitee profile 配置项 |
| `.github/workflows/project-automation.yml` | 重写 | 改为独立 Node 服务，通过 Webhook 触发，调 Gitee 标签 API |
| `.github/workflows/ai-review.yml` | 重写 | 改为独立 Node 服务，通过 Webhook 触发 |
| `.github/workflows/notify-feishu.yml` | 重写 | 改为独立 Node 服务或飞书机器人模块内接收 Webhook |
| `.github/scripts/ai-review.js` | 复用 | 提取审查核心逻辑为公共模块，CI 服务和机器人侧共享 |
| `docs/SRS/feishu-github-notify.md` | 补充 | 新增 Gitee 适配章节 |
*（内容由AI生成，仅供参考）*
