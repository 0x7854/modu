import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createCloudServer } from '../cloud/server.js';
import { CloudStore } from '../cloud/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const appBundle = process.env.MODU_APP_BUNDLE || path.join(projectRoot, 'dist', '墨读.app');
const executable = path.join(appBundle, 'Contents', 'MacOS', '墨读');
const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
const runRoot = path.join(projectRoot, '.build', 'packaged-test');

function readInfoPlist() {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
  }));
}

async function waitFor(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`);
}

function waitForPortClosed(port, timeout = 8000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(800);
      socket.once('connect', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
      socket.once('error', () => resolve(true));
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

test('packaged bundle carries the standalone runtime, seal icon, and Markdown associations', () => {
  assert.ok(fs.existsSync(appBundle), `missing app bundle: ${appBundle}`);
  assert.ok(fs.existsSync(executable), 'missing packaged executable');
  assert.ok(fs.existsSync(path.join(
    appBundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework',
  )), 'Electron runtime is not bundled');

  const info = readInfoPlist();
  assert.equal(info.CFBundleIdentifier, 'com.modu.reader');
  assert.equal(info.CFBundleExecutable, '墨读');
  assert.equal(info.LSUIElement, false, 'the app must stay a regular Dock app');

  const types = info.CFBundleDocumentTypes || [];
  const extensions = new Set(types.flatMap((entry) => entry.CFBundleTypeExtensions || []));
  assert.deepEqual([...extensions].sort(), ['htm', 'html', 'markdown', 'md']);
  assert.equal(extensions.has('txt'), false, 'must not claim plain-text .txt files');
  const handlers = types.flatMap((entry) => entry.LSItemContentTypes || []);
  assert.ok(handlers.includes('net.daringfireball.markdown'));
  assert.ok(handlers.includes('public.html'));
  assert.equal(types.find(t => t.LSItemContentTypes?.includes('public.html')).LSHandlerRank, 'Alternate');

  const iconName = info.CFBundleIconFile;
  assert.ok(iconName);
  const packagedIcon = path.join(appBundle, 'Contents', 'Resources', iconName);
  assert.ok(fs.existsSync(packagedIcon), 'declared app icon is missing');
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(packagedIcon)).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(path.join(projectRoot, 'build', 'icon.icns'))).digest('hex'),
    'packaged icon must be the generated ink seal',
  );

  const resources = path.join(appBundle, 'Contents', 'Resources', 'app');
  assert.ok(fs.existsSync(path.join(resources, 'node_modules', 'markdown-it')));
  assert.ok(fs.existsSync(path.join(resources, 'node_modules', 'jsdom')));
  assert.equal(fs.existsSync(path.join(resources, 'node_modules', 'playwright')), false);
  assert.equal(fs.existsSync(path.join(resources, 'node_modules', 'electron')), false);
});

test('packaged app cold-opens, hot-opens, live-syncs, reopens, and cleans up on quit', {
  timeout: 120000,
}, async () => {
  fs.rmSync(runRoot, { recursive: true, force: true });
  const docs = path.join(runRoot, 'documents');
  const profile = path.join(runRoot, 'profile');
  const home = path.join(runRoot, 'home');
  const tmp = path.join(projectRoot, '.build', 'tmp');
  for (const dir of [docs, profile, home, tmp]) fs.mkdirSync(dir, { recursive: true });

  const coldPath = path.join(docs, 'cold-start.md');
  const hotPath = path.join(docs, 'hot-open.md');
  const refusedPath = path.join(docs, 'not-a-document.txt');
  await fsp.writeFile(coldPath, '# 冷启动标题\n\n冷启动正文。\n');
  await fsp.writeFile(hotPath, '# 热启动标题\n\n热启动正文。\n');
  await fsp.writeFile(refusedPath, '纯文本不应被打开。\n');

  let app;
  let page;
  let cloudServer;
  const pageErrors = [];
  const cloudStore = await new CloudStore(path.join(runRoot, 'cloud-data')).init();
  const cloudAccount = await cloudStore.addUser('pack-smoke', 'correct horse battery');
  cloudServer = await createCloudServer({
    dataDir: path.join(runRoot, 'cloud-data'),
    publicDir: path.join(projectRoot, 'cloud', 'public'),
    maxDocBytes: 2 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    cloudServer.once('error', reject);
    cloudServer.once('listening', resolve);
    cloudServer.listen(0, '127.0.0.1');
  });
  const cloudBase = `http://127.0.0.1:${cloudServer.address().port}`;
  try {
    app = await electron.launch({
      executablePath: executable,
      args: ['--no-sandbox', coldPath],
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: tmp,
        MODU_USER_DATA_DIR: profile,
        MODU_TEMP_DIR: tmp,
        MODU_DISABLE_SINGLE_INSTANCE: '1',
        MODU_PLAYWRIGHT_LOADER: path.join(
          projectRoot, 'node_modules', 'playwright-core', 'lib', 'server', 'electron', 'loader.js',
        ),
      },
      timeout: 30000,
    });

    page = await app.firstWindow({ timeout: 30000 });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForLoadState('domcontentloaded');

    const url = new URL(page.url());
    assert.equal(url.hostname, '127.0.0.1');
    assert.notEqual(url.port, '4648', 'the packaged app should use a dynamic port');
    assert.equal(await page.evaluate(() => typeof window.moduDesktop), 'object');
    assert.deepEqual(
      await page.evaluate(() => Object.keys(window.moduDesktop).sort()),
      ['documentOpened', 'getPathForFile', 'onOpenPath', 'ready', 'sync'],
    );
    assert.deepEqual(
      await page.evaluate(() => Object.keys(window.moduDesktop.sync).sort()),
      ['addPath', 'getLibrary', 'getState', 'mutateLibrary', 'onState', 'ping', 'removePath', 'saveSettings', 'syncNow'],
    );

    // Official webUtils.getPathForFile path, through the narrow preload bridge.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'modu-path-probe';
      input.style.display = 'none';
      document.body.append(input);
    });
    await page.setInputFiles('#modu-path-probe', hotPath);
    const bridgePath = await page.evaluate(() => {
      const file = document.querySelector('#modu-path-probe').files[0];
      return window.moduDesktop.getPathForFile(file);
    });
    assert.equal(bridgePath, hotPath);
    assert.equal(
      await page.evaluate(() => window.moduDesktop.getPathForFile(new File(['x'], 'fake.md'))),
      '',
      'a synthetic File has no filesystem path',
    );

    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? win.webContents.getLastWebPreferences() : null;
    });
    assert.equal(prefs?.nodeIntegration, false);
    assert.equal(prefs?.contextIsolation, true);
    assert.equal(prefs?.sandbox, true);
    assert.equal(prefs?.webSecurity, true);
    assert.equal(prefs?.allowRunningInsecureContent, false);
    assert.equal(prefs?.webviewTag, false);

    const dockVisible = await app.evaluate(({ app: electronApp }) => (
      electronApp.dock ? electronApp.dock.isVisible() : null
    ));
    assert.equal(dockVisible, true);

    await page.waitForFunction(
      () => document.title.startsWith('cold-start.md'),
      null,
      { timeout: 15000 },
    );
    await page.getByText('冷启动正文。').waitFor({ timeout: 10000 });

    await fsp.writeFile(coldPath, '# 冷启动标题\n\n实时改写后的正文。\n');
    await page.getByText('实时改写后的正文。').waitFor({ timeout: 15000 });

    // Use LaunchServices to deliver a real macOS open-file event to the
    // running packaged bundle, exactly like double-clicking a Markdown file.
    execFileSync('open', ['-a', appBundle, hotPath], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    await page.waitForFunction(
      () => document.title.startsWith('hot-open.md'),
      null,
      { timeout: 20000 },
    );
    await page.getByText('热启动正文。').waitFor({ timeout: 10000 });

    await app.evaluate(({ app: electronApp }, filePath) => {
      electronApp.emit('open-file', { preventDefault() {} }, filePath);
    }, refusedPath);
    await page.waitForTimeout(800);
    assert.match(await page.title(), /^hot-open\.md/);
    assert.equal(await page.getByText('纯文本不应被打开。').count(), 0);

    // Real packaged IPC: configure the private cloud library, explicitly add
    // the current document, and verify the sync token reaches only the local
    // settings file while the body reaches the cloud server.
    await page.locator('#cloud-trigger').click();
    await page.locator('#cloud-panel').waitFor({ state: 'visible' });
    await page.locator('#cloud-server-url').fill(cloudBase);
    await page.locator('#cloud-token').fill(cloudAccount.syncToken);
    await page.locator('#cloud-save').click();
    await page.waitForFunction(
      () => document.querySelector('#cloud-account-text')?.textContent.includes('pack-smoke'),
      null,
      { timeout: 15000 },
    );
    await page.locator('#cloud-add-current').click();
    const cloudDocs = await waitFor(async () => {
      const list = await cloudStore.listDocuments(cloudAccount.user.id);
      return list.length ? list : null;
    }, 10000);
    const syncedDoc = await cloudStore.getDocument(cloudAccount.user.id, cloudDocs[0].id);
    assert.match(syncedDoc.markdown, /热启动正文/);
    const bridgeState = await page.evaluate(() => window.moduDesktop.sync.getState());
    assert.equal(bridgeState.configured, true);
    assert.equal(JSON.stringify(bridgeState).includes(cloudAccount.syncToken), false);
    const managed = await page.evaluate(async (docId) => {
      const api = window.moduDesktop.sync;
      let result = await api.getLibrary();
      result = await api.mutateLibrary({revision: result.library.revision, action:'createFolder', name:'打包测试', parentId:null});
      const folderId = result.library.folders.find(f => f.name === '打包测试').id;
      result = await api.mutateLibrary({revision:result.library.revision, action:'moveDocument',docId,folderId});
      return {folderId, result};
    }, cloudDocs[0].id);
    assert.equal(managed.result.library.assignments[cloudDocs[0].id], managed.folderId);
    assert.equal(JSON.stringify(managed).includes(cloudAccount.syncToken), false);
    const fromCloud = await fetch(cloudBase+'/api/sync/library', {headers:{Authorization:'Bearer '+cloudAccount.syncToken}}).then(r=>r.json());
    assert.equal(fromCloud.library.assignments[cloudDocs[0].id], managed.folderId);
    assert.match((await cloudStore.getDocument(cloudAccount.user.id,cloudDocs[0].id)).markdown,/热启动正文/);

    const credentialsPath = path.join(profile, 'cloud-sync.json');
    const credentialsStat = fs.statSync(credentialsPath);
    assert.equal(credentialsStat.mode & 0o777, 0o600);
    assert.match(fs.readFileSync(credentialsPath, 'utf8'), new RegExp(cloudAccount.syncToken));

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      0,
      'closing the window must leave the app resident without windows',
    );

    const nextWindow = app.waitForEvent('window', { timeout: 15000 });
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'));
    page = await nextWindow;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => document.title.startsWith('hot-open.md'),
      null,
      { timeout: 15000 },
    );

    const port = Number(new URL(page.url()).port);
    const closeEvent = new Promise((resolve) => app.once('close', resolve));
    await app.evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 20);
    });
    await Promise.race([
      closeEvent,
      new Promise((_, reject) => setTimeout(() => reject(new Error('app did not quit')), 15000)),
    ]);
    assert.equal(await waitForPortClosed(port), true, 'local server must stop on quit');

    assert.deepEqual(pageErrors, []);
  } finally {
    if (app) await app.close().catch(() => {});
    if (cloudServer) {
      cloudServer.cloudShutdown();
      await new Promise((resolve) => cloudServer.close(resolve));
    }
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
