# DevGame (Alpha) — final computer-use QA pass

Build under test: commit **566e9c803**
Date: 2026-08-04 (America/Vancouver)
App: DevGame (Alpha), bundle id com.devgame.app

## Test and evidence notes

Preflight passed. DevGame was already running, its accessibility tree was readable, and a benign navigation from the existing chat to Settings changed state as expected. The app was never launched, quit, relaunched, or rebuilt. I did not type into a terminal, modify a project file, click Unity Play, or open/list/inspect ~/Projects/Deepmind. No write-producing dialog appeared.

The requested screenshot destination was unusable from the Computer Use helper. The exact failures were:

- EPERM: operation not permitted, chmod '/tmp/devgame-qa-shots'
- EPERM: operation not permitted, copyfile '/var/folders/5q/s6q_14m1043_k3mfylbxmyyh0000gn/T/com.openai.sky.CUAService/DevGame (Alpha) Screenshot 2026-08-04 at 9.17.59 PM.jpeg' -> '/tmp/devgame-qa-shots/01-unity-integration-checking.png'

Per the fallback instruction, evidence remains in Sky's native capture directory:

/var/folders/5q/s6q_14m1043_k3mfylbxmyyh0000gn/T/com.openai.sky.CUAService

The first native screenshot was verified before the round continued: 45,159 bytes with a valid JPEG signature. A final audit confirmed that screenshots exist for all ten items.

## 1 — Settings → Connections → Unity integration — **OBSERVED**

Defect reproduced. After opening Connections and waiting 12 seconds, Unity integration remained indefinitely at:

> Checking…
>
> Reading this project's Unity setup.

No CLI, Pipeline package, selection package, or live-editor status rows appeared. There was no timeout, retry action, failure reason, or recovery explanation.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.17.59 PM.jpeg

## 2 — Mafia Game engine toolbar diagnosis — **OBSERVED**

Defect reproduced. Mafia Game showed the Unity selector and a disabled Play control whose only exposed disabled-state wording was:

> No editor connected

It did not name the missing Pipeline package. No Pipeline-specific diagnosis was visible in the header. The current Computer Use API has no hover primitive, so I could not establish whether an additional pointer-hover-only tooltip exists; the accessibility label and visible disabled state expose only the generic diagnosis above. Unity Play was not clicked.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.18.53 PM.jpeg

Commits dc4ad0ca5 and d71f1d889 are newer than this binary and may bear on the probe/dispatch paths, but they are not in build 566e9c803. This finding stands against 566e9c803.

## 3 — Engine selector placement and styling — **OBSERVED**

The engine selector sits in the top-right chat header between the Git action and Play, at the same height and visual weight as its neighbors. On Mafia Game it visibly reads:

> Unity

Opening it showed these exact choices:

- Godot
- Unity
- Unreal
- three.js

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.19.03 PM.jpeg

## 4 — Project with no engine — **OBSERVED**

WellnessCompanion provided the no-engine case. The header visibly read:

> No engine

Play was absent, which is the expected behavior.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.19.20 PM.jpeg

## 5 — Files panel — **OBSERVED**

Files opened and listed the WellnessCompanion workspace. Selecting README.md opened a read-only observed preview with the heading:

> # Claude Code Hooks

The panel retained multiple open file tabs, including challenger-agent.md and README.md. No file content was edited.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.19.45 PM.jpeg

## 6 — Diff panel — **OBSERVED**

Diff opened successfully and showed an honest non-empty working-tree state. Exact exposed state:

> Working tree
>
> 5183 additions, 1 deletions
>
> .claude/settings.local.json.bak-20260710

Stacked/split, line-wrap, whitespace, and collapse controls were present. I made no changes.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.19.56 PM.jpeg

## 7 — Terminal panel — **OBSERVED**

A fresh Terminal 2 was created without entering any input. It reached a shell prompt, but the raw startup output reproduced the prior defect. The visible messages included:

> Detecting the Python interpreter...
>
> Checking "python3" ...
>
> Python 3.14.6
>
> "python3" has been detected
>
> Checking Python compatibility...
>
> Checking other ESP-IDF version...
>
> WARNING: Error while accessing the ESP-IDF version file in the Python environment: [Errno 2] No such file or directory: '/Users/pieroherrera/.espressif/python_env/idf5.3_py3.14_env/idf_version.txt'
>
> Adding ESP-IDF tools to PATH...
>
> WARNING: Error while accessing the ESP-IDF version file in the Python environment: [Errno 2] No such file or directory: '/Users/pieroherrera/.espressif/python_env/idf5.3_py3.14_env/idf_version.txt'
>
> Checking if Python packages are up to date...
>
> ERROR: /Users/pieroherrera/.espressif/python_env/idf5.3_py3.14_env/bin/python doesn't exist! Please run the install script or "idf_tools.py install-python-env" in order to create it
>
> pieroherrera@Pieros-Mac-Studio WellnessCompanion %

The shell starts, but normal terminal opening exposes implementation-level environment failures before the prompt.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.20.20 PM.jpeg

## 8 — Browser panel — **OBSERVED**

Browser opened to this exact empty state:

> Open a local app or URL.
>
> New Tab

No Figma or Notion dock traces were present.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.20.36 PM.jpeg

## 9 — Per-thread dock state — **OBSERVED**

