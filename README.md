# AI Review

测试用仓库——用来跑 GitHub Actions 的 AI 审查流水线。

## 文件结构

```
.
├── .github/
│   ├── workflows/
│   │   └── ai-review.yml     # PR 触发 → 调 MiniMax 审查 → post 评论
│   └── scripts/
│       └── ai-review.js       # Node 脚本：拿 diff + 调 API + post 评论
├── index.js                   # 示例入口：导出一个加法函数（待 AI 审查）
├── src/
│   ├── math.js                # 加减乘除
│   └── greet.js               # 问候语生成
├── package.json
└── .gitignore
```

## 本地运行

```bash
npm install
node index.js          # 输出 3
node src/greet.js Alice
```

## CI 审查触发方式

1. 仓库设置 → Secrets → 加 `MINIMAX_API_KEY`（你 MiniMax 控制的 API key）
2. 推一个 commit 到任意分支
3. 创建一个 PR 到 main/master
4. **PR 创建时**自动触发 `.github/workflows/ai-review.yml`
5. 流水线跑完，AI 审查意见作为 **PR 评论**自动 post

## 调试

- 仓库 → Actions → 选 build → 看日志
- ai-review 阶段会打 `===== AI 审查意见 =====` 段
- 评论失败日志会有 HTTP 状态码 + body
