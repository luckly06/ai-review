// AI 审查脚本
// 1) 拿 PR diff
// 2) 调 minimax API 拿审查意见
// 3) post 评论到 PR
// 4) 发送飞书卡片通知到群聊
import https from 'node:https';
import { execSync } from 'node:child_process';

const {
  MINIMAX_API_KEY,
  GH_TOKEN,
  PR_NUMBER,
  REPO,
  BASE_REF,
  FEISHU_REVIEW_BOT_APP_ID,
  FEISHU_REVIEW_BOT_APP_SECRET,
  FEISHU_REVIEW_BOT_CHAT_ID,
} = process.env;

function fail(msg, err) {
  console.error('===== AI 审查失败 =====');
  console.error(msg);
  if (err) console.error(err);
  process.exit(1);
}

function readDiff() {
  try {
    const diff = execSync(
      `git fetch origin ${BASE_REF} --depth=1 && git diff origin/${BASE_REF}...HEAD`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    return diff;
  } catch (e) {
    fail('读取 diff 失败', e);
  }
}

function callMinimax(diff) {
  const body = JSON.stringify({
    model: 'MiniMax-M3',
    messages: [
      {
        role: 'user',
        content:
          '你是代码审查员，审查以下 PR diff，指出问题、建议改进、识别风险，用中文回答。\n\n' +
          '直接输出审查意见，不要复述你的任务、规则或思考过程。\n\n' +
          'DIFF START\n' + diff + '\nDIFF END',
      },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.minimaxi.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MINIMAX_API_KEY}`,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
          }
          try {
            const json = JSON.parse(chunks);
            const text = json.choices?.[0]?.message?.content;
            if (!text) return reject(new Error('API 返回空内容: ' + chunks));
            resolve(text);
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

function postComment(text) {
  const body = JSON.stringify({ body: text });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        port: 443,
        path: `/repos/${REPO}/issues/${PR_NUMBER}/comments`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ai-review-bot',
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode !== 201) {
            return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
          }
          resolve(JSON.parse(chunks));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 获取飞书 tenant_access_token
function getFeishuToken() {
  const body = JSON.stringify({
    app_id: FEISHU_REVIEW_BOT_APP_ID,
    app_secret: FEISHU_REVIEW_BOT_APP_SECRET,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'open.feishu.cn',
        port: 443,
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            const token = json.tenant_access_token;
            if (!token) return reject(new Error('获取飞书 token 失败: ' + chunks));
            resolve(token);
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

// 发送飞书卡片消息（AI 审查结果）
function sendFeishuReviewCard(token, reviewText) {
  // 截断过长内容（飞书卡片限制 30KB）
  const MAX_LEN = 25000;
  const truncated = reviewText.length > MAX_LEN
    ? reviewText.slice(0, MAX_LEN) + '\n\n⚠️ 内容过长，已截断。完整内容请查看 GitHub PR 评论。'
    : reviewText;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 AI 代码审查结果' },
      template: 'purple',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**仓库**: ${REPO}\n**PR**: #${PR_NUMBER}\n\n${truncated}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看 PR 详情' },
            url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
            type: 'primary',
          },
        ],
      },
    ],
  };

  const content = JSON.stringify(card);
  const body = JSON.stringify({
    receive_id: FEISHU_REVIEW_BOT_CHAT_ID,
    msg_type: 'interactive',
    content: content,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'open.feishu.cn',
        port: 443,
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            if (json.code !== 0) {
              console.error('飞书发送失败:', json.msg);
              return resolve(false);
            }
            resolve(true);
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

(async () => {
  console.log('===== AI 审查开始 =====');
  console.log(`repo=${REPO} pr=${PR_NUMBER} base=${BASE_REF}`);

  if (!PR_NUMBER || PR_NUMBER === 'undefined') {
    fail('PR_NUMBER 为空 —— 不是 PR 触发（可能是 workflow_dispatch）');
  }

  const diff = readDiff();
  console.log(`diff 长度: ${diff.length} 字符`);

  if (!diff.trim()) {
    console.log('diff 为空，跳过审查');
    return;
  }

  const review = await callMinimax(diff);
  console.log('===== AI 审查意见 =====');
  console.log(review);

  await postComment(review);
  console.log('===== 评论已 post =====');

  // 发送飞书通知（非阻塞，失败不影响主流程）
  if (FEISHU_REVIEW_BOT_APP_ID && FEISHU_REVIEW_BOT_APP_SECRET && FEISHU_REVIEW_BOT_CHAT_ID) {
    try {
      const feishuToken = await getFeishuToken();
      const sent = await sendFeishuReviewCard(feishuToken, review);
      if (sent) {
        console.log('===== 飞书审查通知已发送 =====');
      } else {
        console.log('===== 飞书审查通知发送失败（不影响主流程）=====');
      }
    } catch (e) {
      console.error('飞书通知异常（不影响主流程）:', e.message);
    }
  } else {
    console.log('===== 飞书通知未配置，跳过 =====');
  }
})().catch((e) => fail('未捕获错误', e));