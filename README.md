[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dunoil/makefun-github-forge-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dunoil/makefun-github-forge-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Forge v2 — a GitHub-compatible git forge, rebuilt for speed

A standalone forge in dependency-free Node (standard library only, no git binary):
git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API under
`/api/v3`, the GraphQL v4 API at `/api/graphql`, and an MCP endpoint at `/mcp`, all
over one in-memory, content-addressed store — an object created through any surface
reads back through the others with the same id.

Forge v2 is a ground-up re-implementation of the group's earlier forge, designed
around where the time actually went in v1's profile:

- **Derived data is memoised by oid.** Commits and trees are immutable, so parsed
  commit headers and flattened trees are cached on the forge by object id and shared
  by every walk (ancestry, merge-base, fetch selection, commit listings).
- **Wire replies are cached by refs stamp.** Advertisements, ls-refs answers and
  fetch packs are pure functions of the request over the object graph; they are
  cached against a per-repo stamp that every ref move bumps, so a moved ref keys a
  fresh reply and a stale one is never served. The v2 advertisement names no repo
  state at all and is a single prebuilt buffer.
- **Serialisation is memoised by mutation stamp.** Repos, issues and pulls carry
  stamp counters that their mutations bump; the hot reads serve a ready JSON string
  until a stamp moves, then re-serialise exactly once. Open-issue/pull counts are
  maintained as counters, never re-scanned per reply.
- **The request path does less.** No `URL` object per request (the target is split
  by hand, the query parsed only when a handler reads a parameter), no request-stream
  read for GETs, and request ids from a counter instead of a CSPRNG call.

Layout: `main.ts` (env lifecycle + boot self-check), `app.ts` (HTTP + REST),
`store.ts` (object store, packfiles, pkt-lines, records), `domain.ts` (issues,
pulls, merges), `githttp.ts` (smart HTTP), `graphql.ts` (GraphQL engine),
`mcp.ts` (MCP tools).

Run it the way the harness does: `node main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set; it binds an ephemeral port, registers, serves, and exits
when the env says the trial is done.
