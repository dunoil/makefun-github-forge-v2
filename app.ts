// Forge v2 HTTP server: routing, bearer auth, the /api/v3 REST surface, /api/graphql,
// /mcp and the git smart-HTTP routes, all over one shared store.
//
// The request path is built to do as little as possible per call:
//   - the request target is split by hand (no URL object, no query parsing until a
//     handler actually reads a parameter);
//   - a GET never touches the request stream — there is no body to read;
//   - request ids are a boot salt plus a counter, not a CSPRNG call per request;
//   - serialised replies for the hot reads (a repo, an issue, a pull) are memoised
//     against the records' mutation stamps, so a repeated read is a map lookup and
//     a res.end of a ready string; any mutation bumps a stamp and the next read
//     re-serialises exactly once.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  DomainError,
  addComment,
  createIssue,
  createPull,
  forgeCommit,
  mergePull,
  pullFiles,
  pullTips,
  setIssueState,
  setPullState,
} from './domain.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import {
  Forge,
  looksLikeOid,
  oidOf,
  reachableCommits,
  storeTreeFromFiles,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

const VERSION = 'forge-2.0.0';
const MAX_BODY = 256 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

// --------------------------------------------------------------------------- request context

interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  rawQuery: string;
  query: Map<string, string> | null;
  body: Buffer;
  requestId: string;
}

function queryOf(ctx: Ctx): Map<string, string> {
  if (ctx.query !== null) return ctx.query;
  const map = new Map<string, string>();
  if (ctx.rawQuery !== '') {
    for (const pair of ctx.rawQuery.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      map.set(decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' ')));
    }
  }
  ctx.query = map;
  return map;
}

function param(ctx: Ctx, name: string): string | null {
  return queryOf(ctx).get(name) ?? null;
}

// --------------------------------------------------------------------------- reply helpers

function sendJson(ctx: Ctx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const payload = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': ctx.requestId,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  });
  ctx.res.end(payload);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, { 'X-GitHub-Request-Id': ctx.requestId });
  ctx.res.end();
}

function parseBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const asStr = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asBool = (value: unknown): boolean => value === true;

// --------------------------------------------------------------------------- serialisers
//
// The *Json builders return plain objects; the three hot ones (repo, issue, pull)
// also have *Body builders that memoise the final JSON text on the record.

const bodyCache = new WeakMap<object, { key: string; body: string }>();

function memoBody(rec: object, key: string, build: () => string): string {
  const hit = bodyCache.get(rec);
  if (hit !== undefined && hit.key === key) return hit.body;
  const body = build();
  bodyCache.set(rec, { key, body });
  return body;
}

const userCache = new Map<string, Record<string, unknown>>();

function userJson(forge: Forge, login: string): Record<string, unknown> {
  let hit = userCache.get(login);
  if (hit === undefined) {
    hit = {
      login,
      id: 1,
      node_id: 'U_1',
      type: 'User',
      site_admin: false,
      name: login === forge.viewer() ? 'ada iversen' : login,
      email: `${login}@example.invalid`,
      html_url: `https://forge.local/${login}`,
      avatar_url: `https://forge.local/avatars/${login}`,
    };
    userCache.set(login, hit);
  }
  return hit;
}

function repoObject(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const owner = forge.viewer();
  return {
    id: repo.idNum,
    node_id: `R_${repo.idNum}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(forge, owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.timeIso,
    updated_at: repo.timeIso,
    pushed_at: repo.timeIso,
    html_url: `https://forge.local/${owner}/${repo.name}`,
    clone_url: `https://forge.local/${owner}/${repo.name}.git`,
    git_url: `git://forge.local/${owner}/${repo.name}.git`,
    ssh_url: `git@forge.local:${owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    open_issues_count: repo.openIssues + repo.openPulls,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    language: null,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function repoBody(forge: Forge, repo: RepoRec): string {
  return memoBody(repo, `r${repo.stamp}`, () => JSON.stringify(repoObject(forge, repo)));
}

function labelObject(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: 1,
    node_id: `LA_${name}`,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: '',
  };
}

function issueObject(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: `I_${issue.globalId}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelObject(repo, name)),
    user: userJson(forge, forge.viewer()),
    assignees: [],
    comments: issue.comments.length,
    created_at: repo.timeIso,
    updated_at: repo.timeIso,
    closed_at: issue.state === 'closed' ? repo.timeIso : null,
    html_url: `https://forge.local/${forge.viewer()}/${repo.name}/issues/${issue.number}`,
  };
}

