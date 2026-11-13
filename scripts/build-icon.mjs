import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  projectRoot,
  resetRepoDir,
  workspacePaths,
} from './lib/build-workspace.mjs';

const { buildRoot: workspaceBuildRoot } = workspacePaths();
const workRoot = path.join(workspaceBuildRoot, 'icon-build');
const buildRoot = path.join(projectRoot, 'build');
const iconset = path.join(workRoot, '墨读.iconset');
const binary = path.join(workRoot, 'ink-icon');
const source = path.join(projectRoot, 'scripts', 'InkIcon.swift');
const icns = path.join(buildRoot, 'icon.icns');

const variants = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

resetRepoDir(workRoot, '图标构建目录');
fs.mkdirSync(iconset, { recursive: true });
fs.mkdirSync(buildRoot, { recursive: true });

const swiftEnv = {
  ...process.env,
  TMPDIR: path.join(workspaceBuildRoot, 'tmp'),
  CLANG_MODULE_CACHE_PATH: path.join(workspaceBuildRoot, 'swift-cache'),
  SWIFT_MODULECACHE_PATH: path.join(workspaceBuildRoot, 'swift-cache'),
};
fs.mkdirSync(swiftEnv.TMPDIR, { recursive: true });
fs.mkdirSync(swiftEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });

execFileSync('swiftc', [
  '-O',
  '-sdk', execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8', env: swiftEnv }).trim(),
  source,
  '-o', binary,
], { stdio: 'inherit', env: swiftEnv });

for (const [size, name] of variants) {
  execFileSync(binary, [String(size), path.join(iconset, name)], {
    stdio: 'inherit',
    env: swiftEnv,
  });
}

// iconutil is unreliable in this managed macOS environment. Write the ICNS
// container directly: a header followed by type/length/PNG elements.
const icnsEntries = [
  ['icp4', 'icon_16x16.png'],
  ['icp5', 'icon_32x32.png'],
  ['icp6', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png'],
  ['ic11', 'icon_16x16@2x.png'],
  ['ic12', 'icon_32x32@2x.png'],
  ['ic13', 'icon_128x128@2x.png'],
  ['ic14', 'icon_256x256@2x.png'],
];
const chunks = icnsEntries.map(([type, name]) => {
  const data = fs.readFileSync(path.join(iconset, name));
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(icns, Buffer.concat([header, body]));

const previewSource = path.join(iconset, 'icon_512x512@2x.png');
const preview = path.join(buildRoot, 'icon-1024.png');
fs.copyFileSync(previewSource, preview);

console.log(`icon: ${icns}`);
console.log(`preview: ${preview}`);
