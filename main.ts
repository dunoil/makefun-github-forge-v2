// Forge v2 entrypoint: the entry <-> env lifecycle, plus a boot self-check.
//
// The lifecycle is the harness's contract (env/src/wire.ts): bind an ephemeral
// port, POST it to $MAKEFUN_ENV_URL/register, then poll $MAKEFUN_ENV_URL/done
// until the env answers {"done": true} and exit 0. Port 8080 belongs to the env
// and is never bound here.
//
// The self-check below is this entry's own addition. Before registering, the
// forge proves its object store round-trips: it hashes a blob, builds and
// re-reads a tree, writes a commit over it, packs the three objects and reads
// the pack back, then applies a hand-built delta to the blob. A store that
// cannot do that in-process will not survive the suite either, so failing
// fast with a clear line beats registering broken.

import { createApp } from './app.ts';
import { Forge, applyDelta, oidOf, readPack, readTree, writeCommit, writePack, writeTree } from './store.ts';

const BUILD_NOTE =
  'forge v2: dependency-free GitHub-compatible forge; store.ts (content-addressed objects, ' +
  'oid-memoised commit/tree derivations), domain.ts (issues/pulls/merges shared by all surfaces), ' +
  'githttp.ts (smart HTTP with refs-stamped advertisement, ls-refs and fetch caches), ' +
  'graphql.ts (lexer/parser/resolver engine), mcp.ts (JSON-RPC tools over the same store), ' +
  'app.ts (REST with stamp-memoised serialisation).';

/** Round-trip the object store once; throws (and the entry exits 1) if any step disagrees. */
function selfCheck(): void {
  const forge = new Forge();
  const repo = forge.createRepo('self-check', {});
  const blobData = Buffer.from('forge v2 self-check\n', 'utf8');
  const blobOid = forge.putObject(repo, 'blob', blobData);
  if (blobOid !== oidOf('blob', blobData)) throw new Error('self-check: blob hashing disagrees with itself');

  const treeData = writeTree([{ mode: '100644', name: 'check.txt', oid: blobOid }]);
  const treeOid = forge.putObject(repo, 'tree', treeData);
  const rows = readTree(treeData);
  if (rows.length !== 1 || rows[0]!.oid !== blobOid) throw new Error('self-check: tree round-trip lost the blob');

  const commitData = writeCommit({
    tree: treeOid,
    parents: [],
    author: 'Forge Self-Check <check@forge.local> 1735689600 +0000',
    committer: 'Forge Self-Check <check@forge.local> 1735689600 +0000',
    message: 'self-check commit\n',
  });
  const commitOid = forge.putObject(repo, 'commit', commitData);
  const head = forge.commitHead(repo, commitOid);
  if (head === null || head.tree !== treeOid) throw new Error('self-check: commit parse lost its tree');

  const pack = writePack([
    { type: 'blob', data: blobData },
    { type: 'tree', data: treeData },
    { type: 'commit', data: commitData },
  ]);
  const back = readPack(pack, () => undefined);
  if (!back.has(blobOid) || !back.has(treeOid) || !back.has(commitOid)) {
    throw new Error('self-check: pack round-trip lost an object');
  }
  const flat = forge.filesAtCommit(repo, commitOid);
  if (flat.get('check.txt')?.oid !== blobOid) throw new Error('self-check: flattened tree lost the file');

  // Delta application, checked against a hand-encoded delta: header varints
  // (base size, target size), one copy op (opcode 0x90: copy from offset 0,
  // one size byte follows) covering the whole base, then a one-byte insert.
  const delta = Buffer.from([blobData.length, blobData.length + 1, 0x90, blobData.length, 0x01, 0x21]);
  const grown = applyDelta(blobData, delta);
  const expected = Buffer.concat([blobData, Buffer.from('!', 'latin1')]);
  if (!grown.equals(expected)) throw new Error('self-check: delta application disagrees with the hand-built delta');
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential waits between register/done retries: 250ms doubling to a 2s cap. */
function retryWait(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means another entry registered first and this process simply waits like any
 * other. 400/405 are contract errors and end the program; anything else retries.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryWait(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, so poll again.
    }
    await sleep(retryWait(attempt));
  }
}

async function main(): Promise<void> {
  selfCheck();
  process.stderr.write(`[entry] ${BUILD_NOTE}\n`);
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
