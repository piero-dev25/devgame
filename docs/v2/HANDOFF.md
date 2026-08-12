# AI-Native Game Development Harness

## Multimodal Generation Architecture, Agent Tooling & UX Exploration Handoff

**Date:** August 11, 2026  
**Phase:** Architecture exploration + implementation spikes  
**Current foundation:** T3 Code-derived coding-agent harness  
**Primary engine target:** Unity  
**Future targets:** Unreal, potentially Godot  
**Primary coding agents:** Codex, Claude Code, OpenCode, others where useful

---

# 0. Why We Are Exploring This

We are building a coding-agent harness specialized for game development.

The current product already starts from the general T3 Code model:

```text
Project
  ↓
Coding Agent
  ├─ Codex
  ├─ Claude Code
  ├─ OpenCode
  └─ others
  ↓
Code / files / terminal
```

We want to extend that model so that **AI-generated media becomes a native part of the same game-development workflow**.

This includes:

```text
Images
3D models
Textures
Audio
Voices
Sound effects
Potentially video
Potentially animation
```

The important idea is NOT simply:

> Add buttons for Meshy, ElevenLabs, image models, etc.

The larger product thesis is:

> **A game developer should be able to express a game-development intent to their coding agent, and the harness should orchestrate the coding, generation, engine operations, review and iteration necessary to achieve it.**

Example:

```text
"Add a wooden barrel beside the tavern."
```

should eventually be able to become:

```text
Understand current project
        ↓
Understand art style / references
        ↓
Determine technical requirements
        ↓
Generate appropriate asset
        ↓
Review generation
        ↓
Regenerate if necessary
        ↓
Import into Unity
        ↓
Configure materials / collider / prefab
        ↓
Place into scene
        ↓
Run game
        ↓
Observe result
        ↓
Agent iterates
```

That loop is the product.

---

# 1. Core Product Thesis

The harness should eventually contain three interconnected planes:

```text
                     GAME DEV HARNESS
                            │
           ┌────────────────┼────────────────┐
           │                │                │
           ↓                ↓                ↓

       AGENT PLANE     GENERATION PLANE   ENGINE PLANE

     Codex / Claude       Image / 3D      Unity / Unreal
       OpenCode            Audio etc.
           │                │                │
           └────────────────┼────────────────┘
                            ↓
                       GAME PROJECT
                            ↓
                    OBSERVATION LOOP
```

The differentiator is not any individual plane.

The value is the loop:

```text
Agent
  ↓
Generate
  ↓
Observe
  ↓
Iterate
  ↓
Import
  ↓
Run
  ↓
Observe
  ↓
Agent
```

The architecture must preserve this loop.

---

# 2. Current Foundation: Why T3 Still Matters

T3 Code remains the preferred foundation unless this investigation finds strong evidence against it.

Its architecture is centered around coding-agent orchestration.

T3 currently abstracts coding-agent runtimes through provider drivers/adapters and keeps the higher-level orchestration system independent from the specific agent implementation.

The current provider contract is specifically designed around **agent sessions and turns**:

```text
startSession
sendTurn
interruptTurn
respondToRequest
stopSession
rollbackThread
streamEvents
```

That is appropriate for:

```text
Codex
Claude Code
OpenCode
Cursor
etc.
```

It is probably NOT the right abstraction for:

```text
Meshy
Tripo
ElevenLabs
ComfyUI
Unsloth image models
etc.
```

Therefore:

> Do not force media-generation services into T3's existing coding-agent `ProviderAdapter`.

Investigate a parallel generation architecture.

---

# 3. Proposed High-Level Architecture

Current hypothesis:

```text
┌─────────────────────────────────────────────────────────────┐
│                    GAME DEV HARNESS                         │
│                                                             │
│ Project   Agent   Files   Diff   Engine   Generations      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ↓                             ↓

          CODING AGENTS                 GENERATION SERVICE
                │                             │
         Codex / Claude           ┌───────────┼───────────┐
         OpenCode etc.            ↓           ↓           ↓
                                Image        3D         Audio
                                  │           │           │
                              providers   providers    providers
                │                             │
                └──────────────┬──────────────┘
                               ↓
                        GENERATED ASSET
                               ↓
                        ENGINE INTEGRATION
                               ↓
                        Unity / Unreal
```

Key separation:

```text
Generation Provider
        ↓
GeneratedAsset
        ↓
Engine Integration
```

NOT:

```text
MeshyUnityProvider
MeshyUnrealProvider
TripoUnityProvider
TripoUnrealProvider
```

Avoid provider × engine combinatorial architecture.

Prefer:

```text
Meshy
  ↓
GeneratedAsset(GLB)

Tripo
  ↓
GeneratedAsset(GLB)

             ↓

UnityImporter
UnrealImporter
```

---

# 4. Two Separate Unsloth Ideas

Unsloth is interesting for **two different reasons**.

Do not confuse them.

---

# 4A. Unsloth as an Optional Local AI Backend

In this model, we do NOT fork Unsloth Studio into the product.

Unsloth runs as external/local infrastructure:

```text
Game Dev Harness
       │
       │ local API / compatible interface
       ↓
    Unsloth
       │
       ├─ local LLM
       ├─ image/diffusion model
       ├─ multimodal model
       └─ audio model
```

The harness owns the product experience.

Unsloth is just one possible execution backend.

Example user configuration:

```text
Coding
Claude Code

Image
Local → Unsloth

3D
Meshy

Voice
ElevenLabs
```

Another user might choose:

```text
Coding
Codex

Image
Cloud provider

3D
Tripo

Voice
Local
```

The application must remain provider-neutral.

The agent should ask:

```text
generate_image(...)
```

not:

```text
run_unsloth_image_generation(...)
```

Provider resolution happens below the agent capability layer.

