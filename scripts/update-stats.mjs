#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

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
    followers { totalCount }
  }
}
`;

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

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

  // Legend baked INTO the svg so each dot keeps its language colour
  // (GitHub markdown strips inline text colour, so a plain-text legend
  // would render every bullet in the same default colour).
  const FONT = 13;      // px
  const CHAR_W = 7.1;   // approx advance width at this font size
  const DOT_R = 5;      // dot radius
  const DOT_GAP = 8;    // dot → text gap
  const ITEM_GAP = 22;  // item → item gap
  const ROW_H = 22;     // legend line height
  const START_Y = 28;   // first legend baseline (below the bar)

  let lx = 0;
  let ly = 0;
  const legend = top8.map(([name, { size, color }]) => {
    const pct = ((size / total) * 100).toFixed(1);
    const label = `${name} ${pct}%`;
    const itemW = DOT_R * 2 + DOT_GAP + label.length * CHAR_W;
    if (lx > 0 && lx + itemW > BAR_W) { lx = 0; ly += 1; }
    const baseline = START_Y + ly * ROW_H;
    const cx = lx + DOT_R;
    const cy = baseline - FONT / 2 + 1;
    const tx = lx + DOT_R * 2 + DOT_GAP;
    lx += itemW + ITEM_GAP;
    return (
      `<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${color}"/>` +
      `<text x="${tx}" y="${baseline}" font-size="${FONT}" fill="#8b949e">` +
      `<tspan font-weight="600">${escapeXml(name)}</tspan> ${pct}%</text>`
    );
  }).join('');

  const rows = ly + 1;
  const svgH = START_Y + (rows - 1) * ROW_H + 4;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${svgH}" ` +
    `font-family="Segoe UI, Helvetica, Arial, sans-serif">${rects}${legend}</svg>`;

  mkdirSync('assets', { recursive: true });
  writeFileSync('assets/top-langs.svg', svg, 'utf8');
  return `<img src="./assets/top-langs.svg" alt="Top languages" width="500" />`;
}

function buildSection(user) {
  const { map: langs, total: langTotal } = aggregateLangs(user.repositories.nodes);
  const commits =
    user.contributionsCollection.totalCommitContributions +
    user.contributionsCollection.restrictedContributionsCount;

  const langBar = langTotal > 0 ? buildLangBar(langs, langTotal) : '_No language data_';

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
| 🔀 PRs opened | **${user.allPRs.totalCount}** |
| ✅ PRs merged | **${user.mergedPRs.totalCount}** |
| 💻 Commits (yr)* | **${commits}** |
| 🐛 Issues opened | **${user.contributionsCollection.totalIssueContributions}** |
| 👥 Followers | **${user.followers.totalCount}** |

<sub>* public + private this year</sub>

</td>
<td valign="top" width="52%">

### 🗣️ Top Languages

${langBar}

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
