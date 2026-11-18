// Git smart HTTP for /{owner}/{repo}.git: info/refs advertisements (protocol v2 and
// v0), upload-pack (ls-refs and fetch with shallow/deepen), and receive-pack (push
// with per-ref fast-forward rules and a sideband report). Written from the git wire
// format over the shared store; no git binary anywhere.
//
// Speed comes from one observation: a fetch reply is a pure function of the request
// over an immutable object graph, and an advertisement is a pure function of the
// repo's refs. Both are cached — the fetch by its full argument set plus the repo's
// refs stamp, the advertisements by the refs stamp alone. Ref moves bump the stamp,
// so a stale reply is never served.

import {
  NULL_OID,
  PKT_DELIM,
  PKT_FLUSH,
  isAncestor,
  looksLikeOid,
  peelToCommit,
  pktFrame,
  readPack,
  reachableCommits,
  splitPkts,
  tagTarget,
  writePack,
  type Forge,
  type RepoRec,
  type StoredObject,
} from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/2.0';
const RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/2.0 quiet atomic';

function jsonReply(status: number, message: string): GitReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function headRefOf(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Ref lines for an advertisement or ls-refs, HEAD first, then refs in name order. */
function refLines(repo: RepoRec): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  const headOid = repo.refs.get(headRefOf(repo));
  if (headOid !== undefined) lines.push(['HEAD', headOid]);
  const names = [...repo.refs.keys()].sort();
  for (const name of names) lines.push([name, repo.refs.get(name)!]);
  return lines;
}

// --------------------------------------------------------------------------- advertisements

// The v2 capability advertisement names no repo state at all: build it once.
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktFrame('version 2\n'),
  pktFrame('agent=forge/2.0\n'),
  pktFrame('ls-refs=unborn peel symrefs ref-prefix\n'),
  pktFrame('fetch=shallow wait-for-done\n'),
  pktFrame('server-option\n'),
  pktFrame('object-format=sha1\n'),
  PKT_FLUSH,
]);

const advCache = new Map<string, Buffer>();