---

# 5. Why Unsloth Could Be Useful Locally

Possible roles include:

### Local image generation

```text
generate_image
      ↓
GenerationService
      ↓
Unsloth backend
      ↓
local GPU
```

### Local multimodal analysis

Potentially useful for cheap repetitive visual tasks.

### Local LLM/subagent work

Example:

```text
Claude Code
     ↓
high-value reasoning / coding

Local model
     ↓
asset classification
metadata
summarization
simple inspections
repetitive transformations
```

This could reduce reliance on expensive cloud inference for simple internal tasks.

---

# 6. Do Not Assume Unsloth Is the Best Local Image Backend

Compare it against alternatives, especially:

```text
ComfyUI
```

Possible final architecture could easily be:

```text
Local LLM       → Unsloth
Local Image     → ComfyUI
Cloud Image     → provider APIs
3D              → Meshy / Tripo
Audio           → ElevenLabs / local
```

Research rather than assume.

Criteria:

```text
Installation
Headless use
API quality
Job progress
Cancellation
GPU/model management
Output handling
Model ecosystem
Reliability
Licensing
Ease of embedding into Setup Integrations
```

---

# 7. Unsloth Idea B: Study Its Generation UX and Architecture

This may be strategically more valuable than using Unsloth itself.

Unsloth Studio has already had to solve many generic AI-workbench problems:

```text
local vs cloud
provider selection
model selection
model downloads
hardware state
model loading
capabilities
generation
tools
image inputs
image outputs
audio
history
errors
provider settings
```

We should inspect these patterns and independently implement the useful concepts.

Current Unsloth Studio code explicitly contains capability logic for determining whether providers/models support functionality including image generation and other model tools.

Its chat adapter also handles concerns including local models, external providers, model downloads, image generation, audio generation, tools and persistent runtime state.

These are useful architectural references.

---

# 8. Important Unsloth Licensing Boundary

Treat this as a hard engineering consideration.

The Studio files inspected are explicitly marked:

```text
SPDX-License-Identifier: AGPL-3.0-only
```

Therefore:

## Desired approach

```text
Unsloth source
      ↓
Research agent
      ↓
Behavioral / architectural notes
      ↓
Independent specification
      ↓
──────────────────────────
CLEAN IMPLEMENTATION BOUNDARY
──────────────────────────
      ↓
Our implementation agent
      ↓
Our T3-based implementation
```

Do not copy:

```text
React components
backend implementation
source code
comments
distinctive UI copy
assets
```

The purpose of studying Studio is:

> understand the problems they solved and derive our own requirements.

Not:

> port Studio.

If Unsloth is used as a runtime backend, prefer a clean external process/API boundary.

Any eventual bundling/distribution of AGPL components should receive separate OSS/legal review.

---

# 9. Required Unsloth Research Deliverable

Create:

```text
UNSLOTH_REFERENCE_NOTES.md
```

Analyze:

## Provider architecture

How does Studio conceptualize:

```text
provider
model
local model
external provider
API key
base URL
model capabilities
```

---

## Capability discovery

Especially:

```text
supports image input?
supports image output?
supports audio?
supports tools?
supports reasoning?
supports code execution?
```

What patterns should we independently reproduce?

---

## Model lifecycle

Understand:

```text
not installed
downloading
installed
loading
loaded
running
unloaded
failed
```

---

## Generation/task lifecycle

Look for useful patterns around:

```text
queued
running
progress
success
failure
cancel
retry
history
```

---

## Hardware UX

How are things like:

```text
GPU
VRAM
model fit
CPU fallback
```

communicated?

---

## Local/cloud experience

How does the system avoid making local models and cloud APIs feel like completely unrelated products?

---

# 10. Generation Service

Design a generation subsystem separate from coding-agent providers.

Do not over-generalize initially.

Potential conceptual structure:

```ts
GenerationService;
```

with jobs:

```ts
GenerationJob {
    id

    modality
    capability

    providerId
    providerJobId

    status
    progress

    input
    parameters

    outputs

    error

    createdAt
    startedAt
    completedAt
}
```

Potential status:

```text
created
queued
running
succeeded
failed
cancelled
```

Keep external generation state separate from game-engine state.

Example:

```text
generationStatus = succeeded

importStatus = not_imported
```

versus:

```text
generationStatus = succeeded

importStatus = imported

engineStatus = prefab_created
```

Do not build one enormous state enum.

---

# 11. GeneratedAsset Must Become First-Class Project State

Generation output should not just be:

```text
/path/to/file.glb
```

Explore:

```ts
GeneratedAsset {
    id

    modality:
        image
        model3d
        audio
        video
        animation

    localFiles[]

    generationJobId

    providerId

    sourceAssets[]

    metadata

    preview

    gameAssetSpec?

    engineImport?
}
```

---

# 12. Provenance Matters

Eventually a developer should be able to inspect an asset and see:

```text
barrel.glb

Generated:
Meshy

Generation:
#1837

References:
tavern_scene.png
barrel_concept_v2.png

Prompt:
...

Generated:
...

Imported:
...

Current project usage:
TavernScene
```

This enables:

```text
regeneration
iteration
debugging
cost tracking
dependency understanding
variation management
```

---

# 13. Provider Layer vs Game Capability Layer

These are different levels.

## Low-level generation providers

```text
ImageProvider
Model3DProvider
AudioProvider
VideoProvider
```

Possible implementations:

```text
Image
├─ Cloud A
├─ Cloud B
├─ ComfyUI
└─ Unsloth

3D
├─ Meshy
└─ Tripo

Audio
├─ ElevenLabs
└─ local
```

---

# 14. Game-Level Capabilities

The user should eventually think in game-development concepts.

Not providers.

Potential future capabilities:

