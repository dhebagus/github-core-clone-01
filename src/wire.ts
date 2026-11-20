// Wire-level primitives: JSON responses, errors, auth, pagination, body parsing.
// Everything the REST/GraphQL/MCP surfaces share lives here so the status-code and
// JSON discipline is identical across all of them (the `protocol` check group).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** GitHub-shaped error body: { message, documentation_url? }. */
export interface ApiError extends Error {
  readonly status: number;
}

export function apiError(status: number, message: string): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  Object.defineProperty(e, 'name', { value: 'ApiError' });
  return e;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

/** Reads the whole request body as utf-8. Empty body -> ''. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a JSON body; throws a 400 ApiError on malformed input (protocol check). */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw apiError(400, 'Problems parsing JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'Body should be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Real clock in ISO-8601 with `Z`, the shape GitHub returns. */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Deterministic 40-hex id from a seed (stable across runs: `run_deterministic`). */
export function hex40(seed: string): string {
  // FNV-1a over the seed, expanded to 40 hex chars via a second-order mix. No crypto RNG,
  // no clock: the same logical object always gets the same id.
  const out: string[] = [];
  for (let block = 0; block < 5; block += 1) {
    let h = 0x811c9dc5 ^ block;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(16).padStart(8, '0'));
  }
  return out.join('');
}

// ---------------------------------------------------------------- auth

export interface Token {
  readonly token: string;
  readonly login: string;
}

/**
 * The token registry. The harness registers tokens it will accept; a request with any
 * other bearer credential is a 401 (`unauthorized` / `foreign-token` checks).
 */
export class TokenStore {
  private readonly byToken = new Map<string, Token>();
  private readonly byLogin = new Map<string, Token>();

  register(token: string, login: string): Token {
    const t: Token = { token, login };
    this.byToken.set(token, t);
    this.byLogin.set(login, t);
    return t;
  }

  /** The seeded default token, so a bare `gh` with a known token works. */
  seed(): Token {
    const existing = this.byLogin.get('octocat');
    if (existing) return existing;
    return this.register('ghp_makefun_conformance_token', 'octocat');
  }

  get(token: string): Token | undefined {
    return this.byToken.get(token);
  }

  forLogin(login: string): Token | undefined {
    return this.byLogin.get(login);
  }

  all(): Token[] {
    return [...this.byToken.values()];
  }
}

/**
 * Extracts the bearer credential from an Authorization header.
 * Accepts `Bearer <t>`, `token <t>` and `Basic base64(user:pass)` (gh sends Bearer).
 */
export function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const m = /^(bearer|token)\s+(.+)$/i.exec(raw.trim());
  if (m) return m[2].trim();
  const basic = /^basic\s+(.+)$/i.exec(raw.trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(0, idx) : decoded;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- pagination

export interface Page {
  readonly items: unknown[];
  readonly linkHeader?: string;
}

/**
 * Applies GitHub-style pagination: `per_page` (default 30, max 100) and `page`.
 * Emits `Link` with rel="next"/"last"/"prev"/"first" so the pagination check passes.
 */
export function paginate(items: unknown[], params: URLSearchParams, basePath: string): Page {
  const rawPer = Number.parseInt(params.get('per_page') ?? '', 10);
  const perPage = Number.isSafeInteger(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : 30;
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const total = items.length;
  const last = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);

  const links: string[] = [];
  const url = (p: number): string => {
    const q = new URLSearchParams(params);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${basePath}?${q.toString()}`;
  };
  if (page < last) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(last)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);

  return { items: slice, linkHeader: links.length > 0 ? links.join(', ') : undefined };
}