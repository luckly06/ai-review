# Gitee Go 时代任务归档

> 时间窗口：2026-06-15 之前
> 项目：`learn-externe` (pnpm monorepo)
> 平台：Gitee Go
> 结局：弃用，改走 GitHub Actions

以下任务已全部完成（最终结论：弃用 Gitee Go）。这里留个快照，方便日后回看为什么不用 Gitee Go。

---

## 任务清单（13–32 + 15）

| # | 任务 | 结果 |
| --- | --- | --- |
| 13 | 查 Gitee Go PR 环境变量 | 文档不全，prId 在手动 Run 时为空 |
| 14 | 写 pr-pipeline.yml | 4 个 stage：install / lint / test / ai-review |
| 15 | 更新 SRS 文档 | **未做**（弃用后无意义） |
| 16 | 校验 + 提示下一步 | 触发器行为不符，多次返工 |
| 17 | 推 pr-pipeline.yml 到 master | OK，但 PR 触发不可靠 |
| 18 | 执行 CI 配置修正 | 修了默认模板 name 冲突 |
| 19 | 查 install stage 配置错误 | pnpm monorepo 子目录 install 路径 |
| 20 | 改 nodeVersion 并推 frozen | 20.18.0 不在下拉，改 20.10.0 |
| 21 | 改 name 字段避免冲突 | pr-pipeline-frozen.yml |
| 22 | 修 test stage cd 跨 shell 问题 | 用 `(cd X && Y) \|\| true` 子 shell |
| 23 | 接入 minimax AI 审查 | 写到 .workflow/pr-pipeline-frozen.yml |
| 24 | 改用 node 调用 minimax API | python3 不在镜像，改 Node + https 模块 |
| 25 | 同步改动到正确文件 | pr-pipeline-frozen.yml vs pr-pipeline.yml 路径纠正 |
| 26 | 改 git diff 为智能版 | git fetch + diff origin/base...HEAD |
| 27 | 改鉴权头为 Authorization Bearer | minimax 是 OpenAI-style，不是 Anthropic-style |
| 28 | ai-review fail-fast + 详细错误 | 处理空 content 返回 |
| 29 | 写 CI 配置经验到 docs/ | `docs/复盘/GiteeGo流水线接入复盘.md` |
| 30 | 实现 AI 审查回写 PR 评论 | Gitee Open API POST 调通 |
| 31 | 改名 + 只跑 ai-review | `pr-review-comment.yml` 独立流水线 |
| 32 | 推 yml 到 master | OK，但 PR 评论不稳定 |

---

## 最终结论

**Gitee Go 踩坑 2 小时，GitHub Actions 10 分钟跑通。** 详见：
- `docs/复盘/GiteeGo为什么弃用.md` — 7 个缺陷 + 4 个垃圾方案
- `docs/复盘/GiteeGo流水线接入复盘.md` — 详细复盘（18 节，含 YAML edge case）
- `docs/复盘/GitHubActions接入复盘.md` — GitHub 这边 5 个坑

**经验**：能选 GitHub Actions 就别选 Gitee Go。判断标准看 `docs/复盘/GiteeGo为什么弃用.md` 第四节的对比表。