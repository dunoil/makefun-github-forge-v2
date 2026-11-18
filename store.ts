// Forge v2 object store and records.
//
// One in-memory, content-addressed store backs every surface (git smart HTTP, REST,
// GraphQL, MCP). Two facts shape the whole design:
//
//   1. Git objects are immutable and addressed by their content, so anything derived
//      from an object alone — a parsed commit header, a flattened tree — can be cached
//      by oid forever. The caches live on the Forge and are shared by all its repos.
//   2. Records (repos, issues, pulls) are mutable, so each carries a `stamp` counter
//      that every mutation bumps. The HTTP layer memoises serialised replies against
//      those stamps instead of re-scanning and re-stringifying on every read.
//
// Pure Node standard library; no git binary, no files, no network.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const NULL_OID = '0000000000000000000000000000000000000000';

const PACK_TYPE_BY_CODE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_CODE_BY_TYPE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// --------------------------------------------------------------------------- hashing

/** The git object id of `data` under `type`: sha1 of "<type> <len>\0" + data. */
export function oidOf(type: ObjType, data: Buffer): string {
  const hasher = createHash('sha1');
  hasher.update(`${type} ${data.length}\0`, 'utf8');
  hasher.update(data);
  return hasher.digest('hex');
}

const HEX40 = /^[0-9a-f]{40}$/;
export function looksLikeOid(value: string): boolean {
  return HEX40.test(value);
}

// --------------------------------------------------------------------------- trees

export interface TreeRow {
  mode: string;
  name: string;
  oid: string;
}

const HEX_BYTE: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Read the 20 raw bytes at `at` as a lowercase hex oid, without a Buffer slice. */
function hexAt(data: Buffer, at: number): string {
  let out = '';
  for (let i = 0; i < 20; i += 1) out += HEX_BYTE[data[at + i]!];
  return out;
}

