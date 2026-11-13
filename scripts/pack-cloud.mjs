import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  projectRoot,
  removeRepoPath,
  resetRepoDir,
  workspacePaths,
} from './lib/build-workspace.mjs';

const { buildRoot, distRoot } = workspacePaths();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const stagingRoot = path.join(buildRoot, 'cloud-pack', 'current');
const output = path.join(distRoot, `modu-cloud-${version}.tar.gz`);

resetRepoDir(stagingRoot, '云服务打包暂存目录');
fs.mkdirSync(distRoot, { recursive: true });

function copyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (item) => !/(?:^|\/)(?:node_modules|data|\.DS_Store)(?:\/|$)/.test(item),
  });
}

copyTree(path.join(projectRoot, 'cloud'), path.join(stagingRoot, 'cloud'));
copyTree(path.join(projectRoot, 'deploy'), path.join(stagingRoot, 'deploy'));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const source = path.join(projectRoot, name);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(stagingRoot, name));
  }
}

// A package without third-party dependencies is the whole point: the cloud
// server uses Node built-ins only, so there is no npm install on the target.
const cloudPackage = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'cloud', 'package.json'), 'utf8'));
const dependencies = Object.keys(cloudPackage.dependencies || {});
if (dependencies.length) {
  throw new Error(`cloud/package.json 不应有第三方依赖：${dependencies.join(', ')}`);
}

removeRepoPath(output, '云服务包');
execFileSync('tar', [
  '--no-xattrs', '-czf', output,
  '--exclude', '.DS_Store',
  '-C', stagingRoot,
  '.',
], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });

const digest = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);

const bytes = fs.statSync(output).size;
console.log(`cloud package: ${output}`);
console.log(`size: ${(bytes / 1024).toFixed(1)} KB`);
console.log(`sha256: ${digest}`);
console.log('contents: cloud/server.js, cloud/manage.js, cloud/public, cloud/DEPLOY.md, deploy/*, LICENSE, THIRD_PARTY_NOTICES.md');
