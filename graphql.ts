// A small GraphQL engine for the forge's fixed schema: the query/mutation documents
// gh-style clients send, relay-style connections, global ids, and __type/__schema
// introspection. It is a lexer, a recursive-descent parser and a resolver walk over
// the shared store — no schema library, no codegen.
//
// Behaviour the clients rely on:
//   - an unknown field is a 200 with an errors entry naming it, and null data there;
//   - an unknown repository is data.repository = null with no errors;
//   - repository.issues honours states filters and CREATED_AT ordering (ties by
//     number, same direction);
//   - global ids are opaque base64 that this same file decodes for node(id) and the
//     mutations, so an id minted by a query is spent by a mutation unchanged.

import { DomainError, addComment, createIssue, createPull, mergePull, pullConflict, pullFiles, setIssueState } from './domain.ts';
import type { CommentRec, Forge, IssueRec, PullRec, RepoRec } from './store.ts';

// --------------------------------------------------------------------------- global ids

export function mintId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function splitId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

const repoGid = (repo: RepoRec): string => mintId('Repository', repo.idNum);
const issueGid = (repo: RepoRec, issue: IssueRec): string => mintId('Issue', repo.idNum, issue.number);
const pullGid = (repo: RepoRec, pull: PullRec): string => mintId('PullRequest', repo.idNum, pull.number);
const commentGid = (repo: RepoRec, parent: IssueRec | PullRec, comment: CommentRec): string =>
  mintId('IssueComment', repo.idNum, parent.number, comment.id);

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

// --------------------------------------------------------------------------- lexer

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
interface Tok {
  kind: TokKind;
  text: string;
}

