const { simpleGit } = require('simple-git');

const path = require('path');
const fs = require('fs');

async function cloneRepo(url, workspaceDir) {
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  const repoName = url.split('/').pop().replace('.git', '');
  const targetPath = path.join(workspaceDir, repoName);

  console.log(`Cloning ${url} into ${targetPath}...`);
  
  const git = simpleGit();
  await git.clone(url, targetPath);  // full clone, no --depth
  
  console.log(`Clone complete: ${targetPath}`);
  return targetPath;
}

cloneRepo('https://github.com/DaveGamble/cJSON.git', './repos')
  .then(repoPath => console.log('Success:', repoPath))
  .catch(err => console.error('Failed:', err));
