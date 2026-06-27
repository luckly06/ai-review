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
            if (json.code !== 0) {
              console.error('[feishu-send]', JSON.stringify(json));
              return resolve(false);
            }
            resolve(true);
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
// 1b. 写操作守卫 — 纵深防御
// ============================================================
//
// 即便 AI 通过 prompt injection 引导代码调 GitHub 写 API，
// 或未来开发者手滑加了 write 调用，运行时也会直接抛错。
//
// 规则：
// - REST 只允许 GET / HEAD 到 api.github.com
// - GraphQL POST 允许（GitHub 强制），但 body 必须以 "query" 或 "mutation __safe"
//   开头且不能含 mutation 关键字（mutation 操作目前一律拒绝）

function safeGitHubRest(method, path) {
  const m = method.toUpperCase();
  if (!['GET', 'HEAD'].includes(m)) {
    throw new Error(`[guard] GitHub REST ${m} ${path} 被拒：bot 只有读权限`);
  }
}

function safeGitHubGraphQL(body) {
  // body 是 JSON 字符串化后的 { query, variables }
  const parsed = JSON.parse(body);
  const q = (parsed.query || '').trim();
  if (!/^query\b/i.test(q)) {
    throw new Error(`[guard] GitHub GraphQL 必须是 query 操作，拒绝以 "${q.slice(0, 30)}..." 开头的请求`);
  }
  if (/\bmutation\b/i.test(q)) {
    throw new Error(`[guard] GitHub GraphQL mutation 被拒：bot 没有写权限`);
  }
}

// ============================================================
// 2. GitHub API 调用
// ============================================================

function githubGraphQL(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  safeGitHubGraphQL(body);  // 守卫：拒绝 mutation
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
  safeGitHubRest('GET', path);  // 守卫：拒绝非 GET
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

async function fetchAnswer(question, ctx = '') {
  requireMinimax();
  const ctxPart = ctx
    ? '\n以下是与用户问题相关的上下文数据，请基于此评注：\n' +
      (ctx.length > 5000 ? ctx.slice(0, 5000) + '\n...（已截断）' : ctx) +
      '\n'
    : '';
  const prompt =
    '你是 ai-review 助手，回答要简洁（中文）。\n' +
    '你的能力范围：回答问题、解释概念、写示例代码片段（只展示、不落盘）。\n' +
    '\n' +
    '你的内置命令（必须用 @ai-review 前缀触发，不需要额外触发词）：\n' +
    '• @ai-review 看板 — 看 GitHub Project 各列卡片数（Backlog/Ready/In progress/In review/Done）\n' +
    '• @ai-review issue — 列 open Issue（最多 10 条，带链接）\n' +
    '• @ai-review pr — 列 open PR（最多 10 条，带链接）\n' +
    '当用户问"你能干嘛"/"你会啥"/"怎么用"/"help"时，必须把上面三条命令也列出来。\n' +
    '\n' +
    '输出格式约束（飞书卡片 lark_md 渲染规则，必须遵守）：\n' +
    '• 代码示例用 ```语言 围栏 包起来（lark_md 会按等宽字体展示，无语法高亮）\n' +
    '• 不要输出 Mermaid 图表源码（飞书卡片无法渲染），改用纯文本/列表/ASCII 图，并在末尾提示"图表请去 https://github.com/luckly06/ai-review 查看"\n' +
    '• 不要输出 Markdown 表格（飞书卡片不支持），用列表项"• 标题：值"替代\n' +
    '• 单条回答尽量控制在 500 字以内；超过时用要点列表分段\n' +
    '\n' +
    '你不能做的事（必须拒绝并说明原因）：\n' +
    '1. 写代码到任何文件、修改文件、创建 PR、提交 commit\n' +
    '2. 执行任何 shell / 文件操作 / 部署动作\n' +
    '3. 调用 GitHub API 去改仓库内容\n' +
    '如果用户要求做上述事情，明确拒绝并告诉他去找 Claude Code 或自己来。\n' +
    '用户问的是项目相关问题（仓库 luckly06/ai-review），可以直接基于常识回答。\n\n' +
    ctxPart +
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

function buildAnswerCard(question, answer, headerTitle = 'AI 回答') {
  const MAX = 25000;
  const text = answer.length > MAX
    ? answer.slice(0, MAX) + '\n\n⚠️ 内容过长，已截断。'
    : answer;
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: headerTitle }, template: 'blue' },
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
          '• 任何其他问题 — 直接 @ 我，调 MiniMax 自由回答',
          '',
          '**示例**：`@ai-review 这段代码啥意思` / `@ai-review 帮我写个正则`',
          '**触发规则**：必须 @ai-review 才会响应',
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
// 4b. 双卡发送 helper — 先发数据卡（同步），再异步发 AI 评注卡（fire-and-forget）
// ============================================================
//
// 设计意图：
// - 第一张失败就不发第二张——避免 AI 凭空评注无数据的问题
// - 第二张 catch 只打日志，不回发错误卡——避免三连击刷屏
// - 不 await 第二张——handleEvent 不被卡住，下条消息能立刻进 routeCommand

async function sendDualCard(token, dataCard, ctxText, cmd, headerTitle) {
  const ok = await sendFeishuCard(token, dataCard);
  if (!ok) {
    console.error('[dual-card] 第一张数据卡发送失败，跳过 AI 评注。cmd=', cmd);
    return;
  }
  fetchAnswer(cmd, ctxText)
    .then((ans) => sendFeishuCard(token, buildAnswerCard(cmd, ans, headerTitle)))
    .catch((e) => console.error('[ai-followup]', e.message));
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
      case 'board': {
        const data = await fetchBoard();
        const ctx = `看板数据快照（来源：${data.title}）：\n${JSON.stringify(data.buckets)}`;
        sendDualCard(token, buildBoardCard(data), ctx, cmd, '看板评注');
        return;
      }
      case 'issue':
        // Issue 列表本身就是结构化数据，AI 复读无价值，保持单卡
        card = buildListCard('Issue', await fetchIssues(), `${repoUrl}/issues`);
        break;
      case 'pr': {
        const rows = await fetchPRs();
        const ctx = `当前 open PR（共 ${rows.length} 条）：\n` +
          rows.slice(0, 5).map((r) => `- #${r.number} ${r.title}`).join('\n');
        sendDualCard(token, buildListCard('PR', rows, `${repoUrl}/pulls`), ctx, cmd, 'PR 评注');
        return;
      }
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
      default: {
        // 其他都走 AI 自由问答（不要求 "问" 字）
        const question = cmd.trim();
        if (!question) {
          card = buildHelpCard();
        } else {
          card = buildAnswerCard(question, await fetchAnswer(question));
        }
        break;
      }
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
  sendDualCard,
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
  safeGitHubRest,
  safeGitHubGraphQL,
};