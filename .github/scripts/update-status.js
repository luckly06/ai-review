// 更新看板 Status 字段选项
import https from 'node:https';
import { execSync } from 'node:child_process';

const token = execSync(
  '"C:\\Program Files\\GitHub CLI\\gh.exe" auth token',
  { encoding: 'utf8' }
).trim();

const STATUS_FIELD_ID = 'PVTSSF_lAHOC2zqGM4BbalwzhWLRLI';

function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        port: 443,
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'update-status-script',
          Authorization: `Bearer ${token}`,
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
            if (json.errors) {
              return reject(new Error('GraphQL: ' + JSON.stringify(json.errors, null, 2)));
            }
            resolve(json.data);
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
  console.log('更新 Status 字段选项...');

  await graphql(`
    mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      updateProjectV2Field(input: {
        fieldId: $fieldId,
        singleSelectOptions: $options
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            name
            options {
              name
            }
          }
        }
      }
    }
  `, {
    fieldId: STATUS_FIELD_ID,
    options: [
      { name: 'Backlog', description: '待处理', color: 'GRAY' },
      { name: 'Ready', description: '准备开始', color: 'BLUE' },
      { name: 'In progress', description: '进行中', color: 'YELLOW' },
      { name: 'In review', description: '审查中', color: 'ORANGE' },
      { name: 'Done', description: '已完成', color: 'GREEN' },
    ],
  });

  console.log('Status 字段已更新: Backlog / Ready / In progress / In review / Done');
  console.log('看板地址: https://github.com/users/luckly06/projects/1');
})().catch(e => {
  console.error('更新失败:', e.message);
  process.exit(1);
});
