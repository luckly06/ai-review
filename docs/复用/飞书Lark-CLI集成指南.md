# 飞书 Lark CLI 集成指南

本文档记录了 `luckly06/ai-review` 项目的飞书（Lark/Feishu）Lark CLI 集成完整流程，实现与 Slack 协作相同的功能：读取群消息、发送带格式的进展更新。

## 效果预览

通过 Lark CLI，AI Agent 可以直接操作飞书：
- 读取指定群聊的消息历史
- 发送纯文本、Markdown、交互式卡片消息
- 搜索群聊、管理群成员

## 一、前置条件

- Node.js（npm/npx）
- 飞书账号（需有创建应用权限）

## 二、安装 Lark CLI

```bash
# 1. 全局安装 CLI 主体
npm install -g @larksuite/cli

# 2. 安装 CLI SKILL（必需，让 AI Agent 能识别并调用）
npx -y skills add https://open.feishu.cn --skill -y
```

验证安装：
```bash
lark-cli --version
# 输出: lark-cli version 1.0.57
```

## 三、配置应用凭证

```bash
# 交互式创建新应用，输出二维码和授权链接
lark-cli config init --new
```

用飞书 App 扫码或打开输出的链接，在浏览器中完成应用创建和授权。

## 四、登录授权

```bash
# 推荐权限范围自动登录
lark-cli auth login --recommend
```

在浏览器中完成 OAuth 授权。

验证登录状态：
```bash
lark-cli auth status
```

## 五、Slack → 飞书 命令映射

| 功能 | Slack Web API | 飞书 Lark CLI |
|------|--------------|--------------|
| 认证 | Bot Token (`xoxb-`) | OAuth 用户授权 (`lark-cli auth login`) |
| 列出频道/群 | `conversations.list` | `lark-cli im +chat-list` |
| 搜索群聊 | - | `lark-cli im +chat-search --query "关键词"` |
| 读消息 | `conversations.history` | `lark-cli im +chat-messages-list --chat-id oc_xxx` |
| 发文本消息 | `chat.postMessage` + `text` | `lark-cli im +messages-send --chat-id oc_xxx --text "..."` |
| 发 Markdown | `chat.postMessage` + `text` | `lark-cli im +messages-send --chat-id oc_xxx --markdown $'...'` |
| 发卡片消息 | `chat.postMessage` + `blocks` | `lark-cli im +messages-send --chat-id oc_xxx --msg-type interactive --content '<JSON>'` |
| 回复消息 | `chat.postMessage` + `thread_ts` | `lark-cli im +messages-reply --message-id om_xxx --text "..."` |
| 搜索消息 | `search.messages` | `lark-cli im +messages-search --query "关键词"` |
| 频道 ID | `C0BCK8HNR36` | `oc_xxx`（飞书群 chat_id） |

## 六、常用操作示例

### 1. 查找群聊 ID

```bash
# 按名称搜索群聊
lark-cli im +chat-search --query "group-learn" --format json

# 列出当前用户/机器人所在的群
lark-cli im +chat-list --format json
```

### 2. 读取群消息

```bash
# 获取最近的 50 条消息（默认降序）
lark-cli im +chat-messages-list --chat-id oc_xxx --format json

# 指定时间范围
lark-cli im +chat-messages-list --chat-id oc_xxx --start 2026-06-23 --end 2026-06-24

# 升序排列（从旧到新）
lark-cli im +chat-messages-list --chat-id oc_xxx --order asc --page-size 20
```

### 3. 发送纯文本消息

```bash
# 以 bot 身份发送
lark-cli im +messages-send --chat-id oc_xxx --text "Hello from AI agent" --as bot

# 以 user 身份发送
lark-cli im +messages-send --chat-id oc_xxx --text "Hello" --as user

# 多行文本
lark-cli im +messages-send --chat-id oc_xxx --text $'Line 1\nLine 2\nLine 3'
```

### 4. 发送 Markdown 消息

```bash
# Markdown 自动转换为飞书 post 消息
lark-cli im +messages-send --chat-id oc_xxx --markdown $'## 项目进展\n\n- 看板已搭建\n- 自动化已就绪\n- [看板地址](https://github.com/users/luckly06/projects/1)'
```

### 5. 发送交互式卡片消息（对标 Slack Block Kit）

