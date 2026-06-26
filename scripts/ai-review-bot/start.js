// ai-review 对话机器人 - 启动入口
// 用法: node start.js
// 需要环境变量: FEISHU_AI_REVIEW_APP_ID, FEISHU_AI_REVIEW_APP_SECRET, FEISHU_AI_REVIEW_CHAT_ID
// 可选: PROJECT_TOKEN (GitHub PAT，用于查看板/Issue/PR)

import { startEventListener } from './index.js';

let consumer = null;

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭 ai-review 对话机器人...`);
  if (consumer) {
    consumer.consumer?.kill('SIGTERM');
    setTimeout(() => {
      console.log('已关闭');
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});

console.log('========================================');
console.log('  ai-review 对话机器人 v0.1.0');
console.log('========================================');
console.log('');

consumer = startEventListener();

// 保活：stdin 永不 EOF（lark-cli event consume 需要）
process.stdin.resume();