/** Split a raw tree object into rows, in stored (git-sorted) order. */
export function readTree(data: Buffer): TreeRow[] {
  const rows: TreeRow[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    rows.push({
      mode: data.toString('latin1', at, space),
      name: data.toString('utf8', space + 1, nul),
      oid: hexAt(data, nul + 1),
    });
    at = nul + 21;
  }
  return rows;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Serialise tree rows the way git stores them: sorted, dirs sorting as "name/". */
export function writeTree(rows: readonly TreeRow[]): Buffer {
  const keyed = rows.map((row) => ({ row, key: isDirMode(row.mode) ? `${row.name}/` : row.name }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const { row } of keyed) {
    chunks.push(Buffer.from(`${row.mode} ${row.name}\0`, 'utf8'));
    chunks.push(Buffer.from(row.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------------- commits

export interface CommitHead {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorWhen: number;
  committerName: string;
  committerEmail: string;
  committerWhen: number;
  message: string;
}

/** Parse one ident body ("Name <mail> 1234567890 +0000") by scanning, no regex. */
function readIdent(text: string): { name: string; email: string; when: number } {
  const lt = text.indexOf('<');
  const gt = text.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return { name: text.trim(), email: '', when: 0 };
  let when = 0;
  let i = gt + 2;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    when = when * 10 + (code - 48);
    i += 1;
  }
  return { name: text.slice(0, lt).trimEnd(), email: text.slice(lt + 1, gt), when };
}

/**
 * Parse a commit object straight off the buffer: walk header lines by newline
 * offsets and only stringify the header block plus the message.
 */
export function readCommit(data: Buffer): CommitHead {
  const head: CommitHead = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorWhen: 0,
    committerName: '',
    committerEmail: '',
    committerWhen: 0,
    message: '',
  };
  let at = 0;
  let bodyAt = data.length;
  while (at < data.length) {
    const nl = data.indexOf(0x0a, at);
    const end = nl < 0 ? data.length : nl;
    if (end === at) {
      bodyAt = at + 1;
      break;
    }
    const line = data.toString('utf8', at, end);
    if (line.startsWith('tree ')) head.tree = line.slice(5);
    else if (line.startsWith('parent ')) head.parents.push(line.slice(7));
    else if (line.startsWith('author ')) {
      const ident = readIdent(line.slice(7));
      head.authorName = ident.name;
      head.authorEmail = ident.email;
      head.authorWhen = ident.when;
    } else if (line.startsWith('committer ')) {
      const ident = readIdent(line.slice(10));
      head.committerName = ident.name;
      head.committerEmail = ident.email;
      head.committerWhen = ident.when;
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  head.message = bodyAt <= data.length ? data.toString('utf8', bodyAt) : '';
  return head;
}

/** Serialise a commit object from its parts. */
export function writeCommit(parts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let text = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) text += `parent ${parent}\n`;
  text += `author ${parts.author}\ncommitter ${parts.committer}\n\n`;
  text += parts.message.endsWith('\n') ? parts.message : `${parts.message}\n`;
  return Buffer.from(text, 'utf8');
}

/** The oid a tag object points at, or '' when the object is not a tag with a target. */
export function tagTarget(data: Buffer): string {
  // Tag headers open with "object <hex>\n"; scan just the first line.
  const nl = data.indexOf(0x0a);
  const first = data.toString('latin1', 0, nl < 0 ? data.length : nl);
  return first.startsWith('object ') && first.length === 47 ? first.slice(7) : '';
}

// --------------------------------------------------------------------------- packfiles

/** Apply a git delta buffer to `base`. The format is a varint header plus copy/insert ops. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at]!;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  if (varint() !== base.length) throw new Error('delta base size mismatch');
  const targetSize = varint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at]!;
    at += 1;
    if (op & 0x80) {
      let from = 0;
      let count = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          from |= delta[at]! << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          count |= delta[at]! << (8 * bit);
          at += 1;
        }
      }
      if (count === 0) count = 0x10000;
      chunks.push(base.subarray(from, from + count));
      produced += count;
    } else if (op > 0) {
      chunks.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks, produced);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** How many bytes the zlib stream starting at `at` occupies inside `pack`. */
/**
 * Inflate the zlib stream starting at `at` exactly once and report how many pack bytes it
 * consumed. The fast path inflates the remaining tail with stream info (the engine reports
 * the consumed length); the fallback binary-searches for the shortest fitting prefix.
 */
function zlibSpan(pack: Buffer, at: number, wantSize: number): { data: Buffer; span: number } {
  const tail = pack.subarray(at);
  try {
    const done = inflateSync(tail, { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
    const used = done.engine?.bytesWritten;
    if (typeof used === 'number' && used > 0 && done.buffer.length === wantSize) {
      return { data: done.buffer, span: used };
    }
  } catch {
    // fall through to the search
  }
  // Binary search for the shortest prefix that inflates to exactly the wanted size.
  let lo = 1;
  let hi = tail.length;
  const fits = (n: number): boolean => {
    try {
      return inflateSync(pack.subarray(at, at + n)).length === wantSize;
    } catch {
      return false;
    }
  };
  if (!fits(hi)) throw new Error('truncated zlib stream in pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(pack.subarray(at, at + lo)), span: lo };
}

interface RawEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile into a map of resolved objects. Delta bases may be pack-internal
 * (OFS_DELTA / REF_DELTA to an object in the pack) or external via `outside` (thin packs).
 */
export function readPack(pack: Buffer, outside: (oid: string) => StoredObject | undefined): Map<string, StoredObject> {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const total = pack.readUInt32BE(8);
  const byOffset = new Map<number, RawEntry>();
  const resolved = new Map<string, StoredObject>();
  const waiting: Array<{ at: number; baseAt: number; baseOid: string; delta: Buffer }> = [];
  let at = 12;

  const store = (offset: number, type: ObjType, data: Buffer): RawEntry => {
    const entry: RawEntry = { type, data, oid: oidOf(type, data) };
    byOffset.set(offset, entry);
    resolved.set(entry.oid, { type, data });
    return entry;
  };

  for (let index = 0; index < total; index += 1) {
    const entryAt = at;
    let byte = pack[at]!;
    at += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at]!;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: the base sits `back` bytes before this entry.
      let b = pack[at]!;
      at += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[at]!;
        at += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const { data, span } = zlibSpan(pack, at, size);
      waiting.push({ at: entryAt, baseAt: entryAt - back, baseOid: '', delta: data });
      at += span;
    } else if (code === 7) {
      const baseOid = hexAt(pack, at);
      at += 20;
      const { data, span } = zlibSpan(pack, at, size);
      waiting.push({ at: entryAt, baseAt: -1, baseOid, delta: data });
      at += span;
    } else {
      const type = PACK_TYPE_BY_CODE[code];
      if (type === undefined) throw new Error(`unknown pack object code ${code}`);
      const { data, span } = zlibSpan(pack, at, size);
      store(entryAt, type, data);
      at += span;
    }
  }

  // Resolve deltas in dependency order; each pass settles at least one entry.
  let guard = waiting.length * waiting.length + 16;
  while (waiting.length > 0) {
    if (guard-- <= 0) throw new Error('pack delta chain does not resolve');
    const item = waiting.shift()!;
    let base: RawEntry | undefined;
    if (item.baseAt >= 0) {
      base = byOffset.get(item.baseAt);
    } else {
      const inPack = resolved.get(item.baseOid);
      if (inPack !== undefined) base = { type: inPack.type, data: inPack.data, oid: item.baseOid };
      else {
        const external = outside(item.baseOid);
        if (external !== undefined) base = { type: external.type, data: external.data, oid: item.baseOid };
      }
    }
    if (base === undefined) {
      waiting.push(item);
      continue;
    }
    const data = applyDelta(base.data, item.delta);
    store(item.at, base.type, data);
  }
  return resolved;
}

function packEntryHead(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile holding the given objects whole (no deltas), in order. */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    chunks.push(packEntryHead(PACK_CODE_BY_TYPE[object.type], object.data.length));
    chunks.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --------------------------------------------------------------------------- pkt-lines

export function pktFrame(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');
export const PKT_END = Buffer.from('0002', 'latin1');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Split a buffer into pkt-lines; bytes past the packet stream come back as `rest`. */
export function splitPkts(buffer: Buffer, stopAtFlush = true): { pkts: Pkt[]; rest: Buffer } {
  const pkts: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buffer.length) {
    const a = buffer[at]!;
    const b = buffer[at + 1]!;
    const c = buffer[at + 2]!;
    const d = buffer[at + 3]!;
    const nibble = (x: number): number => (x >= 48 && x <= 57 ? x - 48 : x >= 97 && x <= 102 ? x - 87 : x >= 65 && x <= 70 ? x - 55 : -1);
    const n0 = nibble(a);
    const n1 = nibble(b);
    const n2 = nibble(c);
    const n3 = nibble(d);
    if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0) break;
    const length = (n0 << 12) | (n1 << 8) | (n2 << 4) | n3;
    if (length === 0) {
      pkts.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      pkts.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      pkts.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    pkts.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { pkts, rest: buffer.subarray(at) };
}

// --------------------------------------------------------------------------- records

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  author: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  globalId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  /** Bumped by every mutation of this record; serialisers cache against it. */
  stamp: number;
}

export interface PullRec {
  number: number;
  globalId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRec[];
  seq: number;
  stamp: number;
}

export interface RepoRec {
  idNum: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, StoredObject>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
  /** Bumped whenever a ref moves; wire replies that depend on refs cache against it. */
  refsStamp: number;
  /** Bumped whenever anything a repo serialisation shows changes (fields, counts, labels). */
  stamp: number;
  openIssues: number;
  openPulls: number;
  /** The repo's display timestamp, fixed at creation: ISO text, computed once. */
  timeIso: string;
}

const EPOCH_BASE_MS = 1_735_689_600_000;

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  viewerLogin: string | null = null;

  private repoSeq = 0;
  private idSeq = 0;
  private commentSeq = 0;
  private clockSeq = 0;

  // Content-addressed derivation caches: an oid's parse never changes.
  private readonly commitHeads = new Map<string, CommitHead>();
  private readonly flatTrees = new Map<string, Map<string, { oid: string; mode: string }>>();

  /** A deterministic pseudo-timestamp (unix seconds) for forge-authored commits. */
  tick(): number {
    this.clockSeq += 1;
    return 1_735_689_600 + this.clockSeq * 37;
  }

  nextGlobalId(): number {
    this.idSeq += 1;
    return 90_000_000 + this.idSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return 500_000 + this.commentSeq;
  }

  learnViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  viewer(): string {
    return this.viewerLogin ?? 'adaiversen';
  }

  createRepo(name: string, options: { isPrivate?: boolean; description?: string; defaultBranch?: string }): RepoRec {
    this.repoSeq += 1;
    const idNum = 10_000 + this.repoSeq;
    const repo: RepoRec = {
      idNum,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: 0,
      refsStamp: 0,
      stamp: 0,
      openIssues: 0,
      openPulls: 0,
      timeIso: new Date(EPOCH_BASE_MS + idNum * 37_000).toISOString(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Owner-aware lookup: once the viewer is known, another owner's repo is a 404. */
  resolveRepo(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.viewerLogin !== null && owner !== this.viewerLogin) return null;
    return repo;
  }

  /** Move a ref and note the move for every cache keyed on refs. */
  setRef(repo: RepoRec, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.refsStamp += 1;
  }

  deleteRef(repo: RepoRec, ref: string): void {
    if (repo.refs.delete(ref)) repo.refsStamp += 1;
  }

  putObject(repo: RepoRec, type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Parsed commit header for an oid in this repo, memoised on the forge. */
  commitHead(repo: RepoRec, oid: string): CommitHead | null {
    const cached = this.commitHeads.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const head = readCommit(object.data);
    if (this.commitHeads.size > 200_000) this.commitHeads.clear();
    this.commitHeads.set(oid, head);
    return head;
  }

  /** path -> {oid, mode} for a tree oid, memoised; shared subtrees reuse one map. */
  flattenTree(repo: RepoRec, treeOid: string): Map<string, { oid: string; mode: string }> {
    const cached = this.flatTrees.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const row of readTree(object.data)) {
        const path = prefix === '' ? row.name : `${prefix}/${row.name}`;
        if (isDirMode(row.mode)) walk(row.oid, path);
        else out.set(path, { oid: row.oid, mode: row.mode });
      }
    };
    walk(treeOid, '');
    if (this.flatTrees.size > 100_000) this.flatTrees.clear();
    this.flatTrees.set(treeOid, out);
    return out;
  }

  /** The flattened files of the tree a commit names. Treat the result as read-only. */
  filesAtCommit(repo: RepoRec, commitOid: string): Map<string, { oid: string; mode: string }> {
    const head = this.commitHead(repo, commitOid);
    if (head === null) return new Map();
    return this.flattenTree(repo, head.tree);
  }
}

// --------------------------------------------------------------------------- graph walks

/** Every commit reachable from `tip`, breadth-first, newest generations first. */
export function reachableCommits(forge: Forge, repo: RepoRec, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let wave = [tip];
  while (wave.length > 0) {
    const next: string[] = [];
    for (const oid of wave) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      const head = forge.commitHead(repo, oid);
      if (head !== null) next.push(...head.parents);
    }
    wave = next;
  }
  return order;
}

/** True when `ancestor` lies on `descendant`'s parent chain (inclusive). */
export function isAncestor(forge: Forge, repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const head = forge.commitHead(repo, oid);
    if (head === null) continue;
    for (const parent of head.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits by summed BFS distance, or null. */
export function mergeBase(forge: Forge, repo: RepoRec, a: string, b: string): string | null {
  const distances = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    let wave = [tip];
    let depth = 0;
    while (wave.length > 0) {
      const next: string[] = [];
      for (const oid of wave) {
        if (dist.has(oid)) continue;
        dist.set(oid, depth);
        const head = forge.commitHead(repo, oid);
        if (head !== null) next.push(...head.parents);
      }
      wave = next;
      depth += 1;
    }
    return dist;
  };
  const fromA = distances(a);
  const fromB = distances(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db !== undefined && da + db < bestScore) {
      bestScore = da + db;
      best = oid;
    }
  }
  return best;
}

/** Store a tree hierarchy for a flat path map; returns the root tree oid. */
export function storeTreeFromFiles(repo: RepoRec, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = newDir();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      let child = dir.dirs.get(name);
      if (child === undefined) {
        child = newDir();
        dir.dirs.set(name, child);
      }
      dir = child;
    }
    dir.files.set(parts[parts.length - 1]!, file);
  }
  const build = (dir: Dir): string => {
    const rows: TreeRow[] = [];
    for (const [name, file] of dir.files) rows.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of dir.dirs) rows.push({ mode: '40000', name, oid: build(child) });
    const data = writeTree(rows);
    const oid = oidOf('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

export interface MergeOutcome3 {
  merged: Map<string, { oid: string; mode: string }>;
  conflicts: string[];
}

/** File-level three-way merge over flattened trees. */
export function threeWayMerge(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): MergeOutcome3 {
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
    x === undefined || y === undefined ? x === y : x.oid === y.oid && x.mode === y.mode;
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

/** Follow tag objects down to the commit they name; null when there is none. */
export function peelToCommit(forge: Forge, repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = tagTarget(object.data);
    if (target === '') return null;
    current = target;
  }
  return null;
}
