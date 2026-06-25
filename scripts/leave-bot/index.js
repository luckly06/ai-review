// 飞书请假交接机器人 - 主脚本
// 通过 lark-cli event consume 实时监听群消息，解析请假信息，发送交接卡片

import { spawn, exec } from 'node:child_process';
import https from 'node:https';
import config from './config.js';

// 待认领消息存储：message_id → { leaveInfo, expireAt }
const pendingClaims = new Map();

// ============================================================
// 1. 飞书 API 工具函数（复用 ai-review.js 的模式）
// ============================================================

/**
 * 获取飞书 tenant_access_token
 */
function getFeishuToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      app_id: config.bot.appId,
      app_secret: config.bot.appSecret,
    });

    const req = https.request(
      {
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.code === 0) {
              resolve(json.tenant_access_token);
            } else {
              reject(new Error(`获取 token 失败: ${json.msg}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 发送飞书消息（卡片或文本）
 */
async function sendFeishuMessage(token, { msgType, content }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      receive_id: config.bot.chatId,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });

    const req = https.request(
      {
        hostname: 'open.feishu.cn',
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(resBody);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// 2. 消息解析与风险评级
// ============================================================

/**
 * 解析请假消息
 * @param {string} content - 消息文本（已由 lark-cli 解析为纯文本，@提及已转为显示名）
 * @param {string} senderId - 发送者 open_id
 * @returns {object} 解析结果
 */
function parseLeaveMessage(content, senderId) {
  // 检查是否包含请假关键词
  const hasLeaveKeyword = config.leaveKeywords.some((kw) => content.includes(kw));
  if (!hasLeaveKeyword) {
    return null; // 不是请假消息
  }

  // 提取请假时间
  const timePatterns = [
    { regex: /今天/, label: '今天' },
    { regex: /明天/, label: '明天' },
    { regex: /后天/, label: '后天' },
    { regex: /下周[一二三四五六日天]?/, label: '下周' },
    { regex: /本周/, label: '本周' },
    { regex: /(\d+)\s*天/, label: '多天' },
  ];
  let leaveTime = '未明确';
  for (const p of timePatterns) {
    const match = content.match(p.regex);
    if (match) {
      leaveTime = p.label === '多天' ? `${match[1]}天` : p.label;
      break;
    }
  }

  // 提取请假原因
  const reasonPatterns = [
    { regex: /病假/, label: '病假' },
    { regex: /事假/, label: '事假' },
    { regex: /年假/, label: '年假' },
    { regex: /调休/, label: '调休' },
    { regex: /外出/, label: '外出' },
  ];
  let reason = '请假';
  for (const p of reasonPatterns) {
    if (p.regex.test(content)) {
      reason = p.label;
      break;
    }
  }

  // 提取待交接内容（查找 Bug、需求、任务等关键词附近的文本）
  const handoverKeywords = ['Bug', 'bug', '需求', '任务', '排期', '上线', '故障', '功能', '模块'];
  const handoverItems = [];
  // 简单提取：按句号/逗号/换行分割，找包含关键词的片段
  const segments = content.split(/[，。,.！!？?\n]+/).filter((s) => s.trim());
  for (const seg of segments) {
    if (handoverKeywords.some((kw) => seg.includes(kw))) {
      handoverItems.push(seg.trim());
    }
  }

  // 提取指定交接人（@某人 或 "找某某"）
  const assigneeMatch = content.match(/(?:找|交给|联系|@)\s*([^\s，。,.！!？?]+)/);
  let assignee = assigneeMatch ? assigneeMatch[1] : null;

  // 排除机器人名称（@机器人是触发机器人，不是指定交接人）
  if (assignee && (assignee === config.bot.botName || assignee.includes('_user_'))) {
    assignee = null;
  }

  // 风险评级
  const riskLevel = assessRisk(content, handoverItems, assignee);

  return {
    senderId,
    leaveTime,
    reason,
    handoverItems,
    assignee,
    riskLevel,
    rawContent: content,
  };
}

/**
 * 风险评级
 */
function assessRisk(content, handoverItems, assignee) {
  // P0: 阻塞排期、线上故障、今天/明天上线且无备份人
  const isP0 = config.riskKeywords.P0.some((kw) => content.includes(kw));
  if (isP0 && !assignee) {
    return 'P0';
  }

  // P1: 重要 Bug、本周迭代、未完结 P0/P1 任务
  const isP1 = config.riskKeywords.P1.some((kw) => content.includes(kw));
  if (isP1 || (handoverItems.length > 0 && !assignee)) {
    return 'P1';
  }

  // P3: 已提前交接、无紧急工作、例行年假
  const isP3 = config.riskKeywords.P3.some((kw) => content.includes(kw));
  if (isP3 && handoverItems.length === 0) {
    return 'P3';
  }

  // P2: 日常迭代任务、常规功能开发（默认）
  return 'P2';
}

// ============================================================
// 3. 动作执行
// ============================================================

/**
 * 构造交接卡片 JSON
 */
function buildHandoverCard(parsed) {
  const { reason, leaveTime, handoverItems, riskLevel, rawContent } = parsed;
  const template = config.cardTemplates[riskLevel];
  const riskDesc = config.riskDescriptions[riskLevel];

  // 待交接任务文本（使用真正的换行字符）
  const taskText = handoverItems.length > 0
    ? handoverItems.map((item) => `• ${item}`).join('\n')
    : '（未提及具体待交接内容）';

  // 风险评估文本（使用真正的换行字符 \n）
  const riskText = `**风险等级：** ${riskLevel}\n${riskDesc}`;

  // 交接呼叫
  const callText = parsed.assignee
    ? `**指定交接人：** ${parsed.assignee}`
    : '**交接呼叫：** 请有空档的同学点击下方按钮认领，或回复本消息协助跟进。';

  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**请假时间：** ${leaveTime}\n**请假原因：** ${reason}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**待交接任务：**\n${taskText}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: riskText,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: callText,
      },
    },
  ];

  // P0/P1 添加认领提示（用户点 ✅ 表情即可认领，无需 @ 机器人）
  if (riskLevel === 'P0' || riskLevel === 'P1') {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '👆 **认领方式：** 在本条消息上点 ✅ 表情即可认领',
      },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `【${riskLevel} 紧急工作交接】${reason} ${leaveTime}`,
      },
      template,
    },
    elements,
  };
}

/**
 * 发送交接卡片
 */
async function sendHandoverCard(token, parsed) {
  const card = buildHandoverCard(parsed);
  const result = await sendFeishuMessage(token, {
    msgType: 'interactive',
    content: card,
  });

  if (result.code === 0) {
    console.log(`[卡片] 发送成功: ${result.data?.message_id}`);
    return result.data?.message_id;
  } else {
    console.error(`[卡片] 发送失败: ${result.msg}`);
    return null;
  }
}

/**
 * 创建飞书任务（通过 lark-cli）
 */
async function createFeishuTask(parsed) {
  const { riskLevel, handoverItems, leaveTime, reason } = parsed;
  const dueDays = config.taskDueDays[riskLevel] || 3;
  const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const summary = `【交接】${handoverItems[0] || reason + leaveTime}`;
  const description = [
    `来源：请假交接`,
    `风险等级：${riskLevel}`,
    `请假时间：${leaveTime}`,
    `请假原因：${reason}`,
    `待交接内容：`,
    ...handoverItems.map((item) => `- ${item}`),
  ].join('\n');

  return new Promise((resolve) => {
    const args = [
      'task', '+create',
      '--summary', summary,
      '--description', description,
      '--due', dueDate,
    ];

    // 如果有指定交接人，尝试添加成员
    if (parsed.assignee) {
      args.push('--members', parsed.assignee);
    }

    // Windows 使用 spawn + shell: true
    const proc = spawn(`lark-cli task +create --summary "${summary}" --description "${description}" --due ${dueDate} --profile leave-bot`, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });
    let output = '';
    let errOutput = '';

    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (errOutput += d));

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[任务] 创建成功: ${summary}`);
        resolve(true);
      } else {
        console.error(`[任务] 创建失败 (exit ${code}): ${errOutput}`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.error(`[任务] 进程错误: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * P0 级别：@Leader 提醒
 */
async function notifyLeader(token, parsed) {
  if (!config.leader.openId) {
    console.warn('[Leader] 未配置 LEADER_OPEN_ID，跳过 @Leader');
    return;
  }

  // 用卡片消息发送 @Leader 提醒（支持 lark_md 格式：加粗、@ 提及）
  const leaderCard = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ P0 级紧急交接' },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `<at user_id="${config.leader.openId}"></at> 请关注\n\n**请假人：** ${parsed.senderId || '组员'}\n**请假时间：** ${parsed.leaveTime}\n**风险等级：** P0（极高风险）\n**待交接内容：** 涉及阻塞项或线上故障`,
        },
      },
    ],
  };

  const result = await sendFeishuMessage(token, {
    msgType: 'interactive',
    content: leaderCard,
  });

  if (result.code === 0) {
    console.log('[Leader] @Leader 发送成功');
  } else {
    console.error(`[Leader] @Leader 发送失败: ${result.msg}`);
  }
}

/**
 * 信息不足时追问
 */
async function askForMoreInfo(token, senderId) {
  const text = `收到你的请假申请，请问手头有什么需要同步给团队的未完结任务或 Bug 吗？`;
  const result = await sendFeishuMessage(token, {
    msgType: 'text',
    content: JSON.stringify({ text }),
  });

  if (result.code === 0) {
    console.log('[追问] 发送成功');
  } else {
    console.error(`[追问] 发送失败: ${result.msg}`);
  }
}

// ============================================================
// 4. 事件处理主流程
// ============================================================

/**
 * 处理表情回应事件（认领）
 */
async function handleReaction(rawEvent) {
  // lark-cli 输出的 reaction 事件是嵌套结构：{ header, event: { message_id, reaction_type, user_id } }
  const event = rawEvent.event || rawEvent;

  const messageId = event.message_id || '';
  const emojiType = event.reaction_type?.emoji_type || '';
  const operatorOpenId = event.user_id?.open_id || '';

  console.log(`\n[${new Date().toLocaleString()}] 收到表情回应: ${emojiType} on ${messageId}`);

  // 只处理认领表情
  if (emojiType !== config.claimEmoji) return;

  // 检查是否是待认领消息
  if (!pendingClaims.has(messageId)) return;

  // 取出请假信息，并移除（防止重复认领）
  const claimData = pendingClaims.get(messageId);
  pendingClaims.delete(messageId);

  console.log(`[认领] ${operatorOpenId} 认领了任务: ${claimData.leaveInfo}`);

  try {
    const token = await getFeishuToken();

    // 用卡片消息发送认领确认（支持 lark_md 格式：加粗、@ 提及）
    const claimCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '✅ 任务认领确认' },
        template: 'green',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**认领人：** <at user_id="${operatorOpenId}"></at>\n**认领时间：** ${new Date().toLocaleString()}\n**交接内容：** ${claimData.leaveInfo}`,
          },
        },
      ],
    };

    const result = await sendFeishuMessage(token, {
      msgType: 'interactive',
      content: claimCard,
    });

    if (result.code === 0) {
      console.log('[认领] 确认消息发送成功');
    } else {
      console.error(`[认领] 确认消息发送失败: ${result.msg}`);
    }
  } catch (err) {
    console.error(`[认领错误] ${err.message}`);
  }
}