```text
CreateProp
CreateCharacter
CreateEnvironmentAsset
CreateUIAsset
CreateVoice
CreateSoundEffect
CreateAmbientLoop
CreateAnimation
```

Example:

```text
CreateProp(
    "stylized wooden treasure chest"
)
```

could orchestrate:

```text
Reference image
      ↓
ImageProvider

3D mesh
      ↓
Model3DProvider

Opening SFX
      ↓
AudioProvider

Import
      ↓
Unity

Prefab configuration
      ↓
Agent / engine integration
```

Do NOT build this abstraction prematurely.

Start with explicit tools.

---

# 15. Initial Canonical Agent Tools

Explore a minimal common tool surface:

```text
generate_image
generate_3d
generate_audio

generation_status
generation_cancel
list_generations

inspect_generation

import_generated_asset
```

Potential later:

```text
create_game_asset
```

But don't begin with one giant magic tool.

Initially, allow the coding agent to compose:

```text
generate_image
      ↓
generate_3d
      ↓
inspect_generation
      ↓
import_generated_asset
```

---

# 16. CENTRAL QUESTION: How Do Coding Agents Access These Tools?

This is one of the highest-priority investigations.

If the user is currently inside:

```text
Claude Code
Codex
OpenCode
```

how does that agent gain access to:

```text
generate_image
generate_3d
generate_audio
inspect_generation
import_generated_asset
```

Investigate:

```text
MCP
native agent tool APIs
local HTTP
CLI tools
T3-specific bridges
agent-specific integrations
```

---

# 17. Can We Have One Canonical Game Harness Tool Server?

Strong hypothesis to test:

```text
                    GAME HARNESS TOOLS

                    generate_image
                    generate_3d
                    generate_audio
                    inspect_generation
                    import_asset
                           ↑
                           │
              ┌────────────┼────────────┐
              │            │            │
              ↓            ↓            ↓
          Claude Code     Codex      OpenCode
```

Potentially exposed through:

```text
MCP
```

If this works well, it avoids implementing media generation separately for every coding-agent runtime.

Explicitly test:

> Can one canonical tool layer work across our major coding agents?

---

# 18. Harness MCP vs Provider MCP

This distinction matters.

## Provider MCP

Example:

```text
Claude
  ↓
Meshy MCP
  ↓
Meshy
```

Advantages:

```text
fast
little engineering
provider-maintained
easy spike
```

Disadvantages:

```text
our application may not see the generation
weak centralized history
weak cost tracking
weak provider switching
provider-specific behavior
agent controls too much state
```

---

# 19. Harness-Owned Tool Layer

Better long-term hypothesis:

```text
Claude / Codex
       ↓
Game Harness Tool / MCP
       ↓
GenerationService
       ↓
Provider Adapter
       ↓
Meshy / Tripo / etc.
```

Now we own:

```text
GenerationJob
GeneratedAsset
project relationship
status
progress
cost
references
history
approval state
```

The coding agent doesn't need provider-specific knowledge.

---

# 20. MCP vs Direct APIs

Research BOTH.

There are three possible layers:

```text
Agent
 ↓
our generation tool
 ↓
GenerationService
 ↓
┌──────────────────────────────┐
│ Direct provider API          │
│ Provider MCP                 │
│ Local backend API/process    │
└──────────────────────────────┘
```

We do not require every provider to use the same underlying transport.

What matters is the canonical experience above it.

---

# 21. Can the Coding Agent Review What It Generated?

This is a top-level technical question.

Generation without feedback is incomplete.

The desired loop:

```text
Agent
 ↓
Generate
 ↓
Agent sees result
 ↓
Agent evaluates
 ↓
Agent changes prompt / parameters
 ↓
Regenerate
```

Test this separately for:

```text
Images
3D
Audio
Video
```

---

# 22. Image Review

Likely easiest.

Example:

```text
generate_image
      ↓
image.png
      ↓
GeneratedAsset
      ↓
┌──────────────────┐
│                  │
│ User can see it  │
│                  │
└──────────────────┘

AND

Agent receives image
      ↓
multimodal reasoning
```

Test for every supported coding agent:

```text
Can tool responses include images?

Can it inspect local image files?

Can it inspect generated attachments?

Can it receive image URLs?

Which representation works reliably?
```

---

# 23. Image Iteration Loop

Target:

```text
Agent generates barrel concept

Agent observes:
"The metal bands are too ornate."

Agent calls:

edit_image
or
generate_image(reference=previous)

Agent evaluates second version.
```

This should eventually be possible without the user manually moving files.

---

# 24. 3D Review Is More Complicated

An agent cannot meaningfully inspect raw:

```text
barrel.glb
```

We need an **agent-review representation**.

Potential pipeline:

```text
GLB
 ↓
Preview renderer
 ↓
front.png
side.png
back.png
perspective.png
 ↓
Agent vision
```

Potentially better:

```text
GLB
 ↓
Unity
 ↓
render in actual target scene
 ↓
game-view screenshot
 ↓
Agent vision
```

Explore both.

---

# 25. 3D Review Should Include Technical Evidence

Visual evaluation alone is insufficient.

Agent should potentially receive:

```text
Triangles: 18,300
Target: <5,000

Materials: 6
Target: <=2

Texture:
4096 × 4096

Target:
1024 × 1024

Rig:
none

Bounds:
...
```

Combine:

```text
visual review
+
technical inspection
```

Example agent reasoning:

```text
"The silhouette works, but this exceeds
the mobile project's triangle budget.

I'll regenerate or remesh it."
```

This is where a game-specific harness becomes substantially more valuable than generic generation tools.

---

# 26. Human View and Agent View Should Be Different

A generated asset has two consumers.

```text
                GeneratedAsset
                      │
          ┌───────────┴───────────┐
          ↓                       ↓
       USER VIEW                AGENT VIEW
```

