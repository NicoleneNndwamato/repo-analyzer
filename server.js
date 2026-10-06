const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
app.use(express.json());
const repos = {};
const upload = multer({ dest: './uploads/' });

// ========== PARSER ==========

function parseRepoHistory(repoPath) {
  const logOutput = execSync(
    `git -C ${repoPath} log --no-merges --use-mailmap --find-renames=50% --numstat --format=%H%x1f%aN%x1f%aE%x1f%ct`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 100 }
  );
  return parseLogOutput(logOutput);
}

function parseLogOutput(output) {
  const commits = [];
  let currentCommit = null;
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes('\x1f')) {
      const [hash, authorName, authorEmail, committerDate] = line.split('\x1f');
      currentCommit = {
        hash,
        author: { name: authorName, email: authorEmail },
        committerDate: parseInt(committerDate),
        files: []
      };
      commits.push(currentCommit);
    } else if (line.trim() && currentCommit) {
      const fileChange = parseNumstatLine(line);
      if (fileChange) currentCommit.files.push(fileChange);
    }
  }
  return commits;
}

function parseNumstatLine(line) {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [addedStr, removedStr, pathStr] = parts;
  if (addedStr === '-' && removedStr === '-') return null;
  const added = parseInt(addedStr);
  const removed = parseInt(removedStr);
  let path = pathStr;
  if (pathStr.includes(' => ')) path = parseRenamePath(pathStr);
  return { path, added, removed };
}

function parseRenamePath(pathStr) {
  if (pathStr.includes('{')) {
    const match = pathStr.match(/^(.*?)\{.*? => (.*?)\}(.*?)$/);
    if (match) return match[1] + match[2] + match[3];
  } else {
    const parts = pathStr.split(' => ');
    if (parts.length === 2) return parts[1];
  }
  return pathStr;
}

// ========== HELPERS ==========

function parentDir(p) {
  const parts = p.split('/');
  parts.pop();
  return parts.join('/');
}

function extractAuthors(commits) {
  const authors = new Set();
  for (const c of commits) authors.add(`${c.author.name} <${c.author.email}>`);
  return Array.from(authors);
}

function fileInDir(filePath, dirPath) {
  if (dirPath === '') return true;
  return filePath === dirPath || filePath.startsWith(dirPath + '/');
}

function findGitDir(extractPath) {
  const gitPath = path.join(extractPath, '.git');
  if (fs.existsSync(gitPath)) {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return extractPath;
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const match = content.match(/gitdir:\s*(.+)/);
      if (match) {
        let gitDir = match[1];
        if (!path.isAbsolute(gitDir)) gitDir = path.resolve(extractPath, gitDir);
        return path.dirname(gitDir);
      }
    }
  }
  const entries = fs.readdirSync(extractPath);
  for (const entry of entries) {
    const fullPath = path.join(extractPath, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      if (fs.existsSync(path.join(fullPath, '.git'))) return fullPath;
    }
  }
  return null;
}

// ========== METRICS ==========

function computeFileMetrics(commits) {
  const fm = {};
  for (const commit of commits) {
    for (const file of commit.files) {
      if (!fm[file.path]) fm[file.path] = [];
      fm[file.path].push({
        commit: commit.hash, author: commit.author,
        committerDate: commit.committerDate,
        added: file.added, removed: file.removed,
        growth: file.added - file.removed, churn: file.added + file.removed
      });
    }
  }
  return fm;
}

function computeDirectoryMetricsPerCommit(commits) {
  const dm = {};
  for (const commit of commits) {
    for (const file of commit.files) {
      const growth = file.added - file.removed;
      const churn = file.added + file.removed;
      let dir = parentDir(file.path);
      while (true) {
        if (!dm[dir]) dm[dir] = {};
        if (!dm[dir][commit.hash]) dm[dir][commit.hash] = { added: 0, removed: 0, growth: 0, churn: 0 };
        dm[dir][commit.hash].added += file.added;
        dm[dir][commit.hash].removed += file.removed;
        dm[dir][commit.hash].growth += growth;
        dm[dir][commit.hash].churn += churn;
        if (dir === '') break;
        dir = parentDir(dir);
      }
    }
  }
  return dm;
}

