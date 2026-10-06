const { execSync } = require('child_process');

// ========== PARSER (FIXED) ==========

function parseRepoHistory(repoPath) {
  const logOutput = execSync(
    `git -C ${repoPath} log --no-merges --use-mailmap --find-renames=50% --numstat --format=%H%x1f%an%x1f%ae%x1f%ct`,
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
      // This is a commit header line
      const [hash, authorName, authorEmail, committerDate] = line.split('\x1f');
      currentCommit = {
        hash,
        author: { name: authorName, email: authorEmail },
        committerDate: parseInt(committerDate),
        files: []
      };
      commits.push(currentCommit);
    } else if (line.trim() && currentCommit) {
      // This is a numstat line belonging to the current commit
      const fileChange = parseNumstatLine(line);
      if (fileChange) {
        currentCommit.files.push(fileChange);
      }
    }
  }
  
  return commits;
}

function parseNumstatLine(line) {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  
  const [addedStr, removedStr, pathStr] = parts;
  
  if (addedStr === '-' && removedStr === '-') {
    return null;
  }
  
  const added = parseInt(addedStr);
  const removed = parseInt(removedStr);
  
  let path = pathStr;
  if (pathStr.includes(' => ')) {
    path = parseRenamePath(pathStr);
  }
  
  return { path, added, removed };
}

function parseRenamePath(pathStr) {
  if (pathStr.includes('{')) {
    const match = pathStr.match(/^(.*?)\{.*? => (.*?)\}(.*?)$/);
    if (match) {
      const [, prefix, newName, suffix] = match;
      return prefix + newName + suffix;
    }
  } else {
    const parts = pathStr.split(' => ');
    if (parts.length === 2) {
      return parts[1];
    }
  }
  
  return pathStr;
}

// ========== HELPER FUNCTIONS ==========