Defect reproduced: panel contents are retained per thread, but active selection leaks across chats.

Test sequence and result:

1. In Make Temporary File Change, all four dock panels were open and Browser was explicitly selected.
2. Switching to Test Greeting immediately selected Browser there too, even though that chat had previously been left on Diff.
3. In Test Greeting, I selected Diff.
4. Switching back to Make Temporary File Change immediately selected Diff there, even though that chat had been left on Browser.
5. Make Temporary File Change did restore its open file tabs (challenger-agent.md and README.md), while Test Greeting had shown only the Explorer state. However, the inner file selection also followed challenger-agent.md rather than the README.md selection previously left in the first chat.

So open-panel contents/session state return, but outer active-tab selection—and apparently the active file selection—are shared or leaked instead of restored per thread.

Screenshots:

- DevGame (Alpha) Screenshot 2026-08-04 at 9.21.05 PM.jpeg — Test Greeting Files/Explorer state
- DevGame (Alpha) Screenshot 2026-08-04 at 9.21.34 PM.jpeg — first chat's open file tabs restored
- DevGame (Alpha) Screenshot 2026-08-04 at 9.21.59 PM.jpeg — first chat returned with Diff selected from the second chat

## 10 — Tab context menu and Maximize — **OBSERVED**

Right-clicking the Diff tab exposed:

> Maximize
>
> Close

Maximize worked: Diff filled the app content area and the chat/sidebar were hidden. Right-clicking the maximized tab then exposed Restore; restoring returned the standard layout and announced:

> Diff restored

No functional failure was observed, but the maximized view has no obvious always-visible restore affordance; recovery depends on discovering the tab context menu.

Screenshot: DevGame (Alpha) Screenshot 2026-08-04 at 9.22.28 PM.jpeg

## UI/UX critique

- **Connections / Unity:** This is unfinished. An unbounded Checking… state with no rows, timeout, retry, or explanation gives the user no way to distinguish slow work from a dead probe. The card should fail into a stable, per-dependency diagnosis with a retry affordance.
- **Engine toolbar:** Placement and chip styling are consistent, but No editor connected is the wrong level of abstraction for a missing package. The disabled control should name the Pipeline package inline or expose an unmistakable adjacent diagnostic. Low-contrast disabled styling makes the already-vague state easier to miss.
- **No-engine state:** No engine plus no Play is clear and calm. This is the cleanest engine-toolbar state observed.
- **Files:** The editor/tree combination is capable and readable, with useful breadcrumbs, file tabs, and syntax color. The right panel is narrow enough that paths and tree labels truncate aggressively. The preview also looks editable without an explicit read-only indicator, which is risky for confidence.
- **Diff:** Counts, scope, and view controls are clear. A 5,183-line working-tree state overwhelms the narrow dock quickly; a file summary or large-diff treatment would make it less punishing to scan.
- **Terminal:** Dumping ESP-IDF bootstrap diagnostics on every open makes a working shell look broken. Nonfatal environment setup should be folded behind a warning summary, with one actionable message and the prompt kept visually primary.
- **Browser:** The empty state is honest and uncluttered. It is also extremely bare; a URL field or a short explanation of what New Tab will ask for would reduce ambiguity.
- **Per-thread state:** Selection leakage is disorienting and breaks spatial memory. Users expect returning to a chat to restore what they were looking at, not merely which resources happened to be open.
- **Maximize:** The result is spacious and useful, but restore is hidden in a context menu. A visible restore icon or Escape affordance would make the mode legible.
- **Overall:** Alignment is generally disciplined, but the interface leans heavily on pale gray text and large empty areas. Critical status and error messaging needs stronger contrast and clearer hierarchy.

## Could not verify

- Unity Play/Stop dispatch: intentionally not clicked under the safety rule and because Unity automation permission is absent.
- A pointer-hover-only Play tooltip: Sky Computer Use exposes no hover action; the visible/accessibility diagnosis was No editor connected.
- Godot Play/Stop: no Godot project exists on this machine.
- Any behavior from dc4ad0ca5 or d71f1d889: neither commit is present in binary 566e9c803.

## Final safety/evidence state

DevGame (Alpha) remained running. The standard layout was restored after the maximized-panel capture. All ten item screenshots still existed in Sky's native directory at the final audit. No project files were modified.

---

## Collection note (added by the orchestrator, not the QA driver)

The Computer Use helper cannot write anywhere under `~/Projects` or `/tmp`
(`EPERM` — a macOS privacy restriction on that helper process, NOT a Codex
sandbox issue; the same directories are writable by the orchestrator). Evidence
was therefore captured to Sky's native directory and copied here afterwards:

    /var/folders/5q/.../T/com.openai.sky.CUAService  ->  evidence/qa-final-pass/screenshots/

46 screenshots collected, renamed `NN-H-MM-SS.jpeg` by capture time. The
report's inline filenames are Sky's originals; match them by timestamp.

## One correction to the driver's reading (orchestrator)

Item 7's ESP-IDF output is **not a DevGame defect.** Those warnings come from
the owner's own shell profile (`~/.espressif`, in the WellnessCompanion
working directory) — the terminal is faithfully printing what the shell
prints, which is correct behaviour for a terminal. The UX observation that it
_looks_ broken on open still stands as a product judgement; the attribution to
DevGame does not.
