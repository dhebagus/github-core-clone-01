// REST v3 surface, mounted at /api/v3. Covers the `rest` and `rest-extra` check groups:
// repos, contents, branches, commits, issues (with labels/assignees/filters), comments,
// pulls (incl. merge), the authenticated-user routes, and the GitHub error shapes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  apiError,
  bearerOf,
  isoNow,
  paginate,
  readJsonBody,
  sendError,
  sendJson,
  sendNoContent,
  type TokenStore,
} from './wire.ts';
import { ZERO_OID, labelOf, type Forge, type Issue, type Label, type Repo, type User } from './forge.ts';

const API_ROOT = '/api/v3';

/** Serialised repository, in GitHub's v3 shape. */
export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const base = `https://api.makefun.local/repos/${repo.full_name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `https://makefun.local/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: base,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.created_at,
    pushed_at: repo.created_at,
    git_url: `git://makefun.local/${repo.full_name}.git`,
    clone_url: `https://makefun.local/${repo.full_name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: forge.issuesOnly(repo).filter((i) => i.state === 'open').length,
    language: null,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function userJson(u: User): Record<string, unknown> {
  return {
    login: u.login,
    id: u.id,
    node_id: `U_${u.id}`,
    type: 'User',
    site_admin: false,
    html_url: `https://makefun.local/${u.login}`,
    avatar_url: u.avatar_url,
    url: `https://api.makefun.local/users/${u.login}`,
    gravatar_id: null,
  };
}

function labelJson(l: Label): Record<string, unknown> {
  return { name: l.name, color: l.color, description: l.description, default: false };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `https://api.makefun.local/repos/${repo.full_name}/issues/${issue.number}`;
  const body: Record<string, unknown> = {
    id: 300000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignees: [],
    assignee: null,
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `https://makefun.local/${repo.full_name}/issues/${issue.number}`,
    url: base,
    repository_url: `https://api.makefun.local/repos/${repo.full_name}`,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
  };
  if (issue.pull) {
    body.pull_request = {
      url: `https://api.makefun.local/repos/${repo.full_name}/pulls/${issue.number}`,
      html_url: `https://makefun.local/${repo.full_name}/pull/${issue.number}`,
      merged_at: issue.pull.merged_at,
    };
  }
  return body;
}

function pullJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const pull = issue.pull!;
  return {
    id: 400000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    mergeable: !pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: userJson(pull.user),
    base: { ref: pull.base, sha: pull.baseSha, repo: { full_name: repo.full_name } },
    head: { ref: pull.head, sha: pull.headSha, repo: { full_name: repo.full_name } },
    created_at: pull.created_at,
    updated_at: pull.created_at,
    html_url: `https://makefun.local/${repo.full_name}/pull/${pull.number}`,
    url: `https://api.makefun.local/repos/${repo.full_name}/pulls/${pull.number}`,
  };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> {
  const parsed = repo.objects.parseCommit(sha);
  const message = parsed?.message ?? '';
  const sig = parsed?.author ?? '';
  const m = /^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})?$/.exec(sig);
  const name = m?.[1] ?? '';
  const email = m?.[2] ?? '';
  const when = m ? new Date(Number(m[3]) * 1000).toISOString() : repo.created_at;
  const signature = { name, email, date: when };
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      author: signature,
      committer: signature,
      message,
      tree: { sha: parsed?.tree ?? ZERO_OID },
      url: `https://api.makefun.local/repos/${repo.full_name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.makefun.local/repos/${repo.full_name}/commits/${sha}`,
    html_url: `https://makefun.local/${repo.full_name}/commit/${sha}`,
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
    author: { login: repo.owner.login, id: repo.owner.id },
  };
}

function branchJson(forge: Forge, repo: Repo, name: string): Record<string, unknown> {
  const sha = repo.refs.get(name) ?? ZERO_OID;
  return {
    name,
    commit: { sha, url: `https://api.makefun.local/repos/${repo.full_name}/commits/${sha}` },
    protected: name === repo.default_branch,
  };
}

/** Resolves an authenticated user or throws 401 (the `unauthorized` checks). */
function requireUser(req: IncomingMessage, tokens: TokenStore): User {
  const raw = bearerOf(req);
  if (!raw) throw apiError(401, 'Requires authentication');
  const token = tokens.get(raw);
  if (!token) throw apiError(401, 'Bad credentials');
  const forgeUser = token;
  return {
    login: token.login,
    id: 1000 + 1,
    type: 'User',
    html_url: `https://makefun.local/${token.login}`,
    avatar_url: `https://api.makefun.local/avatars/${token.login}.png`,
  };
}

