const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT_DIR = path.resolve(__dirname, '..');
const CODES_DIR = path.join(ROOT_DIR, 'codes');
const TEAMS_DIR = path.join(ROOT_DIR, 'teams');
const TEAMS_JSON_PATH = path.join(ROOT_DIR, 'teams.json');
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'index.html');
const CNAME_PATH = path.join(ROOT_DIR, 'CNAME');

const BASE_DOMAIN = 'okwwcharcode.ok-script.com';
const BASE_URL = `https://${BASE_DOMAIN}`;

// 显示层中文译名表：只影响 index.html 的渲染结果。
// teams.json / teams/*.json / codes/*.zip 里的数据一律保持原始英文，保证 slug、分组键与 API 地址不变。
const CHARACTER_NAMES_PATH = path.join(__dirname, 'character-names.json');

function loadCharacterNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHARACTER_NAMES_PATH, 'utf8'));
    return (raw && raw.characters) ? raw.characters : raw;
  } catch (err) {
    console.warn(`[WARN] Failed to load scripts/character-names.json (${err.message}). Falling back to original names.`);
    return {};
  }
}

const CHARACTER_NAMES = loadCharacterNames();
const unmappedNames = new Set();

function toDisplayName(name) {
  const key = String(name).trim();
  if (CHARACTER_NAMES[key]) {
    return CHARACTER_NAMES[key];
  }
  if (/^[\x20-\x7E]+$/.test(key)) {
    unmappedNames.add(key);
  }
  return key;
}

// 按原有分隔符（, ，/）逐个翻译队伍名，分隔符与空白保持原样。
function toDisplayTeamText(team) {
  return String(team)
    .split(/([,，/])/)
    .map(part => (/^[,，/]$/.test(part)
      ? part
      : part.replace(/^(\s*)([\s\S]*?)(\s*)$/, (m, lead, core, trail) => lead + toDisplayName(core) + trail)))
    .join('');
}

