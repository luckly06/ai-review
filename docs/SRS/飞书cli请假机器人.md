# 飞书 CLI 请假交接机器人

> 基于 Lark CLI（MCP 协议）的团队请假与任务交接自动化方案。
> 当组员请假时，AI 自动解析待交接工作、评估风险、发送交互卡片、创建飞书任务，实现无后端的轻量交接流。

**参考文档**：[Lark CLI 官方文档](https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu)

---

## 一、核心工作流

```
组员在群里 @机器人 说请假
        ↓
AI 解析：请假人 / 时间 / 待交接内容
        ↓
AI 评估风险等级（P0~P3）
        ↓
┌───────────────────────────────────┐
│  发送交互卡片到群聊（含任务详情）    │
│  创建飞书任务（分配给交接人）        │
│  P0 额外 @团队Leader               │
└───────────────────────────────────┘
```

---

## 二、触发条件与消息解析

### 触发源

群聊中有人 **`@请假机器人`**（或当前机器人名称）时触发。

### 信息提取

利用 NLP 从用户发言中提取：

| 字段 | 说明 | 示例 |
|------|------|------|
| 请假人 | 发送消息的飞书用户 | 张三 |
| 请假原因/时间 | 病假、事假、明天、下周 | 明天病假 |
| 待交接内容 | 未完结 Bug、功能模块、紧急排期 | 主页渲染变慢的 P1 Bug |
| 指定交接人 | 用户明确提到的备份人（可选） | 李四 |

### 信息不足时

如果消息过于模糊（如只说"我明天请假"），AI 在群内追问：

> 收到你的请假申请，请问手头有什么需要同步给团队的未完结任务或 Bug 吗？

---

## 三、智能风险评级

| 等级 | 颜色 | 触发条件 | 处理方式 |
|------|------|---------|---------|
| 🔴 **P0** | 红色 | 提及"阻塞排期"、"线上重大故障"、"今天/明天上线"且无备份人 | 发卡片 + 创建任务 + **@Leader** |
| 🟠 **P1** | 橙色 | 提及"重要 Bug"、"本周迭代需求"、"名下未完结 P0/P1 任务" | 发卡片 + 创建任务 |
| 🟡 **P2** | 黄色 | 提及"日常迭代任务"、"常规功能开发" | 发卡片（可选创建任务） |
| 🟢 **P3** | 绿色 | 提及"已提前交接"、"无紧急工作"、"例行年假" | 发轻量卡片 |

---

## 四、落地执行：Lark CLI 命令

### 1. 发送交互卡片到群聊

```bash
lark-cli im +messages-send \
  --chat-id "oc_xxx" \
  --msg-type interactive \
  --content '{
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "【P1 紧急工作交接】张三申请明天病假"},
      "template": "orange"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**待交接任务：**\\n主页渲染变慢的 P1 Bug（未修复）\\n\\n**风险评估：**\\n涉及前端核心链路，本周需迭代上线，建议优先处理。"
        }
      },
      {"tag": "hr"},
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**交接呼叫：**\\n请有空档的同学回复本消息认领，或联系 @张三 了解详情。"
        }
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 我来认领"},
            "type": "primary",
            "value": {"action": "claim", "task": "homepage-render-bug"}
          }
        ]
      }
    ]
  }'
```

**卡片颜色对照：**

| 风险等级 | `template` 值 | 效果 |
|---------|--------------|------|
| P0 | `red` | 红色标题栏 |
| P1 | `orange` | 橙色标题栏 |
| P2 | `yellow` | 黄色标题栏 |
| P3 | `green` | 绿色标题栏 |

### 2. 创建飞书任务（分配给交接人）

```bash
# 查找交接人的 open_id（注意：+search-user 只支持 --as user 身份）
lark-cli contact +search-user --query "李四" --as user

# 创建任务（参数以 lark-cli schema task.tasks.create 为准）
lark-cli task +create \
  --summary "【交接】修复主页渲染变慢的 P1 Bug" \
  --description "来源：张三请假交接\\n风险等级：P1\\n截止：本周内\\n详情联系 @张三" \
  --members "ou_xxx" \
  --due "2026-06-27"
```

### 3. P0 级别：额外 @Leader

