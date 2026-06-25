# 任务：GitHub 事件自动通知到飞书群

## 背景

仓库 `luckly06/ai-review` 已经搭建好 GitHub Projects 看板自动化（issue/PR 状态变更会自动挪动看板卡片）。现在需要补充：**GitHub 事件发生时，自动把格式化消息推送到飞书群**，让团队成员不用刷 GitHub 也能第一时间知道状态变化。

**这次专门新建一个独立的飞书应用**，只负责 GitHub 通知这一件事，不与现有的飞书应用（用于获取群内消息等其他用途）混用，职责分离，方便排查问题。新应用的 App ID / App Secret 需要单独保存，**不要复用或覆盖现有应用的凭证**。

---

## 第 0 步：创建专用飞书cli应用(参照飞书Lark-CLI集成指南.md)

---

## 需要的 GitHub Secrets

请设置以下 Secrets（仓库 Settings → Secrets and variables → Actions）。**命名加了 `GITHUB_BOT` 前缀，与现有飞书应用的凭证区分开**：

| Secret 名称 | 说明 |
|---|---|
| `FEISHU_GITHUB_BOT_APP_ID` | 新建专用应用的 App ID |
| `FEISHU_GITHUB_BOT_APP_SECRET` | 新建专用应用的 App Secret |
| `FEISHU_GITHUB_BOT_CHAT_ID` | 目标群聊的 chat_id（格式如 `oc_xxxxxxxx`） |

设置命令(把值替换成第 0 步拿到的真实值):
```bash
gh secret set FEISHU_GITHUB_BOT_APP_ID --repo luckly06/ai-review --body "替换为真实值"
gh secret set FEISHU_GITHUB_BOT_APP_SECRET --repo luckly06/ai-review --body "替换为真实值"
gh secret set FEISHU_GITHUB_BOT_CHAT_ID --repo luckly06/ai-review --body "替换为真实值"
```

> 提醒：现有飞书应用的 Secret（如果之前存过 `FEISHU_APP_ID` 之类）不要动，两套凭证并存，互不影响。

---

## 要实现的功能

新增一个 GitHub Actions workflow 文件:`.github/workflows/notify-feishu.yml`

### 触发事件与对应消息内容

| 事件 | 消息内容应包含 |
|---|---|
| `push` | 仓库名、推送人、commit message、commit 短 hash |
| `issues: opened` | Issue 标题、创建人、Issue 链接 |
| `issues: closed` | Issue 标题、关闭人 |
| `pull_request: opened` | PR 标题、提交人、PR 链接 |
| `pull_request: ready_for_review` | PR 标题、提交人，提示"待审查" |
| `pull_request: closed` (且 merged=true) | PR 标题、合并人,提示"已合并" |

### 技术实现要求

0. **Secret 引用**:workflow 中通过 `${{ secrets.FEISHU_GITHUB_BOT_APP_ID }}`、`${{ secrets.FEISHU_GITHUB_BOT_APP_SECRET }}`、`${{ secrets.FEISHU_GITHUB_BOT_CHAT_ID }}` 获取凭证,不要用 `FEISHU_APP_ID` 等旧名称(那是现有应用的凭证,这个 workflow 不应该用到)。

1. **获取 tenant_access_token**:调用飞书 `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`,传入 `app_id` 和 `app_secret`(对应上面的 Secret),拿到 `tenant_access_token`(该 token 有效期 2 小时,每次 workflow 运行时重新获取即可,不需要缓存)。

2. **发送消息**:调用 `POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,Header 带 `Authorization: Bearer {token}`,Body 的 `receive_id` 填 chat_id。

3. **消息格式用 `interactive` 卡片**,不要用纯文本(`text` 类型在长内容/多字段场景下排版差)。卡片结构参考:

```json
{
  "receive_id": "oc_xxx",
  "msg_type": "interactive",
  "content": "{\"config\":{\"wide_screen_mode\":true},\"header\":{\"title\":{\"tag\":\"plain_text\",\"content\":\"📦 标题文字\"},\"template\":\"blue\"},\"elements\":[{\"tag\":\"div\",\"text\":{\"tag\":\"lark_md\",\"content\":\"**仓库**: xxx\\n**操作人**: xxx\\n**内容**: xxx\"}},{\"tag\":\"action\",\"actions\":[{\"tag\":\"button\",\"text\":{\"tag\":\"plain_text\",\"content\":\"查看详情\"},\"url\":\"https://github.com/xxx\",\"type\":\"primary\"}]}]}"
}
```

   - `header.template` 颜色按事件类型区分:push 用 `blue`,issue opened 用 `orange`,issue closed/PR merged 用 `green`,PR opened 用 `purple`
   - `elements` 里用 `lark_md` 富文本展示关键信息(仓库名、操作人、标题等)
   - 最下面加一个跳转按钮,链接到对应的 GitHub 页面(commit/issue/PR 的 URL)
   - 注意 `content` 字段是字符串化的 JSON,内部双引号需要转义,在 workflow 里用 `jq -Rs .` 或类似方式做转义,不要手写转义容易出错

4. **不同事件的卡片标题和颜色**(具体内容自行设计,风格参考下表):

| 事件 | 标题示例 | 颜色 |
|---|---|---|
| push | 📦 代码提交通知 | blue |
| issue opened | 🐛 新建 Issue | orange |
| issue closed | ✅ Issue 已关闭 | green |
| PR opened | 🔀 新建 Pull Request | purple |
| PR ready_for_review | 👀 PR 待审查 | orange |
| PR merged | 🎉 PR 已合并 | green |

5. **Workflow 触发条件**:

```yaml
on:
  push:
    branches: [main]
  issues:
    types: [opened, closed]
  pull_request:
    types: [opened, closed, ready_for_review]
```

   注意 `pull_request: closed` 需要在脚本里判断 `github.event.pull_request.merged == true` 来区分"合并关闭"和"未合并直接关闭"(后者可以不发通知或用不同文案)。

6. **错误处理**:如果获取 token 失败或发消息失败(非 200 响应),workflow 应该报错退出但不应该影响其他 job;这个 workflow 是独立的,不依赖、不影响已有的看板自动化 workflow。

---

## 验收标准

- [ ] `.github/workflows/notify-feishu.yml` 创建完成
- [ ] push 到 main 分支后,群里收到带 commit 信息的卡片
- [ ] 创建一个测试 Issue 后,群里收到"新建 Issue"卡片,点击按钮能跳转到该 Issue
- [ ] 关闭该 Issue 后,群里收到"Issue 已关闭"卡片
- [ ] 创建一个测试 PR 后,群里收到"新建 PR"卡片
- [ ] 合并该 PR 后,群里收到"PR 已合并"卡片(绿色)
- [ ] 卡片样式正常渲染(不是显示原始 JSON 字符串),按钮可点击跳转
- [ ] 不影响现有的 `project-automation.yml` 看板自动化逻辑

---

## 测试命令

```bash
# 创建测试 Issue 触发通知
gh issue create --repo luckly06/ai-review --title "测试飞书通知" --body "验证 webhook"

# 查看 workflow 运行日志
gh run list --repo luckly06/ai-review --workflow notify-feishu.yml
gh run view --repo luckly06/ai-review --log
```

---

## 工程约束

- 不引入额外依赖,纯 shell + curl + jq 实现,GitHub Actions runner 自带这些工具
- 不要把 App Secret 打印到日志里(GitHub Actions 默认会对 secrets 做掩码,但传递过程中也要避免不必要的 echo)
- workflow 文件命名、job 命名清晰,方便日后排查
