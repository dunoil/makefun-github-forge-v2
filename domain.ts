// Domain operations shared by REST, GraphQL and MCP. One implementation per verb, so
// an issue opened through any door is the same record — same number, same global id,
// same state — through every other door. Mutations keep the repo's open-count counters
// and per-record stamps current; the HTTP layer's serialisation caches key on them.

import {
  isAncestor,
  mergeBase,
  oidOf,
  storeTreeFromFiles,
  threeWayMerge,
  writeCommit,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export class DomainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Author a commit object in the repo and return its oid. */
export function forgeCommit(
  forge: Forge,
  repo: RepoRec,
  options: { tree: string; parents: readonly string[]; authorName: string; authorEmail: string; message: string; ts: number },
): string {
  void forge;
  const ident = `${options.authorName} <${options.authorEmail}> ${options.ts} +0000`;
  const data = writeCommit({ tree: options.tree, parents: options.parents, author: ident, committer: ident, message: options.message });
  const oid = oidOf('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

export function createIssue(forge: Forge, repo: RepoRec, input: { title: string; body: string; labels: string[] }): IssueRec {
  for (const name of input.labels) {
    if (!repo.labels.has(name)) throw new DomainError(422, `Validation Failed: label "${name}" does not exist`);
  }
  const issue: IssueRec = {
    number: repo.nextNumber++,
    globalId: forge.nextGlobalId(),
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    seq: ++repo.seq,
    stamp: 0,
  };
  repo.issues.set(issue.number, issue);
  repo.openIssues += 1;
  repo.stamp += 1;
  return issue;
}

/** Set an issue's state, keeping the repo's open counter honest. */
export function setIssueState(repo: RepoRec, issue: IssueRec, state: 'open' | 'closed'): void {
  if (issue.state === state) return;
  issue.state = state;
  issue.stamp += 1;
  repo.openIssues += state === 'open' ? 1 : -1;
  repo.stamp += 1;
}

export function createPull(forge: Forge, repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec {
  if (!repo.refs.has(`refs/heads/${input.head}`)) {
    throw new DomainError(422, `Validation Failed: head ref "${input.head}" does not exist`);
  }
  if (!repo.refs.has(`refs/heads/${input.base}`)) {
    throw new DomainError(422, `Validation Failed: base ref "${input.base}" does not exist`);
  }
  const pull: PullRec = {
    number: repo.nextNumber++,
    globalId: forge.nextGlobalId(),
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedSeq: null,
    mergeSha: null,
    headRef: input.head,
    baseRef: input.base,
    comments: [],
    seq: ++repo.seq,
    stamp: 0,
  };
  repo.pulls.set(pull.number, pull);
  repo.openPulls += 1;
  repo.stamp += 1;
  return pull;
}

/** Set a pull's state (not merged-ness), keeping the open counter honest. */
export function setPullState(repo: RepoRec, pull: PullRec, state: 'open' | 'closed'): void {
  if (pull.state === state) return;
  pull.state = state;
  pull.stamp += 1;
  repo.openPulls += state === 'open' ? 1 : -1;
  repo.stamp += 1;
}

export function addComment(forge: Forge, rec: IssueRec | PullRec, body: string): CommentRec {
  const comment: CommentRec = { id: forge.nextCommentId(), body, author: forge.viewer(), seq: forge.tick() };
  rec.comments.push(comment);
  rec.stamp += 1;
  return comment;
}

/** The branch tips a pull currently points at; branches move, the record keeps names. */
export function pullTips(repo: RepoRec, pull: PullRec): { headSha: string | null; baseSha: string | null } {
  return {
    headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null,
    baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null,
  };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Addition/deletion counts between two file texts via a longest-common-subsequence pass. */
function diffCounts(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const m = a.length;
  const n = b.length;
  // One-row LCS: enough for the counts, kind to the memory budget on big files.
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      curr[j] = a[i] === b[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[0]!;
  return { additions: n - common, deletions: m - common };
}

function fileText(repo: RepoRec, oid: string | undefined): string {
  if (oid === undefined) return '';
  return repo.objects.get(oid)?.data.toString('utf8') ?? '';
}

/** The files a pull changes, measured from the merge-base of its two tips. */
export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): ChangedFile[] {
  const { headSha, baseSha } = pullTips(repo, pull);
  if (headSha === null || baseSha === null) return [];
  const base = mergeBase(forge, repo, baseSha, headSha) ?? baseSha;
  const beforeFiles = forge.filesAtCommit(repo, base);
  const afterFiles = forge.filesAtCommit(repo, headSha);
  const paths = new Set<string>([...beforeFiles.keys(), ...afterFiles.keys()]);
  const out: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const before = beforeFiles.get(path);
    const after = afterFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const { additions, deletions } = diffCounts(fileText(repo, before?.oid), fileText(repo, after?.oid));
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Whether merging the pull's head into its base right now would conflict. */
export function pullConflict(forge: Forge, repo: RepoRec, pull: PullRec): boolean {
  const { headSha, baseSha } = pullTips(repo, pull);
  if (headSha === null || baseSha === null) return false;
  const base = mergeBase(forge, repo, baseSha, headSha) ?? baseSha;
  const result = threeWayMerge(forge.filesAtCommit(repo, base), forge.filesAtCommit(repo, baseSha), forge.filesAtCommit(repo, headSha));
  return result.conflicts.length > 0;
}

export type MergeResult = { ok: true; sha: string } | { ok: false };

/**
 * Merge a pull into its base branch. MERGE makes a two-parent commit; SQUASH (and
 * REBASE, approximated as squash) collapses the head into one commit that keeps the
 * head tip's author. A conflicted merge changes nothing at all.
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: string): MergeResult {
  const { headSha, baseSha } = pullTips(repo, pull);
  if (headSha === null || baseSha === null) return { ok: false };
  const base = mergeBase(forge, repo, baseSha, headSha) ?? baseSha;
  const result = threeWayMerge(forge.filesAtCommit(repo, base), forge.filesAtCommit(repo, baseSha), forge.filesAtCommit(repo, headSha));
  if (result.conflicts.length > 0) return { ok: false };
  const tree = storeTreeFromFiles(repo, result.merged);
  const login = forge.viewer();
  const ts = forge.tick();
  let sha: string;
  if (method.toUpperCase() === 'MERGE') {
    sha = forgeCommit(forge, repo, {
      tree,
      parents: [baseSha, headSha],
      authorName: login,
      authorEmail: `${login}@users.noreply.forge`,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
      ts,
    });
  } else {
    const head = forge.commitHead(repo, headSha);
    sha = forgeCommit(forge, repo, {
      tree,
      parents: [baseSha],
      authorName: head?.authorName ?? login,
      authorEmail: head?.authorEmail ?? `${login}@users.noreply.forge`,
      message: `${pull.title} (#${pull.number})`,
      ts,
    });
  }
  forge.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
  if (pull.state === 'open') repo.openPulls -= 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = ts;
  pull.mergeSha = sha;
  pull.stamp += 1;
  repo.stamp += 1;
  return { ok: true, sha };
}

/** True when the pull's head is already fully contained in its base. */
export function headContained(forge: Forge, repo: RepoRec, pull: PullRec): boolean {
  const { headSha, baseSha } = pullTips(repo, pull);
  if (headSha === null || baseSha === null) return false;
  return isAncestor(forge, repo, headSha, baseSha);
}
