import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Build artifacts default to this repository. MODU_WORKSPACE_ROOT is kept as
 * an optional compatibility hook, but only repository-internal values are
 * accepted: no build script may delete or overwrite a user directory outside
 * the checkout.
 */
export function resolveWorkspaceRoot(env = process.env) {
  const raw = String(env.MODU_WORKSPACE_ROOT || '').trim();
  if (!raw) return projectRoot;
  const resolved = path.resolve(raw);
  if (resolved === projectRoot || isInside(projectRoot, resolved)) return resolved;
  console.warn(
    `[modu] 忽略仓库外的 MODU_WORKSPACE_ROOT=${resolved}；`
    + `构建产物只写入 ${projectRoot} 内的 .build/ 与 dist/。`,
  );
  return projectRoot;
}

export function workspacePaths(env = process.env) {
  const workspaceRoot = resolveWorkspaceRoot(env);
  return {
    workspaceRoot,
    buildRoot: path.join(workspaceRoot, '.build'),
    distRoot: path.join(workspaceRoot, 'dist'),
  };
}

/** Remove and recreate a directory, but only when it is inside this repo. */
export function resetRepoDir(target, label = '目录') {
  const resolved = path.resolve(target);
  if (!isInside(projectRoot, resolved)) {
    throw new Error(`拒绝清理仓库外${label}：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Remove a known generated path while refusing anything outside this repo. */
export function removeRepoPath(target, label = '路径') {
  const resolved = path.resolve(target);
  if (!isInside(projectRoot, resolved)) {
    throw new Error(`拒绝删除仓库外${label}：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return resolved;
}