```bash
# 用 lark_md 的 <at> 语法实现真正的 @ 提及（非纯文本 @）
lark-cli im +messages-send \
  --chat-id "oc_xxx" \
  --msg-type text \
  --content '{"text":"<at user_id=\"ou_xxx\"></at> ⚠️ P0 级紧急交接：张三明天请假，手里有阻塞上线的 Bug 未修复，请关注。"}'
```

### 4. 回复原消息（话题内跟进）

```bash
lark-cli im +messages-reply \
  --message-id "om_xxx" \
  --text "已创建飞书任务并通知相关同学，请在请假前完成代码交接。"
```

---

## 五、AI Prompt（系统提示词）

将以下内容注入 AI Agent（Cursor / Claude Desktop / TRAE）作为 System Prompt：

```markdown
你是一个集成了飞书 CLI（Lark CLI）的团队请假交接助手。

## 触发条件
当群聊中有人 @你 并提及请假、休假、不在等内容时触发。

## 你的职责
1. 从消息中提取：请假人、请假时间/原因、待交接内容、指定交接人（如有）
2. 根据待交接内容评估风险等级（P0~P3）
3. 调用 Lark CLI 发送交互卡片到群聊
4. 调用 Lark CLI 创建飞书任务（P0/P1 必须创建）
5. P0 级别额外 @Leader 提醒

## 风险评级规则
- P0（红色）：阻塞排期、线上故障、今天/明天上线且无备份人
- P1（橙色）：重要 Bug、本周迭代需求、未完结 P0/P1 任务
- P2（黄色）：日常迭代任务、常规功能开发
- P3（绿色）：已提前交接、无紧急工作、例行年假

## 卡片格式要求
- 使用飞书交互式卡片（interactive 类型）
- header.template 按风险等级选色：red/orange/yellow/green
- lark_md 加粗用双星号 **加粗**
- 换行用 \\n（JSON 转义）
- 包含"认领"按钮（P0/P1）

## Lark CLI 命令
- 发卡片：lark-cli im +messages-send --chat-id "oc_xxx" --msg-type interactive --content '<JSON>'
- 创建任务：lark-cli task +create --summary "标题" --members "ou_xxx"（参数以 `lark-cli schema task.tasks.create` 为准）
- 回复消息：lark-cli im +messages-reply --message-id "om_xxx" --text "..."
- 查找用户：lark-cli contact +search-user --query "姓名" --as user（注意：只支持 user 身份）
- @Leader：用 lark_md 的 `<at user_id="ou_xxx">` 语法，不能用纯文本 @

## 异常处理
- 信息不足时，在群内温柔追问待交接内容
- P0 级别发完卡片后，额外发一条 @Leader 的文本消息
- 不要自行假设交接人，如果用户未指定，在卡片中呼叫群内认领
```

---

## 六、测试验证

配置完成后，在群里发一句：

> @请假机器人 我明天发烧要请假，手里那个主页渲染变慢的 P1 Bug 还没改完，谁帮我看一下

**预期结果：**
1. 机器人发送橙色卡片到群聊
2. 卡片包含待交接任务描述 + 认领按钮
3. （可选）创建飞书任务

---

## 七、前置条件

| 条件 | 说明 |
|------|------|
| Lark CLI 已安装 | `lark-cli --version` 验证 |
| 机器人已加入目标群 | 否则发送失败 |
| 已配置 App 凭证 | `lark-cli auth status` 验证 |
| 事件订阅已启用 | 飞书后台 → 事件订阅 → 启用 `im.message.receive_v1` |
| 权限范围 | `im:message`（发消息）、`task:task`（创建任务）、`contact:user.id:readonly`（查用户） |
| 本地 Node.js 18+ | 运行 `node scripts/leave-bot/start.js` |

### 启动方式

```bash
# 设置环境变量
export LEAVE_BOT_APP_ID="cli_xxx"
export LEAVE_BOT_APP_SECRET="xxx"
export LEAVE_BOT_CHAT_ID="oc_xxx"
export LEADER_OPEN_ID="ou_xxx"

# 启动机器人
node scripts/leave-bot/start.js
```

机器人启动后会持续监听群消息，直到 Ctrl+C 退出。

---

## 八、Lark CLI 能力对照

| 领域 | 能力 | 请假机器人用途 |
|------|------|--------------|
| IM 消息 | 发送卡片、回复消息 | 发送交接卡片、话题跟进 |
| Tasks 任务 | 创建任务、分配成员 | 为交接内容创建飞书任务 |
| Contacts 通讯录 | 查找用户 ID | 解析交接人/Leader 的 user_id |
| Calendar 日历 | 查看日程 | （扩展）检查交接人是否有空 |