/**
 * 处理单条消息事件（仅处理消息接收事件）
 */
async function handleEvent(event) {
  // 过滤：只处理文本消息 + 群消息
  if (event.message_type !== 'text' || event.chat_type !== 'group') return;

  const { chat_id, message_id, sender_id, content, message_type } = event;

  // 只处理目标群的消息
  if (chat_id !== config.bot.chatId) return;

  // 检查是否 @了机器人（lark-cli 会把 @ 解析为显示名）
  const botName = config.bot.botName;
  const isMentioned = content.includes(`@${botName}`) || content.includes('@_user_');

  if (!isMentioned) return;

  console.log(`\n[${new Date().toLocaleString()}] 收到 @消息: ${content}`);

  // 解析请假信息
  const parsed = parseLeaveMessage(content, sender_id);

  if (!parsed) {
    // 不是请假消息，忽略
    console.log('[跳过] 非请假消息');
    return;
  }

  // 信息不足：没有待交接内容且风险等级不确定
  if (parsed.handoverItems.length === 0 && parsed.riskLevel === 'P2') {
    console.log('[追问] 信息不足，请求补充');
    const token = await getFeishuToken();
    await askForMoreInfo(token, sender_id);
    return;
  }

  console.log(`[解析] 风险等级: ${parsed.riskLevel}, 待交接: ${parsed.handoverItems.length}项`);

  try {
    const token = await getFeishuToken();

    // 1. 发送交接卡片
    const cardMessageId = await sendHandoverCard(token, parsed);

    // 记录待认领消息（用于表情认领）
    if (cardMessageId && (parsed.riskLevel === 'P0' || parsed.riskLevel === 'P1')) {
      pendingClaims.set(cardMessageId, {
        leaveInfo: parsed.handoverItems.length > 0
          ? parsed.handoverItems.join('、')
          : `${parsed.leaveTime} ${parsed.reason}`,
        expireAt: Date.now() + config.claimTimeout,
      });
      // 30 分钟后自动清理
      setTimeout(() => pendingClaims.delete(cardMessageId), config.claimTimeout);
      console.log(`[待认领] 已记录卡片消息 ${cardMessageId}，等待 ✅ 表情认领`);
    }

    // 2. 创建飞书任务（P0/P1）
    if (config.createTaskLevels.includes(parsed.riskLevel)) {
      await createFeishuTask(parsed);
    }

    // 3. P0 额外 @Leader
    if (parsed.riskLevel === 'P0') {
      await notifyLeader(token, parsed);
    }

    console.log('[完成] 所有动作执行完毕');
  } catch (err) {
    console.error(`[错误] ${err.message}`);
  }
}