function lex(source: string): Tok[] {
  const toks: Tok[] = [];
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      toks.push({ kind: 'spread', text: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      toks.push({ kind: 'punct', text: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        toks.push({ kind: 'string', text: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u') {
            text += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
            j += 2;
          }
        } else {
          text += source[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const raw = source.slice(i, j);
      toks.push({ kind: /[.eE]/.test(raw) ? 'float' : 'int', text: raw });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      toks.push({ kind: 'name', text: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  toks.push({ kind: 'eof', text: '' });
  return toks;
}

// --------------------------------------------------------------------------- parser

type Value =
  | { t: 'var'; name: string }
  | { t: 'str'; value: string }
  | { t: 'num'; value: number }
  | { t: 'bool'; value: boolean }
  | { t: 'nil' }
  | { t: 'enum'; value: string }
  | { t: 'list'; items: Value[] }
  | { t: 'obj'; fields: Array<{ name: string; value: Value }> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  children: Sel[] | null;
}
type Sel =
  | FieldSel
  | { kind: 'inline'; on: string | null; children: Sel[] }
  | { kind: 'spread'; name: string };

interface Operation {
  op: 'query' | 'mutation';
  name: string | null;
  children: Sel[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos]!;
  }
  private take(): Tok {
    return this.toks[this.pos++]!;
  }
  private want(text: string): void {
    const tok = this.take();
    if (tok.text !== text) throw new Error(`expected ${text}, found ${tok.text}`);
  }
  private eat(text: string): boolean {
    if (this.peek().text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  document(): { operations: Operation[]; fragments: Map<string, Sel[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Sel[]>();
    while (this.peek().kind !== 'eof') {
      const head = this.peek();
      if (head.text === '{') {
        operations.push({ op: 'query', name: null, children: this.selectionSet() });
      } else if (head.text === 'query' || head.text === 'mutation' || head.text === 'subscription') {
        this.take();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.take().text;
        this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ op: head.text === 'mutation' ? 'mutation' : 'query', name, children: this.selectionSet() });
      } else if (head.text === 'fragment') {
        this.take();
        const fragName = this.take().text;
        this.want('on');
        this.take();
        this.skipDirectives();
        fragments.set(fragName, this.selectionSet());
      } else {
        throw new Error(`unexpected token ${head.text}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    if (this.peek().text !== '(') return;
    let depth = 0;
    do {
      const tok = this.take();
      if (tok.text === '(' || tok.text === '[' || tok.text === '{') depth += 1;
      else if (tok.text === ')' || tok.text === ']' || tok.text === '}') depth -= 1;
    } while (depth > 0 && this.peek().kind !== 'eof');
  }

  private skipDirectives(): void {
    while (this.peek().text === '@') {
      this.take();
      this.take();
      this.skipBalancedParens();
    }
  }

  private selectionSet(): Sel[] {
    this.want('{');
    const sels: Sel[] = [];
    while (this.peek().text !== '}') {
      const tok = this.peek();
      if (tok.kind === 'spread') {
        this.take();
        if (this.peek().text === 'on') {
          this.take();
          const on = this.take().text;
          this.skipDirectives();
          sels.push({ kind: 'inline', on, children: this.selectionSet() });
        } else {
          const name = this.take().text;
          this.skipDirectives();
          sels.push({ kind: 'spread', name });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.take().text;
      if (this.peek().text === ':') {
        this.take();
        alias = name;
        name = this.take().text;
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.peek().text === '(') {
        this.take();
        while (this.peek().text !== ')') {
          const argName = this.take().text;
          this.want(':');
          args.push({ name: argName, value: this.value() });
        }
        this.want(')');
      }
      this.skipDirectives();
      const children = this.peek().text === '{' ? this.selectionSet() : null;
      sels.push({ kind: 'field', alias, name, args, children });
    }
    this.want('}');
    return sels;
  }

  private value(): Value {
    const tok = this.take();
    if (tok.text === '$') return { t: 'var', name: this.take().text };
    if (tok.kind === 'string') return { t: 'str', value: tok.text };
    if (tok.kind === 'int') return { t: 'num', value: parseInt(tok.text, 10) };
    if (tok.kind === 'float') return { t: 'num', value: parseFloat(tok.text) };
    if (tok.text === '[') {
      const items: Value[] = [];
      while (this.peek().text !== ']') items.push(this.value());
      this.want(']');
      return { t: 'list', items };
    }
    if (tok.text === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek().text !== '}') {
        const name = this.take().text;
        this.want(':');
        fields.push({ name, value: this.value() });
      }
      this.want('}');
      return { t: 'obj', fields };
    }
    if (tok.text === 'true') return { t: 'bool', value: true };
    if (tok.text === 'false') return { t: 'bool', value: false };
    if (tok.text === 'null') return { t: 'nil' };
    return { t: 'enum', value: tok.text };
  }
}

function resolveValue(node: Value, variables: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'var':
      return variables[node.name] ?? null;
    case 'str':
    case 'num':
    case 'bool':
    case 'enum':
      return node.value;
    case 'nil':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema tables

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', '__typename'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'isArchived', 'isFork', 'forkCount',
    'stargazerCount', 'primaryLanguage', 'licenseInfo', 'ref', 'object', 'labels', 'mentionableUsers', '__typename',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', '__typename'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'tree', '__typename'],
  GitActor: ['name', 'email', 'date', 'user', '__typename'],
  Issue: [
    'id', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'author', 'repository', 'labels',
    'comments', 'createdAt', 'updatedAt', 'url', 'assignees', 'milestone', 'viewerCanUpdate', '__typename',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'files', 'author', 'repository',
    'comments', 'createdAt', 'updatedAt', 'url', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
    'isDraft', 'labels', 'viewerCanUpdate', '__typename',
  ],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  IssueComment: ['id', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL', '__typename'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives', '__typename'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileViewedState: ['VIEWED', 'UNVIEWED', 'DISMISSED'],
};

const KINDS: Record<string, string> = {
  String: 'SCALAR', Int: 'SCALAR', Float: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR', URI: 'SCALAR', DateTime: 'SCALAR', GitObjectID: 'SCALAR',
  SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM', RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM', OrderDirection: 'ENUM', PullRequestMergeMethod: 'ENUM', FileViewedState: 'ENUM', State: 'ENUM',
};

// --------------------------------------------------------------------------- execution

type Node2 = { __type: string; [key: string]: unknown };
const node = (type: string, fields: Record<string, unknown>): Node2 => ({ __type: type, ...fields });

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Sel[]>;
  errors: Array<{ message: string }>;
}

const userNode = (forge: Forge, login: string): Node2 => node('User', { login, displayName: login === forge.viewer() ? 'ada iversen' : login });
const repoNode = (repo: RepoRec): Node2 => node('Repository', { repo });
const issueNode = (repo: RepoRec, issue: IssueRec): Node2 => node('Issue', { repo, issue });
const pullNode = (repo: RepoRec, pull: PullRec): Node2 => node('PullRequest', { repo, pull });
const commentNode = (repo: RepoRec, parent: IssueRec | PullRec, comment: CommentRec): Node2 => node('IssueComment', { repo, parent, comment });

function repoByGid(forge: Forge, gid: string): RepoRec | null {
  const parts = splitId(gid);
  if (parts[0] !== 'Repository') return null;
  const id = Number(parts[1]);
  for (const repo of forge.repos.values()) if (repo.idNum === id) return repo;
  return null;
}

type Located = { repo: RepoRec; rec: IssueRec; isPull: false } | { repo: RepoRec; rec: PullRec; isPull: true };

function locateByGid(forge: Forge, gid: string): Located | null {
  const parts = splitId(gid);
  if ((parts[0] !== 'Issue' && parts[0] !== 'PullRequest') || parts.length < 3) return null;
  const repoId = Number(parts[1]);
  const number = Number(parts[2]);
  for (const repo of forge.repos.values()) {
    if (repo.idNum !== repoId) continue;
    if (parts[0] === 'Issue') {
      const issue = repo.issues.get(number);
      if (issue !== undefined) return { repo, rec: issue, isPull: false };
    } else {
      const pull = repo.pulls.get(number);
      if (pull !== undefined) return { repo, rec: pull, isPull: true };
    }
  }
  return null;
}

const cursorFor = (num: number): string => Buffer.from(`cursor:${num}`, 'utf8').toString('base64');

function pageSlice<T extends { number: number }>(list: T[], args: Record<string, unknown>): { items: T[]; remaining: number } {
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : list.length;
  const after = typeof args['after'] === 'string' ? (args['after'] as string) : null;
  let start = 0;
  if (after !== null) {
    const num = Number(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', ''));
    const index = list.findIndex((item) => item.number === num);
    if (index >= 0) start = index + 1;
  }
  return { items: list.slice(start, start + Math.max(0, first)), remaining: list.length - start };
}

function connection<T extends { number: number }>(
  type: string,
  edgeType: string,
  list: T[],
  args: Record<string, unknown>,
  wrapItem: (item: T) => Node2,
): Node2 {
  const { items, remaining } = pageSlice(list, args);
  return node(type, {
    nodes: items.map(wrapItem),
    edges: items.map((item) => node(edgeType, { node: wrapItem(item), cursor: cursorFor(item.number) })),
    pageInfo: node('PageInfo', {
      hasNextPage: items.length < remaining,
      hasPreviousPage: false,
      startCursor: items.length > 0 ? cursorFor(items[0]!.number) : null,
      endCursor: items.length > 0 ? cursorFor(items[items.length - 1]!.number) : null,
    }),
    totalCount: list.length,
  });
}

function stateFilter<T extends { state: string }>(list: T[], args: Record<string, unknown>, display: (item: T) => string): T[] {
  const states = args['states'];
  if (!Array.isArray(states) || states.length === 0) return list;
  const wanted = new Set(states.map((value) => String(value).toUpperCase()));
  return list.filter((item) => wanted.has(display(item)));
}

function issuesConn(repo: RepoRec, args: Record<string, unknown>): Node2 {
  let list = stateFilter([...repo.issues.values()], args, (issue) => issue.state.toUpperCase());
  const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? {};
  const direction = String(orderBy['direction'] ?? 'DESC').toUpperCase();
  list.sort((a, b) => a.seq - b.seq || a.number - b.number);
  if (direction !== 'ASC') list.reverse();
  return connection('IssueConnection', 'IssueEdge', list, args, (issue) => issueNode(repo, issue));
}

function pullDisplay(pull: PullRec): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

function pullsConn(repo: RepoRec, args: Record<string, unknown>): Node2 {
  const list = stateFilter([...repo.pulls.values()], args, pullDisplay);
  list.sort((a, b) => b.seq - a.seq || b.number - a.number);
  return connection('PullRequestConnection', 'PullRequestEdge', list, args, (pull) => pullNode(repo, pull));
}

function typeNode(name: string): Node2 {
  return node('__Type', {
    name,
    kind: KINDS[name] ?? 'OBJECT',
    fields: (FIELDS[name] ?? []).filter((field) => field !== '__typename').map((field) => node('__Field', { name: field })),
    enumValues: (ENUMS[name] ?? []).map((value) => node('__EnumValue', { name: value })),
  });
}

function nodeByGlobalId(forge: Forge, id: string): Node2 | null {
  const parts = splitId(id);
  if (parts[0] === 'Repository') {
    const repo = repoByGid(forge, id);
    return repo === null ? null : repoNode(repo);
  }
  if (parts[0] === 'Issue' || parts[0] === 'PullRequest') {
    const found = locateByGid(forge, id);
    if (found === null) return null;
    return found.isPull ? pullNode(found.repo, found.rec as PullRec) : issueNode(found.repo, found.rec as IssueRec);
  }
  if (parts[0] === 'User') return userNode(forge, parts[1] ?? forge.viewer());
  return null;
}

// --------------------------------------------------------------------------- resolvers

function resolve(ctx: Ctx, source: Node2, field: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const type = source.__type;
  if (field === '__typename') return type;
  if (type.endsWith('Payload') && field === 'clientMutationId') return source['clientMutationId'] ?? null;

  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userNode(forge, forge.viewer());
      if (field === 'repository') {
        forge.learnViewer(String(args['owner'] ?? ''));
        const repo = forge.resolveRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return repo === null ? null : repoNode(repo);
      }
      if (field === 'node') return nodeByGlobalId(forge, String(args['id'] ?? ''));
      if (field === '__type') return typeNode(String(args['name'] ?? ''));
      if (field === '__schema') return node('__Schema', {});
      return undefined;
    }
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'User': {
      const login = source['login'] as string;
      switch (field) {
        case 'id': return mintId('User', login);
        case 'login': return login;
        case 'name': return source['displayName'];
        case 'email': return `${login}@example.invalid`;
        case 'isViewer': return login === forge.viewer();
        case 'url': return `https://forge.local/${login}`;
        case 'avatarUrl': return `https://forge.local/avatars/${login}`;
        default: return undefined;
      }
    }
    case 'Repository': {
      const repo = source['repo'] as RepoRec;
      switch (field) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.idNum;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${forge.viewer()}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return userNode(forge, forge.viewer());
        case 'defaultBranchRef': {
          const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return node('Ref', { name: repo.defaultBranch, target: oid === undefined ? null : node('Commit', { oid }) });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasWikiEnabled': return true;
        case 'hasProjectsEnabled': return true;
        case 'isArchived': return false;
        case 'isFork': return false;
        case 'forkCount': return 0;
        case 'stargazerCount': return 0;
        case 'createdAt': return repo.timeIso;
        case 'updatedAt': return repo.timeIso;
        case 'url': return `https://forge.local/${forge.viewer()}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args['number']));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues': return issuesConn(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args['number']));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        case 'pullRequests': return pullsConn(repo, args);
        case 'ref': {
          const name = String(args['qualifiedName'] ?? '').replace('refs/heads/', '');
          const oid = repo.refs.get(`refs/heads/${name}`);
          return oid === undefined ? null : node('Ref', { name, target: node('Commit', { oid }) });
        }
        default: return undefined;
      }
    }
    case 'Ref': {
      if (field === 'name') return source['name'];
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return source['target'];
      if (field === 'id') return mintId('Ref', String(source['name']));
      return undefined;
    }
    case 'Commit': {
      if (field === 'oid' || field === 'id') return source['oid'];
      return undefined;
    }
    case 'Issue': {
      const repo = source['repo'] as RepoRec;
      const issue = source['issue'] as IssueRec;
      switch (field) {
        case 'id': return issueGid(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'author': return userNode(forge, forge.viewer());
        case 'repository': return repoNode(repo);
        case 'labels':
          return node('LabelConnection', {
            nodes: issue.labels.map((name) => node('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })),
            totalCount: issue.labels.length,
          });
        case 'comments': {
          const first = typeof args['first'] === 'number' ? (args['first'] as number) : issue.comments.length;
          return node('IssueCommentConnection', {
            nodes: issue.comments.slice(0, first).map((comment) => commentNode(repo, issue, comment)),
            totalCount: issue.comments.length,
          });
        }
        case 'createdAt': return repo.timeIso;
        case 'updatedAt': return repo.timeIso;
        case 'url': return `https://forge.local/${forge.viewer()}/${repo.name}/issues/${issue.number}`;
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const repo = source['repo'] as RepoRec;
      const pull = source['pull'] as PullRec;
      switch (field) {
        case 'id': return pullGid(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'bodyText': return pull.body;
        case 'state': return pullDisplay(pull);
        case 'closed': return pull.state === 'closed';
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedSeq !== null ? seqIso(pull.mergedSeq) : null;
        case 'mergeable':
          return pull.merged || pull.state === 'closed' ? 'UNKNOWN' : pullConflict(forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': {
          const oid = repo.refs.get(`refs/heads/${pull.headRef}`);
          return oid === undefined ? null : node('Ref', { name: pull.headRef, target: node('Commit', { oid }) });
        }
        case 'baseRef': {
          const oid = repo.refs.get(`refs/heads/${pull.baseRef}`);
          return oid === undefined ? null : node('Ref', { name: pull.baseRef, target: node('Commit', { oid }) });
        }
        case 'files': {
          const files = pullFiles(forge, repo, pull);
          const first = typeof args['first'] === 'number' ? (args['first'] as number) : files.length;
          return node('PullRequestChangedFileConnection', {
            nodes: files.slice(0, first).map((file) =>
              node('ChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
            ),
            pageInfo: node('PageInfo', { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: files.length,
          });
        }
        case 'author': return userNode(forge, forge.viewer());
        case 'repository': return repoNode(repo);
        case 'comments': {
          const first = typeof args['first'] === 'number' ? (args['first'] as number) : pull.comments.length;
          return node('IssueCommentConnection', {
            nodes: pull.comments.slice(0, first).map((comment) => commentNode(repo, pull, comment)),
            totalCount: pull.comments.length,
          });
        }
        case 'labels': return node('LabelConnection', { nodes: [], totalCount: 0 });
        case 'mergeCommit': return pull.mergeSha === null ? null : node('Commit', { oid: pull.mergeSha });
        case 'additions': return pullFiles(forge, repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return pullFiles(forge, repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return pullFiles(forge, repo, pull).length;
        case 'isDraft': return false;
        case 'createdAt': return repo.timeIso;
        case 'updatedAt': return repo.timeIso;
        case 'url': return `https://forge.local/${forge.viewer()}/${repo.name}/pull/${pull.number}`;
        default: return undefined;
      }
    }
    case 'Label': {
      if (field === 'id') return mintId('Label', String(source['name']));
      if (field === 'name') return source['name'];
      if (field === 'color') return source['color'];
      return undefined;
    }
    case 'IssueComment': {
      const repo = source['repo'] as RepoRec;
      const parent = source['parent'] as IssueRec | PullRec;
      const comment = source['comment'] as CommentRec;
      switch (field) {
        case 'id': return commentGid(repo, parent, comment);
        case 'body': return comment.body;
        case 'bodyText': return comment.body;
        case 'author': return userNode(forge, comment.author);
        case 'createdAt': return seqIso(comment.seq);
        case 'updatedAt': return seqIso(comment.seq);
        default: return undefined;
      }
    }
    case 'PageInfo':
      return field in source ? source[field] : undefined;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
      return field === 'nodes' || field === 'edges' || field === 'pageInfo' || field === 'totalCount' ? source[field] : undefined;
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommentEdge':
      return field === 'node' || field === 'cursor' ? source[field] : undefined;
    case 'ChangedFile': {
      if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return source[field];
      if (field === 'viewerViewedState') return 'UNVIEWED';
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field === 'issue' ? source['issue'] : undefined;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field === 'pullRequest' ? source['pullRequest'] : undefined;
    case 'AddCommentPayload':
      return field === 'commentEdge' || field === 'subject' ? source[field] : undefined;
    case '__Type': {
      if (field === 'name' || field === 'kind' || field === 'fields' || field === 'enumValues') return source[field];
      if (field === 'description') return null;
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return source['name'];
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return typeNode('String');
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return source['name'];
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    default:
      return undefined;
  }
}

function resolveMutation(ctx: Ctx, field: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
  const clientMutationId = typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null;
  try {
    switch (field) {
      case 'createIssue': {
        const repo = repoByGid(forge, String(input['repositoryId'] ?? ''));
        if (repo === null) throw new DomainError(404, 'repository not found');
        const issue = createIssue(forge, repo, { title: String(input['title'] ?? ''), body: String(input['body'] ?? ''), labels: [] });
        return node('CreateIssuePayload', { issue: issueNode(repo, issue), clientMutationId });
      }
      case 'closeIssue': {
        const found = locateByGid(forge, String(input['issueId'] ?? ''));
        if (found === null || found.isPull) throw new DomainError(404, 'issue not found');
        const issue = found.rec as IssueRec;
        setIssueState(found.repo, issue, 'closed');
        return node('CloseIssuePayload', { issue: issueNode(found.repo, issue), clientMutationId });
      }
      case 'createPullRequest': {
        const repo = repoByGid(forge, String(input['repositoryId'] ?? ''));
        if (repo === null) throw new DomainError(404, 'repository not found');
        const pull = createPull(forge, repo, {
          title: String(input['title'] ?? ''),
          body: String(input['body'] ?? ''),
          head: String(input['headRefName'] ?? ''),
          base: String(input['baseRefName'] ?? ''),
        });
        return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull), clientMutationId });
      }
      case 'mergePullRequest': {
        const found = locateByGid(forge, String(input['pullRequestId'] ?? ''));
        if (found === null || !found.isPull) throw new DomainError(404, 'pull request not found');
        const pull = found.rec as PullRec;
        const outcome = mergePull(forge, found.repo, pull, String(input['mergeMethod'] ?? 'SQUASH'));
        if (!outcome.ok) throw new DomainError(405, 'merge conflict');
        return node('MergePullRequestPayload', { pullRequest: pullNode(found.repo, pull), clientMutationId });
      }
      case 'addComment': {
        const found = locateByGid(forge, String(input['subjectId'] ?? ''));
        if (found === null) throw new DomainError(404, 'subject not found');
        const comment = addComment(forge, found.rec, String(input['body'] ?? ''));
        return node('AddCommentPayload', {
          commentEdge: node('CommentEdge', { node: commentNode(found.repo, found.rec, comment), cursor: cursorFor(found.rec.number) }),
          subject: found.isPull ? pullNode(found.repo, found.rec as PullRec) : issueNode(found.repo, found.rec as IssueRec),
          clientMutationId,
        });
      }
      default:
        return undefined;
    }
  } catch (err) {
    if (err instanceof DomainError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

// --------------------------------------------------------------------------- completion

function complete(ctx: Ctx, value: unknown, children: Sel[] | null, parentType: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => complete(ctx, item, children, parentType));
  if (typeof value === 'object') {
    const wrapped = value as Node2;
    const type = typeof wrapped.__type === 'string' ? wrapped.__type : parentType;
    if (children === null) return wrapped;
    return runSelections(ctx, wrapped, type, children);
  }
  return value;
}

function runSelections(ctx: Ctx, source: Node2, type: string, sels: Sel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'inline') {
      if (sel.on === null || sel.on === type) Object.assign(out, runSelections(ctx, source, type, sel.children));
      continue;
    }
    if (sel.kind === 'spread') {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment !== undefined) Object.assign(out, runSelections(ctx, source, type, fragment));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const arg of sel.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    if (sel.name === '__type' && (type === 'Query' || type === 'Mutation')) {
      out[key] = complete(ctx, typeNode(String(args['name'] ?? '')), sel.children, '__Type');
      continue;
    }
    if (sel.name === '__schema' && type === 'Query') {
      out[key] = complete(ctx, node('__Schema', {}), sel.children, '__Schema');
      continue;
    }
    const known = FIELDS[type];
    if (known !== undefined && sel.name !== '__typename' && !known.includes(sel.name)) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolve(ctx, source, sel.name, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    out[key] = complete(ctx, value === undefined ? null : value, sel.children, type);
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL document against the forge. Document problems become errors, never throws. */
export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let doc: { operations: Operation[]; fragments: Map<string, Sel[]> };
  try {
    doc = new Parser(lex(query)).document();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'no operation found' }] };
  let operation = doc.operations[0]!;
  if (operationName !== undefined && operationName !== '') {
    const named = doc.operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  const ctx: Ctx = { forge, variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = runSelections(ctx, node(rootType, {}), rootType, operation.children);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
