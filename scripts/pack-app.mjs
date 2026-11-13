import fs from 'node:fs';
import path from 'node:path';
import { packager } from '@electron/packager';
import {
  projectRoot,
  resetRepoDir,
  workspacePaths,
} from './lib/build-workspace.mjs';

const { buildRoot, distRoot } = workspacePaths();
const outputApp = process.env.MODU_APP_BUNDLE
  ? path.resolve(process.env.MODU_APP_BUNDLE)
  : path.join(distRoot, '墨读.app');
const stagingRoot = path.join(buildRoot, 'pack');
const stagingApp = path.join(stagingRoot, '墨读-darwin-arm64', '墨读.app');
const icon = path.join(projectRoot, 'build', 'icon.icns');
const electronCache = path.join(buildRoot, 'electron-cache');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

if (!fs.existsSync(icon)) {
  throw new Error('缺少 build/icon.icns，请先运行 npm run build:icon。');
}

resetRepoDir(stagingRoot, '打包暂存目录');

// @electron/packager matches these against the path relative to dir, with a
// leading slash (despite the option docs describing absolute paths).
const ignored = [
  /^\/(?:test|scripts|build|assets|cloud|deploy|dist|\.git|\.build)(?:\/|$)/,
  /^\/node_modules\/(?:playwright|playwright-core|electron|electron-nightly|@electron|@electron-internal)(?:\/|$)/,
  /^\/(?:live-demo\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/,
  /(?:^|\/)(?:package(?:-lock)? 2\.json|\.package-lock 2\.json)$/,
  /\.DS_Store$/,
  /\.command$/,
];

const documentTypes = [{
  CFBundleTypeName: 'Markdown 文稿',
  CFBundleTypeRole: 'Viewer',
  LSHandlerRank: 'Alternate',
  LSItemContentTypes: ['net.daringfireball.markdown'],
  CFBundleTypeExtensions: ['md', 'markdown'],
}, {
  // HTML is an alternate viewer only. 墨读 must never become the default
  // browser for every .html file on the Mac.
  CFBundleTypeName: 'HTML 交互页',
  CFBundleTypeRole: 'Viewer',
  LSHandlerRank: 'Alternate',
  LSItemContentTypes: ['public.html'],
  CFBundleTypeExtensions: ['html', 'htm'],
}];

const importedTypes = [{
  UTTypeIdentifier: 'net.daringfireball.markdown',
  UTTypeDescription: 'Markdown 文稿',
  UTTypeConformsTo: ['public.plain-text'],
  UTTypeTagSpecification: {
    'public.filename-extension': ['md', 'markdown'],
    'public.mime-type': ['text/markdown'],
  },
}];

const extraResource = [
  path.join(projectRoot, 'welcome.md'),
  path.join(projectRoot, 'LICENSE'),
  path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'),
  path.join(projectRoot, 'assets'),
].filter((item) => fs.existsSync(item));

await packager({
  dir: projectRoot,
  out: stagingRoot,
  name: '墨读',
  executableName: '墨读',
  appBundleId: 'com.modu.reader',
  appCategoryType: 'public.app-category.productivity',
  appVersion: packageJson.version,
  buildVersion: packageJson.version,
  appCopyright: 'Copyright © 2026 墨读 contributors',
  icon,
  platform: 'darwin',
  arch: 'arm64',
  asar: false,
  prune: true,
  overwrite: true,
  osxSign: false,
  extraResource,
  tmpdir: path.join(buildRoot, 'pack-tmp'),
  download: { cacheRoot: electronCache },
  ...(process.env.MODU_ELECTRON_ZIP_DIR ? { electronZipDir: path.resolve(process.env.MODU_ELECTRON_ZIP_DIR) } : {}),
  ignore: ignored,
  extendInfo: {
    CFBundleDisplayName: '墨读',
    CFBundleName: '墨读',
    CFBundleDocumentTypes: documentTypes,
    UTImportedTypeDeclarations: importedTypes,
    LSMinimumSystemVersion: '12.0',
    LSUIElement: false,
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
  },
  quiet: true,
});

if (!fs.existsSync(stagingApp)) {
  throw new Error(`打包结果不存在：${stagingApp}`);
}

fs.mkdirSync(path.dirname(outputApp), { recursive: true });
if (fs.existsSync(outputApp)) {
  // Only replace an existing bundle inside this checkout. A caller-supplied
  // path outside the repository is never deleted by the build script.
  const relative = path.relative(projectRoot, outputApp);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`输出 app 已存在且位于仓库外，拒绝覆盖：${outputApp}`);
  }
  fs.rmSync(outputApp, { recursive: true, force: true });
}
fs.renameSync(stagingApp, outputApp);

console.log(`app: ${outputApp}`);