function parentDir(path) {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

// ========== METRIC COMPUTATION ==========

// Step 4: File metrics per commit
function computeFileMetrics(commits) {
  const fileMetrics = {};
  
  for (const commit of commits) {
    for (const file of commit.files) {
      if (!fileMetrics[file.path]) {
        fileMetrics[file.path] = [];
      }
      
      const growth = file.added - file.removed;
      const churn = file.added + file.removed;
      
      fileMetrics[file.path].push({
        commit: commit.hash,
        author: commit.author,
        committerDate: commit.committerDate,
        added: file.added,
        removed: file.removed,
        growth,
        churn
      });
    }
  }
  
  return fileMetrics;
}

// Step 5: Directory metrics (per-commit granularity)
function computeDirectoryMetricsPerCommit(commits) {
  const dirMetrics = {};
  
  for (const commit of commits) {
    for (const file of commit.files) {
      const growth = file.added - file.removed;
      const churn = file.added + file.removed;
      
      // Walk up and add to each ancestor directory
      let dir = parentDir(file.path);
      while (true) {
        if (!dirMetrics[dir]) dirMetrics[dir] = {};
        if (!dirMetrics[dir][commit.hash]) {
          dirMetrics[dir][commit.hash] = { added: 0, removed: 0, growth: 0, churn: 0 };
        }
        dirMetrics[dir][commit.hash].added += file.added;
        dirMetrics[dir][commit.hash].removed += file.removed;
        dirMetrics[dir][commit.hash].growth += growth;
        dirMetrics[dir][commit.hash].churn += churn;
        
        if (dir === '') break;
        dir = parentDir(dir);
      }
      
      // Root directory
      if (!dirMetrics['']) dirMetrics[''] = {};
      if (!dirMetrics[''][commit.hash]) {
        dirMetrics[''][commit.hash] = { added: 0, removed: 0, growth: 0, churn: 0 };
      }
      dirMetrics[''][commit.hash].added += file.added;
      dirMetrics[''][commit.hash].removed += file.removed;
      dirMetrics[''][commit.hash].growth += growth;
      dirMetrics[''][commit.hash].churn += churn;
    }
  }
  
  return dirMetrics;
}

// Step 6: Repository metrics = root directory metrics
function getRepositoryMetrics(dirMetrics) {
  return dirMetrics[''] || {};
}

// Step 7: Commit set metrics (works for files AND directories)
function computeCommitSetMetrics(commits, objectPath, isDirectory = false) {
  let added = 0, removed = 0, growth = 0, churn = 0;
  let modifications = 0;
  
  for (const commit of commits) {
    let objectAdded = 0, objectRemoved = 0;
    
    if (isDirectory) {
      for (const file of commit.files) {
        if (file.path === objectPath || file.path.startsWith(objectPath + '/')) {
          objectAdded += file.added;
          objectRemoved += file.removed;
        }
      }
    } else {
      const fileChange = commit.files.find(f => f.path === objectPath);
      if (fileChange) {
        objectAdded = fileChange.added;
        objectRemoved = fileChange.removed;
      }
    }
    
    if (objectAdded > 0 || objectRemoved > 0) {
      added += objectAdded;
      removed += objectRemoved;
      growth += objectAdded - objectRemoved;
      churn += objectAdded + objectRemoved;
      modifications++;
    }
  }
  
  const n = commits.length;
  return {
    added,
    removed,
    growth,
    churn,
    modifications,
    modFrequency: n > 0 ? modifications / n : 0,
    churnRate: n > 0 ? churn / n : 0
  };
}

// Step 8: Author metrics (works for files AND directories)
function computeAuthorMetrics(commits, objectPath, isDirectory = false) {
  const authorMetrics = {};
  
  for (const commit of commits) {
    const authorKey = `${commit.author.name} <${commit.author.email}>`;
    
    if (!authorMetrics[authorKey]) {
      authorMetrics[authorKey] = {
        author: commit.author,
        modifications: 0,
        churn: 0
      };
    }
    
    let objectChurn = 0;
    let hasChange = false;
    
    if (isDirectory) {
      for (const file of commit.files) {
        if (file.path === objectPath || file.path.startsWith(objectPath + '/')) {
          objectChurn += file.added + file.removed;
          hasChange = true;
        }
      }
    } else {
      const fileChange = commit.files.find(f => f.path === objectPath);
      if (fileChange) {
        objectChurn = fileChange.added + fileChange.removed;
        hasChange = true;
      }
    }
    
    if (hasChange) {
      authorMetrics[authorKey].modifications++;
      authorMetrics[authorKey].churn += objectChurn;
    }
  }
  
  const totalChurn = Object.values(authorMetrics).reduce((sum, m) => sum + m.churn, 0);
  for (const metrics of Object.values(authorMetrics)) {
    metrics.ownership = totalChurn > 0 ? metrics.churn / totalChurn : 0;
  }
  
  return authorMetrics;
}

// ========== TEST IT ==========

const commits = parseRepoHistory('./repos/cJSON');
console.log(`Parsed ${commits.length} commits\n`);

// Test file metrics
const fileMetrics = computeFileMetrics(commits);
console.log(`File metrics: ${Object.keys(fileMetrics).length} files`);
const sampleFile = Object.keys(fileMetrics)[0];
console.log(`Sample: ${sampleFile}`);
console.log('Changes:', fileMetrics[sampleFile].slice(0, 2), '\n');

// Test directory metrics (per-commit)
const dirMetrics = computeDirectoryMetricsPerCommit(commits);
console.log(`Directory metrics: ${Object.keys(dirMetrics).length} directories`);
console.log('Dirs:', Object.keys(dirMetrics).slice(0, 5), '\n');

// Test repository metrics
const repoMetrics = getRepositoryMetrics(dirMetrics);
console.log(`Repository: ${Object.keys(repoMetrics).length} commits with changes\n`);

// Test commit set metrics on FILE
console.log(`Commit set metrics for file "${sampleFile}":`);
const fileSetMetrics = computeCommitSetMetrics(commits, sampleFile, false);
console.log(fileSetMetrics, '\n');

// Test commit set metrics on DIRECTORY
const sampleDir = Object.keys(dirMetrics).find(d => d !== '' && !d.includes('/'));
console.log(`Commit set metrics for directory "${sampleDir}":`);
const dirSetMetrics = computeCommitSetMetrics(commits, sampleDir, true);
console.log(dirSetMetrics, '\n');

// Test author metrics on FILE
console.log(`Author metrics for file "${sampleFile}":`);
const fileAuthorMetrics = computeAuthorMetrics(commits, sampleFile, false);
for (const [author, metrics] of Object.entries(fileAuthorMetrics).slice(0, 3)) {
  console.log(`  ${author}: ${metrics.modifications} mods, churn=${metrics.churn}, ownership=${(metrics.ownership * 100).toFixed(1)}%`);
}
console.log();

// Test author metrics on DIRECTORY
console.log(`Author metrics for directory "${sampleDir}":`);
const dirAuthorMetrics = computeAuthorMetrics(commits, sampleDir, true);
for (const [author, metrics] of Object.entries(dirAuthorMetrics).slice(0, 3)) {
  console.log(`  ${author}: ${metrics.modifications} mods, churn=${metrics.churn}, ownership=${(metrics.ownership * 100).toFixed(1)}%`);
}
