// 查找 project 相关的 view mutation
import https from 'node:https';
import { execSync } from 'node:child_process';

const token = execSync(
  '"C:\\Program Files\\GitHub CLI\\gh.exe" auth token',
  { encoding: 'utf8' }
).trim();

function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', port: 443, path: '/graphql', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'introspect-view',
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try {
          const json = JSON.parse(chunks);
          if (json.errors) return reject(new Error('GraphQL: ' + JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // 查找所有包含 project 的 mutation
  const data = await graphql(`
    query {
      __type(name: "Mutation") {
        fields(includeDeprecated: true) {
          name
          description
        }
      }
    }
  `);

  const projectMutations = data.__type.fields.filter(f =>
    f.name.toLowerCase().includes('projectv2')
  );
  console.log('ProjectV2 相关 mutation:');
  projectMutations.forEach(f => console.log(`  ${f.name}: ${f.description}`));
})().catch(e => {
  console.error('失败:', e.message);
  process.exit(1);
});