For 3D:

### Human

```text
Interactive viewport
rotate
zoom
materials
animations
```

### Agent

```text
rendered screenshots
triangle counts
materials
textures
bounds
rig metadata
file paths
```

Do not force them to consume identical representations.

---

# 27. Audio Review

Research realistically.

For dialogue:

```text
audio
 ↓
transcript
 ↓
agent can verify content
```

Potential agent metadata:

```text
duration
speaker
transcript
sample rate
format
```

For SFX:

possible representations:

```text
waveform
spectrogram
duration
loudness
audio-capable multimodal model
```

Do not assume coding agents are good autonomous sound designers.

User review will likely remain more important for audio than image/technical checks.

---

# 28. User Review UX Is a First-Class Design Problem

Generation likely deserves a dedicated development surface.

Today common work surfaces are conceptually:

```text
Terminal
Browser
Problems
```

Potential new surface:

```text
Generation
```

or:

```text
Generations
```

This needs UX experimentation.

Do NOT simply build the first obvious tab.

---

# 29. UX Trial A — Inline Only

Generation appears directly in chat:

```text
Claude

I generated a concept.

┌─────────────────────────┐
│                         │
│       IMAGE             │
│                         │
├─────────────────────────┤
│ Viking Shield           │
│                         │
│ [Use] [Variation]       │
└─────────────────────────┘
```

Advantages:

```text
continuous conversation
easy relationship to agent reasoning
simple
```

Problems:

```text
chat becomes cluttered
poor for many generations
poor for comparison
poor for complex 3D inspection
```

---

# 30. UX Trial B — Dedicated Generation Tab

Potential workspace:

```text
Terminal | Browser | Generation
```

Generation surface:

```text
Viking Shield v3

[ LARGE PREVIEW ]

3D · provider

✓ Complete

Triangles 4,700
Materials 2

[Import]
[Variation]
[Regenerate]
```

Advantages:

```text
persistent
rich preview
history
comparison
large media surface
```

Potential problem:

```text
breaks conversational continuity
```

---

# 31. UX Trial C — Inline Card + Generation Inspector

Current preferred hypothesis.

Chat:

```text
Claude

Viking Shield v3
✓ Generated

[Preview]
```

Selecting it opens:

```text
Generation Inspector
```

The responsibilities become:

```text
Chat
=
intent
reasoning
task history

Generation tab
=
inspection
comparison
media controls
asset details
```

Prototype this seriously.

---

# 32. Possible Workspace Model

Example only:

```text
┌───────────────────────────────────────────────────────┐
│ Project                                      ▶ Unity │
├──────────────────────────────┬────────────────────────┤
│                              │                        │
│                              │                        │
│          AGENT CHAT          │      FILES / DIFF      │
│                              │                        │
│                              │                        │
├──────────────────────────────┴────────────────────────┤
│ Terminal | Browser | Generation                      │
├───────────────────────────────────────────────────────┤
│                                                       │
│              GENERATION INSPECTOR                     │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Generation should feel like another development tool.

Not a separate AI application embedded into ours.

---

# 33. Modality-Specific Inspector

One shared Generation surface, different content.

## Image

```text
Concept Art v3

[ IMAGE ]

Provider
...

References
...

Prompt
...

[Use]
[Edit]
[Variation]
[Open File]
```

---

## 3D

```text
Fantasy Barrel

[ INTERACTIVE 3D VIEWER ]

Perspective
Front
Side
Game View

Triangles
4,820

Textures
1024

Materials
2

[Import]
[Regenerate]
[Remesh]
```

---

## Audio

```text
Chest Open

▶ ━━━━━━━━━━━━━━━━━

2.7 sec

[ waveform ]

[Use]
[Variation]
[Regenerate]
```

---

# 34. Generation History

A user should eventually be able to see:

```text
Barrel

v1
v2
v3 ← selected

┌─────┐ ┌─────┐ ┌─────┐
│     │ │     │ │     │
└─────┘ └─────┘ └─────┘
```

and know:

```text
which version is selected
which was imported
which is being used in scene
what prompt created it
what source asset it came from
```

This implies generation belongs primarily to the **project**, not the chat thread.

Threads can reference generation IDs.

---

# 35. Generation Context

A major game-specific advantage is that the agent can use project context automatically.

User says:

```text
"Make a barrel matching this game."
```

The system could supply:

```text
scene screenshot
existing concept art
nearby props
selected object
art direction document
target engine
platform
technical budgets
```

Explore:

```ts
GenerationContext {
    projectId

    referenceAssets[]
    sceneScreenshots[]
    selectedObjects[]

    styleReferences[]

    targetEngine
    targetPlatform

    technicalConstraints
}
```

Do not overbuild yet.

---

# 36. User-Selected Context

Potential interactions:

```text
Select object
 ↓
"Generate a variation"
```

or:

```text
Select three images
 ↓
"Make a prop matching these."
```

or:

```text
Current Unity scene
 ↓
