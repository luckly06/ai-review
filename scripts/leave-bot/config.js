// 请假交接机器人配置
// 凭证通过环境变量注入，不硬编码

export default {
  // 机器人凭证（在飞书后台创建应用后获取）
  bot: {
    appId: process.env.LEAVE_BOT_APP_ID || 'cli_aab611ea27f8dbe2',
    appSecret: process.env.LEAVE_BOT_APP_SECRET || '3biKbzJRoGKDukqM0eGlFcgbuM7kIWn4',
    chatId: process.env.LEAVE_BOT_CHAT_ID || 'oc_e98c804bce08a68b7b6b841545da4441',  // 目标群 chat_id (oc_xxx)
    botName: process.env.LEAVE_BOT_NAME || 'group-请假机器人',  // 机器人名称（用于 @ 检测）
  },

  // Leader 信息（P0 级别 @Leader 用）
  leader: {
    openId: process.env.LEADER_OPEN_ID || 'ou_bf13c776272237fb3dac4dd6dcf56c55',  // Leader 的 open_id (ou_xxx)
  },

  // 风险评级关键词
  riskKeywords: {
    P0: ['阻塞', '线上', '故障', '今天上线', '明天上线', '宕机', 'P0'],
    P1: ['重要', '本周', '迭代', 'P1', 'Bug', 'bug', '需求', '排期'],
    P2: ['日常', '常规', '功能', '开发', '优化'],
    P3: ['已交接', '无紧急', '年假', '调休', '没事'],
  },

  // 请假触发关键词
  leaveKeywords: ['请假', '休假', '不在', '休息', '病假', '事假', '年假', '调休', '外出'],

  // 卡片颜色映射
  cardTemplates: {
    P0: 'red',
    P1: 'orange',
    P2: 'yellow',
    P3: 'green',
  },

  // 风险等级描述
  riskDescriptions: {
    P0: '极高风险 - 阻塞排期或线上故障，需立即处理',
    P1: '高风险 - 重要 Bug 或本周迭代需求，需优先处理',
    P2: '中风险 - 日常迭代任务，正常交接即可',
    P3: '低风险 - 已提前交接或无紧急工作',
  },

  // 是否创建飞书任务（仅 P0/P1 创建）
  createTaskLevels: ['P0', 'P1'],

  // 任务默认截止天数（从今天算起）
  taskDueDays: {
    P0: 1,   // P0: 1 天内
    P1: 3,   // P1: 3 天内
  },

  // 认领表情（飞书 emoji_type，✅ = CheckMark）
  claimEmoji: 'CheckMark',

  // 待认领消息过期时间（毫秒，30 分钟）
  claimTimeout: 30 * 60 * 1000,
};