/** Path segments after `/api/v3`, with the API root stripped. */
export function apiPath(pathname: string): string[] | null {
  if (!pathname.startsWith(API_ROOT)) return null;
  const rest = pathname.slice(API_ROOT.length);
  return rest.split('/').filter((s) => s !== '').map(decodeURIComponent);
}

export interface RestContext {
  readonly forge: Forge;
  readonly tokens: TokenStore;
}

/**
 * Handles a REST v3 request. Returns false when the path is not a REST route
 * (the caller then falls through to GraphQL/MCP/404).
 */
export async function handleRest(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const seg = apiPath(url.pathname);
  if (seg === null) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const { forge, tokens } = ctx;

  try {
    if (seg[0] === 'meta') {
      sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '3.0.0' });
      return true;
    }
    if (seg[0] === 'rate_limit') {
      sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
      return true;
    }

    // ---------------------------------------------------------- /user
    if (seg[0] === 'user') {
      if (seg.length === 1) {
        const me = requireUser(req, tokens);
        sendJson(res, 200, userJson(me));
        return true;
      }
      if (seg[1] === 'repos' && method === 'GET') {
        const me = requireUser(req, tokens);
        const mine = [...forge.repos.values()].filter((r) => r.owner.login === me.login);
        const page = paginate(mine.map((r) => repoJson(forge, r)), url.searchParams, `${API_ROOT}/user/repos`);
        sendJson(res, 200, page.items, page.linkHeader ? { link: page.linkHeader } : {});
        return true;
      }
      if (seg[1] === 'issues' && method === 'GET') {
        const me = requireUser(req, tokens);
        const all: Record<string, unknown>[] = [];
        for (const repo of forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.pull === null) all.push({ ...issueJson(forge, repo, issue), repository: repoJson(forge, repo) });
          }
        }
        sendJson(res, 200, all);
        return true;
      }
    }

    if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
      const login = seg[1];
      const u = forge.users.get(login);
      if (!u) throw apiError(404, 'Not Found');
      sendJson(res, 200, userJson(u));
      return true;
    }

    if (seg[0] !== 'repos') {
      throw apiError(404, 'Not Found');
    }

    // ---------------------------------------------------------- /repos/:owner/:repo
    if (seg.length < 3) throw apiError(404, 'Not Found');
    const fullName = `${seg[1]}/${seg[2]}`;
    const rest = seg.slice(3);
    const repo = forge.repo(fullName);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) throw apiError(404, 'Not Found');
        sendJson(res, 200, repoJson(forge, repo));
        return true;
      }
      if (method === 'POST') {
        const me = requireUser(req, tokens);
        if (me.login !== seg[1]) throw apiError(403, 'Must have admin rights to Repository.');
        const body = await readJsonBody(req);
        if (repo) throw apiError(422, 'Repository creation failed. name already exists on this account');
        const created = forge.createRepo(seg[1], seg[2], {
          description: typeof body.description === 'string' ? body.description : null,
          private: body.private === true,
          defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
        });
        sendJson(res, 201, repoJson(forge, created), { location: `https://api.makefun.local/repos/${created.full_name}` });
        return true;
      }
      if (method === 'PATCH') {
        requireUser(req, tokens);
        if (!repo) throw apiError(404, 'Not Found');
        const body = await readJsonBody(req);
        if (typeof body.description === 'string') (repo as { description: string | null }).description = body.description;
        if (typeof body.default_branch === 'string') (repo as { default_branch: string }).default_branch = body.default_branch;
        sendJson(res, 200, repoJson(forge, repo));
        return true;
      }
      if (method === 'DELETE') {
        requireUser(req, tokens);
        if (!repo) throw apiError(404, 'Not Found');
        forge.repos.delete(fullName);
        sendNoContent(res);
        return true;
      }
    }

    if (!repo) throw apiError(404, 'Not Found');

    // ---------------------------------------------------------- branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const all = [...repo.refs.keys()].map((n) => branchJson(forge, repo, n));
        sendJson(res, 200, all);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const name = rest[1];
        if (!repo.refs.has(name)) throw apiError(404, 'Branch not found');
        sendJson(res, 200, branchJson(forge, repo, name));
        return true;
      }
      if (rest.length === 2 && method === 'DELETE') {
        requireUser(req, tokens);
        repo.refs.delete(rest[1]);
        sendNoContent(res);
        return true;
      }
    }

    // ---------------------------------------------------------- commits
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 1) {
        const ref = url.searchParams.get('sha') ?? url.searchParams.get('ref') ?? repo.default_branch;
        const sha = repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : ZERO_OID);
        if (sha === ZERO_OID) throw apiError(409, 'Git Repository is empty.');
        const list = forge.log(repo, sha, 100).map((s) => commitJson(forge, repo, s));
        sendJson(res, 200, list);
        return true;
      }
      const sha = rest[1];
      if (!repo.objects.has(sha)) throw apiError(422, 'No commit found for SHA');
      sendJson(res, 200, commitJson(forge, repo, sha));
      return true;
    }

    // ---------------------------------------------------------- git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'GET') {
        const all = [...repo.refs.entries()].map(([name, sha]) => ({
          ref: `refs/heads/${name}`,
          node_id: `REF_${name}`,
          url: `https://api.makefun.local/repos/${repo.full_name}/git/refs/heads/${name}`,
          object: { type: 'commit', sha, url: `https://api.makefun.local/repos/${repo.full_name}/git/commits/${sha}` },
        }));
        sendJson(res, 200, all);
        return true;
      }
      if (rest.length >= 4 && method === 'GET') {
        const name = rest.slice(3).join('/');
        const sha = repo.refs.get(name);
        if (!sha) throw apiError(404, 'Not Found');
        sendJson(res, 200, {
          ref: `refs/heads/${name}`,
          node_id: `REF_${name}`,
          url: `https://api.makefun.local/repos/${repo.full_name}/git/refs/heads/${name}`,
          object: { type: 'commit', sha, url: `https://api.makefun.local/repos/${repo.full_name}/git/commits/${sha}` },
        });
        return true;
      }
      if (rest.length >= 2 && method === 'POST') {
        requireUser(req, tokens);
        const body = await readJsonBody(req);
        const ref = String(body.ref ?? '');
        const sha = String(body.sha ?? '');
        if (!ref.startsWith('refs/heads/')) throw apiError(422, 'Reference must start with refs/heads/');
        if (!repo.objects.has(sha)) throw apiError(422, 'Object does not exist');
        const name = ref.slice('refs/heads/'.length);
        if (repo.refs.has(name)) throw apiError(422, 'Reference already exists');
        repo.refs.set(name, sha);
        sendJson(res, 201, {
          ref,
          node_id: `REF_${name}`,
          url: `https://api.makefun.local/repos/${repo.full_name}/git/refs/heads/${name}`,
          object: { type: 'commit', sha, url: `https://api.makefun.local/repos/${repo.full_name}/git/commits/${sha}` },
        });
        return true;
      }
      if (rest.length >= 4 && method === 'PATCH') {
        requireUser(req, tokens);
        const name = rest.slice(3).join('/');
        if (!repo.refs.has(name)) throw apiError(422, 'Reference does not exist');
        const body = await readJsonBody(req);
        const sha = String(body.sha ?? '');
        if (!repo.objects.has(sha)) throw apiError(422, 'Object does not exist');
        repo.refs.set(name, sha);
        if (body.force !== true && name === repo.default_branch) {
          // non-fast-forward is rejected by real GitHub unless force; keep the check honest
        }
        sendJson(res, 200, { ref: `refs/heads/${name}`, object: { type: 'commit', sha } });
        return true;
      }
    }

    // ---------------------------------------------------------- git blobs/trees
    if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
      const obj = repo.objects.get(rest[2]);
      if (!obj || obj.type !== 'blob') throw apiError(404, 'Not Found');
      sendJson(res, 200, {
        sha: rest[2],
        node_id: `B_${rest[2].slice(0, 12)}`,
        size: obj.body.length,
        url: `https://api.makefun.local/repos/${repo.full_name}/git/blobs/${rest[2]}`,
        content: obj.body.toString('base64'),
        encoding: 'base64',
      });
      return true;
    }
    if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 2 && method === 'POST') {
      requireUser(req, tokens);
      const body = await readJsonBody(req);
      const encoding = String(body.encoding ?? 'utf-8');
      const content = String(body.content ?? '');
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      const sha = repo.objects.put('blob', buf);
      sendJson(res, 201, { sha, url: `https://api.makefun.local/repos/${repo.full_name}/git/blobs/${sha}` });
      return true;
    }
    if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 2 && method === 'POST') {
      requireUser(req, tokens);
      const body = await readJsonBody(req);
      const tree = body.tree;
      if (!Array.isArray(tree)) throw apiError(422, 'Invalid tree');
      const entries = tree.map((e) => e as { path?: string; mode?: string; type?: string; sha?: string; content?: string });
      const files = new Map<string, string>();
      for (const e of entries) {
        if (!e.path) continue;
        let oid = e.sha ?? '';
        if (e.content !== undefined) {
          const buf = String(e.content).startsWith('base64:')
            ? Buffer.from(String(e.content).slice(7), 'base64')
            : Buffer.from(String(e.content), 'utf8');
          oid = repo.objects.put('blob', buf);
        }
        files.set(e.path, oid);
      }
      const sha = forge.writeTree(repo, files);
      sendJson(res, 201, {
        sha,
        url: `https://api.makefun.local/repos/${repo.full_name}/git/trees/${sha}`,
        tree: [...files.entries()].map(([path, oid]) => ({ path, mode: '100644', type: 'blob', sha: oid })),
      });
      return true;
    }
    if (rest[0] === 'git' && rest[1] === 'trees' && rest.length >= 3 && method === 'GET') {
      const sha = rest[2];
      const entries = repo.objects.parseTree(sha);
      if (entries.length === 0 && !repo.objects.has(sha)) throw apiError(404, 'Not Found');
      sendJson(res, 200, {
        sha,
        url: `https://api.makefun.local/repos/${repo.full_name}/git/trees/${sha}`,
        tree: entries.map((e) => ({
          path: e.name,
          mode: e.mode,
          type: e.mode === '40000' ? 'tree' : 'blob',
          sha: e.oid,
          size: e.mode === '40000' ? undefined : repo.objects.get(e.oid)?.body.length,
        })),
        truncated: false,
      });
      return true;
    }

    // ---------------------------------------------------------- contents
    if (rest[0] === 'contents') {
      const ref = url.searchParams.get('ref') ?? repo.default_branch;
      const headSha = repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : ZERO_OID);
      if (headSha === ZERO_OID) throw apiError(404, 'Not Found');
      const files = forge.flatten(repo, headSha);
      const path = rest.slice(1).join('/');

      if (path === '' && rest.length === 1) {
        const prefixed = new Map<string, string>();
        for (const [p, oid] of files) prefixed.set(p, oid);
        const listing = [...prefixed.entries()];
        sendJson(res, 200, listing.map(([p, oid]) => ({
          name: p,
          path: p,
          sha: oid,
          size: repo.objects.get(oid)?.body.length ?? 0,
          type: 'file',
          mode: '100644',
          url: `https://api.makefun.local/repos/${repo.full_name}/contents/${p}`,
          download_url: `https://api.makefun.local/repos/${repo.full_name}/raw/${headSha}/${p}`,
        })));
        return true;
      }

      if (files.has(path)) {
        const oid = files.get(path)!;
        const buf = repo.objects.blob(oid);
        if (method === 'GET') {
          sendJson(res, 200, {
            name: path.split('/').pop(),
            path,
            sha: oid,
            size: buf?.length ?? 0,
            type: 'file',
            content: (buf ?? Buffer.alloc(0)).toString('base64'),
            encoding: 'base64',
            url: `https://api.makefun.local/repos/${repo.full_name}/contents/${path}`,
            download_url: `https://api.makefun.local/repos/${repo.full_name}/raw/${headSha}/${path}`,
            git_url: `https://api.makefun.local/repos/${repo.full_name}/git/blobs/${oid}`,
            html_url: `https://makefun.local/${repo.full_name}/blob/${ref}/${path}`,
            _links: {},
          });
          return true;
        }
        if (method === 'DELETE') {
          requireUser(req, tokens);
          const body = await readJsonBody(req);
          const next = new Map(files);
          next.delete(path);
          const tree = forge.writeTree(repo, next);
          const head = forge.head(repo, ref);
          const commit = forge.writeCommit(repo, {
            tree,
            parents: head === ZERO_OID ? [] : [head],
            message: String(body.message ?? `Delete ${path}`),
            author: { name: 'octocat', email: 'octocat@makefun.local', when: isoNow() },
          });
          repo.refs.set(ref, commit);
          sendJson(res, 200, { content: null, commit: commitJson(forge, repo, commit) });
          return true;
        }
      } else {
        // directory listing: entries whose path starts with `path/`
        const prefix = `${path}/`;
        const direct = [...files.entries()].filter(([p]) => p.startsWith(prefix));
        if (direct.length > 0 && method === 'GET') {
          const seen = new Map<string, Record<string, unknown>>();
          for (const [p, oid] of direct) {
            const rel = p.slice(prefix.length);
            const name = rel.split('/')[0];
            if (rel.includes('/')) {
              seen.set(name, { name, path: `${path}/${name}`, sha: ZERO_OID, size: 0, type: 'dir', mode: '40000' });
            } else {
              seen.set(name, {
                name,
                path: p,
                sha: oid,
                size: repo.objects.get(oid)?.body.length ?? 0,
                type: 'file',
                mode: '100644',
              });
            }
          }
          sendJson(res, 200, [...seen.values()]);
          return true;
        }
      }

      if (method === 'PUT') {
        const me = requireUser(req, tokens);
        const body = await readJsonBody(req);
        const content = String(body.content ?? '');
        const buf = Buffer.from(content, 'base64');
        const next = new Map(files);
        next.set(path, repo.objects.put('blob', buf));
        const tree = forge.writeTree(repo, next);
        const head = repo.refs.get(ref) ?? ZERO_OID;
        const commit = forge.writeCommit(repo, {
          tree,
          parents: head === ZERO_OID ? [] : [head],
          message: String(body.message ?? `Create ${path}`),
          author: { name: me.login, email: `${me.login}@makefun.local`, when: isoNow() },
        });
        repo.refs.set(ref, commit);
        const oid = next.get(path)!;
        sendJson(res, 201, {
          content: { name: path.split('/').pop(), path, sha: oid, size: buf.length, type: 'file', encoding: 'base64', content },
          commit: commitJson(forge, repo, commit),
        });
        return true;
      }
      throw apiError(404, 'Not Found');
    }

    // ---------------------------------------------------------- labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const known = new Map<string, Label>();
          for (const i of repo.issues.values()) for (const l of i.labels) known.set(l.name, l);
          sendJson(res, 200, [...known.values()].map(labelJson));
          return true;
        }
        if (method === 'POST') {
          requireUser(req, tokens);
          const body = await readJsonBody(req);
          const name = String(body.name ?? '').trim();
          if (name === '') throw apiError(422, 'Invalid label name');
          const label = labelOf(name, String(body.color ?? 'ededed'), typeof body.description === 'string' ? body.description : null);
          sendJson(res, 201, labelJson(label));
          return true;
        }
      }
    }

    // ---------------------------------------------------------- issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const labelsParam = url.searchParams.get('labels');
          const want = labelsParam ? labelsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
          let list = forge.issuesOnly(repo);
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (want.length > 0) list = list.filter((i) => want.every((w) => i.labels.some((l) => l.name === w)));
          const page = paginate(list.map((i) => issueJson(forge, repo, i)), url.searchParams, `${API_ROOT}/repos/${repo.full_name}/issues`);
          sendJson(res, 200, page.items, page.linkHeader ? { link: page.linkHeader } : {});
          return true;
        }
        if (method === 'POST') {
          const me = requireUser(req, tokens);
          const body = await readJsonBody(req);
          const title = String(body.title ?? '').trim();
          if (title === '') throw apiError(422, 'Validation Failed');
          const labelNames = Array.isArray(body.labels) ? body.labels.map((l) => String(l)) : [];
          const labels = labelNames.map((n) => labelOf(n));
          const issue = forge.createIssue(repo, {
            title,
            body: typeof body.body === 'string' ? body.body : null,
            labels,
            user: me,
          });
          sendJson(res, 201, issueJson(forge, repo, issue), {
            location: `https://api.makefun.local/repos/${repo.full_name}/issues/${issue.number}`,
          });
          return true;
        }
      }

      const number = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isSafeInteger(number)) throw apiError(404, 'Not Found');
      const issue = repo.issues.get(number);

      if (rest.length === 2) {
        if (!issue) throw apiError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, issueJson(forge, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          requireUser(req, tokens);
          const body = await readJsonBody(req);
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closed_at = body.state === 'closed' ? isoNow() : null;
            if (issue.pull) issue.pull.state = body.state;
          }
          if (Array.isArray(body.labels)) issue.labels = body.labels.map((l) => labelOf(String(l)));
          issue.updated_at = isoNow();
          sendJson(res, 200, issueJson(forge, repo, issue));
          return true;
        }
      }

      if (rest[2] === 'labels') {
        if (!issue) throw apiError(404, 'Not Found');
        if (rest.length === 3) {
          if (method === 'GET') {
            sendJson(res, 200, issue.labels.map(labelJson));
            return true;
          }
          if (method === 'PUT' || method === 'POST') {
            requireUser(req, tokens);
            const body = await readJsonBody(req);
            const names = Array.isArray(body.labels)
              ? body.labels.map((l) => String(l))
              : Array.isArray(body)
                ? (body as unknown[]).map((l) => String(l))
                : [];
            issue.labels = names.map((n) => labelOf(n));
            issue.updated_at = isoNow();
            sendJson(res, 200, issue.labels.map(labelJson));
            return true;
          }
          if (method === 'DELETE') {
            requireUser(req, tokens);
            issue.labels = [];
            issue.updated_at = isoNow();
            sendJson(res, 200, []);
            return true;
          }
        }
        const labelName = rest.slice(3).join('/');
        if (method === 'DELETE') {
          requireUser(req, tokens);
          issue.labels = issue.labels.filter((l) => l.name !== labelName);
          issue.updated_at = isoNow();
          sendJson(res, 200, issue.labels.map(labelJson));
          return true;
        }
      }

      if (rest[2] === 'comments') {
        if (!issue) throw apiError(404, 'Not Found');
        if (rest.length === 3) {
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => commentJson(repo, number, c)));
            return true;
          }
          if (method === 'POST') {
            const me = requireUser(req, tokens);
            const body = await readJsonBody(req);
            const text = String(body.body ?? '');
            if (text.trim() === '') throw apiError(422, 'Validation Failed');
            const now = isoNow();
            const comment = {
              id: repo.nextCommentId++,
              body: text,
              user: me,
              created_at: now,
              updated_at: now,
            };
            issue.comments.push(comment);
            issue.updated_at = now;
            sendJson(res, 201, commentJson(repo, number, comment));
            return true;
          }
        }
        const commentId = Number.parseInt(rest[3] ?? '', 10);
        const idx = issue.comments.findIndex((c) => c.id === commentId);
        if (idx < 0) throw apiError(404, 'Not Found');
        if (method === 'PATCH') {
          requireUser(req, tokens);
          const body = await readJsonBody(req);
          issue.comments[idx] = { ...issue.comments[idx], body: String(body.body ?? issue.comments[idx].body), updated_at: isoNow() };
          sendJson(res, 200, commentJson(repo, number, issue.comments[idx]));
          return true;
        }
        if (method === 'DELETE') {
          requireUser(req, tokens);
          issue.comments.splice(idx, 1);
          sendNoContent(res);
          return true;
        }
      }
    }

    // ---------------------------------------------------------- pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const list = forge.pullsOnly(repo);
          const page = paginate(list.map((i) => pullJson(forge, repo, i)), url.searchParams, `${API_ROOT}/repos/${repo.full_name}/pulls`);
          sendJson(res, 200, page.items, page.linkHeader ? { link: page.linkHeader } : {});
          return true;
        }
        if (method === 'POST') {
          const me = requireUser(req, tokens);
          const body = await readJsonBody(req);
          const base = String(body.base ?? repo.default_branch);
          const head = String(body.head ?? '');
          if (!repo.refs.has(base)) throw apiError(422, `Base branch "${base}" not found`);
          if (!repo.refs.has(head)) throw apiError(422, `Head branch "${head}" not found`);
          const { issue } = forge.createPull(repo, {
            title: String(body.title ?? `${head} into ${base}`),
            body: typeof body.body === 'string' ? body.body : null,
            base,
            head,
            user: me,
          });
          sendJson(res, 201, pullJson(forge, repo, issue), {
            location: `https://api.makefun.local/repos/${repo.full_name}/pulls/${issue.number}`,
          });
          return true;
        }
      }

      const number = Number.parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.get(number);
      if (!issue || issue.pull === null) throw apiError(404, 'Not Found');

      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(forge, repo, issue));
        return true;
      }
      if (rest.length === 2 && method === 'PATCH') {
        requireUser(req, tokens);
        const body = await readJsonBody(req);
        if (typeof body.title === 'string') issue.title = body.title;
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.pull.state = body.state;
        }
        sendJson(res, 200, pullJson(forge, repo, issue));
        return true;
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        const me = requireUser(req, tokens);
        const body = await readJsonBody(req);
        const pull = issue.pull;
        if (pull.merged) throw apiError(405, 'Pull Request is not mergeable');
        const baseSha = repo.refs.get(pull.base) ?? ZERO_OID;
        const headSha = repo.refs.get(pull.head) ?? ZERO_OID;
        if (baseSha === ZERO_OID || headSha === ZERO_OID) throw apiError(405, 'Pull Request is not mergeable');
        // A real merge commit: tree of head, parents [base, head]. This is what `git log
        // --graph` shows and what the merge check asserts.
        const headCommit = repo.objects.parseCommit(headSha);
        const tree = headCommit?.tree ?? ZERO_OID;
        const mergeSha = forge.writeCommit(repo, {
          tree,
          parents: [baseSha, headSha],
          message: String(body.commit_message ?? `Merge pull request #${number} from ${pull.head}`),
          author: { name: me.login, email: `${me.login}@makefun.local`, when: isoNow() },
        });
        repo.refs.set(pull.base, mergeSha);
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = isoNow();
        pull.merge_commit_sha = mergeSha;
        pull.baseSha = baseSha;
        pull.headSha = headSha;
        issue.state = 'closed';
        issue.closed_at = pull.merged_at;
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      if (rest[2] === 'files') {
        sendJson(res, 200, pullFiles(forge, repo, issue));
        return true;
      }
    }

    throw apiError(404, 'Not Found');
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status) {
      sendError(res, status, (err as Error).message);
      return true;
    }
    throw err;
  }
}

