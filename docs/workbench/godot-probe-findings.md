# Godot publisher: what the engine actually does

Everything below was **observed by running Godot 4.7.1**, not read from the
class reference. The engine-publisher research specs were written on the
premise that Godot was not installed on this machine; it is, so these
observations supersede the corresponding "unverifiable" entries in
`spec-godot-publisher`.

Probe harness (throwaway, lives in the job scratch dir, not in the repo):
a dependency-free RFC-6455 server in three modes, driven by
`godot --headless --path . --script probe.gd`.

```
Godot Engine v4.7.1.stable.official.a13da4feb
VERSION={ major:4, minor:7, patch:1, status:"stable", string:"4.7.1-stable (official)" }
```

## Confirmed capabilities

| Question                                                 | Answer                | Evidence                                                                                   |
| -------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Can `WebSocketPeer` send custom handshake headers?       | **Yes**               | Server logged `authorization: Bearer spike-token` on the upgrade request                   |
| Does the generated setter exist as well as the property? | **Yes**               | `HAS_set_handshake_headers=true`                                                           |
| Does `ResourceLoader.get_resource_uid` exist?            | **Yes**               | `HAS_get_resource_uid=true`                                                                |
| Full text round-trip from a plain script?                | **Yes**               | Sent a `hello` frame, received the echo                                                    |
| `Time.get_datetime_string_from_unix_time` output shape   | `2025-08-03T00:00:00` | ISO 8601, **no `Z`, no milliseconds** — add them if the protocol wants UTC-explicit stamps |
| `Time.get_unix_time_from_system()` return type           | float (`typeof` = 3)  | —                                                                                          |

**Consequence: the Godot publisher does not need the `?wsTicket=` query-param
path.** It has header parity with Unity's `ClientWebSocket` and can send
`Authorization: Bearer` directly. The ticket path remains necessary for the
_web_ client, which cannot set WebSocket handshake headers — so the presence
route must accept both, for different callers rather than different engines.

## The failure-diagnosis finding, and the design ruling it forces

The spec flagged, correctly, that the addon might not be able to tell "bad
token" from "server down". Measured, with the server refusing the upgrade at
the HTTP layer:

| Scenario                                    | State path            | `get_close_code()` | `get_close_reason()`             |
| ------------------------------------------- | --------------------- | ------------------ | -------------------------------- |
| Server returns **HTTP 401**                 | `CONNECTING → CLOSED` | `-1`               | `""`                             |
| **Nothing listening** on the port           | `→ CLOSED`            | `-1`               | `""`                             |
| Upgrade accepted, then **close frame 4401** | `CONNECTING → CLOSED` | **`4401`**         | **`"invalid or expired token"`** |

An HTTP 401 is genuinely invisible to GDScript. The engine prints
`Not enough response headers. Got: 3, expected >= 4.` from C++
(`wsl_peer.cpp:427`) into the Output dock, and a script cannot capture that. A
user with a stale token would see an addon that silently does nothing.

The state path _looks_ like a discriminator — 401 passes through `CONNECTING`
while a dead port goes straight to `CLOSED` — but that is a localhost timing
artifact. A firewalled or remote port would sit in `CONNECTING` and then close,
exactly like a 401. **Do not build the diagnosis on the state sequence.**

**Ruling: the presence route authenticates AFTER accepting the WebSocket
upgrade, and rejects by closing with a 4xxx application close code plus a
human-readable reason. It never refuses the upgrade with HTTP 401.**

We own this route, so this is ours to decide, and it costs nothing. It gives
every engine client a clean rule that does not depend on timing:

- close code **≥ 4000** → the server told us why; show the reason verbatim
- close code **−1** → no WebSocket session was ever established; show
  "cannot reach Workbench at `<url>`"

### Correction: "≥ 4000 means stop retrying" was too coarse

The first version of this rule said any code ≥ 4000 should halt reconnection,
on the reasoning that the server had given a definitive answer. Three codes are
now in use and they do not behave alike:

| Code | Meaning               | Retry?                                                       |
| ---- | --------------------- | ------------------------------------------------------------ |
| 4400 | missing credential    | **No** — nothing to retry with until the user configures one |
| 4401 | invalid credential    | **No** — retrying sends the same rejected token              |
| 4500 | server internal error | **Yes, with backoff** — transient by definition              |

Under the original rule a momentary server fault would permanently disconnect
every editor on every machine until each user noticed and clicked retry. That
is an availability bug created by writing the rule too broadly, not by any
client implementing it wrongly.

**The distinction is credential-class versus everything-else, not a numeric
threshold.** Encode it by name so it does not get re-flattened into a
comparison later. An unrecognised ≥ 4000 code should keep retrying — an unknown
failure is more likely to be transient than to be the user's fault.

This should hold for Unity and Unreal too — both of their WebSocket clients
expose close codes — but it is proven only for Godot.

## Still unverified for Godot

The probe ran as a plain `SceneTree` script, which exercises `WebSocketPeer`
but **not the editor**. These remain open and need the editor running:

- Whether `EditorPlugin._process` ticks with no game running, no scene focused,
  and **the editor window in the background**. The spec's fallback is a `Timer`
  child with `PROCESS_MODE_ALWAYS`; the rest of the design is identical either
  way.
- `EditorSelection.selection_changed` firing, and `get_selected_nodes()`
  contents.
- That `EditorInterface.get_selected_paths()` (FileSystem dock) needs polling
  because it has no change signal.

This is why the addon's selection source stays injectable: frame construction
and transport are provable headlessly, and only the editor binding is blind.