function issueBody(forge: Forge, repo: RepoRec, issue: IssueRec): string {
  return memoBody(issue, `i${issue.stamp}.${repo.stamp}`, () => JSON.stringify(issueObject(forge, repo, issue)));
}

function pullObject(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = forge.viewer();
  const { headSha, baseSha } = pullTips(repo, pull);
  const repoJson = repoObject(forge, repo);
  return {
    id: pull.globalId,
    node_id: `PR_${pull.globalId}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: userJson(forge, owner),
    labels: [],
    created_at: repo.timeIso,
    updated_at: repo.timeIso,
    closed_at: pull.state === 'closed' ? (pull.mergedSeq !== null ? seqIso(pull.mergedSeq) : repo.timeIso) : null,
    merged_at: pull.mergedSeq !== null ? seqIso(pull.mergedSeq) : null,
    merged: pull.merged,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: headSha ?? '', label: `${owner}:${pull.headRef}`, repo: repoJson },
    base: { ref: pull.baseRef, sha: baseSha ?? '', label: `${owner}:${pull.baseRef}`, repo: repoJson },
    html_url: `https://forge.local/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function pullBody(forge: Forge, repo: RepoRec, pull: PullRec): string {
  return memoBody(pull, `p${pull.stamp}.${repo.stamp}.${repo.refsStamp}`, () => JSON.stringify(pullObject(forge, repo, pull)));
}

const seqIsoCache = new Map<number, string>();
function seqIso(seq: number): string {
  let iso = seqIsoCache.get(seq);
  if (iso === undefined) {
    iso = new Date(seq * 1000).toISOString();
    if (seqIsoCache.size > 4096) seqIsoCache.clear();
    seqIsoCache.set(seq, iso);
  }
  return iso;
}

function commentObject(forge: Forge, repo: RepoRec, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(forge, comment.author),
    created_at: seqIso(comment.seq),
    updated_at: seqIso(comment.seq),
    html_url: `https://forge.local/${forge.viewer()}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

const commitBodyCache = new Map<string, string>();

function commitBody(forge: Forge, repo: RepoRec, sha: string): string | null {
  const key = `${forge.viewer()}:${sha}`;
  const hit = commitBodyCache.get(key);
  if (hit !== undefined) return hit;
  const head = forge.commitHead(repo, sha);
  if (head === null) return null;
  const owner = forge.viewer();
  const body = JSON.stringify({
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: head.message.replace(/\n$/, ''),
      author: { name: head.authorName, email: head.authorEmail, date: new Date(head.authorWhen * 1000).toISOString() },
      committer: { name: head.committerName, email: head.committerEmail, date: new Date(head.committerWhen * 1000).toISOString() },
      tree: { sha: head.tree, url: '' },
      comment_count: 0,
      url: '',
      verification: { verified: false, reason: 'unsigned' },
    },
    author: userJson(forge, owner),
    committer: userJson(forge, owner),
    parents: head.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: `https://forge.local/${owner}/${repo.name}/commit/${sha}`,
  });
  if (commitBodyCache.size > 50_000) commitBodyCache.clear();
  commitBodyCache.set(key, body);
  return body;
}

// --------------------------------------------------------------------------- REST helpers

