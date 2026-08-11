# Round 15 closure — CDP verification of the shipped force-visible fix

Method: the packaged app relaunched once with --remote-debugging-port,
Runtime.evaluate reading real computed styles (no style injection — the
shipped CSS/JS only). This supersedes the round-15 driver run, which
executed against the pre-fix build and reported the brand missing
(consistent with the owner's own report that triggered the diagnosis).

Diagnosis (pre-fix build, same method): header used width 224px (floor
applied) yet brand computed display "none" — container size queries
measure the CONTENT box; the corner's 110px of padding left 114px
against .sidebar-brand's 216px threshold. Style-injection painted the
brand at x=126, proving composition before any source change.

Shipped-fix verification (post-install, clean run):
brandDisplay: "flex" brandLeft: 126 brandRight: 200
cornerWidth: 224 cornerVar: 224px
firstTab: "Sidebar" at x=225 — clear of the corner by construction.

Composition = lights inset (0-90) + toggle (~90-118) + gap + brand
(126-200) + trailing gap → corner 224 → first tab 225. Matches the
owner's mock ordering.
