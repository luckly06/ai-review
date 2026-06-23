// 看板自动化脚本
// 根据事件类型自动移动卡片到对应列
//
// 自动化规则:
//   Issue opened       → Backlog
//   Issue assigned     → Ready
//   Issue closed       → Done
//   Issue reopened     → Backlog
//   PR opened          → In progress
//   PR ready_for_review → In review
//   PR review_requested → In review
//   PR closed (merged)  → Done
//   PR reopened         → In progress

import https from 'node:https';

const {
  GH_TOKEN,
  PROJECT_ID,
  STATUS_FIELD_ID,
  EVENT_NAME,
  EVENT_ACTION,
  REPO,
  ISSUE_NUMBER,
  PR_NUMBER,
  IS_PR,
} = process.env;

if (!GH_TOKEN || !PROJECT_ID || !STATUS_FIELD_ID) {
  console.log('缺少 PROJECT_ID 或 STATUS_FIELD_ID，跳过看板自动化');
  console.log('请运行 setup-project.js 并将输出添加到仓库 Secrets');
  process.exit(0);
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
          'User-Agent': 'project-automation-script',
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

// 根据事件决定目标列
function getTargetStatus() {
  const isPR = IS_PR === 'true';
  const action = EVENT_ACTION;

  if (isPR) {
    switch (action) {
      case 'opened':
      case 'reopened':
        return 'In progress';
      case 'ready_for_review':
      case 'review_requested':
        return 'In review';
      case 'closed':
        return 'Done';
      default:
        return null;
    }
  } else {
    // Issue
    switch (action) {
      case 'opened':
      case 'reopened':
        return 'Backlog';
      case 'assigned':
        return 'Ready';
      case 'closed':
        return 'Done';
      default:
        return null;
    }
  }
}

async function getNodeItemId() {
  // 获取 Issue 或 PR 的 node ID
  const number = isPR() ? PR_NUMBER : ISSUE_NUMBER;
  if (!number) return null;

  const [owner, repo] = REPO.split('/');
  const query = isPR()
    ? `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { id }
        }
      }`
    : `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) { id }
        }
      }`;

  const data = await graphql(query, { owner, repo, number: parseInt(number) });
  return isPR()
    ? data.repository.pullRequest.id
    : data.repository.issue.id;
}

function isPR() {
  return IS_PR === 'true';
}

async function addItemToProject(contentId) {
  // 将 Issue/PR 添加到 Project
  const data = await graphql(`
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item {
          id
        }
      }
    }
  `, { projectId: PROJECT_ID, contentId: contentId });
  return data.addProjectV2ItemById.item.id;
}

async function findProjectItem(contentId) {
  // 在 Project 中查找已有的 item
  const data = await graphql(`
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue { id }
                ... on PullRequest { id }
              }
            }
          }
        }
      }
    }
  `, { projectId: PROJECT_ID });

  const items = data.node.items.nodes;
  const found = items.find(item => item.content?.id === contentId);
  return found?.id || null;
}

async function getOrCreateItem(contentId) {
  // 先查找，找不到就添加
  let itemId = await findProjectItem(contentId);
  if (!itemId) {
    itemId = await addItemToProject(contentId);
    console.log(`已添加到看板: item ${itemId}`);
  }
  return itemId;
}

async function updateItemStatus(itemId, statusName) {
  // 获取 Status 字段的选项 ID
  const data = await graphql(`
    query($projectId: ID!, $fieldId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          field(id: $fieldId) {
            ... on ProjectV2SingleSelectField {
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  `, { projectId: PROJECT_ID, fieldId: STATUS_FIELD_ID });

  const options = data.node.field.options;
  const targetOption = options.find(opt => opt.name === statusName);
  if (!targetOption) {
    throw new Error(`未找到 Status 选项: ${statusName}`);
  }

  // 更新 item 的 Status
  await graphql(`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item {
          id
        }
      }
    }
  `, {
    projectId: PROJECT_ID,
    itemId,
    fieldId: STATUS_FIELD_ID,
    optionId: targetOption.id,
  });
}

(async () => {
  const targetStatus = getTargetStatus();
  if (!targetStatus) {
    console.log(`事件 ${EVENT_NAME}.${EVENT_ACTION} 无需移动卡片`);
    return;
  }

  console.log(`事件: ${EVENT_NAME}.${EVENT_ACTION}`);
  console.log(`目标列: ${targetStatus}`);

  const contentId = await getNodeItemId();
  if (!contentId) {
    console.error('无法获取 Issue/PR 的 Node ID');
    process.exit(1);
  }

  const itemId = await getOrCreateItem(contentId);
  await updateItemStatus(itemId, targetStatus);

  console.log(`卡片已移动到: ${targetStatus}`);
})().catch(e => {
  console.error('自动化失败:', e.message);
  process.exit(1);
});