---

## 九，新增的扩展：

````
因为“飞书 CLI + MCP”是飞书近期才推出的前沿 AI 协作能力，目前市面上还没有一个 100% 完美的、开箱即用的“MCP 请假机器人”开源项目。

但是，**这个机器人的核心拼图（UI 卡片、事件监听骨架）在飞书官方和开源社区有大量现成的模板可以“白嫖”和借用**。你完全不需要从零手写，直接把下面这些拼图拼起来就行：

---

### 🧱 拼图一：借用官方的“互动卡片模板”（解决 UI 问题）

飞书官方有一个 **[消息卡片搭建工具](https://open.feishu.cn/tool/cardbuilder)**，里面自带了大量诸如“任务认领”、“审批通知”的精美模板。

你可以直接借用我为你调整好的这套“请假任务认领卡片 JSON 骨架”。直接把它喂给你的 AI，让它用飞书 CLI 发送即可：

```json
{
  "config": { "enable_forward": true, "update_multi": false },
  "header": {
    "template": "orange",
    "title": { "tag": "plain_text", "content": "🚨 团队工作交接预警" }
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**请假人：** <at id=ou_xxx></at> (病假)\n**风险等级：** 🟠 **P1 (高风险)**\n**交接说明：** 某某业务的 Bug 尚未处理完毕，需要紧急协助。"
    },
    { "tag": "hr" },
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "🙋‍♂️ 我来认领此任务" },
          "type": "primary",
          "value": { "task_id": "12345", "action_type": "accept" }
        }
      ]
    }
  ]
}

```

---

### 🧱 拼图二：借用官方的“长连接事件监听骨架”（解决通信问题）

由于你选择的是**方案 A（本地监听）**，你需要一段基础代码来接住群里 `@机器人` 的消息。飞书官方的 `larksuite/oapi-sdk` 提供了非常标准的 **长连接 (WebSocket) 模板**。

如果你用 **Node.js (TypeScript)** 编写，可以直接参考和借用这段最基础的启动骨架：

```typescript
import * as Lark from "@larksuiteoapi/node-sdk";

// 初始化飞书 Client（换成你自己的 App ID 和 Secret）
const client = new Lark.Client({
  appId: "cli_xxxxxxxx",
  appSecret: "xxxxxxxxxxxxxxxx",
});

// 创建长连接事件监听器
const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data.message;
    
    // 借用此处的逻辑判断：如果是群聊且被 @
    if (message.chat_type === "group" && message.mentions) {
      const isMentioned = message.mentions.some(m => m.name === "请假机器人");
      
      if (isMentioned) {
        console.log("收到了请假人的消息:", message.content);
        // 接下来在这里调用你的 MCP AI 大脑处理文本并回复卡片
      }
    }
    return { code: 0, msg: "success" };
  },
});

// 启动长连接（免公网IP，本地直接跑）
const wsClient = new Lark.WSClient({
  eventDispatcher: eventDispatcher,
});
wsClient.start();

```

---

### 🧱 拼图三：参考开源社区的 AI 技能思路

如果在业务逻辑上缺乏灵感，你可以去 GitHub 搜索或参考 **OpenClaw (AI 智能助手框架)** 的技能库。
社区里有一个开源技能叫 **`feishu-leave-request`**，虽然它是用来协助用户“提交请假申请单”的，但它提供了一个非常好的思路：**如何用 AI 一步步引导用户把“模糊的口语”变成“结构化的表单字段”**。

---

### 💡 借用与拼装的最佳姿势

因为最多只有 8 个人，你最省力的方法是：

1. 打开你的 AI 编程助手（比如 Cursor 或 Claude）。
2. 把拼图二（Node.js 长连接代码）**和**拼图一（卡片 JSON）直接发给它。
3. 对 AI 说：
> “我已经为你准备好了飞书长连接的骨架代码和互动的卡片样式。请帮我把上一轮对话中发给你的‘请假机器人系统提示词’融入到这段代码中，当 `isMentioned` 为 true 时，让 AI 大脑分析内容，填充卡片 JSON，并调用 `client.im.message.create` 发送出去。”



这样，一个专属于你们 8 人小组的、极速响应的智能请假交接机器人，不到半小时就能直接在你的电脑上跑起来了！


````

*文档更新时间：2026-06-25*