"Add a merchant stall here."
```

The selected context must become understandable by the coding agent and GenerationService.

---

# 37. GameAssetSpec

Explore a lightweight engine-aware specification.

Potential:

```ts
GameAssetSpec {
    targetEngine

    targetPlatform

    assetType

    geometry?: {
        targetPolycount
        lod
    }

    textures?: {
        maxResolution
        pbr
    }

    physics?: {
        collider
    }

    character?: {
        rigged
        humanoid
    }

    audio?: {
        format
        loop
    }
}
```

Do not create a giant schema.

Determine the minimum required by real spikes.

---

# 38. Provider Capability Matrix

Create:

```text
PROVIDER_MATRIX.md
```

At minimum research:

```text
Meshy
Tripo
Unsloth
ComfyUI
ElevenLabs
```

Potential table:

| Capability     | Meshy | Tripo | Unsloth | ComfyUI | ElevenLabs |
| -------------- | ----- | ----- | ------- | ------- | ---------- |
| Text → Image   |       |       |         |         |            |
| Image → Image  |       |       |         |         |            |
| Text → 3D      |       |       |         |         |            |
| Image → 3D     |       |       |         |         |            |
| Multiview → 3D |       |       |         |         |            |
| Texturing      |       |       |         |         |            |
| Remeshing      |       |       |         |         |            |
| Rigging        |       |       |         |         |            |
| Animation      |       |       |         |         |            |
| TTS            |       |       |         |         |            |
| SFX            |       |       |         |         |            |
| Local runtime  |       |       |         |         |            |
| Cloud API      |       |       |         |         |            |
| MCP            |       |       |         |         |            |
| Progress       |       |       |         |         |            |
| Cancel         |       |       |         |         |            |
| Webhook        |       |       |         |         |            |

Also investigate:

```text
pricing
rate limits
credentials
output formats
SDK maturity
API stability
licensing
commercial usage
game-readiness
```

Separate:

```text
verified facts
```

from:

```text
our evaluation
```

---

# 39. 3D Providers: Initial Research Focus

Start with:

```text
Meshy
Tripo
```

Do not support both immediately.

Compare:

```text
text-to-3D
image-to-3D
quality
latency
topology
polycount controls
textures
PBR
output formats
rigging
animation
progress reporting
cancellation
API ergonomics
pricing
reliability
Unity compatibility
```

The first implementation can use whichever produces the fastest credible vertical slice.

---

# 40. Audio Provider

Use ElevenLabs as the first cloud audio reference.

Research:

```text
TTS
character voice
sound effects
ambience
looping behavior
cost
job semantics
output format
```

Our eventual game abstractions should be:

```text
CharacterVoice
DialogueLine
SoundEffect
AmbientLoop
UISound
Music
```

not:

```text
ElevenLabs API endpoint
```

---

# 41. Local Backend Research

Compare:

```text
Unsloth
ComfyUI
```

Criteria:

### Setup

Can our current project integration flow eventually expose:

```text
Setup Integrations
```

and install/configure the local backend with low friction?

### Runtime detection

Can we know:

```text
running?
installed?
version?
GPU?
VRAM?
available models?
```

### Generation

Can we:

```text
submit
observe
cancel
retry
retrieve output
```

### Headless use

Can the harness control it without forcing users into another app?

### Commercial/licensing implications

Document clearly.

---

# 42. Agent Review Must Be Tested Per Agent

Create:

```text
AGENT_GENERATION_TOOLING.md
```

For:

```text
Claude Code
Codex
OpenCode
```

answer:

### Tool access

Can it consume:

```text
MCP tools?
local tool servers?
native tool definitions?
CLI tools?
```

### Image input

Can it inspect:

```text
local image path?
tool-returned image?
URL?
attachment?
```

### Tool output

Can it receive:

```text
structured JSON?
files?
image references?
multiple files?
```

### Long-running operations

How should agent interaction behave when:

```text
3D generation takes time?
```

Does tool call block?

Does it return a job?

Should agent poll?

Should our service notify completion?

---

# 43. Async Job Design

This is important.

Potential pattern:

```text
generate_3d()
 ↓
returns:
{
    generationId: "..."
    status: "running"
}
```

Then:

```text
generation_status(id)
```

Alternatively:

```text
generate_3d
 ↓
tool stays active until completion
```

Compare both.

Consider:

```text
agent usability
timeouts
UI progress
cancellation
remote clients
crash recovery
provider API semantics
```

---

# 44. Remote Client Implications

The harness may eventually have remote access.

Potential:

```text
Phone / remote client
       ↓
T3 server / project machine
       ↓
GenerationService
       ↓
local GPU / provider API
       ↓
game project
```

Generation execution belongs to the **environment/project host**, not the UI client.

Do not accidentally make local generation dependent on the remote viewing device.

---

# 45. Credential Handling

Research existing T3 patterns for secrets.

We will need things like:

```text
MESHY_API_KEY
TRIPO_API_KEY
ELEVENLABS_API_KEY
other provider credentials
```

Requirements:

```text
never commit to game project
encrypted / protected appropriately
environment-specific
remote-client safe
```

---

# 46. Costs

Do not make pricing part of the core contract.

Pricing changes.

But architecture should allow optional metadata:

```text
estimatedCost
actualCost
creditsConsumed
```

Potential UX:

```text
3D generation

Meshy
Estimated: ~X credits

[Generate]
```

Later:

```text
This project has spent:
3D: ...
Images: ...
Audio: ...
```

Not part of first spike.

---

# 47. Human Approval vs Agent Autonomy

Generation needs permission semantics similar to coding actions.

Explore three modes.

## Manual

```text
Generate
 ↓
User review
 ↓
Use / reject
```

---

## Autonomous

```text
Generate
 ↓
Agent evaluates
 ↓
Regenerate if necessary
 ↓
Import
```

---

## Hybrid

Likely default:

```text
Agent generates
 ↓
Agent performs quality/technical check
 ↓
User sees candidate
 ↓
User approves import
```

Potential permission model:

```text
Allow image generation            ✓
Allow automatic variations        ✓
Allow paid cloud generation       ask
Allow importing generated 3D      ask
Allow modifying Unity scene       existing agent permission
```

Explore, don't overbuild.

---

# 48. Tool Result Contract

Tool should NOT merely return:

```text
/tmp/barrel.glb
```

Explore something like:

```json
{
  "generationId": "...",
  "assetId": "...",
  "status": "succeeded",
  "modality": "model3d",

  "files": [],

  "preview": {
    "thumbnail": "...",
    "renders": []
  },

  "metadata": {
    "triangles": 4700,
    "materials": 2
  },

  "provider": "...",

  "reviewable": true
}
```

This lets BOTH UI and coding agent continue intelligently.

---

# 49. First End-to-End Vertical Spike

Prioritize 3D because it most clearly demonstrates game-development differentiation.

Goal:

> From a coding-agent request, generate a simple 3D prop and get it into a running Unity scene.

Example:

```text
"Create a stylized wooden barrel
and place it next to the tavern."
```

Expected flow:

```text
User
 ↓