function v0Advertisement(forge: Forge, repo: RepoRec, service: string): Buffer {
  const key = `${repo.name}|${repo.refsStamp}|${service}`;
  const hit = advCache.get(key);
  if (hit !== undefined) return hit;
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktFrame(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktFrame(`${NULL_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [name, oid] of refs) {
      let line = `${oid} ${name}`;
      if (first) {
        line += `\0${caps}`;
        if (service === 'git-upload-pack') line += ` symref=HEAD:${headRefOf(repo)}`;
        first = false;
      }
      parts.push(pktFrame(`${line}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge, repo, oid);
        if (peeled !== null) parts.push(pktFrame(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (advCache.size > 512) advCache.clear();
  advCache.set(key, body);
  return body;
}

export function infoRefs(forge: Forge, owner: string, repoName: string, service: string, v2: boolean): GitReply {
  forge.learnViewer(owner);
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) return jsonReply(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (v2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(forge, repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(forge, repo, service) };
  }
  return jsonReply(404, 'Not Found');
}

// --------------------------------------------------------------------------- upload-pack

export function uploadPack(forge: Forge, owner: string, repoName: string, body: Buffer, v2: boolean): GitReply {
  forge.learnViewer(owner);
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) return jsonReply(404, 'Not Found');
  const { pkts } = splitPkts(body, false);
  const lines: string[] = [];
  for (const pkt of pkts) {
    if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (v2) {
    const command = lines[0] ?? '';
    if (command === 'command=ls-refs') return lsRefs(forge, repo, lines);
    if (command === 'command=fetch') return fetchReply(forge, repo, lines, 1, true);
    return jsonReply(400, `unknown command ${command}`);
  }
  return fetchReply(forge, repo, lines, 0, false);
}

const lsCache = new Map<string, Buffer>();

function lsRefs(forge: Forge, repo: RepoRec, lines: string[]): GitReply {
  const args = lines.slice(1);
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const key = `${repo.name}|${repo.refsStamp}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(' ')}`;
  const hit = lsCache.get(key);
  if (hit !== undefined) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: hit };

  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headRefOf(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid !== undefined) parts.push(pktFrame(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn) parts.push(pktFrame(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge, repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktFrame(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (lsCache.size > 512) lsCache.clear();
  lsCache.set(key, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// --------------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(lines: string[], from: number): FetchArgs {
  const args: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) args.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface Selection {
  objects: StoredObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Choose a fetch's pack contents: the wants' closure minus what the client holds,
 * honouring depth limits and deepen requests against the client's shallow boundary.
 */
function selectObjects(forge: Forge, repo: RepoRec, args: FetchArgs): Selection {
  const wantOids: string[] = [...args.wants];
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined && !wantOids.includes(oid)) wantOids.push(oid);
  }
  const clientShallow = new Set(args.shallow);

  // Commits the client holds: the haves' ancestry, not crossing its shallow boundary.
  const heldCommits = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (heldCommits.has(oid)) continue;
      heldCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      const head = forge.commitHead(repo, oid);
      if (head !== null) stack.push(...head.parents);
    }
  }
  // Objects the client holds: the haves' full closure on the same boundary rule.
  const heldObjects = new Set<string>();
  {
    const visit = (oid: string): void => {
      if (heldObjects.has(oid)) return;
      const object = repo.objects.get(oid);
      if (object === undefined) return;
      heldObjects.add(oid);
      if (object.type === 'commit') {
        const head = forge.commitHead(repo, oid);
        if (head !== null) {
          visit(head.tree);
          if (!clientShallow.has(oid)) for (const parent of head.parents) visit(parent);
        }
      } else if (object.type === 'tree') {
        for (const entryOid of treeChildOids(repo, oid)) visit(entryOid);
      } else if (object.type === 'tag') {
        const target = tagTarget(object.data);
        if (target !== '') visit(target);
      }
    };
    for (const have of args.haves) visit(have);
  }
  const excluded = new Set<string>();
  for (const ref of args.deepenNot) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) for (const commit of reachableCommits(forge, repo, oid)) excluded.add(commit);
  }

  // BFS generations of every commit the wants can reach.
  const generation = new Map<string, number>();
  {
    let wave: string[] = [];
    for (const oid of wantOids) {
      const commit = peelToCommit(forge, repo, oid);
      if (commit !== null && !generation.has(commit)) wave.push(commit);
    }
    let gen = 0;
    while (wave.length > 0) {
      const next: string[] = [];
      for (const oid of wave) {
        if (generation.has(oid)) continue;
        generation.set(oid, gen);
        const head = forge.commitHead(repo, oid);
        if (head !== null) next.push(...head.parents);
      }
      wave = next;
      gen += 1;
    }
  }

  const included = new Set<string>();
  for (const [oid, distance] of generation) {
    if (heldCommits.has(oid) && !clientShallow.has(oid)) continue;
    if (excluded.has(oid)) continue;
    if (args.depth !== null && distance >= args.depth) continue;
    if (args.deepenSince !== null) {
      const head = forge.commitHead(repo, oid);
      if (head !== null && head.committerWhen < args.deepenSince) continue;
    }
    included.add(oid);
  }
  for (const oid of clientShallow) {
    if (heldCommits.has(oid)) included.delete(oid);
  }

  const shallow: string[] = [];
  for (const oid of included) {
    const head = forge.commitHead(repo, oid);
    if (head === null) continue;
    if (head.parents.some((parent) => repo.objects.has(parent) && !included.has(parent) && !heldCommits.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const head = forge.commitHead(repo, oid);
    if (head === null) continue;
    if (!shallow.includes(oid) && head.parents.some((parent) => included.has(parent))) unshallow.push(oid);
  }

  // The pack itself: walk from the wants, sending only included, unheld objects,
  // but passing through held commits so a deepened parent behind one is reached.
  const chosen = new Map<string, StoredObject>();
  const walked = new Set<string>();
  const visit = (oid: string): void => {
    if (walked.has(oid)) return;
    walked.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    if (object.type === 'commit') {
      const head = forge.commitHead(repo, oid);
      if (head === null) return;
      if (included.has(oid) && !heldObjects.has(oid)) {
        chosen.set(oid, object);
        visit(head.tree);
      }
      for (const parent of head.parents) if (included.has(parent)) visit(parent);
      return;
    }
    if (chosen.has(oid) || heldObjects.has(oid)) return;
    chosen.set(oid, object);
    if (object.type === 'tree') {
      for (const entryOid of treeChildOids(repo, oid)) visit(entryOid);
    } else if (object.type === 'tag') {
      const target = tagTarget(object.data);
      if (target !== '') visit(target);
    }
  };
  for (const oid of wantOids) visit(oid);

  const acks = args.haves.filter((oid) => repo.objects.has(oid) && forge.commitHead(repo, oid) !== null);
  return { objects: [...chosen.values()], shallow, unshallow, acks };
}

/** The child oids of a tree object, read straight off its raw bytes. */
function treeChildOids(repo: RepoRec, treeOid: string): string[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const data = object.data;
  const out: string[] = [];
  let at = 0;
  while (at < data.length) {
    const nul = data.indexOf(0x00, at);
    out.push(data.toString('hex', nul + 1, nul + 21));
    at = nul + 21;
  }
  return out;
}

/** Frame a pack in side-band-64k packets (band 1), in <=64 KiB chunks. */
function sideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65_000;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pktFrame(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktFrame(Buffer.from([1])));
  return parts;
}

const fetchCache = new Map<string, Buffer>();

function fetchReply(forge: Forge, repo: RepoRec, lines: string[], from: number, v2: boolean): GitReply {
  const args = parseFetchArgs(lines, from);
  const key = [
    repo.name,
    repo.refsStamp,
    v2 ? 'v2' : 'v0',
    args.wants.join(' '),
    args.wantRefs.join(' '),
    args.haves.join(' '),
    args.shallow.join(' '),
    String(args.depth),
    String(args.deepenSince),
    args.deepenNot.join(' '),
    args.done ? 'd' : '',
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit !== undefined) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: hit };

  const selection = selectObjects(forge, repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (args.haves.length > 0) {
      parts.push(pktFrame('acknowledgments\n'));
      if (selection.acks.length === 0) {
        parts.push(pktFrame('NAK\n'));
      } else {
        for (const oid of selection.acks) parts.push(pktFrame(`ACK ${oid} common\n`));
        if (args.done) parts.push(pktFrame('ready\n'));
      }
      parts.push(PKT_DELIM);
    }
    const shallowInfo = args.depth !== null || args.shallow.length > 0 || args.deepenSince !== null || selection.shallow.length > 0 || selection.unshallow.length > 0;
    if (shallowInfo) {
      parts.push(pktFrame('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pktFrame(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pktFrame(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (args.wantRefs.length > 0) {
      parts.push(pktFrame('wanted-refs\n'));
      for (const ref of args.wantRefs) {
        const oid = repo.refs.get(ref);
        if (oid !== undefined) parts.push(pktFrame(`${oid} ${ref}\n`));
      }
      parts.push(PKT_DELIM);
    }
    parts.push(pktFrame('packfile\n'));
  } else {
    for (const oid of selection.shallow) parts.push(pktFrame(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktFrame(`unshallow ${oid}\n`));
    if (selection.acks.length === 0) {
      parts.push(pktFrame('NAK\n'));
    } else {
      for (const oid of selection.acks) parts.push(pktFrame(`ACK ${oid} common\n`));
      parts.push(pktFrame(`ACK ${selection.acks[selection.acks.length - 1]!}\n`));
    }
  }
  parts.push(...sideband(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (body.length <= 8 * 1024 * 1024) {
    if (fetchCache.size >= 64) fetchCache.delete(fetchCache.keys().next().value!);
    fetchCache.set(key, body);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// --------------------------------------------------------------------------- receive-pack

interface PushCmd {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitReply {
  forge.learnViewer(owner);
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) return jsonReply(404, 'Not Found');
  const { pkts, rest } = splitPkts(body);
  const commands: PushCmd[] = [];
  let capabilities: string[] = [];
  for (const pkt of pkts) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const firstSpace = line.indexOf(' ');
    const secondSpace = firstSpace < 0 ? -1 : line.indexOf(' ', firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) continue;
    const oldOid = line.slice(0, firstSpace);
    const newOid = line.slice(firstSpace + 1, secondSpace);
    const ref = line.slice(secondSpace + 1);
    if (looksLikeOid(oldOid) && looksLikeOid(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'index-pack failed';
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const reason = applyPush(forge, repo, command);
    report.push(reason === '' ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }

  if (!capabilities.includes('report-status') && !capabilities.includes('report-status-v2')) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const inner = Buffer.concat([...report.map((line) => pktFrame(line)), PKT_FLUSH]);
  if (capabilities.includes('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65_000;
    for (let at = 0; at < inner.length; at += CHUNK) {
      parts.push(pktFrame(Buffer.concat([Buffer.from([1]), inner.subarray(at, at + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: inner };
}

/** Apply one ref update; returns '' on success or the report's refusal reason. */
function applyPush(forge: Forge, repo: RepoRec, command: PushCmd): string {
  const current = repo.refs.get(command.ref) ?? NULL_OID;
  if (command.newOid === NULL_OID) {
    if (current === NULL_OID) return '';
    if (current !== command.oldOid) return 'stale ref';
    forge.deleteRef(repo, command.ref);
    return '';
  }
  if (!repo.objects.has(command.newOid)) return 'object not found';
  if (current !== command.oldOid) return 'stale ref';
  if (current !== NULL_OID && command.ref.startsWith('refs/heads/')) {
    const newCommit = peelToCommit(forge, repo, command.newOid);
    if (newCommit === null) return 'not a commit';
    if (!isAncestor(forge, repo, current, newCommit)) return 'non-fast-forward';
  }
  forge.setRef(repo, command.ref, command.newOid);
  return '';
}
