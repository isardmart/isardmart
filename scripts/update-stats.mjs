#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
const USERNAME = 'isardmart';
const README_PATH = 'README.md';
const START = '<!-- GITHUB-STATS:START -->';
const END = '<!-- GITHUB-STATS:END -->';

if (!TOKEN) {
  console.error('Error: set GH_STATS_TOKEN or GITHUB_TOKEN env var');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-profile-stats/1.0',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors.map(e => e.message).join('\n'));
  return data;
}

const QUERY = `
query($login: String!) {
  user(login: $login) {
    repositories(
      first: 100
      ownerAffiliations: [OWNER]
      isFork: false
      privacy: PUBLIC
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      nodes {
        name
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          totalSize
          edges { size node { name color } }
        }
      }
    }
    allPRs: pullRequests { totalCount }
    mergedPRs: pullRequests(states: [MERGED]) { totalCount }
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
      totalPullRequestReviewContributions
      totalIssueContributions
    }
    organizations(first: 20) {
      totalCount
      nodes { login name avatarUrl url }
    }
    followers { totalCount }
  }
}
`;

function aggregateLangs(repos) {
  const map = {};
  let total = 0;
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      map[node.name] ??= { size: 0, color: node.color ?? '#ccc' };
      map[node.name].size += size;
      total += size;
    }
  }
  return { map, total };
}

function buildLangBar(map, total) {
  const top8 = Object.entries(map)
    .sort(([, a], [, b]) => b.size - a.size)
    .slice(0, 8);

  // SVG progress bar made of colored segments
  const BAR_W = 500;
  let x = 0;
  const rects = top8.map(([, { size, color }]) => {
    const w = Math.round((size / total) * BAR_W);
    const rect = `<rect x="${x}" y="0" width="${w}" height="10" fill="${color}" rx="2"/>`;
    x += w;
    return rect;
  }).join('');

  // Legend dots
  const legend = top8.map(([name, { size, color }]) => {
    const pct = ((size / total) * 100).toFixed(1);
    return `<span>&#9679; <b>${name}</b>&nbsp;${pct}%</span>`;
  }).join('&emsp;');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="10">${rects}</svg>`;
  const b64 = Buffer.from(svg).toString('base64');

  return `<img src="data:image/svg+xml;base64,${b64}" alt="language bar" width="500" /><br/>\n${legend}`;
}

function buildSection(user) {
  const { map: langs, total: langTotal } = aggregateLangs(user.repositories.nodes);
  const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
  const commits =
    user.contributionsCollection.totalCommitContributions +
    user.contributionsCollection.restrictedContributionsCount;

  const langBar = langTotal > 0 ? buildLangBar(langs, langTotal) : '_No language data_';

  const orgLogos = user.organizations.nodes.length
    ? user.organizations.nodes
        .map(o => `<a href="${o.url}" title="${o.name ?? o.login}"><img src="${o.avatarUrl}" width="48" height="48" alt="${o.login}" style="border-radius:50%"/></a>`)
        .join('&nbsp;')
    : '_No public organization memberships_';

  const date = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  return `
<table width="100%">
<tr>
<td valign="top" width="48%">

### ⚡ Quick Stats

| | |
|---|:---:|
| 📦 Public repos | **${user.repositories.totalCount}** |
| ⭐ Stars earned | **${stars}** |
| 🔀 PRs opened | **${user.allPRs.totalCount}** |
| ✅ PRs merged | **${user.mergedPRs.totalCount}** |
| 💻 Commits (yr)* | **${commits}** |
| 🔍 PR reviews | **${user.contributionsCollection.totalPullRequestReviewContributions}** |
| 🐛 Issues opened | **${user.contributionsCollection.totalIssueContributions}** |
| 👥 Followers | **${user.followers.totalCount}** |

<sub>* public + private this year</sub>

</td>
<td valign="top" width="52%">

### 🗣️ Top Languages

${langBar}

### 🏢 Organizations

${orgLogos}

</td>
</tr>
</table>

<sub>📅 Last updated: ${date}</sub>
`;
}

const readme = readFileSync(README_PATH, 'utf8');
if (!readme.includes(START)) {
  console.error(`Missing ${START} marker in README.md`);
  process.exit(1);
}

console.log(`Fetching stats for @${USERNAME}…`);
const { user } = await gql(QUERY, { login: USERNAME });

const section = buildSection(user);
const updated = readme.replace(
  new RegExp(`${START}[\\s\\S]*?${END}`),
  `${START}\n${section}\n${END}`,
);

writeFileSync(README_PATH, updated, 'utf8');
console.log('✅ README.md updated');