Claude / Codex
 ↓
generate_3d
 ↓
GenerationService
 ↓
3D provider
 ↓
GenerationJob
 ↓
GLB
 ↓
GeneratedAsset
 ↓
Unity import
 ↓
material configuration
 ↓
prefab
 ↓
collider
 ↓
scene placement
 ↓
Play
```

The first spike does NOT need:

```text
perfect UI
many providers
billing
marketplace
enterprise features
perfect retry infrastructure
```

---

# 50. But Updated Success Criterion Is Stronger

The spike is NOT complete merely because:

```text
provider returned GLB
```

The useful target is:

```text
Coding agent
      ↓
can invoke generation
      ↓
harness tracks generation
      ↓
user can inspect it
      ↓
agent can inspect it
      ↓
agent or user can request variation
      ↓
chosen result can enter Unity
```

This is the actual loop we are proving.

---

# 51. Micro-Spike A — Agent → Provider MCP

Use one available provider MCP if practical.

Test:

```text
Claude/Codex
 ↓
provider MCP
 ↓
generate
 ↓
download asset
 ↓
Unity
```

Measure:

```text
integration effort
agent reliability
job observability
progress
cancel
metadata
output handling
```

Purpose:

> understand how far existing agent tooling gets us for almost free.

---

# 52. Micro-Spike B — Harness-Owned GenerationService

Implement the thinnest possible:

```text
Agent
 ↓
our tool
 ↓
GenerationService
 ↓
Provider REST/API
```

Persist:

```text
GenerationJob
GeneratedAsset
```

Then compare against direct provider MCP.

---

# 53. Architecture Decision: MCP vs Direct

Produce:

```text
MCP_VS_DIRECT.md
```

Compare:

```text
Agent → Provider MCP
```

versus:

```text
Agent → Harness Tool → GenerationService → provider
```

and potentially:

```text
Agent → Harness Tool → GenerationService → Provider MCP
```

Judge:

```text
developer experience
implementation cost
observability
reliability
provider portability
UI integration
cost tracking
permissions
asset history
remote support
```

Do not force one architecture across every provider.

---

# 54. Second Spike — Image → 3D

After basic 3D works, prove **cross-provider composition**.

Example:

```text
User:
"Make a stylized Viking shield."
```

Flow:

```text
Agent
 ↓
generate_image
 ↓
local/cloud image provider
 ↓
concept.png
 ↓
Agent visually reviews
 ↓
potential edit
 ↓
generate_3d(reference=concept.png)
 ↓
3D provider
 ↓
shield.glb
 ↓
agent reviews
 ↓
Unity
```

This is a more valuable proof than simple standalone image generation.

---

# 55. Third Spike — Audio

Example:

```text
"Give this treasure chest
a heavy wooden opening sound."
```

Flow:

```text
Agent
 ↓
generate_audio(type=SFX)
 ↓
audio provider
 ↓
WAV
 ↓
GeneratedAsset
 ↓
Generation tab
 ↓
user reviews
 ↓
Unity AudioClip
```

Automatic game-event wiring can come later.

---

# 56. Generation UX Prototypes Required

Before settling UX, implement or prototype three variants.

## Prototype A

```text
Inline cards only
```

## Prototype B

```text
Dedicated Generation tab only
```

## Prototype C

```text
Inline compact card
+
dedicated Generation inspector
```

Run real workflows through them:

```text
generate
wait
review
compare
give feedback
regenerate
select
import
```

Do not judge from static mockups alone.

Current preferred hypothesis:

```text
Prototype C
```

---

# 57. Generation Tab Should Behave Like a Development Tool

The mental model should be:

```text
Terminal
Browser
Generation
```

not:

```text
ChatGPT
+
embedded Midjourney
+
embedded Meshy
```

Generation is a work surface inside the project.

---

# 58. Agent-Generated Content Notification

Explore what happens while the user is coding.

Example:

```text
3D generation running...
```

The user should not necessarily lose focus.

Potential:

```text
Generation tab ● 1
```

or:

```text
Barrel finished generating
[Review]
```

Do not automatically switch tabs unless appropriate.

---

# 59. Agent Can Continue Working While Generation Runs

Potentially powerful:

```text
Agent starts 3D generation
        ↓
while provider runs
        ↓
agent creates BarrelController.cs
        ↓
asset finishes
        ↓
agent imports it
```

Explore whether asynchronous generation can enable parallel agent work rather than blocking the entire turn.

This could become a meaningful productivity feature.

---

# 60. Generation Comparison

Eventually support:

```text
v1
v2
v3
```

with:

```text
compare
select
reject
regenerate from
```

For 3D:

```text
side-by-side viewport
```

For image:

```text
side-by-side image
```

Do not need for first spike, but ensure state model doesn't make it difficult.

---

# 61. Agent Needs to Know Human Selection

Example:

User selects:

```text
Barrel v2
```

and says:

```text
"Use this one but make the top wider."
```

The coding agent should receive:

```text
selectedGenerationId
selectedAssetId
```

along with the message.

Generation selection therefore needs to participate in chat context similarly to selected files or other project context.

---

# 62. Potential Future Region / Object Feedback

Do not implement now.

But explore architecture implications.

Image:

```text
User selects area
 ↓
