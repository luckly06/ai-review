# SRS 第九节"新增的扩展"投入评估

## 摘要

SRS 第九节描述的是"如何从零借用现成拼图构建请假机器人"的三种思路。但**当前机器人已跑通**（lark-cli event consume 双进程 + https 直发卡片 + 表情认领），第九节对我们而言是"回顾性重构建议"而非"构建指南"。

**结论：不建议在 8 人小组投入全面重构。** 当前实现已覆盖第九节承诺的核心能力（免公网 IP 长连接、交互卡片、任务创建）。可选择性吸收"卡片美化"这一低成本项，其余两项（迁移 node-sdk、AI 引导式表单）边际价值低于迁移成本。

## 当前状态分析

当前机器人（`scripts/leave-bot/`）已实现并验证：

| 能力 | 当前实现 | 第九节承诺 | 差距 |
|---|---|---|---|
| 免公网 IP 事件监听 | `lark-cli event consume`（长连接） | node-sdk WSClient（长连接） | 无功能差距，仅实现栈不同 |
| 交互卡片 | 手写 `buildHandoverCard` JSON | 官方卡片搭建工具模板 | 无功能差距，仅 UI 精美度 |
| 任务创建 | `lark-cli task +create` | `lark-cli task +create` | 完全一致 |
| 认领机制 | ✅ 表情认领（已验证） | 按钮回调（第九节未涉及） | 当前方案更优（lark-cli 不支持卡片回调） |
| 请假解析 | 正则 + 关键词 | AI 引导式表单 | 当前够用，AI 方案更智能但更重 |

**关键事实**：第九节承诺的"免公网 IP、本地直接跑"，当前 lark-cli event consume 方案**已经具备**——这是 lark-cli 的固有特性，不是 node-sdk 独有。

## 三个拼图逐项评估

### 拼图一：官方互动卡片模板

**提议**：用[消息卡片搭建工具](https://open.feishu.cn/tool/cardbuilder)的现成模板替代手写 JSON。

**评估**：
- 当前 `buildHandoverCard`（[index.js#L214-L289](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L214-L289)）已生成带颜色标题栏、分隔线、lark_md 加粗、认领提示的完整卡片，功能无缺失
- 官方模板优势：UI 更精美（图标、多列布局、按钮样式），视觉更"专业"
- 迁移成本：低（只是换 JSON 结构，逻辑不变）
- 8 人小组场景：内部协作，卡片够用即可，视觉精美度收益有限

**建议**：**可选投入**。如果后续要给上级/跨团队看，值得美化；纯组内用，当前够用。

### 拼图二：迁移到 @larksuiteoapi/node-sdk WebSocket

**提议**：用官方 Node SDK 的 WSClient 替代 lark-cli event consume。

**评估**：
- 当前 lark-cli event consume 双进程方案已验证可用（消息 + 表情认领都跑通）
- node-sdk 理论优势：
  - 单进程监听多事件（当前需双进程）
  - 事件结构标准（不用手动处理 `event.event` 嵌套，[index.js#L420-L422](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L420-L422)）
  - 不依赖 lark-cli 二进制，部署更纯
- 迁移成本：**高**
  - 引入新依赖 `@larksuiteoapi/node-sdk`
  - 重写 `startEventListener`（[index.js#L550-L647](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L550-L647)）
  - 重写 `sendFeishuMessage`（改用 SDK client）
  - 重新验证表情认领事件结构
  - 放弃 lark-cli（与项目"用飞书 cli"的规则冲突，见 [.trae/rules/rules.md](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/.trae/rules/rules.md)）
- 8 人小组场景：当前双进程稳定运行，无性能瓶颈

**建议**：**不建议投入**。迁移成本高，功能无增量，且违反"用飞书 cli"的项目规则。当前方案已解决 lark-cli 的主要痛点（不支持卡片回调 → 用表情认领绕过）。

### 拼图三：参考 OpenClaw feishu-leave-request 的 AI 引导式表单

**提议**：用 AI 一步步引导用户把"模糊口语"变成"结构化表单字段"。

**评估**：
- 当前 `parseLeaveMessage`（[index.js#L111-L179](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L111-L179)）用正则提取时间/原因/待交接项，对规范表达够用
- AI 引导式优势：处理"我下周可能要请一下假，那个东西你帮我盯着点"这类模糊表达
- 迁移成本：**中高**
  - 需接入 LLM（API 调用或本地模型）
  - 需多轮对话状态管理（当前是单轮触发）
  - 增加延迟和 API 成本
- 8 人小组场景：组员请假消息通常较规范（"我明天病假，手里 P1 Bug 没改完"），正则够用。模糊表达的频率不足以支撑 AI 投入

**建议**：**不建议投入**。8 人小组请假消息规范度高，正则解析命中率已够。若未来解析失败率高再考虑。

## 结论与建议

### 总体结论

**不建议在 8 人小组投入第九节的扩展重构。**

理由：
1. 第九节承诺的"免公网 IP、本地长连接"——当前 lark-cli 方案**已具备**
2. 当前机器人功能完整且已验证（请假触发 → 卡片 → 表情认领 → 任务创建）
3. 三项扩展的边际价值均低于迁移成本
4. 迁移 node-sdk 违反项目"用飞书 cli"的规则

### 可选的低成本投入（仅一项）

**唯一值得考虑的**：拼图一的卡片美化（仅在需要给上级/跨团队展示时）。
- 成本：换 JSON 结构，逻辑不变
- 收益：视觉更专业
- 时机：有展示需求时再做，非现在

### 建议的真正后续行动（与第九节无关）

基于当前机器人已完成，更有价值的后续是：
1. 修复 `createFeishuTask` 中 `\\n` 字面量问题（[index.js#L328](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L328)）和 `notifyLeader` 的 `\\n`（[index.js#L382](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/scripts/leave-bot/index.js#L382)）—— 这是已知 bug，影响任务描述和 @Leader 消息格式
2. SRS 文档第九节可加注"已用 lark-cli 方案实现，本节作为备选思路存档"——避免误导后续维护者重复投入

## 假设与决策

1. **假设**：8 人小组请假消息表达较规范，正则解析命中率可接受
2. **假设**：项目规则"用飞书 cli"是硬约束（来自 [.trae/rules/rules.md](file:///f:/ai_agent/dev2/xiaomi/ai/test08/ai-review/.trae/rules/rules.md)），迁移 node-sdk 违反此约束
3. **决策**：本评估为"不投入"建议，若用户坚持某项扩展，再单独写实现计划
4. **决策**：不修改 SRS 文档（用户未要求），仅给出评估建议

## 验证步骤

本计划为评估文档，无代码变更。验证方式：
- 用户确认评估结论
- 若用户决定投入某项，转为实现计划另行执行
