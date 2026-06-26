// ai-review 对话机器人配置
// 凭证通过环境变量注入，不硬编码
// 镜像 scripts/leave-bot/config.js 的写法

export default {
  // 机器人凭证（在飞书后台创建应用后获取）
  bot: {
    appId: process.env.FEISHU_AI_REVIEW_APP_ID || 'cli_aab1fae329b99bb4',
    appSecret: process.env.FEISHU_AI_REVIEW_APP_SECRET || '8bvqmt4TFrRO7SqqjqvvncrPoIzYNQci',
    chatId: process.env.FEISHU_AI_REVIEW_CHAT_ID || 'oc_e98c804bce08a68b7b6b841545da4441',  // group-learn
    botName: process.env.FEISHU_AI_REVIEW_BOT_NAME || 'ai-review',
  },

  // GitHub 配置（仓库 luckly06/ai-review 的 Project 看板）
  github: {
    owner: 'luckly06',
    repo: 'ai-review',
    // 来自 docs/复用/GitHub看板搭建指南.md L26/L74
    projectId: process.env.PROJECT_ID || 'PVT_kwHOC2zqGM4Bbalw',
    statusFieldId: process.env.STATUS_FIELD_ID || 'PVTSSF_lAHOC2zqGM4BbalwzhWLRLI',
    token: process.env.PROJECT_TOKEN || '',
  },

  // 看板列名（与 setup-project.js 创建时一致）
  boardColumns: ['Backlog', 'Ready', 'In progress', 'In review', 'Done'],

  // 路由命令关键词
  commands: {
    board:  ['看板', 'board', '状态', 'kanban'],
    issue:  ['issue', 'issues', 'bug', '问题'],
    pr:     ['pr', 'pull', 'pullrequest', '拉取'],
    // 'ask' 现在是默认兜底（不需要关键词触发），
    // 保留空数组防止 matchCommand 误中其他字段
    ask:    [],
  },

  // AI 配置（与 leave-bot/config.js 一致；token 仅走环境变量，不落明文）
  ai: {
    apiKey:   process.env.MINIMAX_API_KEY || '',
    model:    'MiniMax-M3',
    endpoint: 'api.minimaxi.com',
    path:     '/v1/chat/completions',
  },

  // 列表查询上限
  listLimit: 10,
};