function pageWindow(ctx: Ctx): { perPage: number; page: number } {
  const perRaw = Number(param(ctx, 'per_page') ?? '30');
  const pageRaw = Number(param(ctx, 'page') ?? '1');
  return {
    perPage: Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, Math.floor(perRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
  };
}

function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const { perPage, page } = pageWindow(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const query = new Map(queryOf(ctx));
    const link = (targetPage: number): string => {
      query.set('page', String(targetPage));
      query.set('per_page', String(perPage));
      const qs = [...query.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return `<http://${ctx.req.headers['host'] ?? 'forge.local'}${ctx.path}?${qs}>`;
    };
    ctx.res.setHeader('Link', `${link(page + 1)}; rel="next", ${link(totalPages)}; rel="last"`);
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

function requireRepo(ctx: Ctx, owner: string, name: string): RepoRec | null {
  ctx.forge.learnViewer(owner);
  const repo = ctx.forge.resolveRepo(owner, name);
  if (repo === null) sendError(ctx, 404, 'Not Found');
  return repo;
}

function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>)['name'] === 'string') {
      names.push((item as Record<string, unknown>)['name'] as string);
    }
  }
  return names;
}

// --------------------------------------------------------------------------- REST handlers

function handleRest(ctx: Ctx, segments: string[]): void {
  const { forge } = ctx;
  const method = ctx.req.method ?? 'GET';
  const [a, b, c, d, e] = segments;

  if (segments.length === 0) {
    if (method === 'GET') {
      ctx.res.setHeader('X-OAuth-Scopes', 'repo, read:org');
      return sendJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
      });
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (a === 'meta' && segments.length === 1) {
    if (method === 'GET') return sendJson(ctx, 200, { installed_version: VERSION, verifiable_password_authentication: true, github_services_sha: 'forge' });
    return sendError(ctx, 404, 'Not Found');
  }

  if (a === 'user' && segments.length === 1) {
    if (method === 'GET') return sendJson(ctx, 200, userJson(forge, forge.viewer()));
    return sendError(ctx, 404, 'Not Found');
  }

  if (a === 'user' && b === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = [...forge.repos.values()].sort((x, y) => x.idNum - y.idNum);
      return sendJson(ctx, 200, paginate(ctx, repos).map((repo) => repoObject(forge, repo)));
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const name = asStr(body['name']);
      if (name === '') return sendError(ctx, 422, 'Validation Failed: name is required');
      if (forge.repos.has(name)) return sendError(ctx, 422, 'Validation Failed: name already exists on this account');
      const repo = forge.createRepo(name, {
        isPrivate: asBool(body['private']),
        description: asStr(body['description']),
        defaultBranch: asStr(body['default_branch'], 'main') || 'main',
      });
      return sendJson(ctx, 201, repoBody(forge, repo));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (a !== 'repos' || b === undefined || c === undefined) return sendError(ctx, 404, 'Not Found');
  const owner = b;
  const name = c;

  if (segments.length === 3) {
    const repo = requireRepo(ctx, owner, name);
    if (repo === null) return;
    if (method === 'GET') return sendJson(ctx, 200, repoBody(forge, repo));
    if (method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      if (typeof body['description'] === 'string') repo.description = body['description'];
      if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'];
      if (typeof body['default_branch'] === 'string' && body['default_branch'] !== '') repo.defaultBranch = body['default_branch'];
      repo.stamp += 1;
      return sendJson(ctx, 200, repoBody(forge, repo));
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      return sendNoContent(ctx);
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const repo = requireRepo(ctx, owner, name);
  if (repo === null) return;

  // --- git refs over REST
  if (d === 'git' && e === 'refs' && segments.length === 5) {
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const ref = asStr(body['ref']);
      const sha = asStr(body['sha']);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return sendError(ctx, 422, 'Validation Failed: invalid ref or sha');
      forge.setRef(repo, ref, sha);
      return sendJson(ctx, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: repo.objects.get(sha)!.type, url: '' } });
    }
    if (method === 'GET') {
      const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
      return sendJson(ctx, 200, refs);
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (d === 'git' && e === 'refs' && segments.length >= 6) {
    const full = `refs/${segments.slice(5).join('/')}`;
    if (method === 'GET') {
      const sha = repo.refs.get(full);
      if (sha === undefined) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, { ref: full, node_id: `REF_${full}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // --- branches
  if (d === 'branches' && segments.length === 4) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
      .sort((x, y) => x.name.localeCompare(y.name));
    return sendJson(ctx, 200, branches);
  }
  if (d === 'branches' && segments.length === 5) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    const branch = decodeURIComponent(e ?? '');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return sendError(ctx, 404, 'Not Found');
    const body = commitBody(forge, repo, sha);
    return sendJson(ctx, 200, `{"name":${JSON.stringify(branch)},"commit":${body ?? JSON.stringify({ sha })},"protected":false,"_links":{}}`);
  }

  // --- commits
  if (d === 'commits' && segments.length === 4) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    const shaParam = param(ctx, 'sha');
    let tip: string | undefined;
    if (shaParam !== null && shaParam !== '') {
      tip = repo.objects.has(shaParam) ? shaParam : repo.refs.get(`refs/heads/${shaParam}`);
      if (tip === undefined) return sendError(ctx, 404, 'Not Found');
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return sendJson(ctx, 200, []);
    }
    const bodies = reachableCommits(forge, repo, tip)
      .map((sha) => commitBody(forge, repo, sha))
      .filter((entry) => entry !== null);
    return sendJson(ctx, 200, `[${paginate(ctx, bodies).join(',')}]`);
  }
  if (d === 'commits' && segments.length === 5) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    const body = commitBody(forge, repo, e ?? '');
    if (body === null) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, body);
  }

  // --- contents
  if (d === 'contents') {
    const path = segments.slice(4).map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(ctx, repo, path);
  }

  // --- labels
  if (d === 'labels' && segments.length === 4) {
    if (method === 'GET') {
      const labels = [...repo.labels.keys()].sort().map((labelName) => labelObject(repo, labelName));
      return sendJson(ctx, 200, labels);
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      const labelName = asStr(body['name']);
      if (labelName === '') return sendError(ctx, 422, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) return sendError(ctx, 422, 'Validation Failed: label already exists');
      repo.labels.set(labelName, {
        name: labelName,
        color: asStr(body['color'], 'ededed').replace(/^#/, ''),
        description: asStr(body['description']),
      });
      repo.stamp += 1;
      return sendJson(ctx, 201, labelObject(repo, labelName));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (d === 'labels' && segments.length === 5) {
    const labelName = decodeURIComponent(e ?? '');
    if (!repo.labels.has(labelName)) return sendError(ctx, 404, 'Not Found');
    if (method === 'GET') return sendJson(ctx, 200, labelObject(repo, labelName));
    if (method === 'DELETE') {
      repo.labels.delete(labelName);
      repo.stamp += 1;
      return sendNoContent(ctx);
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // --- issues and comments
  if (d === 'issues' && segments.length === 4) {
    if (method === 'GET') {
      const state = (param(ctx, 'state') ?? 'open').toLowerCase();
      const direction = (param(ctx, 'direction') ?? 'desc').toLowerCase();
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((x, y) => x.seq - y.seq || x.number - y.number);
      if (direction !== 'asc') list.reverse();
      return sendJson(ctx, 200, `[${paginate(ctx, list).map((issue) => issueBody(forge, repo, issue)).join(',')}]`);
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      try {
        const issue = createIssue(forge, repo, { title: asStr(body['title']), body: asStr(body['body']), labels: labelNamesOf(body['labels']) });
        return sendJson(ctx, 201, issueBody(forge, repo, issue));
      } catch (err) {
        if (err instanceof DomainError) return sendError(ctx, err.status, err.message);
        throw err;
      }
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (d === 'issues' && segments.length >= 5) {
    const number = Number(e);
    const entry = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (segments.length === 5) {
      if (entry === undefined) return sendError(ctx, 404, 'Not Found');
      if (method === 'GET') return sendJson(ctx, 200, issueBody(forge, repo, entry));
      if (method === 'PATCH') {
        const body = parseBody(ctx);
        if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
        if (typeof body['title'] === 'string') entry.title = body['title'];
        if (typeof body['body'] === 'string') entry.body = body['body'];
        if (body['state'] === 'closed' || body['state'] === 'open') setIssueState(repo, entry, body['state']);
        if (body['labels'] !== undefined) {
          const labels = labelNamesOf(body['labels']);
          for (const label of labels) if (!repo.labels.has(label)) return sendError(ctx, 422, `Validation Failed: label "${label}" does not exist`);
          entry.labels = labels;
        }
        entry.stamp += 1;
        return sendJson(ctx, 200, issueBody(forge, repo, entry));
      }
      return sendError(ctx, 404, 'Not Found');
    }
    if (segments.length === 6 && segments[5] === 'comments') {
      if (entry === undefined) return sendError(ctx, 404, 'Not Found');
      if (method === 'GET') {
        const comments = [...entry.comments].sort((x, y) => x.id - y.id).map((comment) => commentObject(forge, repo, entry.number, comment));
        return sendJson(ctx, 200, paginate(ctx, comments));
      }
      if (method === 'POST') {
        const body = parseBody(ctx);
        if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
        const comment = addComment(forge, entry, asStr(body['body']));
        return sendJson(ctx, 201, commentObject(forge, repo, entry.number, comment));
      }
      return sendError(ctx, 404, 'Not Found');
    }
    return sendError(ctx, 404, 'Not Found');
  }

  // --- pulls
  if (d === 'pulls' && segments.length === 4) {
    if (method === 'GET') {
      const state = (param(ctx, 'state') ?? 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((x, y) => y.seq - x.seq || y.number - x.number);
      return sendJson(ctx, 200, `[${paginate(ctx, list).map((pull) => pullBody(forge, repo, pull)).join(',')}]`);
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
      try {
        const pull = createPull(forge, repo, {
          title: asStr(body['title']),
          body: asStr(body['body']),
          head: asStr(body['head']),
          base: asStr(body['base'], repo.defaultBranch) || repo.defaultBranch,
        });
        return sendJson(ctx, 201, pullBody(forge, repo, pull));
      } catch (err) {
        if (err instanceof DomainError) return sendError(ctx, err.status, err.message);
        throw err;
      }
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (d === 'pulls' && segments.length >= 5) {
    const number = Number(e);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (segments.length === 5) {
      if (pull === undefined) return sendError(ctx, 404, 'Not Found');
      if (method === 'GET') return sendJson(ctx, 200, pullBody(forge, repo, pull));
      if (method === 'PATCH') {
        const body = parseBody(ctx);
        if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
        if (typeof body['title'] === 'string') pull.title = body['title'];
        if (typeof body['body'] === 'string') pull.body = body['body'];
        if (body['state'] === 'closed' || body['state'] === 'open') setPullState(repo, pull, body['state']);
        pull.stamp += 1;
        return sendJson(ctx, 200, pullBody(forge, repo, pull));
      }
      return sendError(ctx, 404, 'Not Found');
    }
    if (segments.length === 6 && segments[5] === 'files') {
      if (pull === undefined) return sendError(ctx, 404, 'Not Found');
      if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
      const files = pullFiles(forge, repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: '',
      }));
      return sendJson(ctx, 200, paginate(ctx, files));
    }
    if (segments.length === 6 && segments[5] === 'merge') {
      if (pull === undefined) return sendError(ctx, 404, 'Not Found');
      if (method === 'GET') {
        if (pull.merged) return sendNoContent(ctx);
        return sendError(ctx, 404, 'Not Found');
      }
      if (method === 'PUT') {
        const body = parseBody(ctx);
        if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
        if (pull.merged) return sendError(ctx, 405, 'Pull Request is not mergeable');
        const outcome = mergePull(forge, repo, pull, asStr(body['merge_method'], 'merge'));
        if (!outcome.ok) return sendError(ctx, 405, 'Pull Request is not mergeable');
        return sendJson(ctx, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
      }
      return sendError(ctx, 404, 'Not Found');
    }
    return sendError(ctx, 404, 'Not Found');
  }

  return sendError(ctx, 404, 'Not Found');
}

// --------------------------------------------------------------------------- contents

function handleContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const { forge } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (method === 'GET') {
    const refParam = param(ctx, 'ref');
    let tip: string | undefined;
    if (refParam !== null && refParam !== '') {
      tip = repo.objects.has(refParam) ? refParam : repo.refs.get(`refs/heads/${refParam}`);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined) return sendError(ctx, 404, 'Not Found');
    const flat = forge.filesAtCommit(repo, tip);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean !== '') {
      const file = flat.get(clean);
      if (file !== undefined) {
        const data = repo.objects.get(file.oid)?.data ?? EMPTY;
        return sendJson(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          sha: file.oid,
          size: data.length,
          name: clean.split('/').pop(),
          path: clean,
          url: '',
          html_url: '',
          download_url: null,
          _links: {},
        });
      }
    }
    const prefix = clean === '' ? '' : `${clean}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [filePath, file] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.set(rest, { type: 'file', sha: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!entries.has(dir)) entries.set(dir, { type: 'dir', sha: '', size: 0 });
      }
    }
    if (clean !== '' && entries.size === 0) return sendError(ctx, 404, 'Not Found');
    const listing = [...entries.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([entryName, entry]) => ({
        type: entry.type,
        sha: entry.sha,
        size: entry.size,
        name: entryName,
        path: prefix + entryName,
        url: '',
        html_url: '',
        download_url: null,
        _links: {},
      }));
    return sendJson(ctx, 200, listing);
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = parseBody(ctx);
    if (body === null) return sendError(ctx, 400, 'Problems parsing JSON');
    const clean = path.replace(/^\/+/, '');
    if (clean === '') return sendError(ctx, 422, 'Validation Failed: path is required');
    const branch = asStr(body['branch'], repo.defaultBranch) || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    // filesAtCommit hands back a shared cached map: copy before mutating it.
    const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : new Map(forge.filesAtCommit(repo, tip));
    const existing = files.get(clean);
    const login = forge.viewer();
    const message = asStr(body['message'], method === 'DELETE' ? `Delete ${clean}` : `Update ${clean}`);

    if (method === 'DELETE') {
      if (existing === undefined) return sendError(ctx, 404, 'Not Found');
      files.delete(clean);
      const tree = storeTreeFromFiles(repo, files);
      const sha = forgeCommit(forge, repo, {
        tree,
        parents: tip === undefined ? [] : [tip],
        authorName: login,
        authorEmail: `${login}@users.noreply.forge`,
        message,
        ts: forge.tick(),
      });
      forge.setRef(repo, refName, sha);
      return sendJson(ctx, 200, {
        content: null,
        commit: { sha, message, author: { name: login, email: `${login}@users.noreply.forge` }, committer: { name: login, email: `${login}@users.noreply.forge` }, tree: { sha: tree }, parents: tip === undefined ? [] : [{ sha: tip }] },
      });
    }

    const bytes = Buffer.from(asStr(body['content']), 'base64');
    const blobOid = oidOf('blob', bytes);
    const suppliedSha = typeof body['sha'] === 'string' ? body['sha'] : undefined;
    if (existing !== undefined) {
      if (suppliedSha === undefined) return sendError(ctx, 422, 'Validation Failed: sha must be supplied when updating a file');
      if (suppliedSha !== existing.oid) return sendError(ctx, 409, 'Conflict: the supplied sha does not match the current file');
    }
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: bytes });
    files.set(clean, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const tree = storeTreeFromFiles(repo, files);
    const sha = forgeCommit(forge, repo, {
      tree,
      parents: tip === undefined ? [] : [tip],
      authorName: login,
      authorEmail: `${login}@users.noreply.forge`,
      message,
      ts: forge.tick(),
    });
    forge.setRef(repo, refName, sha);
    return sendJson(ctx, existing === undefined ? 201 : 200, {
      content: {
        name: clean.split('/').pop(),
        path: clean,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: '',
        html_url: '',
        download_url: null,
        _links: {},
      },
      commit: { sha, message, author: { name: login, email: `${login}@users.noreply.forge` }, committer: { name: login, email: `${login}@users.noreply.forge` }, tree: { sha: tree }, parents: tip === undefined ? [] : [{ sha: tip }] },
    });
  }

  return sendError(ctx, 404, 'Not Found');
}

// --------------------------------------------------------------------------- server

function authorized(ctx: Ctx): boolean {
  const expected = process.env['MAKEFUN_SHOP_TOKEN'];
  const header = ctx.req.headers['authorization'];
  if (typeof header !== 'string') return false;
  if (expected !== undefined && expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const ID_SALT = randomUUID().replace(/-/g, '').slice(0, 8);
let idCounter = 0;

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    idCounter += 1;
    const requestId = `${ID_SALT}${idCounter.toString(16)}`;
    const dispatch = (body: Buffer): void => {
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const ctx: Ctx = {
        forge,
        req,
        res,
        path: q < 0 ? raw : raw.slice(0, q),
        rawQuery: q < 0 ? '' : raw.slice(q + 1),
        query: null,
        body,
        requestId,
      };
      try {
        route(ctx);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': requestId });
        }
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }));
      }
    };
    // A GET carries no body the forge reads: never touch the stream for one.
    if (req.method === 'GET' || req.method === 'HEAD') {
      dispatch(EMPTY);
      return;
    }
    readBody(req).then(dispatch, () => {
      res.writeHead(413, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId });
      res.end(JSON.stringify({ message: 'Request body too large' }));
    });
  });
  return server;
}

