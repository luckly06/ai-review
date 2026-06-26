#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署 fetchAnswer 改版 + 测两道题验证格式约束
1. 问代码示例 — 应返回 ``` 围栏
2. 问 Mermaid — 应拒绝输出 mermaid，改说"请去 GitHub 看"
"""
import paramiko, sys, re

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('124.71.209.36', 22, 'root', 'Www135168.', timeout=15)

# 1) 推 index.js
sftp = ssh.open_sftp()
sftp.put(r'F:\ai_agent\dev2\xiaomi\ai\test08\ai-review\scripts\ai-review-bot\index.js',
         '/opt/ai-review-bot/index.js')
sftp.close()
print('=== uploaded index.js ===')

# 2) 测试脚本 — 跑两道题
TEST = """
import { fetchAnswer } from './index.js';

console.log('=== Q1: 问代码示例 ===');
const a1 = await fetchAnswer('写一个 Python 函数，判断一个数是不是素数');
console.log('--- answer ---');
console.log(a1);
console.log('--- check ---');
console.log('has fenced code block?', /```\\w*\\n[\\s\\S]+?```/.test(a1));
console.log('no mermaid?', !/```mermaid/i.test(a1));

console.log('\\n=== Q2: 问 Mermaid ===');
const a2 = await fetchAnswer('画一个用户登录流程的时序图');
console.log('--- answer ---');
console.log(a2);
console.log('--- check ---');
console.log('no mermaid block?', !/```mermaid/i.test(a2));
console.log('mentions GitHub?', a2.includes('github.com/luckly06/ai-review'));
"""

sftp = ssh.open_sftp()
with sftp.file('/opt/ai-review-bot/t-format.mjs', 'w') as f:
    f.write(TEST)
sftp.close()

# 3) 拿 key
stdin, stdout, stderr = ssh.exec_command(
    "grep MINIMAX_API_KEY /opt/ai-review-bot/ecosystem.config.cjs | head -1",
    timeout=5)
key_line = stdout.read().decode('utf-8', errors='replace').strip()
m = re.search(r"['\"]([^'\"]+)['\"]", key_line)
api_key = m.group(1) if m else ''
print(f'=== got key len={len(api_key)} ===')

# 4) 跑测试
cmd = f"cd /opt/ai-review-bot && MINIMAX_API_KEY='{api_key}' node t-format.mjs 2>&1"
print(f'=== running ===')
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=90)
raw = stdout.read()
# 写文件，print 时用 errors='replace' 避免 GBK 编码爆掉
with open(r'F:\ai_agent\dev2\xiaomi\ai\test08\ai-review\deploy\test-format.out', 'wb') as f:
    f.write(raw)
out = raw.decode('utf-8', errors='replace')
print(out)

# 5) 重启 + 清理
stdin, stdout, stderr = ssh.exec_command(
    'pm2 restart ai-review-bot --update-env 2>&1 | tail -3 && rm -f /opt/ai-review-bot/t-format.mjs',
    timeout=15)
print('=== restart ===')
print(stdout.read().decode('utf-8', errors='replace'))

ssh.close()
