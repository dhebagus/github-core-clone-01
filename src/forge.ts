// The forge's in-memory model: users, repositories, git refs and objects, issues,
// comments, labels and pull requests. One indexed Store is the single writer, so every
// surface (REST v3, GraphQL v4, MCP) reads the same truth and an MCP tool call is
// visible on the REST view immediately (an mcp check asserts exactly that).

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  type ObjType,
  type CommitInfo,
} from './git-objects.ts';

export interface User {
  readonly login: string;
  readonly id: number;
  readonly type: 'User';
  readonly html_url: string;
  readonly avatar_url: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Non-null when this issue is really a pull request (GitHub models them the same way). */
  pull: Pull | null;
  comments: Comment[];
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: User;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  user: User;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly owner: User;
  readonly private: boolean;
  readonly default_branch: string;
  readonly description: string | null;
  readonly created_at: string;
  /** branch name -> commit sha (packed refs, always head of a branch). */
  refs: Map<string, string>;
  /** issue/PR numbers share one counter, as on GitHub. */
  issues: Map<number, Issue>;
  nextNumber: number;
  nextCommentId: number;
  /** git object store, shared per repository. */
  objects: ObjectStore;
}

export class Forge {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  readonly objects = new Map<string, ObjectStore>();
  private nextUserId = 1;
  private nextRepoId = 1;
  /** Mirrors the harness clock so ids stay deterministic. */
  private seq = 0;

  constructor(private readonly clock: () => string) {}

  now(): string {
    return this.clock();
  }