// ============================================================
// 5. 事件监听子进程
// ============================================================

/**
 * 启动事件监听（两个进程：消息接收 + 表情回应）
 * 认领方式：用户在卡片消息上点 ✅ 表情，机器人监听 reaction 事件自动回复确认
 */
export function startEventListener() {
  console.log('正在启动请假交接机器人...');

  // 检查凭证
  if (!config.bot.appId || !config.bot.appSecret) {
    console.error('错误: 未配置 LEAVE_BOT_APP_ID / LEAVE_BOT_APP_SECRET');
    console.error('请在环境变量中设置，或创建 .env 文件');
    process.exit(1);
  }

  if (!config.bot.chatId) {
    console.error('错误: 未配置 LEAVE_BOT_CHAT_ID');
    process.exit(1);
  }

  // 进程1：监听消息接收
  const messageConsumer = spawn('lark-cli event consume im.message.receive_v1 --as bot --profile leave-bot', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });

  // 进程2：监听表情回应（用于认领）
  const reactionConsumer = spawn('lark-cli event consume im.message.reaction.created_v1 --as bot --profile leave-bot', [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });

  let msgBuffer = '';
  let reactionBuffer = '';

  // 消息接收进程
  messageConsumer.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('[event] ready')) {
      console.log(`✅ 消息监听已就绪，监听群 ${config.bot.chatId}`);
      console.log(`   等待 @${config.bot.botName} 的请假消息...`);
    } else if (text.includes('"ok":false')) {
      console.error(`[消息监听错误] ${text}`);
    }
  });

  messageConsumer.stdout.on('data', (data) => {
    msgBuffer += data.toString();
    const lines = msgBuffer.split('\n');
    msgBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleEvent(event).catch((err) => {
          console.error(`[消息处理错误] ${err.message}`);
        });
      } catch (e) {
        console.error(`[JSON 解析错误] ${e.message}: ${line.substring(0, 100)}`);
      }
    }
  });

  // 表情回应进程
  reactionConsumer.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('[event] ready')) {
      console.log(`✅ 表情认领监听已就绪，等待 ✅ 表情`);
    } else if (text.includes('"ok":false')) {
      console.error(`[表情监听错误] ${text}`);
    }
  });

  reactionConsumer.stdout.on('data', (data) => {
    reactionBuffer += data.toString();
    const lines = reactionBuffer.split('\n');
    reactionBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleReaction(event).catch((err) => {
          console.error(`[表情处理错误] ${err.message}`);
        });
      } catch (e) {
        console.error(`[JSON 解析错误] ${e.message}: ${line.substring(0, 100)}`);
      }
    }
  });

  // 进程退出处理
  messageConsumer.on('close', (code) => {
    console.log(`[消息监听] 退出，code=${code}`);
  });

  reactionConsumer.on('close', (code) => {
    console.log(`[表情监听] 退出，code=${code}`);
  });

  return { messageConsumer, reactionConsumer };
}

// ============================================================
// 6. 导出（供 start.js 和测试使用）
// ============================================================

export {
  parseLeaveMessage,
  assessRisk,
  buildHandoverCard,
  handleEvent,
  getFeishuToken,
  sendFeishuMessage,
};