"Make this larger."
```

3D:

```text
User rotates camera
or selects part/object
 ↓
"Change this."
```

Generation UX may eventually need richer context than just asset ID.

---

# 63. Game-Specific Automated Review

One of the strongest opportunities.

Generic generator says:

```text
Generation completed.
```

Game harness says:

```text
Generation completed.

Target:
Mobile prop

Result:
18,000 triangles

Recommended:
<5,000

Texture:
4096

Recommended:
1024
```

This allows the coding agent to automatically enforce game constraints.

Future validation:

```text
polycount
materials
texture memory
missing textures
UVs
scale
bounds
colliders
rig
animation
audio format
platform constraints
```

This could become a major product moat.

---

# 64. Unity Review Loop

Potentially the strongest review method is not standalone asset inspection.

It's:

```text
Generate
 ↓
Import
 ↓
Place
 ↓
Unity Game View
 ↓
Screenshot
 ↓
Agent visually evaluates
```

Example:

```text
"The barrel is too tall relative
to the tavern doorway.

I'll scale or regenerate it."
```

This links generation directly to the actual game context.

Prioritize experiments around this.

---

# 65. Long-Term North-Star Interaction

User:

```text
"Add a blacksmith to this village."
```

Potential eventual orchestration:

```text
                     BLACKSMITH
                          │
       ┌──────────────────┼───────────────────┐
       │                  │                   │
       ↓                  ↓                   ↓

   Concept Art         3D Character          Voice
       │                  │                   │
   ImageProvider       3DProvider         AudioProvider
       │                  │                   │
       └──────────────────┼───────────────────┘
                          ↓
                      Asset Spec
                          ↓
                        Unity
                          ↓
                  Materials / Rig
                          ↓
                       Prefab
                          ↓
                    Village Scene
                          ↓
                       Play Mode
                          ↓
                    Game screenshot
                          ↓
                    Agent evaluates
                          ↓
                        iterate
```

Do not build this now.

Use it to judge whether architectural decisions lead in the right direction.

---

# 66. Critical Research Questions

The orchestrator MUST explicitly answer these.

## Agent Tooling

1. How does Claude Code access generation tools?
2. How does Codex access them?
3. How does OpenCode access them?
4. Can one MCP/tool server serve all of them?
5. What functionality differs between agents?
6. How are rich tool results represented?
7. How are local project files exposed safely?

---

## Async Generation

8. Should generation calls block or return jobs?
9. Who polls external providers?
10. Can agents work while a job runs?
11. How does cancellation work?
12. How does retry work?
13. What happens if the desktop app closes?
14. What happens if the agent session ends?
15. What happens if a remote client disconnects?

---

## Agent Review

16. Can agents inspect generated images reliably?
17. What exact input format works best?
18. How should agents inspect 3D?
19. Should we render automatic turntable screenshots?
20. Should Unity render the asset in context instead?
21. What metadata should accompany 3D screenshots?
22. Can agents meaningfully inspect audio?
23. Which inspections should remain human-only?

---

## Human UX

24. Inline generation?
25. Dedicated Generation tab?
26. Both?
27. How should generation completion notify the user?
28. How do users compare variations?
29. How does user selection become agent context?
30. How do users approve/reject imports?
31. How should generation history work?

---

## Architecture

32. Does GenerationService use T3's event system?
33. Does it need separate persistence?
34. Should generation jobs be project-scoped?
35. How should `GeneratedAsset` relate to files?
36. How are provider credentials stored?
37. How should local generation run on project hosts?
38. How much of provider transport should MCP handle?
39. What does our own canonical capability layer need?

---

## Game Engine

40. What is the minimum Unity import contract?
41. What can Unity CLI/Pipeline automate?
42. How do we inspect an imported model?
43. How do we capture Game View for agent review?
44. Can agent generation and Unity operations be safely chained?
45. Where should approval boundaries occur?

---

# 67. Deliverables

Before large implementation, produce the following.

---

## `GENERATION_ARCHITECTURE.md`

Include:

```text
system diagram
service boundaries
provider boundary
agent tool boundary
GenerationJob
GeneratedAsset
project ownership
persistence
async model
engine boundary
remote execution
credentials
errors
cancellation
```

---

## `AGENT_GENERATION_TOOLING.md`

For:

```text
Codex
Claude Code
OpenCode
```

document:

```text
tool protocol
MCP support
file/image support
multimodal support
async behavior
limitations
recommended integration
```

---

## `UNSLOTH_REFERENCE_NOTES.md`

Include:

```text
useful UX patterns
provider patterns
capability patterns
local/cloud patterns
model lifecycle
download lifecycle
hardware UX
patterns worth independently implementing
patterns NOT to copy
license boundary
```

---

## `PROVIDER_MATRIX.md`

Compare:

```text
Meshy
Tripo
Unsloth
ComfyUI
ElevenLabs
```

---

## `MCP_VS_DIRECT.md`

Compare:

```text
direct provider MCP
harness MCP
direct provider API
hybrid architecture
```

---

## `GENERATION_UX_EXPLORATION.md`

Prototype:

```text
inline
tab
hybrid
```

Include actual workflow observations.

---

## `SPIKE_RESULTS.md`

Document reality:

```text
what worked
what failed
latency
API issues
agent behavior
review quality
Unity import issues
provider quality
integration complexity
```

---

## Architecture Decision Record

Finish with an explicit recommendation.

Potential outcomes:

### A

```text
T3
+
custom GenerationService
```

### B

```text
T3
+
GenerationService
+
Unsloth optional local backend
```

### C

```text
T3
+
thin GenerationService
+
heavy MCP usage
```

### D

```text
different architecture
```

Option D requires strong technical evidence.

---

# 68. Recommended Work Order

Do not start by implementing everything.

Proceed:

```text
1.
Inspect current T3 architecture.

