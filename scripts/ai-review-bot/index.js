// ai-review 对话机器人 - 主脚本
// 通过 lark-cli event consume 实时监听群消息，
// 响应 @ai-review 开头的查询：看板 / Issue / PR 状态
//
// 架构镜像 scripts/leave-bot/index.js，但省略请假相关逻辑

import { spawn } from 'node:child_process';
import https from 'node:https';
import config from './config.js';

// ============================================================
// 1. 飞书 API 工具函数（复用 leave-bot 模式）
// ============================================================

function getFeishuToken() {
  const data = JSON.stringify({
    app_id: config.bot.appId,
    app_secret: config.bot.appSecret,
  });
  return new Promise((resolve, reject) => {
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
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.code === 0) resolve(json.tenant_access_token);
            else reject(new Error(`获取 token 失败: ${json.msg}`));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendFeishuCard(token, card) {
  const body = JSON.stringify({
    receive_id: config.bot.chatId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  return new Promise((resolve, reject) => {
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
        res.on('data', (c) => (resBody += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(resBody);
            resolve(json.code === 0);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// 2. GitHub API 调用
// ============================================================

function githubGraphQL(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ai-review-bot',
    Authorization: `Bearer ${config.github.token}`,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        port: 443,
        path: '/graphql',
        method: 'POST',
        headers,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            if (json.errors) return reject(new Error('GraphQL: ' + JSON.stringify(json.errors)));
            resolve(json.data);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function githubRest(path) {
  const headers = {
    'User-Agent': 'ai-review-bot',
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.github.com', port: 443, path, method: 'GET', headers },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
          try { resolve(JSON.parse(chunks)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// 3. 看板 / Issue / PR 数据获取
// ============================================================

function requireToken() {
  if (!config.github.token) {
    throw new Error(
      'PROJECT_TOKEN 未配置 — 请在环境变量里注入 GitHub PAT ' +
      '（需要 `project` scope 且能读写 luckly06 的 user-level Project）'
    );
  }
}

async function fetchBoard() {
  requireToken();
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          title
          items(first: 100) {
            nodes {
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }
      }
    }`;
  const data = await githubGraphQL(query, { projectId: config.github.projectId });
  const project = data?.node;
  if (!project) throw new Error('Project 未找到 — 检查 PROJECT_ID 是否为 ' + config.github.projectId);
  const buckets = Object.fromEntries(config.boardColumns.map((c) => [c, 0]));
  for (const item of project.items.nodes) {
    const status = item.fieldValueByName?.name;
    if (status && buckets[status] !== undefined) buckets[status]++;
  }
  return { title: project.title, buckets };
}

async function fetchIssues() {
  requireToken();
  const rows = await githubRest(
    `/repos/${config.github.owner}/${config.github.repo}/issues?state=open&per_page=${config.listLimit}`
  );
  return rows.filter((r) => !r.pull_request); // 排除 PR
}

async function fetchPRs() {
  requireToken();
  return githubRest(
    `/repos/${config.github.owner}/${config.github.repo}/pulls?state=open&per_page=${config.listLimit}`
  );
}

// ============================================================
// 3b. MiniMax AI 调用（参考 scripts/leave-bot/index.js L110-L151）
// ============================================================

function requireMinimax() {
  if (!config.ai.apiKey) {
    throw new Error(
      'MINIMAX_API_KEY 未配置 — 请在环境变量注入 MiniMax API key ' +
      '（@ai-review 问 xxx 命令需要）'
    );
  }
}

// 去掉 MiniMax 返回的 <think>...</think> 思考块
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function callMinimax(prompt) {
  const body = JSON.stringify({
    model: config.ai.model,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: config.ai.endpoint,
        port: 443,
        path: config.ai.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${config.ai.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`MiniMax HTTP ${res.statusCode}: ${chunks}`));
          }
          try {
            const json = JSON.parse(chunks);
            const raw = json.choices?.[0]?.message?.content;
            if (!raw) return reject(new Error('MiniMax 返回空内容: ' + chunks));
            resolve(stripThinking(raw));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchAnswer(question) {
  requireMinimax();
  const prompt =
    '你是 ai-review 助手，回答要简洁（中文）。' +
    '用户问的是项目相关问题（仓库 luckly06/ai-review），可以直接基于常识回答。\n\n' +
    '用户问题：' + question;
  return callMinimax(prompt);
}

// ============================================================
// 4. 卡片构造
// ============================================================

function buildBoardCard({ title, buckets }) {
  const lines = config.boardColumns.map((c) => `**${c}**: ${buckets[c]}`).join('\n');
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'purple' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines } }],
  };
}

function buildAnswerCard(question, answer) {
  const MAX = 25000;
  const text = answer.length > MAX
    ? answer.slice(0, MAX) + '\n\n⚠️ 内容过长，已截断。'
    : answer;
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'AI 回答' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**问**：${question}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: text } },
    ],
  };
}

function buildListCard(kind, rows, urlBase) {
  if (!rows.length) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `${kind} 列表` }, template: 'green' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '当前没有 open 的项' } }],
    };
  }
  const lines = rows.map((r) => `- [#${r.number} ${r.title}](${r.html_url})`).join('\n');
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${kind} (open, top ${rows.length})` }, template: 'purple' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: `查看全部 ${kind}` },
          url: `${urlBase}?q=is%3Aissue+is%3Aopen`,
          type: 'primary',
        }],
      },
    ],
  };
}

function buildHelpCard() {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'ai-review 能做啥' }, template: 'blue' },
    elements: [{
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: [
          '**当前命令**：',
          '• `@ai-review 看板` — 看 GitHub Project 各列卡片数',
          '• `@ai-review issue` — 列 open Issue（最多 10 条）',
          '• `@ai-review pr` — 列 open PR（最多 10 条）',
          '• `@ai-review 问 xxx` — 调 MiniMax 自由回答',
          '',
          '**触发规则**：必须 @ai-review 才会响应，其他消息忽略',
        ].join('\n'),
      },
    }],
  };
}

function buildErrorCard(err) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '查询失败' }, template: 'red' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: `\`\`\`\n${err.message}\n\`\`\`` } }],
  };
}

// ============================================================
// 5. 命令路由
// ============================================================

function matchCommand(cmd) {
  const lower = cmd.toLowerCase();
  for (const [name, keywords] of Object.entries(config.commands)) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) return name;
  }
  return null;
}

async function routeCommand(cmd) {
  const token = await getFeishuToken();
  const matched = matchCommand(cmd);
  const repoUrl = `https://github.com/${config.github.owner}/${config.github.repo}`;
  let card;
  try {
    switch (matched) {
      case 'board':
        card = buildBoardCard(await fetchBoard());
        break;
      case 'issue':
        card = buildListCard('Issue', await fetchIssues(), `${repoUrl}/issues`);
        break;
      case 'pr':
        card = buildListCard('PR', await fetchPRs(), `${repoUrl}/pulls`);
        break;
      case 'ask': {
        const question = cmd
          .replace(new RegExp(config.commands.ask.join('|'), 'gi'), '')
          .replace(/[，,。.？?\s]+/g, ' ')
          .trim();
        if (!question) {
          card = buildHelpCard();
        } else {
          card = buildAnswerCard(question, await fetchAnswer(question));
        }
        break;
      }
      default:
        card = buildHelpCard();
    }
  } catch (e) {
    console.error('[route]', e.message);
    card = buildErrorCard(e);
  }
  await sendFeishuCard(token, card);
}

// ============================================================
// 6. 事件过滤与处理
// ============================================================

export async function handleEvent(event) {
  if (event.message_type !== 'text') return;
  if (event.chat_type !== 'group') return;
  if (event.chat_id !== config.bot.chatId) return;
  const raw = event.content || '';
  const mention = `@${config.bot.botName}`;
  if (!raw.includes(mention)) return;
  const cmd = raw.split(mention)[1]?.trim() || '';
  console.log(`[cmd] from ${event.sender_id || '?'}: ${cmd}`);
  await routeCommand(cmd);
}

// ============================================================
// 7. 事件订阅子进程
// ============================================================

export function startEventListener() {
  console.log('正在启动 ai-review 对话机器人...');

  if (!config.bot.appId || !config.bot.appSecret) {
    console.error('错误: 未配置 FEISHU_AI_REVIEW_APP_ID / FEISHU_AI_REVIEW_APP_SECRET');
    process.exit(1);
  }
  if (!config.bot.chatId) {
    console.error('错误: 未配置 FEISHU_AI_REVIEW_CHAT_ID');
    process.exit(1);
  }

  const consumer = spawn(
    'lark-cli event consume im.message.receive_v1 --as bot --profile ai-review',
    [],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true }
  );

  let buf = '';
  consumer.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('[event] ready')) {
      console.log(`✅ 消息监听已就绪，监听群 ${config.bot.chatId}`);
      console.log(`   等待 @${config.bot.botName} 的命令...`);
    } else if (text.includes('"ok":false')) {
      console.error(`[监听错误] ${text}`);
    }
  });

  consumer.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleEvent(event).catch((err) => console.error(`[处理错误] ${err.message}`));
      } catch (e) {
        console.error(`[JSON 解析错误] ${e.message}: ${line.substring(0, 100)}`);
      }
    }
  });

  consumer.on('close', (code) => {
    console.log(`[消息监听] 退出，code=${code}`);
  });

  return { consumer };
}

// ============================================================
// 8. 导出（供 start.js 和测试使用）
// ============================================================

export {
  getFeishuToken,
  sendFeishuCard,
  routeCommand,
  matchCommand,
  fetchBoard,
  fetchIssues,
  fetchPRs,
  fetchAnswer,
  callMinimax,
  stripThinking,
  buildBoardCard,
  buildListCard,
  buildAnswerCard,
  buildHelpCard,
  buildErrorCard,
};