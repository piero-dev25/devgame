# The hard condition: one transport, and it is Effect

The goal carries one hard condition:

> Effect Layer/RpcServer becomes THE server transport in the same wave as the
> first T3 service; retire our node:http. Two transports in parallel = the
> fork never converges.

This records how it is satisfied, with the evidence, because "we forked so it
is fine" is exactly the kind of assertion this project keeps getting wrong.

## The fork is single-transport, and that transport is Effect

- `apps/server/src/ws.ts` runs `RpcServer` — the RPC surface.
- `apps/server/src/server.ts:191` serves through
  `NodeHttpServer.layer(NodeHttp.createServer, …)` under
  `serverEnvironmentHttpApiLayer`.

That `node:http` import is **not** a second transport. It is Effect's own
platform driver: `@effect/platform-node`'s `NodeHttpServer` takes
`createServer` as its factory and wraps it in an Effect `Layer` beneath an
`HttpApi`. Idiomatic Effect, one transport.

Worth being precise about, since grepping for `node:http` in the fork returns
hits and it would be easy to read those as a violation. They are the
foundation the Effect layer is built on, not a parallel path.

## Our node:http server is retired

The pre-fork Workbench server (`app/server/src/index.mjs` +
`api/*-routes.mjs` in the gamedev-workbench repo) was a plain `node:http`
server on port 4700. As of this record it is **stopped**, and the port is
clear.

Two facts establish that retiring it costs nothing:

- **The fork has no dependency on it.** Searching the fork's `apps/` and
  `packages/` for `gamedev-workbench` or `@workbench/` returns only provenance
  comments — "Ported verbatim from gamedev-workbench's …" — on the dock files.
  Comments, not imports. Nothing in the fork calls it, links it, or expects it
  to be running.
- **Nothing in the product routes through it.** The product is the fork. Its
  server is `apps/server`, on 13773, on Effect.

So there was never a moment where two transports served the same product. The
old one was simply still running, left over, on a port nobody used.

It was also actively harmful: pid 34353 was one of the processes spawning the
`codex app-server` sessions that accumulated to roughly a thousand leaked
processes and filled the owner's remote session list with
`workbench-routes-*` entries.

## What is NOT done

The old server's **source has not been deleted**. Stopping it retires it;
deleting several thousand lines is a separate, deliberate, reviewable change
and not something to fold into an unrelated wave.

The fork's dock files carry provenance comments pointing at those paths, so
anyone deleting them should update those comments in the same commit rather
than leaving dangling references.

## Why this is not "we forked, therefore fine"

The condition exists because two transports mean the fork never converges —
every new service has to choose, and half get it wrong. The check that
actually matters is not "did we fork" but "can a request into the product
reach two different server implementations". It cannot: there is one server,
one port, one Layer.