2.
Determine exactly how Codex / Claude /
OpenCode receive custom tools.

3.
Test one trivial harness-owned custom tool
through each agent.

4.
Inspect Unsloth Studio architecture as
reference only.

5.
Research Meshy / Tripo / ComfyUI /
Unsloth / ElevenLabs.

6.
Design minimum:
GenerationJob
GeneratedAsset

7.
Build provider-MCP micro-spike.

8.
Build harness-owned GenerationService
micro-spike.

9.
Compare.

10.
Build:
Agent → 3D generation → human review.

11.
Add:
Agent review of 3D via screenshots + metadata.

12.
Import asset into Unity.

13.
Capture Unity Game View.

14.
Give screenshot back to coding agent.

15.
Allow agent to iterate.

16.
Prototype Generation UX:
inline / tab / hybrid.

17.
Build image → 3D composition spike.

18.
Test local image backend:
Unsloth vs ComfyUI.

19.
Build audio spike.

20.
Return with final architectural proposal
before expanding provider count.
```

---

# 69. First Major Success Criterion

The first meaningful proof is:

```text
User asks coding agent
for a game asset

        ↓

Coding agent has access
to generation capability

        ↓

Generation runs

        ↓

Harness knows:
what
why
where
provider
status

        ↓

User can review it

        ↓

Agent can review it

        ↓

Either can request iteration

        ↓

Selected result enters Unity

        ↓

Game runs

        ↓

Agent can observe result
in game context
```

If that works cleanly, the architecture is promising.

---

# 70. What We Are NOT Building

Do not accidentally turn this phase into:

```text
AI asset marketplace
full DAM
full local-model manager
full ComfyUI replacement
full Meshy replacement
full image editor
full Blender replacement
generic multimodal AI chat app
```

We are building:

> **the orchestration and review layer connecting coding agents, generative AI and game engines.**

---

# 71. Avoid Provider-Centric Product Design

Bad:

```text
OpenAI
Gemini
Meshy
Tripo
ElevenLabs
```

Better:

```text
Image
3D
Audio
```

Long-term:

```text
Create Prop
Create Character
Create Environment
Create Sound
```

Providers are implementation choices.

Game-development capabilities are product concepts.

---

# 72. Avoid Tightly Coupling Generation to Chat

Chat is how intent enters.

Generation is project state.

Therefore:

```text
Thread
  ↓ references
Generation

Project
  ↓ owns
Generation
```

A generated asset should survive:

```text
thread deletion
new agent session
switch from Claude to Codex
application restart
```

assuming the project itself remains.

---

# 73. Avoid Tightly Coupling Generation to One Agent

The user may start with:

```text
Claude
```

then switch to:

```text
Codex
```

Both should see project generations.

Therefore:

```text
Generation state
```

belongs to our harness.

Not Claude.

Not Codex.

Not Meshy.

---

# 74. Avoid Tightly Coupling Generation to One Provider

Likewise:

```text
barrel concept
```

could come from:

```text
local model
```

while:

```text
barrel 3D
```

comes from:

```text
Meshy
```

then later be regenerated through:

```text
Tripo
```

Same game-development workflow.

---

# 75. Potential Strategic Moat

Keep this in mind while designing.

The defensible layer is unlikely to be:

```text
"we have a Meshy API integration"
```

or:

```text
"we can call image generation"
```

Those will commoditize.

Potentially stronger differentiation is:

```text
game project understanding

game-specific context gathering

engine-aware generation constraints

automated asset validation

agent review representations

asset provenance

generation → engine import

scene placement

game-view observation

agent iteration

cross-provider composition

low-friction setup
```

In other words:

> **the workflow graph around generated assets**, not the underlying generation model.

---

# 76. Final Architecture Hypothesis to Falsify

Current preferred direction:

```text
                         GAME DEV HARNESS
                                │
              ┌─────────────────┼────────────────┐
              │                                  │
              ↓                                  ↓

         AGENT CONTROL                    GENERATION SYSTEM
              │                                  │
      ┌───────┼────────┐               ┌─────────┼─────────┐
      ↓       ↓        ↓               ↓         ↓         ↓
    Codex   Claude   OpenCode         Image      3D       Audio
                                      │          │         │
                                  Providers  Providers  Providers
              │                                  │
              └─────────────────┬────────────────┘
                                ↓
                         GeneratedAsset
                                ↓
                        Engine Integration
                                ↓
                         Unity / Unreal
                                ↓
                           Game Output
                                ↓
                     screenshot / metadata
                                ↓
                           Agent review
```

With Unsloth participating in two possible ways:

```text
1.
Optional local AI/model backend.

2.
Architectural/UX reference for how
a multimodal local/cloud workbench handles
models, capabilities and generation.
```

Unsloth does NOT need to become the product foundation.

---

# 77. Final Instruction to the Implementation Orchestrator

Optimize this exploration for **learning**, not code volume.

Do not prematurely:

```text
support many providers
design giant abstractions
rewrite T3
fork Unsloth Studio
build polished UX
create generalized engine support
```

Instead, answer the fundamental question:

> **Can a coding agent inside our harness naturally use multimodal generation tools, understand the generated results, collaborate with the human to select or iterate on them, and then use the selected assets directly inside a game project?**

The smallest convincing demonstration is:

```text
Claude/Codex
     ↓
"Create a barrel"
     ↓
3D generation tool
     ↓
Generation tab
     ↓
human + agent review
     ↓
Unity import
     ↓
scene placement
     ↓
Play
     ↓
game screenshot
     ↓
agent evaluates result
```

If this interaction feels coherent, fast and native to coding-agent work, proceed toward the larger multimodal game-development system.

If it feels like several external AI products loosely glued together, revisit the architecture before expanding scope.
