// GitHub Projects V2 看板初始化脚本
// 用法: REPO=owner/repo GH_TOKEN=xxx node .github/scripts/setup-project.js
//
// 功能:
//   1. 创建 GitHub Project (V2) 看板
//   2. 添加 Status 字段选项: Backlog / Ready / In progress / In review / Done
//   3. 输出 Project ID 和字段 ID 供自动化 workflow 使用

import https from 'node:https';

const { REPO, GH_TOKEN } = process.env;

if (!REPO || !GH_TOKEN) {
  console.error('请设置 REPO 和 GH_TOKEN 环境变量');
  console.error('示例: REPO=owner/repo GH_TOKEN=xxx node .github/scripts/setup-project.js');
  process.exit(1);
}

const [owner, repo] = REPO.split('/');
if (!owner || !repo) {
  console.error('REPO 格式错误，应为 owner/repo');
  process.exit(1);
}

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
          'User-Agent': 'setup-project-script',
          Authorization: `Bearer ${GH_TOKEN}`,
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
              return reject(new Error('GraphQL 错误: ' + JSON.stringify(json.errors, null, 2)));
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

async function getRepoId() {
  const data = await graphql(`
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
      }
    }
  `, { owner, repo });
  return data.repository.id;
}

async function getViewerId() {
  const data = await graphql(`
    query {
      viewer {
        id
      }
    }
  `);
  return data.viewer.id;
}

async function createProject(title) {
  const ownerId = await getViewerId();
  const data = await graphql(`
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 {
          id
          number
          title
        }
      }
    }
  `, { ownerId, title });
  return data.createProjectV2.projectV2;
}

async function linkProjectToRepo(projectId, repoId) {
  await graphql(`
    mutation($projectId: ID!, $repoId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repoId }) {
        projectV2 {
          id
        }
      }
    }
  `, { projectId, repoId });
}

async function getProjectFields(projectId) {
  const data = await graphql(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2Field {
                id
                name
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `, { projectId });
  return data.node.fields.nodes;
}

async function updateStatusField(projectId, fieldId) {
  // 更新 Status 单选字段，添加看板列选项
  await graphql(`
    mutation($projectId: ID!, $fieldId: ID!) {
      updateProjectV2Field(input: {
        projectId: $projectId,
        fieldId: $fieldId,
        singleSelectOptions: [
          { name: "Backlog" },
          { name: "Ready" },
          { name: "In progress" },
          { name: "In review" },
          { name: "Done" }
        ]
      }) {
        projectV2 {
          id
        }
      }
    }
  `, { projectId, fieldId });
}

async function addView(projectId) {
  // 添加 Board 视图，按 Status 分组
  const data = await graphql(`
    mutation($projectId: ID!) {
      addProjectV2DraftIssue(input: { projectId: $projectId, title: "看板已就绪" }) {
        projectItem {
          id
        }
      }
    }
  `, { projectId });
  return data;
}

(async () => {
  console.log('===== 开始创建看板 =====');
  console.log(`仓库: ${REPO}`);

  // 1. 获取 repo ID
  const repoId = await getRepoId();
  console.log(`仓库 ID: ${repoId}`);

  // 2. 创建 Project
  const projectTitle = `${repo} 看板`;
  const project = await createProject(projectTitle);
  console.log(`看板已创建: ${project.title} (#${project.number})`);
  console.log(`Project ID: ${project.id}`);

  // 3. 关联到仓库
  await linkProjectToRepo(project.id, repoId);
  console.log('已关联到仓库');

  // 4. 获取字段并更新 Status
  const fields = await getProjectFields(project.id);
  const statusField = fields.find(f => f.name === 'Status');
  if (statusField) {
    await updateStatusField(project.id, statusField.id);
    console.log('Status 字段已更新: Backlog / Ready / In progress / In review / Done');
  } else {
    console.log('未找到 Status 字段，请手动在 GitHub 网页端添加');
  }

  // 5. 输出关键信息
  console.log('\n===== 看板创建完成 =====');
  console.log(`Project Number: ${project.number}`);
  console.log(`Project ID: ${project.id}`);
  if (statusField) {
    console.log(`Status Field ID: ${statusField.id}`);
  }
  console.log('\n请将以下值添加到仓库 Secrets:');
  console.log(`  PROJECT_ID = ${project.id}`);
  if (statusField) {
    console.log(`  STATUS_FIELD_ID = ${statusField.id}`);
  }
  console.log(`\n打开看板: https://github.com/${REPO}/projects/${project.number}`);
})().catch(e => {
  console.error('创建失败:', e.message);
  process.exit(1);
});
