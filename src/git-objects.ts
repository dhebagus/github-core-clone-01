// Git object storage: SHA-1 hashing, zlib loose objects, commit/tree/tag parsing and building.
// Everything is the forge's own: no git binary, no outside service.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Inflated body without the "<type> <len>\0" header. */
  body: Buffer;
}

/** git's object id: sha1("<type> <size>\0" + body). */
export function hashObject(type: ObjType, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(body).digest('hex');
}

/** Store one object; returns its oid. Idempotent. */
export class ObjectStore {
  private objects = new Map<string, GitObject>();

  put(type: ObjType, body: Buffer): string {
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
    return oid;
  }

  putRaw(oid: string, type: ObjType, body: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Objects as loose zlib entries, for a clone/push pack (plain, no deltas). */
  all(): Array<{ oid: string; obj: GitObject }> {
    return [...this.objects.entries()].map(([oid, obj]) => ({ oid, obj }));
  }

  /** Parsed commit view of `oid`, or undefined when absent / not a commit. */
  parseCommit(oid: string): CommitInfo | undefined {
    const obj = this.objects.get(oid);
    return obj && obj.type === 'commit' ? parseCommit(obj.body) : undefined;
  }

  /** Parsed tree view of `oid`, or [] when absent / not a tree. */
  parseTree(oid: string): TreeEntry[] {
    const obj = this.objects.get(oid);
    return obj && obj.type === 'tree' ? parseTree(obj.body) : [];
  }

  /** Raw body bytes for a blob, or undefined. */
  blob(oid: string): Buffer | undefined {
    const obj = this.objects.get(oid);
    return obj && obj.type === 'blob' ? obj.body : undefined;
  }

  get size(): number { return this.objects.size; }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;          // '100644', '100755', '40000', '120000', '160000'
  name: string;
  oid: string;
}

/** Binary git tree: "<mode> <name>\0<20-byte oid>" per entry, sorted by name (dirs as name+'/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = body.subarray(i, sp).toString('utf8');
    const nul = body.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = body.subarray(sp + 1, nul).toString('utf8');
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Extra headers (gpgsig, encoding, ...) preserved verbatim. */
  extra?: string;
}

export function buildCommit(c: CommitInfo): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  if (c.extra) lines.push(c.extra.replace(/\n$/, ''));
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const out: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  const extra: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
    else if (line.startsWith(' ')) extra.push(line);       // continuation (e.g. gpgsig)
    else if (line.trim() !== '') extra.push(line);
  }
  if (extra.length) out.extra = extra.join('\n');
  return out;
}

/** Signature "<name> <email> <unix> <tz>" as git writes it. */
export function signature(name: string, email: string, when: Date, offsetMinutes = 0): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${name} <${email}> ${Math.floor(when.getTime() / 1000)} ${tz}`;
}

/** Parse the unix ts and tz out of a signature line. */
export function parseSignature(sig: string): { name: string; email: string; date: Date; tz: string } {
  const m = /^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})?$/.exec(sig.trim());
  if (!m) return { name: sig.trim(), email: '', date: new Date(0), tz: '+0000' };
  return {
    name: m[1] ?? '',
    email: m[2] ?? '',
    date: new Date(Number(m[3]) * 1000),
    tz: m[4] ?? '+0000',
  };
}