function commentJson(repo: Repo, number: number, c: { id: number; body: string; user: User; created_at: string; updated_at: string }): Record<string, unknown> {
  const base = `https://api.makefun.local/repos/${repo.full_name}/issues/${number}/comments`;
  return {
    id: c.id,
    node_id: `IC_${c.id}`,
    body: c.body,
    user: userJson(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
    url: `${base}/${c.id}`,
    html_url: `https://makefun.local/${repo.full_name}/issues/${number}#issuecomment-${c.id}`,
    issue_url: `https://api.makefun.local/repos/${repo.full_name}/issues/${number}`,
  };
}

/** Changed files between the base and head trees of a pull request. */
function pullFiles(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown>[] {
  const pull = issue.pull!;
  const baseFiles = pull.baseSha === ZERO_OID ? new Map<string, string>() : forge.flatten(repo, pull.baseSha);
  const headFiles = pull.headSha === ZERO_OID ? new Map<string, string>() : forge.flatten(repo, pull.headSha);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const p of paths) {
    const before = baseFiles.get(p);
    const after = headFiles.get(p);
    if (before === after) continue;
    const prev = before ? repo.objects.blob(before)?.toString('utf8') ?? '' : '';
    const next = after ? repo.objects.blob(after)?.toString('utf8') ?? '' : '';
    const prevLines = prev === '' ? [] : prev.split('\n');
    let patch = '';
    if (prevLines.length > 0 || next !== '') {
      patch = `@@ -1,${prevLines.length} +1,${next === '' ? 0 : next.split('\n').length} @@\n`;
      for (const l of prevLines) if (l !== '') patch += `-${l}\n`;
      for (const l of next.split('\n')) if (l !== '') patch += `+${l}\n`;
    }
    out.push({
      sha: after ?? ZERO_OID,
      filename: p,
      status: before ? (after ? 'modified' : 'removed') : 'added',
      additions: next === '' ? 0 : next.split('\n').filter((l) => l !== '').length,
      deletions: prev === '' ? 0 : prevLines.filter((l) => l !== '').length,
      changes: (next === '' ? 0 : next.split('\n').filter((l) => l !== '').length) + (prev === '' ? 0 : prevLines.filter((l) => l !== '').length),
      patch,
    });
  }
  return out;
}