// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over the streamable HTTP transport.
// It speaks the 2026-07-28 revision statelessly (server/discover) and the classic
// handshake revisions (initialize + notifications/initialized) alike. The six tools
// act on the same store as REST and GraphQL, so an object made here reads back
// there with its id unchanged.
//
// tools/list is a fixed document: it is serialised once, at module load, and the
// same bytes answer every call — the "two calls, byte for byte" rule holds by
// construction rather than by re-serialising equal objects.

import { DomainError, createIssue, createPull, mergePull } from './domain.ts';
import type { Forge, RepoRec } from './store.ts';

export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'forge-mcp', version: '2.0.0' };

interface ToolSpec {
  name: string;
  blurb: string;
  props: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'create_repo',
    blurb: 'Create a new repository for the authenticated user.',
    props: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    blurb: 'Get a repository by owner and name.',
    props: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    blurb: 'Create an issue in a repository.',
    props: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    blurb: 'List issues in a repository, optionally filtered by state.',
    props: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    blurb: 'Create a pull request from a head branch into a base branch.',
    props: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    blurb: 'Merge a pull request into its base branch (squash).',
    props: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

/** The tools/list result, built once: every call returns this very object. */
const TOOLS_RESULT = {
  tools: TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.blurb,
    inputSchema: { type: 'object', properties: spec.props, required: spec.required },
  })),
};

function repoCard(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.idNum,
    name: repo.name,
    full_name: `${forge.viewer()}/${repo.name}`,
    owner: { login: forge.viewer() },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** Tool arguments name a repo as {owner, repo} or as one full_name "owner/repo". */
function repoArgs(forge: Forge, args: Record<string, unknown>): { owner: string; name: string } {
  let owner = typeof args['owner'] === 'string' ? args['owner'] : '';
  let name = typeof args['repo'] === 'string' ? args['repo'] : '';
  const full = typeof args['full_name'] === 'string' ? args['full_name'] : '';
  if (full.includes('/')) {
    const cut = full.indexOf('/');
    if (owner === '') owner = full.slice(0, cut);
    if (name === '') name = full.slice(cut + 1);
  }
  if (owner !== '') forge.learnViewer(owner);
  return { owner, name };
}

function mustRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const { owner, name } = repoArgs(forge, args);
  const repo = forge.resolveRepo(owner, name);
  if (repo === null) throw new DomainError(404, `repository ${owner}/${name} not found`);
  return repo;
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args['name'] ?? '');
      if (repoName === '') throw new DomainError(422, 'name is required');
      if (forge.repos.has(repoName)) throw new DomainError(422, `repository "${repoName}" already exists`);
      const repo = forge.createRepo(repoName, {
        isPrivate: args['private'] === true,
        description: typeof args['description'] === 'string' ? args['description'] : '',
      });
      return repoCard(forge, repo);
    }
    case 'get_repo':
      return repoCard(forge, mustRepo(forge, args));
    case 'create_issue': {
      const repo = mustRepo(forge, args);
      const issue = createIssue(forge, repo, {
        title: String(args['title'] ?? ''),
        body: typeof args['body'] === 'string' ? args['body'] : '',
        labels: [],
      });
      return { id: issue.globalId, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
    }
    case 'list_issues': {
      const repo = mustRepo(forge, args);
      const state = typeof args['state'] === 'string' ? args['state'].toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({
          id: issue.globalId,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label })),
        }));
      return { issues, total_count: issues.length };
    }
    case 'create_pull_request': {
      const repo = mustRepo(forge, args);
      const pull = createPull(forge, repo, {
        title: String(args['title'] ?? ''),
        body: typeof args['body'] === 'string' ? args['body'] : '',
        head: String(args['head'] ?? ''),
        base: String(args['base'] ?? ''),
      });
      return {
        id: pull.globalId,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? '' },
        base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '' },
      };
    }
    case 'merge_pull_request': {
      const repo = mustRepo(forge, args);
      const pull = repo.pulls.get(Number(args['pull_number']));
      if (pull === undefined) throw new DomainError(404, `pull request #${String(args['pull_number'])} not found`);
      const outcome = mergePull(forge, repo, pull, 'squash');
      if (!outcome.ok) throw new DomainError(405, 'pull request is not mergeable');
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' };
    }
    default:
      return undefined;
  }
}

interface Outcome {
  status: number;
  payload?: unknown;
}

const ok = (id: unknown, result: unknown): Outcome => ({ status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } });
const fail = (id: unknown, code: number, message: string): Outcome => ({
  status: 200,
  payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
});

function handleMessage(forge: Forge, message: Record<string, unknown>): Outcome {
  const method = typeof message['method'] === 'string' ? message['method'] : '';
  const id = message['id'];
  const params = (message['params'] as Record<string, unknown> | undefined) ?? {};

  switch (method) {
    case 'server/discover':
      return ok(id, {
        supportedVersions: MCP_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER },
      });
    case 'initialize': {
      const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const revision = MCP_REVISIONS.includes(asked) ? asked : '2025-11-25';
      return ok(id, { protocolVersion: revision, capabilities: { tools: {} }, serverInfo: SERVER });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, TOOLS_RESULT);
    case 'tools/call': {
      const toolName = typeof params['name'] === 'string' ? params['name'] : '';
      const args = (params['arguments'] as Record<string, unknown> | undefined) ?? {};
      const spec = SPEC_BY_NAME.get(toolName);
      if (spec === undefined) return fail(id, -32602, `unknown tool ${toolName}`);
      for (const needed of spec.required) {
        if (args[needed] === undefined || args[needed] === null || args[needed] === '') {
          return fail(id, -32602, `missing required argument ${needed}`);
        }
      }
      try {
        const value = runTool(forge, toolName, args);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(value ?? {}) }], structuredContent: value, isError: false });
      } catch (err) {
        return ok(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      if (id === undefined || id === null) return { status: 202 };
      return fail(id, -32601, `method not found ${method}`);
  }
}

/** Handle one raw POST /mcp body. The caller has already enforced auth. */
export function handleMcp(forge: Forge, raw: string): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  if (Array.isArray(parsed)) {
    const payloads = parsed
      .map((entry) => handleMessage(forge, (entry ?? {}) as Record<string, unknown>))
      .filter((outcome) => outcome.payload !== undefined)
      .map((outcome) => outcome.payload);
    if (payloads.length === 0) return { status: 202, body: '' };
    return { status: 200, body: JSON.stringify(payloads) };
  }
  const outcome = handleMessage(forge, (parsed ?? {}) as Record<string, unknown>);
  if (outcome.payload === undefined) return { status: 202, body: '' };
  return { status: outcome.status, body: JSON.stringify(outcome.payload) };
}
