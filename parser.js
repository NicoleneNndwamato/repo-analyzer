const { simpleGit } = require('simple-git');

async function parseRepoHistory(repoPath) {
  const git = simpleGit(repoPath);
  
  const logOutput = await git.raw([
    'log',
    '--no-merges',
    '--use-mailmap',
    '--find-renames=50%',
    '--numstat',
    '--format=%H%x1f%an%x1f%ae%x1f%ct'
  ]);

  return parseLogOutput(logOutput);
}

function parseLogOutput(output) {
  const commits = [];
  const commitBlocks = output.split('\n\n');
  
  for (const block of commitBlocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;
    
    const [hash, authorName, authorEmail, committerDate] = lines[0].split('\x1f');
    
    const commit = {
      hash,
      author: { name: authorName, email: authorEmail },
      committerDate: parseInt(committerDate),
      files: []
    };
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      const fileChange = parseNumstatLine(line);
      if (fileChange) {
        commit.files.push(fileChange);
      }
    }
    
    commits.push(commit);
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

parseRepoHistory('./repos/cJSON')
  .then(commits => {
    console.log(`Parsed ${commits.length} commits`);
    console.log('First commit:', commits[0]);
    console.log('Sample file changes:', commits[0].files.slice(0, 3));
  })
  .catch(err => console.error('Failed:', err));