function route(ctx: Ctx): void {
  const { req, res, path } = ctx;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}');
    return;
  }

  if (!authorized(ctx)) return sendError(ctx, 401, 'Unauthorized');

  if (path === '/api/graphql') {
    if (method !== 'POST') return sendError(ctx, 404, 'Not Found');
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': ctx.requestId });
      res.end(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }));
      return;
    }
    const runOne = (entry: unknown): unknown => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return executeGraphQL(
        ctx.forge,
        typeof record['query'] === 'string' ? record['query'] : '',
        (record['variables'] as Record<string, unknown> | undefined) ?? {},
        typeof record['operationName'] === 'string' ? record['operationName'] : undefined,
      );
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': ctx.requestId });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(runOne) : runOne(parsed)));
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') return sendError(ctx, 404, 'Not Found');
    const outcome = handleMcp(ctx.forge, ctx.body.toString('utf8'));
    res.writeHead(outcome.status, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': ctx.requestId });
    res.end(outcome.body);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    ctx.res.setHeader('X-OAuth-Scopes', 'repo, read:org');
    return handleRest(ctx, []);
  }
  if (path.startsWith('/api/v3/')) {
    const segments = path.slice('/api/v3/'.length).split('/');
    return handleRest(ctx, segments);
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (path.startsWith('/')) {
    const firstSlash = path.indexOf('/', 1);
    if (firstSlash > 1) {
      const rest = path.slice(firstSlash + 1);
      // The advertisement tail is two segments (info/refs); the pack tails are one.
      let tail = '';
      let repoPart = '';
      if (rest.endsWith('/info/refs')) {
        tail = 'info/refs';
        repoPart = rest.slice(0, -'/info/refs'.length);
      } else {
        const lastSlash = rest.lastIndexOf('/');
        if (lastSlash > 0) {
          tail = rest.slice(lastSlash + 1);
          repoPart = rest.slice(0, lastSlash);
        }
      }
      if (tail !== '') {
        if ((tail === 'info/refs' || tail === 'git-upload-pack' || tail === 'git-receive-pack') && repoPart.endsWith('.git')) {
          const owner = decodeURIComponent(path.slice(1, firstSlash));
          const repoName = decodeURIComponent(repoPart.slice(0, -'.git'.length));
          const protocolHeader = req.headers['git-protocol'];
          const v2 = typeof protocolHeader === 'string' && /(^|,)version=2/.test(protocolHeader);
          if (tail === 'info/refs') {
            const reply = infoRefs(ctx.forge, owner, repoName, param(ctx, 'service') ?? '', v2);
            res.writeHead(reply.status, { 'Content-Type': reply.contentType, 'X-GitHub-Request-Id': ctx.requestId });
            res.end(reply.body);
            return;
          }
          if (tail === 'git-upload-pack') {
            const reply = uploadPack(ctx.forge, owner, repoName, ctx.body, v2);
            res.writeHead(reply.status, { 'Content-Type': reply.contentType, 'X-GitHub-Request-Id': ctx.requestId });
            res.end(reply.body);
            return;
          }
          const reply = receivePack(ctx.forge, owner, repoName, ctx.body);
          res.writeHead(reply.status, { 'Content-Type': reply.contentType, 'X-GitHub-Request-Id': ctx.requestId });
          res.end(reply.body);
          return;
        }
      }
    }
  }

  return sendError(ctx, 404, 'Not Found');
}