```bash
# 构造卡片 JSON
lark-cli im +messages-send --chat-id oc_xxx --msg-type interactive --content '{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📊 ai-review 项目进展更新"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "div",
      "text": {
        "tag": "lark_md",
        "content": "**当前状态：**\n• **GitHub 看板**：已搭建完成\n• **状态配置**：Backlog / Ready / In progress / In review / Done"
      }
    },
    {"tag": "hr"},
    {
      "tag": "div",
      "text": {
        "tag": "lark_md",
        "content": "**下一步：**\n配置仓库 Secrets 以激活自动化流程"
      }
    }
  ]
}'
```

### 6. 回复消息（话题回复）

```bash
# 回复指定消息
lark-cli im +messages-reply --message-id om_xxx --text "收到，正在处理"
```

## 七、身份说明

| 身份 | 参数 | Token 类型 | 说明 |
|------|------|-----------|------|
| 用户 | `--as user` | `user_access_token` | 以授权用户身份操作，权限取决于用户自身 |
| 机器人 | `--as bot` | `tenant_access_token` | 以应用机器人身份操作，需机器人已加入目标群 |

- 默认使用 `--as bot`
- 读取消息时，`--as user` 通常能解析到发送者名称，`--as bot` 可能只显示 open_id
- 发送消息时，`--as bot` 需要机器人已加入目标群

### 身份选择规范

根据消息用途严格选择身份参数：

| 场景 | 身份 | 命令示例 | 说明 |
|------|------|----------|------|
| **定时通知/看板同步/PR评审结果** | 机器人 | `--as bot` 或省略 `--as` | 系统级通知，消息来源清晰（显示为机器人发送） |
| **队长决策/AI协助润色的发言** | 用户 | `--as user` | 个人名义发言，消息显示为用户本人发送 |

**前提条件：**

1. **机器人身份发送**：机器人必须已加入目标群（否则报错 `Bot can NOT be out of the chat`）
2. **用户身份发送**：需要 OAuth 授权 `im:message.send_as_user` scope

**命令示例：**

```bash
# 机器人身份（定时通知）
lark-cli im +messages-send --chat-id oc_xxx --text "看板已更新" --as bot

# 用户身份（队长决策）
lark-cli im +messages-send --chat-id oc_xxx --text "我决定采用方案A" --as user
```

## 八、消息格式对照

### Slack Block Kit → 飞书卡片

| Slack Block Kit | 飞书卡片 |
|----------------|---------|
| `header` block + `plain_text` | `header.title` + `template`（颜色模板） |
| `section` + `mrkdwn` | `div` + `lark_md` |
| `divider` block | `hr` element |
| `*加粗*`（单星号） | `**加粗**`（双星号，lark_md 支持） |

### Slack 纯文本 → 飞书纯文本

| Slack | 飞书 |
|-------|------|
| `*加粗*`（单星号） | `**加粗**`（双星号）或直接用 `--markdown` |
| `\n` 换行 | 直接回车换行，或 `$'...\n...'` |
| `chat.postMessage` + `text` | `lark-cli im +messages-send` + `--text` |

## 九、踩坑记录

### 1. npx 安装失败

**问题**：`npx @larksuite/cli@latest install` 报错 `Failed to install globally`

**解决**：改用 `npm install -g @larksuite/cli` 手动全局安装

### 2. 机器人不在群内

**问题**：`--as bot` 发送消息报错权限不足

**解决**：确保机器人已加入目标群聊。在飞书群设置中添加机器人。

### 3. 发送者名称未解析

**问题**：用 `--as bot` 读取消息时，发送者显示为 open_id 而非姓名

**原因**：机器人应用可见范围未覆盖消息发送者

**解决**：在飞书开发者后台调整应用可见范围，或改用 `--as user` 读取消息

### 4. chat_id 获取

**问题**：不知道目标群的 `chat_id`（`oc_xxx`）

**解决**：使用 `lark-cli im +chat-search --query "群名关键词"` 搜索获取

## 十、文件清单

| 文件 | 用途 |
|------|------|
| `.cursorrules/FEISHU-STYLE.md` | 飞书消息格式提示词模板（卡片消息 + Markdown） |
| `.cursorrules/SLACK-STYLE.md` | Slack 消息格式提示词模板（并存保留） |
| `.agents/skills/lark-im/` | Lark CLI IM 技能文档（自动安装） |
| `docs/复盘/飞书Lark-CLI集成指南.md` | 本文档 |

## 十一、验证方式

```bash
# 验证 CLI 安装
lark-cli --version

# 验证登录状态
lark-cli auth status

# 列出群聊
lark-cli im +chat-list --format json

# 读取消息
lark-cli im +chat-messages-list --chat-id oc_xxx --format json

# 发送测试消息
lark-cli im +messages-send --chat-id oc_xxx --text "飞书集成测试" --dry-run
```

---

*文档生成时间：2026-06-23*