  /** Deterministic monotonic counter, used where a real forge would use a sequence. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  user(login: string): User {
    const existing = this.users.get(login);
    if (existing) return existing;
    const u: User = {
      login,
      id: 1000 + this.nextUserId,
      type: 'User',
      html_url: `https://api.makefun.local/${login}`,
      avatar_url: `https://api.makefun.local/avatars/${login}.png`,
    };
    this.nextUserId += 1;
    this.users.set(login, u);
    return u;
  }

  createRepo(owner: string, name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string } = {}): Repo {
    const fullName = `${owner}/${name}`;
    const existing = this.repos.get(fullName);
    if (existing) return existing;
    const objects = new ObjectStore();
    const repo: Repo = {
      id: 2000 + this.nextRepoId,
      name,
      full_name: fullName,
      owner: this.user(owner),
      private: opts.private === true,
      default_branch: opts.defaultBranch ?? 'main',
      description: opts.description ?? null,
      created_at: this.clock(),
      refs: new Map<string, string>(),
      issues: new Map<number, Issue>(),
      nextNumber: 1,
      nextCommentId: 1,
      objects,
    };
    this.nextRepoId += 1;
    this.repos.set(fullName, repo);
    this.objects.set(fullName, objects);
    return repo;
  }

  repo(fullName: string): Repo | undefined {
    return this.repos.get(fullName);
  }

  // ------------------------------------------------------------ git

  /** Writes a blob and returns its oid. */
  writeBlob(repo: Repo, content: Buffer | string): string {
    return repo.objects.put('blob', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  /**
   * Builds a tree from a path->blob map (`'a/b.txt' -> oid`) and returns its oid.
   * Nested paths create nested tree objects, which is what `contents-directory` reads.
   */
  writeTree(repo: Repo, files: Map<string, string>): string {
    interface Node {
      blobs: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const root: Node = { blobs: new Map(), dirs: new Map() };
    for (const [path, oid] of files) {
      const parts = path.split('/').filter(Boolean);
      let cur = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const seg = parts[i];
        let next = cur.dirs.get(seg);
        if (!next) {
          next = { blobs: new Map(), dirs: new Map() };
          cur.dirs.set(seg, next);
        }
        cur = next;
      }
      if (parts.length > 0) cur.blobs.set(parts[parts.length - 1], oid);
    }
    const write = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, oid] of node.blobs) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const body = Buffer.concat(
        entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex')])),
      );
      return repo.objects.put('tree', body);
    };
    return write(root);
  }

  writeCommit(
    repo: Repo,
    opts: { tree: string; parents: string[]; message: string; author: { name: string; email: string; when: string } },
  ): string {
    const lines: string[] = [`tree ${opts.tree}`];
    for (const p of opts.parents) lines.push(`parent ${p}`);
    const who = `${opts.author.name} <${opts.author.email}> ${Math.floor(Date.parse(opts.author.when) / 1000)} +0000`;
    lines.push(`author ${who}`, `committer ${who}`, '', opts.message);
    return repo.objects.put('commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
  }

  head(repo: Repo, branch = repo.default_branch): string {
    return repo.refs.get(branch) ?? ZERO_OID;
  }

  /** Walks a commit's parents, newest first. Cycle-guarded. */
  log(repo: Repo, sha: string, limit = 100): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0 && out.length < limit) {
      const cur = stack.shift()!;
      if (cur === ZERO_OID || seen.has(cur)) continue;
      seen.add(cur);
      if (!repo.objects.has(cur)) continue;
      out.push(cur);
      const parsed = repo.objects.parseCommit(cur);
      if (parsed) for (const p of parsed.parents) stack.push(p);
    }
    return out;
  }

  /** The flat path->blob map of a commit's tree, recursing into subtrees. */
  flatten(repo: Repo, sha: string): Map<string, string> {
    const result = new Map<string, string>();
    const commit = repo.objects.parseCommit(sha);
    if (!commit) return result;
    const walk = (treeSha: string, prefix: string): void => {
      const entries = repo.objects.parseTree(treeSha);
      for (const e of entries) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else result.set(path, e.oid);
      }
    };
    walk(commit.tree, '');
    return result;
  }

  // ------------------------------------------------------------ issues / pulls

  allocateNumber(repo: Repo): number {
    const n = repo.nextNumber;
    repo.nextNumber += 1;
    return n;
  }

  createIssue(
    repo: Repo,
    opts: { title: string; body?: string | null; labels?: Label[]; user: User },
  ): Issue {
    const now = this.clock();
    const issue: Issue = {
      number: this.allocateNumber(repo),
      title: opts.title,
      body: opts.body ?? null,
      state: 'open',
      labels: opts.labels ?? [],
      user: opts.user,
      created_at: now,
      updated_at: now,
      closed_at: null,
      pull: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    opts: { title: string; body?: string | null; base: string; head: string; user: User },
  ): { issue: Issue; pull: Pull } {
    const now = this.clock();
    const number = this.allocateNumber(repo);
    const pull: Pull = {
      number,
      title: opts.title,
      body: opts.body ?? null,
      state: 'open',
      merged: false,
      base: opts.base,
      head: opts.head,
      baseSha: repo.refs.get(opts.base) ?? ZERO_OID,
      headSha: repo.refs.get(opts.head) ?? ZERO_OID,
      user: opts.user,
      created_at: now,
      merged_at: null,
      merge_commit_sha: null,
    };
    const issue: Issue = {
      number,
      title: opts.title,
      body: opts.body ?? null,
      state: 'open',
      labels: [],
      user: opts.user,
      created_at: now,
      updated_at: now,
      closed_at: null,
      pull,
      comments: [],
    };
    repo.issues.set(number, issue);
    return { issue, pull };
  }

  /** Issues only (pulls excluded), the REST `/issues` view. */
  issuesOnly(repo: Repo): Issue[] {
    return [...repo.issues.values()].filter((i) => i.pull === null);
  }

  pullsOnly(repo: Repo): Issue[] {
    return [...repo.issues.values()].filter((i) => i.pull !== null);
  }
}

export function labelOf(name: string, color = 'ededed', description: string | null = null): Label {
  return { name, color, description };
}

export { ZERO_OID };