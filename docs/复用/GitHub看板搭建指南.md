# GitHub Projects 看板搭建指南

本文档记录了 `luckly06/ai-review` 仓库的 GitHub Projects 看板搭建完整流程。

## 效果预览

看板地址：https://github.com/users/luckly06/projects/1

5 列布局：**Backlog** → **Ready** → **In progress** → **In review** → **Done**

## 一、前置条件

- 安装 GitHub CLI（`gh`）
- 登录 `gh auth login --web`
- 刷新权限：`gh auth refresh -h github.com -s project,read:project`

## 二、创建看板

```bash
gh project create --title "AI Review 项目看板" --owner luckly06
```

输出：
```
{
  "id": "PVT_kwHOC2zqGM4Bbalw",
  "number": 1,
  "title": "AI Review 项目看板"
}
```

**记住 Project ID**，后续步骤需要用到。

## 三、配置 Status 字段（5列）

GitHub 默认的 Status 只有 Todo/In Progress/Done，需要替换为自定义 5 列。

使用 GraphQL API 更新字段选项：

```javascript
// .github/scripts/update-status.js
import https from 'node:https';
import { execSync } from 'node:child_process';

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const STATUS_FIELD_ID = 'PVTSSF_lAHOC2zqGM4BbalwzhWLRLI'; // 你的 Status 字段 ID

// 调用 GraphQL mutation
// singleSelectOptions 需要 name + description + color 三个字段
const options = [
  { name: 'Backlog',    description: '待处理',     color: 'GRAY'   },
  { name: 'Ready',      description: '准备开始',   color: 'BLUE'   },
  { name: 'In progress',description: '进行中',     color: 'YELLOW' },
  { name: 'In review',  description: '审查中',     color: 'ORANGE' },
  { name: 'Done',       description: '已完成',     color: 'GREEN'  }
];
```

运行：`node .github/scripts/update-status.js`

## 四、关联仓库到看板

```bash
gh project link 1 --owner luckly06 --repo luckly06/ai-review
```

## 五、配置仓库 Secrets

自动化 workflow 需要以下 Secrets：

| Secret | 值 | 获取方式 |
|--------|-----|---------|
| `PROJECT_ID` | `PVT_kwHOC2zqGM4Bbalw` | 创建看板时返回的 id |
| `STATUS_FIELD_ID` | `PVTSSF_lAHOC2zqGM4BbalwzhWLRLI` | `gh project field-list 1` 查询 |
| `PROJECT_TOKEN` | `gho_xxx` | `gh auth token` 获取（需有 project 权限） |

设置命令：
```bash
gh secret set PROJECT_ID --repo owner/repo --body "PVT_xxx"
gh secret set STATUS_FIELD_ID --repo owner/repo --body "PVTSSF_xxx"
gh secret set PROJECT_TOKEN --repo owner/repo --body "$(gh auth token)"
```

> **注意**：`GITHUB_TOKEN` 无法访问用户级 Project，必须用带 `project` scope 的 PAT。

## 六、添加自动化 Workflow

文件：`.github/workflows/project-automation.yml`

```yaml
name: Project Board Automation

on:
  issues:
    types: [opened, assigned, closed, reopened]
  pull_request:
    types: [opened, ready_for_review, review_requested, closed, reopened]

permissions:
  issues: write
  pull-requests: write
  repository-projects: write

jobs:
  automate-project-card:
    runs-on: ubuntu-latest
    steps:
      - name: Move Card on Board
        env:
          GH_TOKEN: ${{ secrets.PROJECT_TOKEN }}
          PROJECT_ID: ${{ secrets.PROJECT_ID }}
          STATUS_FIELD_ID: ${{ secrets.STATUS_FIELD_ID }}
          EVENT_NAME: ${{ github.event_name }}
          EVENT_ACTION: ${{ github.event.action }}
          REPO: ${{ github.repository }}
          ISSUE_NUMBER: ${{ github.event.issue.number || '' }}
          PR_NUMBER: ${{ github.event.pull_request.number || '' }}
          IS_PR: ${{ github.event_name == 'pull_request' }}
        run: |
          node -e '
          // ... (内联 Node.js 脚本，见仓库实际文件)
          '
```

## 七、自动化规则

| 触发事件 | 目标列 |
|----------|--------|
| Issue opened / reopened | Backlog |
| Issue assigned | Ready |
| Issue closed | Done |
| PR opened / reopened | In progress |
| PR ready_for_review / review_requested | In review |
| PR closed (merged) | Done |

## 八、手动创建 Board 视图

GitHub API 不支持通过代码创建视图，需在网页操作：

1. 打开 https://github.com/users/luckly06/projects/1
2. 点击 **+ New view**
3. 选择 **Board** 布局
4. 分组方式选 **Status**

完成后即可看到横向 5 列的看板效果。

## 九、踩坑记录

### 1. GITHUB_TOKEN 权限不足

**问题**：workflow 使用 `${{ secrets.GITHUB_TOKEN }}` 报错 `Resource not accessible by integration`

**原因**：`GITHUB_TOKEN` 是仓库级 token，无法访问用户级 Project

**解决**：改用 `PROJECT_TOKEN`（个人 PAT，含 `project` scope）

### 2. updateProjectV2Field 参数错误

**问题**：GraphQL 报错 `InputObject doesn't accept argument 'projectId'`

**原因**：`updateProjectV2Field` 只需要 `fieldId`，不需要 `projectId`

### 3. field() 查询参数错误

**问题**：`field(id: $f)` 报错 `Field doesn't accept argument 'id'`

**原因**：`field()` 接受的是 `name` 参数而非 `id`

**解决**：改为 `field(name: "Status")`

### 4. singleSelectOptions 缺少必填字段

**问题**：只传 `{name: "Backlog"}` 报错 `Expected value to not be null for color/description`

**解决**：每个 option 必须包含 `name` + `description` + `color`

### 5. PowerShell 引号冲突

**问题**：PowerShell 中嵌套 JSON 字符串时引号解析出错

**解决**：将 GraphQL 查询写入 `.js` 文件或使用 `node -e '...'` 内联脚本

## 十、文件清单

| 文件 | 用途 |
|------|------|
| `.github/workflows/project-automation.yml` | 自动化 workflow |
| `.github/scripts/setup-project.js` | 看板初始化脚本（一次性） |
| `.github/scripts/update-status.js` | Status 字段更新脚本（一次性） |
| `.github/scripts/project-automation.js` | 卡片移动逻辑（独立版本） |
| `.github/scripts/create-board-view.js` | 视图创建脚本（API 不支持，仅供参考） |

## 十一、验证方式

```bash
# 创建测试 Issue
gh issue create --repo luckly06/ai-review \
  --title "测试看板" \
  --body "验证自动化"

# 检查 workflow 运行状态
gh run list --repo luckly06/ai-review --workflow project-automation.yml

# 查看看板卡片
gh project item-list 1 --owner luckly06
```

---

*文档生成时间：2026-06-23*
