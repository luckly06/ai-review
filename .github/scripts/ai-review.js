// AI 审查脚本
// 1) 拿 PR diff
// 2) 调 minimax API 拿审查意见
// 3) post 评论到 PR
import https from 'node:https';
import { execSync } from 'node:child_process';

const {
  MINIMAX_API_KEY,
  GH_TOKEN,
  PR_NUMBER,
  REPO,
  BASE_REF,
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
})().catch((e) => fail('未捕获错误', e));