function computeCommitSetMetrics(commits, objectPath, isDirectory = false) {
  let added = 0, removed = 0, growth = 0, churn = 0, modifications = 0;
  for (const commit of commits) {
    let oA = 0, oR = 0;
    if (isDirectory) {
      for (const file of commit.files) {
        if (fileInDir(file.path, objectPath)) { oA += file.added; oR += file.removed; }
      }
    } else {
      const fc = commit.files.find(f => f.path === objectPath);
      if (fc) { oA = fc.added; oR = fc.removed; }
    }
    if (oA > 0 || oR > 0) {
      added += oA; removed += oR;
      growth += oA - oR; churn += oA + oR;
      modifications++;
    }
  }
  const n = commits.length;
  return { added, removed, growth, churn, modifications,
    modFrequency: n > 0 ? modifications / n : 0,
    churnRate: n > 0 ? churn / n : 0 };
}

function computeAuthorMetrics(commits, objectPath, isDirectory = false) {
  const am = {};
  for (const commit of commits) {
    const key = `${commit.author.name} <${commit.author.email}>`;
    if (!am[key]) am[key] = { author: commit.author, modifications: 0, churn: 0 };
    let oC = 0, has = false;
    if (isDirectory) {
      for (const file of commit.files) {
        if (fileInDir(file.path, objectPath)) { oC += file.added + file.removed; has = true; }
      }
    } else {
      const fc = commit.files.find(f => f.path === objectPath);
      if (fc) { oC = fc.added + fc.removed; has = true; }
    }
    if (has) { am[key].modifications++; am[key].churn += oC; }
  }
  const total = Object.values(am).reduce((s, m) => s + m.churn, 0);
  for (const m of Object.values(am)) m.ownership = total > 0 ? m.churn / total : 0;
  return am;
}

// ========== LOAD REPO ==========

function loadRepo(repoName, repoPath) {
  console.log(`Loading ${repoName} from ${repoPath}...`);
  const commits = parseRepoHistory(repoPath);
  const fileMetrics = computeFileMetrics(commits);
  const dirMetrics = computeDirectoryMetricsPerCommit(commits);
  repos[repoName] = { path: repoPath, commits, fileMetrics, dirMetrics, authors: extractAuthors(commits) };
  console.log(`Loaded ${repoName}: ${commits.length} commits, ${Object.keys(fileMetrics).length} files`);
}

if (fs.existsSync('./repos')) {
  for (const entry of fs.readdirSync('./repos')) {
    const p = path.join('./repos', entry);
    if (fs.existsSync(path.join(p, '.git'))) loadRepo(entry, p);
  }
}

// ========== ROUTES ==========

