import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { httpError } from './adminAuth.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const API = 'https://api.github.com';

function config() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_REPO || 'JustWastingTime/TazunaDiscordBot').trim();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
  if (!token) throw httpError(500, 'GITHUB_TOKEN is not configured.');
  if (!repo.includes('/')) throw httpError(500, 'GITHUB_REPO must look like owner/name.');
  return { token, repo, branch };
}

async function gh(pathname, { method = 'GET', body, raw = false } = {}) {
  const { token } = config();
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tazuna-admin-dashboard',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (raw) {
    if (!res.ok) {
      throw httpError(res.status === 404 ? 404 : 502, `GitHub ${method} ${pathname} failed (${res.status}).`);
    }
    return text;
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const message = data?.message || `GitHub ${method} ${pathname} failed (${res.status}).`;
    const status = res.status === 409 || res.status === 422 ? 409 : 502;
    throw httpError(status, message);
  }
  return data;
}

export async function getHead() {
  const { repo, branch } = config();
  const ref = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = ref.object?.sha;
  if (!commitSha) throw httpError(502, 'GitHub ref did not include a commit.');
  const commit = await gh(`/repos/${repo}/git/commits/${commitSha}`);
  return { commitSha, treeSha: commit.tree.sha };
}

async function treeEntries(treeSha) {
  const { repo } = config();
  const tree = await gh(`/repos/${repo}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) throw httpError(502, 'GitHub tree was truncated; refusing to commit.');
  return tree.tree || [];
}

/** Raw file text at the current branch head, plus the blob SHA the editor must echo back. */
export async function getFileAtHead(filePath) {
  const { repo } = config();
  const head = await getHead();
  const item = (await treeEntries(head.treeSha)).find((entry) => entry.path === filePath);
  if (!item || item.type !== 'blob') throw httpError(404, `Not found on GitHub: ${filePath}`);
  const content = await gh(`/repos/${repo}/git/blobs/${item.sha}`, { raw: true });
  return { path: filePath, content, blobSha: item.sha, commitSha: head.commitSha };
}

/**
 * Commit one or more file replacements onto the branch.
 * Rejects when baseBlobSha no longer matches head, or when head moved (no force).
 */
export async function commitFiles(files, message) {
  const { repo, branch } = config();
  const text = String(message || '').trim();
  if (!text) throw httpError(400, 'Commit message is required.');
  if (!Array.isArray(files) || !files.length) throw httpError(400, 'Nothing to commit.');

  const head = await getHead();
  const entries = await treeEntries(head.treeSha);
  for (const file of files) {
    const current = entries.find((entry) => entry.path === file.path);
    if (file.baseBlobSha && current && current.sha !== file.baseBlobSha) {
      throw httpError(409, 'File changed on GitHub. Reload and try again.');
    }
    if (file.baseBlobSha && !current) {
      throw httpError(409, 'File changed on GitHub. Reload and try again.');
    }
  }

  const tree = [];
  for (const file of files) {
    if (file.deleted) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await gh(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: file.content, encoding: 'utf-8' },
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: head.treeSha, tree },
  });
  const commit = await gh(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: { message: text, tree: newTree.sha, parents: [head.commitSha] },
  });

  try {
    await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    });
  } catch (error) {
    if (error.statusCode === 409) {
      throw httpError(409, 'File changed on GitHub. Reload and try again.');
    }
    throw error;
  }

  return {
    commitSha: commit.sha,
    blobShas: Object.fromEntries(tree.map((item) => [item.path, item.sha])),
  };
}

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 60_000,
      env: gitEnv(),
    });
    return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
    };
  }
}

async function dropLocalCopy(file) {
  const restored = await git(['checkout', 'HEAD', '--', file]);
  if (restored.ok) return;
  await git(['clean', '-f', '--', file]);
}

/**
 * Move this checkout forward to the commit just pushed.
 * Writing the file in place leaves it modified, and the next pull refuses to merge.
 * Falls back quietly when this folder is not a fast-forward of the branch.
 */
export async function fastForwardLocalCheckout(paths) {
  const files = [...new Set((paths || []).map((file) => String(file || '').replace(/\\/g, '/')).filter(Boolean))];
  const { branch } = config();
  try {
    const fetched = await git(['fetch', 'origin', branch]);
    if (!fetched.ok) {
      return { synced: false, reason: fetched.stderr || 'git fetch failed' };
    }
    const head = await git(['rev-parse', 'HEAD']);
    const remote = await git(['rev-parse', `origin/${branch}`]);
    if (!head.ok || !remote.ok) {
      return { synced: false, reason: 'Could not read the local or remote commit.' };
    }
    if (head.stdout === remote.stdout) return { synced: true };

    const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
    if (!ancestor.ok) {
      return { synced: false, reason: 'Local checkout has commits that are not on GitHub.' };
    }

    const merged = await git(['merge', '--ff-only', `origin/${branch}`]);
    if (merged.ok) return { synced: true };

    const output = `${merged.stdout}\n${merged.stderr}`;
    const blocked = files.filter((file) => output.includes(file));
    if (!blocked.length) {
      return { synced: false, reason: merged.stderr || 'Local checkout has other changes.' };
    }
    for (const file of blocked) await dropLocalCopy(file);
    const retried = await git(['merge', '--ff-only', `origin/${branch}`]);
    if (retried.ok) return { synced: true };
    return { synced: false, reason: retried.stderr || 'Fast-forward failed.' };
  } catch (error) {
    return { synced: false, reason: error.code === 'ENOENT' ? 'git is not installed' : error.message };
  }
}