function getGitCommitTimestamp(filePath) {
  try {
    const relPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
    const stdout = execSync(`git log -1 --format=%ct -- "${relPath}"`, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    const parsed = parseInt(stdout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  } catch (err) {
    // fallback if git command fails or file is not yet committed
  }

  try {
    const stats = fs.statSync(filePath);
    return Math.floor(stats.mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function sanitizeSlug(str) {
  return str
    .replace(/[\\/:*?"<>|,，;+]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function getGithubRepo() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    if (pkg.repository && typeof pkg.repository === 'string') {
      return pkg.repository.replace(/^git\+/, '').replace(/\.git$/, '');
    }
    if (pkg.repository && pkg.repository.url) {
      return pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '');
    }
  } catch {
    // fallback
  }
  return 'ok-oldking/ok-ww-char-code';
}

function parseZipFiles() {
  if (!fs.existsSync(CODES_DIR)) {
    console.warn(`[WARN] Codes directory not found at ${CODES_DIR}. Creating it...`);
    fs.mkdirSync(CODES_DIR, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(CODES_DIR);
  const zipFiles = files.filter(f => f.toLowerCase().endsWith('.zip'));

  console.log(`[INFO] Found ${zipFiles.length} zip files in codes/`);

  const results = [];

  for (const file of zipFiles) {
    const zipPath = path.join(CODES_DIR, file);
    const stats = fs.statSync(zipPath);
    let teamData = null;

    try {
      const zip = new AdmZip(zipPath);
      const teamEntry = zip.getEntry('team.json');

      if (teamEntry) {
        const content = teamEntry.getData().toString('utf8');
        teamData = JSON.parse(content);
      } else {
        console.warn(`[WARN] ${file} does not contain team.json`);
      }
    } catch (err) {
      console.error(`[ERROR] Failed to read team.json in ${file}:`, err.message);
    }

    const fallbackName = file.replace(/\.zip$/i, '');
    const name = (teamData && teamData.name) ? teamData.name : fallbackName;
    const author = (teamData && teamData.author) ? teamData.author : 'Unknown';
    const version = (teamData && teamData.version) ? teamData.version : '1.0.0';
    const description = (teamData && teamData.description) ? teamData.description : '';
    const team = (teamData && teamData.team) ? teamData.team : (name || 'Unassigned');

    const members = team
      .split(/[,，/]/)
      .map(m => m.trim())
      .filter(Boolean);

    const encodedFileName = encodeURIComponent(file);
    const timestamp = getGitCommitTimestamp(zipPath);

    results.push({
      filename: file,
      downloadUrl: `${BASE_URL}/codes/${encodedFileName}`,
      relativePath: `codes/${encodedFileName}`,
      rawUrl: `https://raw.githubusercontent.com/${getGithubRepo()}/main/codes/${encodedFileName}`,
      name,
      author,
      version,
      description,
      team,
      members,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      timestamp,
      modifiedAt: new Date(timestamp * 1000).toISOString(),
    });
  }

  return results;
}

function groupDataByTeam(items) {
  const groups = {};

  for (const item of items) {
    const teamName = item.team || 'Unassigned';
    if (!groups[teamName]) {
      const slug = sanitizeSlug(teamName);
      groups[teamName] = {
        team: teamName,
        slug,
        jsonUrl: `${BASE_URL}/teams/${slug}.json`,
        relativeJsonPath: `teams/${slug}.json`,
        members: item.members.length > 0 ? item.members : [teamName],
        totalCodes: 0,
        codes: []
      };
    }
    groups[teamName].codes.push(item);
    groups[teamName].totalCodes += 1;
  }

  return groups;
}

function generateHtml(teamsGrouped, allItems, repoName) {
  const teamsList = Object.values(teamsGrouped);
  const totalCodes = allItems.length;
  const totalTeams = teamsList.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wuthering Waves Character Codes Repository</title>
  <meta name="description" content="Download and browse character codes and team configurations for Wuthering Waves. Grouped by team with direct zip downloads and JSON APIs.">
  <link rel="canonical" href="${BASE_URL}/">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0b0f17;
      --bg-surface: #121824;
      --bg-surface-elevated: #1a2332;
      --bg-surface-hover: #222d40;
      --border-subtle: #243044;
      --border-focus: #4b6bfb;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --accent-secondary: #818cf8;
      --success: #34d399;
      --warning: #fbbf24;
      --font-main: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-main);
      line-height: 1.5;
      min-height: 100vh;
      padding: 2rem 1.5rem 4rem;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      margin-bottom: 2.5rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .brand-title {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .brand-title .badge-domain {
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.2rem 0.6rem;
      background: var(--bg-surface-elevated);
      color: var(--accent);
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      font-family: var(--font-mono);
    }

    .brand-desc {
      color: var(--text-secondary);
      font-size: 1rem;
      max-width: 680px;
      margin-top: 0.25rem;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .btn-api, .btn-github {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.55rem 1rem;
      border-radius: var(--radius-sm);
      text-decoration: none;
      transition: all 0.2s ease;
      cursor: pointer;
    }

    .btn-api {
      background: var(--bg-surface-elevated);
      color: var(--accent);
      border: 1px solid var(--border-subtle);
    }

    .btn-api:hover {
      background: var(--bg-surface-hover);
      border-color: var(--accent);
    }

    .btn-github {
      background: #232a3b;
      color: #fff;
      border: 1px solid var(--border-subtle);
    }

    .btn-github:hover {
      background: #2e374d;
    }

    /* Stats Banner */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 1.15rem 1.25rem;
      display: flex;
      flex-direction: column;
    }

    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #fff;
      font-family: var(--font-mono);
      line-height: 1.2;
    }

    .stat-label {
      font-size: 0.825rem;
      color: var(--text-secondary);
      font-weight: 500;
      margin-top: 0.25rem;
    }

    /* Controls Bar (Search & Filters) */
    .controls-bar {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-bottom: 2.25rem;
    }

    @media (min-width: 640px) {
      .controls-bar {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }

    .search-wrapper {
      position: relative;
      flex: 1;
      max-width: 480px;
    }

    .search-icon {
      position: absolute;
      left: 1rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
      width: 18px;
      height: 18px;
    }

    .search-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 0.75rem 1rem 0.75rem 2.75rem;
      color: var(--text-primary);
      font-size: 0.95rem;
      font-family: var(--font-main);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .search-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }

    .search-input::placeholder {
      color: var(--text-muted);
    }

    .filter-info {
      font-size: 0.875rem;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    /* Team Section & Groups */
    .teams-container {
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .team-group {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.2s ease;
    }

    .team-group:hover {
      border-color: #3b4d6a;
    }

    .team-header {
      padding: 1.25rem 1.5rem;
      background: var(--bg-surface-elevated);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .team-title-wrap {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .team-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .member-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .chip-member {
      background: #111e33;
      color: var(--accent);
      border: 1px solid #1e3a5f;
      font-size: 0.775rem;
      font-weight: 600;
      padding: 0.15rem 0.55rem;
      border-radius: 6px;
    }

    .team-header-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .btn-team-json {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.775rem;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      padding: 0.35rem 0.65rem;
      border-radius: 6px;
      text-decoration: none;
      transition: all 0.15s ease;
    }

    .btn-team-json:hover {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--bg-surface-hover);
    }

    /* Codes Grid within Team */
    .codes-grid {
      padding: 1.25rem 1.5rem;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.25rem;
    }

    .code-card {
      background: var(--bg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .code-card:hover {
      transform: translateY(-2px);
      border-color: var(--accent);
      box-shadow: var(--shadow-md);
    }

    .code-card-main {
      margin-bottom: 1.25rem;
    }

    .code-title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.6rem;
    }

    .code-name {
      font-size: 1.05rem;
      font-weight: 700;
      color: #fff;
      word-break: break-all;
    }

    .version-tag {
      font-size: 0.75rem;
      font-family: var(--font-mono);
      font-weight: 600;
      background: #1e293b;
      color: var(--accent-secondary);
      border: 1px solid #334155;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      white-space: nowrap;
    }

    .code-desc {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.85rem;
      word-break: break-word;
    }

    .code-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      border-top: 1px dashed var(--border-subtle);
      padding-top: 0.75rem;
    }

    .meta-item {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }

    .meta-item strong {
      color: var(--text-secondary);
    }

    /* Card Actions */
    .code-actions {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.5rem;
    }

    .btn-download {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: #0284c7;
      color: #fff;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.6rem 1rem;
      border-radius: var(--radius-sm);
      text-decoration: none;
      transition: background 0.15s ease;
    }

    .btn-download:hover {
      background: #0369a1;
    }

    .btn-copy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-surface-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      padding: 0.6rem 0.8rem;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.15s ease;
    }

    .btn-copy:hover {
      color: #fff;
      border-color: var(--text-secondary);
      background: var(--bg-surface-hover);
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 4rem 1rem;
      background: var(--bg-surface);
      border: 1px dashed var(--border-subtle);
      border-radius: var(--radius-lg);
      display: none;
    }

    .empty-state h3 {
      font-size: 1.25rem;
      color: #fff;
      margin-bottom: 0.5rem;
    }

    .empty-state p {
      color: var(--text-muted);
      font-size: 0.95rem;
    }

    /* Footer */
    footer {
      margin-top: 4rem;
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-muted);
      border-top: 1px solid var(--border-subtle);
      padding-top: 2rem;
    }

    footer a {
      color: var(--accent);
      text-decoration: none;
    }

    footer a:hover {
      text-decoration: underline;
    }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #1e293b;
      color: #fff;
      border: 1px solid var(--accent);
      padding: 0.75rem 1.25rem;
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-lg);
      font-size: 0.875rem;
      font-weight: 500;
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
      z-index: 1000;
    }

    #toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-top">
        <div>
          <h1 class="brand-title">
            Wuthering Waves Codes
            <span class="badge-domain">${BASE_DOMAIN}</span>
          </h1>
          <p class="brand-desc">
            Static repository for Wuthering Waves character codes and team compositions. Browse packages, download zip bundles, and access JSON APIs.
          </p>
        </div>
        <div class="header-actions">
          <a href="${BASE_URL}/teams.json" class="btn-api" title="View Aggregated JSON API" target="_blank">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
            teams.json
          </a>
          <a href="https://github.com/${repoName}" class="btn-github" target="_blank" rel="noopener noreferrer">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
            GitHub
          </a>
        </div>
      </div>
    </header>

    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-value">${totalTeams}</div>
        <div class="stat-label">Total Teams</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalCodes}</div>
        <div class="stat-label">Total Code Archives</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${BASE_DOMAIN}</div>
        <div class="stat-label">Pages Endpoint</div>
      </div>
    </div>

    <div class="controls-bar">
      <div class="search-wrapper">
        <svg class="search-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input type="text" id="searchInput" class="search-input" placeholder="Search team, character, author, or code name..." autocomplete="off">
      </div>
      <div class="filter-info" id="filterCount">Showing all ${totalCodes} codes in ${totalTeams} teams</div>
    </div>

    <div class="teams-container" id="teamsContainer">
      ${teamsList.map(teamGroup => {
        const displayTeamName = toDisplayTeamText(teamGroup.team);
        const displayMembers = teamGroup.members.map(toDisplayName);
        return `
        <section class="team-group" data-team="${teamGroup.team.toLowerCase()}" data-members="${teamGroup.members.map(m => m.toLowerCase()).join(' ')}">
          <div class="team-header">
            <div class="team-title-wrap">
              <h2 class="team-title">
                ${displayTeamName}
              </h2>
              <div class="member-chips">
                ${displayMembers.map(member => `<span class="chip-member">${member}</span>`).join('')}
              </div>
            </div>
            <div class="team-header-actions">
              <a href="${teamGroup.jsonUrl}" class="btn-team-json" target="_blank" title="Team JSON API">
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
                ${teamGroup.slug}.json
              </a>
            </div>
          </div>

          <div class="codes-grid">
            ${teamGroup.codes.map(code => `
              <article class="code-card" data-search="${(code.name + ' ' + code.team + ' ' + code.author + ' ' + code.description + ' ' + code.filename + ' ' + code.members.join(' ') + ' ' + displayTeamName + ' ' + displayMembers.join(' ')).toLowerCase()}">
                <div class="code-card-main">
                  <div class="code-title-row">
                    <h3 class="code-name">${code.name}</h3>
                    <span class="version-tag">v${code.version}</span>
                  </div>
                  ${code.description ? `<p class="code-desc">${code.description}</p>` : ''}
                  <div class="code-meta">
                    <span class="meta-item"><strong>Author:</strong> ${code.author}</span>
                    <span class="meta-item"><strong>Size:</strong> ${code.sizeFormatted}</span>
                    <span class="meta-item"><strong>File:</strong> ${code.filename}</span>
                  </div>
                </div>
                <div class="code-actions">
                  <a href="${code.downloadUrl}" download="${code.filename}" class="btn-download" title="Download Zip File">
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                    </svg>
                    Download ZIP
                  </a>
                  <button type="button" class="btn-copy" onclick="copyLink('${code.downloadUrl}')" title="Copy direct download URL">
                    <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                    </svg>
                  </button>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
        `;
      }).join('')}
    </div>

    <div class="empty-state" id="emptyState">
      <h3>No matching character codes found</h3>
      <p>Try clearing your search query or searching for a different character name.</p>
    </div>

    <footer>
      <p>Wuthering Waves Character Codes &bull; <a href="https://github.com/${repoName}" target="_blank">GitHub Repository</a> &bull; <a href="${BASE_URL}/teams.json" target="_blank">teams.json</a></p>
    </footer>
  </div>

  <div id="toast">Link copied to clipboard!</div>

  <script>
    const searchInput = document.getElementById('searchInput');
    const teamsContainer = document.getElementById('teamsContainer');
    const emptyState = document.getElementById('emptyState');
    const filterCount = document.getElementById('filterCount');
    const toast = document.getElementById('toast');

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    function copyLink(url) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Download URL copied to clipboard!');
      }).catch(() => {
        showToast('Copied: ' + url);
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        const teamGroups = document.querySelectorAll('.team-group');
        let visibleCodesCount = 0;
        let visibleTeamsCount = 0;

        teamGroups.forEach(group => {
          const cards = group.querySelectorAll('.code-card');
          let groupHasVisibleCards = false;

          cards.forEach(card => {
            const searchText = card.getAttribute('data-search') || '';
            if (!query || searchText.includes(query)) {
              card.style.display = 'flex';
              groupHasVisibleCards = true;
              visibleCodesCount++;
            } else {
              card.style.display = 'none';
            }
          });

          if (groupHasVisibleCards) {
            group.style.display = 'block';
            visibleTeamsCount++;
          } else {
            group.style.display = 'none';
          }
        });

        if (visibleTeamsCount === 0) {
          emptyState.style.display = 'block';
        } else {
          emptyState.style.display = 'none';
        }

        if (query) {
          filterCount.textContent = 'Found ' + visibleCodesCount + ' codes in ' + visibleTeamsCount + ' teams';
        } else {
          filterCount.textContent = 'Showing all ' + visibleCodesCount + ' codes in ' + visibleTeamsCount + ' teams';
        }
      });
    }
  </script>
</body>
</html>
`;
}

function main() {
  console.log(`--- Generating Static Site & Team JSONs for ${BASE_URL} ---`);

  const repo = getGithubRepo();
  const rawItems = parseZipFiles();
  const groupedTeams = groupDataByTeam(rawItems);

  // 1. Ensure CNAME exists
  fs.writeFileSync(CNAME_PATH, `${BASE_DOMAIN}\n`, 'utf8');
  console.log(`[OK] Configured CNAME: ${BASE_DOMAIN}`);

  // 2. Ensure teams directory exists and clean old files
  if (fs.existsSync(TEAMS_DIR)) {
    for (const f of fs.readdirSync(TEAMS_DIR)) {
      if (f.endsWith('.json')) {
        fs.unlinkSync(path.join(TEAMS_DIR, f));
      }
    }
  } else {
    fs.mkdirSync(TEAMS_DIR, { recursive: true });
  }

  // 3. Generate JSON file for each team
  const teamsSummary = [];

  for (const [teamName, teamData] of Object.entries(groupedTeams)) {
    const teamFilePath = path.join(TEAMS_DIR, `${teamData.slug}.json`);
    const teamJsonPayload = {
      team: teamData.team,
      slug: teamData.slug,
      members: teamData.members,
      totalCodes: teamData.totalCodes,
      jsonUrl: teamData.jsonUrl,
      codes: teamData.codes.map(c => ({
        filename: c.filename,
        downloadUrl: c.downloadUrl,
        rawUrl: c.rawUrl,
        name: c.name,
        description: c.description,
        author: c.author,
        version: c.version,
        team: c.team,
        members: c.members,
        size: c.size,
        sizeFormatted: c.sizeFormatted,
        timestamp: c.timestamp,
        modifiedAt: c.modifiedAt
      }))
    };

    fs.writeFileSync(teamFilePath, JSON.stringify(teamJsonPayload, null, 2), 'utf8');
    console.log(`[OK] Generated team JSON: teams/${teamData.slug}.json (${teamData.codes.length} items)`);

    teamsSummary.push({
      team: teamData.team,
      slug: teamData.slug,
      members: teamData.members,
      totalCodes: teamData.totalCodes,
      jsonUrl: teamData.jsonUrl,
      codes: teamJsonPayload.codes
    });
  }

  // 4. Generate aggregated teams.json
  const aggregatedPayload = {
    repository: repo,
    pageUrl: BASE_URL,
    jsonUrl: `${BASE_URL}/teams.json`,
    totalTeams: Object.keys(groupedTeams).length,
    totalCodes: rawItems.length,
    teams: teamsSummary
  };

  fs.writeFileSync(TEAMS_JSON_PATH, JSON.stringify(aggregatedPayload, null, 2), 'utf8');
  console.log(`[OK] Generated aggregated JSON: teams.json`);

  // 5. Generate root index.html
  const htmlContent = generateHtml(groupedTeams, rawItems, repo);
  fs.writeFileSync(INDEX_HTML_PATH, htmlContent, 'utf8');
  console.log(`[OK] Generated static page: index.html`);

  if (unmappedNames.size > 0) {
    console.log(`[WARN] ${unmappedNames.size} name(s) not found in scripts/character-names.json (displayed as-is): ${Array.from(unmappedNames).sort().join(', ')}`);
  }

  console.log('--- Static Generation Completed Successfully ---');
}

main();
