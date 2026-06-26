#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署 fetchAnswer 改版 + 用 node 调一次 MiniMax 验证 prompt 行为"""
import paramiko, sys, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('124.71.209.36', 22, 'root', 'Www135168.', timeout=15)

# 1) 推 index.js
sftp = ssh.open_sftp()
sftp.put(r'F:\ai_agent\dev2\xiaomi\ai\test08\ai-review\scripts\ai-review-bot\index.js',
         '/opt/ai-review-bot/index.js')
sftp.close()
print('=== uploaded index.js ===')

# 2) 写一个 node 测试：直接调 fetchAnswer('你能干嘛')
#    从 ecosystem.config.cjs 读 MINIMAX_API_KEY，注入到子进程 env
TEST = """
import { fetchAnswer } from './index.js';
const ans = await fetchAnswer('你能干嘛');
console.log('--- answer ---');
console.log(ans);
console.log('--- contains 看板? ---', ans.includes('看板'));
console.log('--- contains issue? ---', /\\bissue\\b/i.test(ans));
console.log('--- contains pr? ---', /\\bpr\\b/i.test(ans));
"""

sftp = ssh.open_sftp()
with sftp.file('/opt/ai-review-bot/t-prompt.mjs', 'w') as f:
    f.write(TEST)
sftp.close()

# 3) 从 ecosystem 拿 key
stdin, stdout, stderr = ssh.exec_command(
    "grep MINIMAX_API_KEY /opt/ai-review-bot/ecosystem.config.cjs | head -1",
    timeout=5)
key_line = stdout.read().decode('utf-8', errors='replace').strip()
# key_line 形如:  MINIMAX_API_KEY: 'sk-cp-...',
import re
m = re.search(r"['\"]([^'\"]+)['\"]", key_line)
api_key = m.group(1) if m else ''
print(f'=== got key len={len(api_key)} ===')

# 4) 跑测试
cmd = f"cd /opt/ai-review-bot && MINIMAX_API_KEY='{api_key}' node t-prompt.mjs 2>&1"
print(f'=== running: {cmd[:80]}... ===')
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=60)
out = stdout.read().decode('utf-8', errors='replace')
print(out)

# 5) 重启 + 清理
stdin, stdout, stderr = ssh.exec_command(
    'pm2 restart ai-review-bot --update-env 2>&1 | tail -3 && rm -f /opt/ai-review-bot/t-prompt.mjs',
    timeout=15)
print('=== restart ===')
print(stdout.read().decode('utf-8', errors='replace'))

ssh.close()