app.post('/api/repos', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const repoName = name || url.split('/').pop().replace('.git', '');
  const repoPath = path.join('./repos', repoName);
  try {
    if (!fs.existsSync(repoPath)) {
      console.log(`Cloning ${url}...`);
      execSync(`git clone ${url} ${repoPath}`, { stdio: 'inherit' });
    }
    loadRepo(repoName, repoPath);
    res.json({ success: true, repo: repoName, commits: repos[repoName].commits.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/repos/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const repoName = req.body.name || path.parse(req.file.originalname).name;
  const repoPath = path.join('./repos', repoName);
  if (fs.existsSync(repoPath)) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Repository already exists' }); }
  try {
    console.log(`Extracting ${req.file.originalname}...`);
    if (!fs.existsSync('./repos')) fs.mkdirSync('./repos', { recursive: true });
    const zip = new AdmZip(req.file.path);
    const tempExtract = path.join('./uploads', `extract-${Date.now()}`);
    zip.extractAllTo(tempExtract, true);
    const gitRepoPath = findGitDir(tempExtract);
    if (!gitRepoPath) {
      fs.unlinkSync(req.file.path);
      fs.rmSync(tempExtract, { recursive: true, force: true });
      return res.status(400).json({ error: 'No .git directory found in the zip file' });
    }
    fs.renameSync(gitRepoPath, repoPath);
    fs.unlinkSync(req.file.path);
    fs.rmSync(tempExtract, { recursive: true, force: true });
    loadRepo(repoName, repoPath);
    res.json({ success: true, repo: repoName, commits: repos[repoName].commits.length });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos', (req, res) => res.json(Object.keys(repos)));

app.get('/api/repos/:repo/metrics', (req, res) => {
  const { repo } = req.params;
  const { author, file, dir, from, to, commits: commitHashes } = req.query;
  if (!repos[repo]) return res.status(404).json({ error: 'Repository not found' });

  let fc = repos[repo].commits;
  if (author) {
    const exact = fc.filter(c => `${c.author.name} <${c.author.email}>` === author);
    if (exact.length > 0) { fc = exact; }
    else {
      const q = author.toLowerCase();
      fc = fc.filter(c => c.author.name.toLowerCase().includes(q) || c.author.email.toLowerCase().includes(q));
    }
  }
  if (from || to) {
    const fTs = from ? parseInt(from) : 0;
    const tTs = to ? parseInt(to) : Infinity;
    fc = fc.filter(c => c.committerDate >= fTs && c.committerDate < tTs);
  }
  if (commitHashes) {
    const set = new Set(commitHashes.split(','));
    fc = fc.filter(c => set.has(c.hash));
  }

  const result = { commitCount: fc.length };
  if (file) { result.file = computeCommitSetMetrics(fc, file, false); result.fileAuthors = computeAuthorMetrics(fc, file, false); }
  if (dir) { result.directory = computeCommitSetMetrics(fc, dir, true); result.directoryAuthors = computeAuthorMetrics(fc, dir, true); }
  if (!file && !dir) { result.repository = computeCommitSetMetrics(fc, '', true); result.repositoryAuthors = computeAuthorMetrics(fc, '', true); }
  res.json(result);
});

app.get('/api/repos/:repo/files', (req, res) => {
  if (!repos[req.params.repo]) return res.status(404).json({ error: 'Not found' });
  res.json(Object.keys(repos[req.params.repo].fileMetrics));
});

app.get('/api/repos/:repo/directories', (req, res) => {
  if (!repos[req.params.repo]) return res.status(404).json({ error: 'Not found' });
  res.json(Object.keys(repos[req.params.repo].dirMetrics));
});

app.get('/api/repos/:repo/authors', (req, res) => {
  if (!repos[req.params.repo]) return res.status(404).json({ error: 'Not found' });
  res.json(repos[req.params.repo].authors);
});

app.post('/api/repos/:repo/merge-authors', (req, res) => {
  const { repo } = req.params;
  const { from, to } = req.body;
  if (!repos[repo]) return res.status(404).json({ error: 'Repository not found' });
  if (!from || !to) return res.status(400).json({ error: 'Both "from" and "to" are required' });
  const repoData = repos[repo];
  let mergedCount = 0;
  for (const commit of repoData.commits) {
    const authorKey = `${commit.author.name} <${commit.author.email}>`;
    if (authorKey === from) {
      const match = to.match(/^(.+?)\s*<(.+?)>$/);
      if (match) { commit.author.name = match[1].trim(); commit.author.email = match[2].trim(); mergedCount++; }
    }
  }
  if (mergedCount === 0) return res.status(400).json({ error: `Author "${from}" not found` });
  repoData.fileMetrics = computeFileMetrics(repoData.commits);
  repoData.dirMetrics = computeDirectoryMetricsPerCommit(repoData.commits);
  repoData.authors = extractAuthors(repoData.commits);
  res.json({ success: true, merged: mergedCount, from, to, message: `Merged ${mergedCount} commits` });
});

app.get('/api/repos/:repo/authors/stats', (req, res) => {
  const { repo } = req.params;
  if (!repos[repo]) return res.status(404).json({ error: 'Not found' });
  const authorStats = {};
  for (const commit of repos[repo].commits) {
    const key = `${commit.author.name} <${commit.author.email}>`;
    if (!authorStats[key]) authorStats[key] = { name: commit.author.name, email: commit.author.email, commits: 0 };
    authorStats[key].commits++;
  }
  res.json(Object.values(authorStats).sort((a, b) => b.commits - a.commits));
});

app.get('/api/repos/:repo/commits', (req, res) => {
  const { repo } = req.params;
  const { author, from, to, limit } = req.query;
  if (!repos[repo]) return res.status(404).json({ error: 'Repository not found' });
  let commits = repos[repo].commits;
  if (author) {
    const q = author.toLowerCase();
    commits = commits.filter(c => c.author.name.toLowerCase().includes(q) || c.author.email.toLowerCase().includes(q));
  }
  if (from || to) {
    const fTs = from ? parseInt(from) : 0;
    const tTs = to ? parseInt(to) : Infinity;
    commits = commits.filter(c => c.committerDate >= fTs && c.committerDate < tTs);
  }
  const maxLimit = Math.min(parseInt(limit) || 100, 1000);
  commits = commits.slice(0, maxLimit);
  const result = commits.map(c => ({
    hash: c.hash,
    author: `${c.author.name} <${c.author.email}>`,
    date: new Date(c.committerDate * 1000).toISOString().split('T')[0],
    files: c.files.length
  }));
  res.json(result);
});


app.listen(3000, () => console.log('Server running on http://localhost:3000'));
app.use(express.static('public'));
