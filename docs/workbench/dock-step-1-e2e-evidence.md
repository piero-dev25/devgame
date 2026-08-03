# Dock step 1 — E2E evidence, gate closed

The commit that landed the dock (`2865d135f`) carried an explicit OPEN GATE:
built and typechecked, but none of the four acceptance checks run. This is the
record that closes it. All four were exercised in a real browser against a
live backend on real threads.

## 1. Live chat through the portal — PASS

A prompt sent from inside the docked chat panel streamed its response back
into that panel, and the thread's row in T3's own left sidebar updated.

That combination is the point: streaming proves the Effect atom registry
reached `ChatView` through `createPortal`, and the sidebar updating proves it
is the _same_ registry instance the rest of the app uses rather than an
isolated one.

## 2. Reload persistence — PASS, more strongly than asked

The spec asked for a splitter drag surviving a reload. What actually happened
was better: the placeholder panel was **re-docked from the right edge to the
bottom**, which is a structural change to the grid rather than a resize. After
a hard reload the serialized layout came back byte-identical:

```
before: [{views:["chat"], size:856.5}, {views:["placeholder"], size:221.5}]
after:  [{views:["chat"], size:856.5}, {views:["placeholder"], size:221.5}]
MATCH: true
```

`localStorage` key `t3-workbench-dock:layout:chat-dock`, 636 bytes, a real
`dockview.grid.root`. DOM after reload: 1 dockview root, 2 groups, tabs
`Chat` / `Panel`, composer live.

## 3. Route is the source of truth, and the dock does not remount — PASS

This is the check that stops a saved layout resurrecting a stale thread, so it
was worth proving rather than reasoning about.

A second thread was created, then the dock's root node was tagged
`data-proof-tag="TAG-371175"`, then the _other_ thread was opened from T3's
sidebar. After the switch:

```
proofTagSurvived: "TAG-371175"     -> the dock element was never recreated
REMOUNTED: false
showsJumpVelocity: true            -> chat swapped to the correct transcript
showsOtherThreadReply: false       -> and is not showing the previous one
```

A tag set before the navigation surviving it is the evidence; "it looked the
same" would not have been.

## 4. No regression outside the dock — PASS

`/settings/general` renders normally with **0** dockview roots and **0** dock
tabs. The mount is correctly scoped to the thread route.

## Two corrections to earlier claims in this repo

**There is no orientation defect.** I briefly recorded the vertical split as a
deviation from the spec. It is not: `ChatDock.tsx:104` sets
`Orientation.HORIZONTAL` with chat left and the placeholder right, and the
vertical arrangement I measured was simply the owner having dragged the panel
to the bottom to try it. The layout was working exactly as designed.

**The "client will not connect" investigation was chasing my own mess.** The
cause was **multiple browser tabs open on the same origin**. Reproduced
deliberately: opening a second tab on `localhost:5733` immediately produced
`Piero's Mac Studio: Failed to connect. Reconnecting…`, and closing it
restored a healthy connection. That is what produced the authenticated-but-
dataless state, and it very likely explains the Wave 0 symptom recorded as an
environment picker stuck on `Connecting…` forever.

It was not `T3CODE_HOME`, and it was not a T3 client bug. **Use one tab per
origin when testing.**

Worth naming the reasoning error, because it survived a differential
experiment that felt rigorous: a worktree at the pre-change commit reproduced
the symptom, which I read as exonerating the diff _and_ indicting upstream. It
did exonerate the diff. It said nothing about upstream, because both arms of
the experiment ran against the same browser with the same extra tabs open. A
differential only clears the variable you actually varied.
