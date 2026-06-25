// 请假交接机器人 - 启动入口
// 用法: node start.js
// 需要环境变量: LEAVE_BOT_APP_ID, LEAVE_BOT_APP_SECRET, LEAVE_BOT_CHAT_ID

import { startEventListener } from './index.js';

// 优雅退出处理
let consumers = null;

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭请假交接机器人...`);
  if (consumers) {
    consumers.messageConsumer?.kill('SIGTERM');
    consumers.reactionConsumer?.kill('SIGTERM');
    // 给 lark-cli 3 秒时间清理订阅
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

// 捕获未处理的异常，防止进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});

// 启动
console.log('========================================');
console.log('  飞书请假交接机器人 v1.0.0');
console.log('========================================');
console.log('');

consumers = startEventListener();

// 保活：stdin 永不 EOF（lark-cli event consume 需要）
// 在无界面环境中运行时，stdin 可能立即 EOF 导致子进程退出
process.stdin.resume();
