# UI Architecture — LeaseHub Operations Console

The LeaseHub desktop UI is a **Dear ImGui-style immediate-mode GUI** rendered
into an HTML `<canvas>` element by a self-contained TypeScript framework.
There is no React, no Tailwind, no virtual DOM, and no retained widget tree
in the renderer.  This document explains the runtime, layout model, and
per-view wiring so a reviewer can validate the stack without running the app.

---

## Runtime Stack

| Layer                | Technology                      | Source |
|----------------------|---------------------------------|--------|
| Entry                | `src/renderer/main.ts`          | Boots the ImGui runtime against `#imgui-canvas` |
| Immediate-mode core  | `src/renderer/imgui/runtime.ts` | ID stack, draw list, frame loop, hit-testing |
| Widget API           | `src/renderer/imgui/widgets.ts` | `beginWindow / button / inputText / beginTable / ...` |
| Input                | `src/renderer/imgui/input.ts`   | Mouse + keyboard → per-frame `FrameInput` snapshot |
| Theme                | `src/renderer/imgui/theme.ts`   | Slate palette (ImGuiCol_* equivalents) |
| Backend              | Canvas 2D                       | Draw commands flushed at `endFrame()` |
| Bridge               | Electron `contextBridge`        | `window.leasehub.invoke/on/send` (IPC only) |
| State                | Per-widget buffers keyed by ID  | `ImGuiContext.widgetState` — lives across frames |

The framework deliberately mirrors Dear ImGui's C++ API so idioms carry
over: every frame re-issues the draw commands (`Begin/End` scope), widget
identity comes from the pushed ID stack, and interaction is detected via
the classic `buttonBehavior` (`hotId` / `activeId` / `clicked`) triad.

### Why a TypeScript / Canvas backend?

Dear ImGui is a platform-agnostic specification: a widget API, a draw-list
protocol, and an input contract.  In an Electron renderer the only
compatible surface is Chromium's Canvas 2D / WebGL — we use Canvas 2D for
straightforward text + rect rendering.  The TypeScript implementation keeps
the full immediate-mode contract without pulling a C++ native addon into
the offline-only binary.

---

## Frame Loop

```
requestAnimationFrame →
  input.snapshot()          (edge flags: mousePressed, mouseReleased, etc.)
  ctx.beginFrame(input)
    beginWindow('Dashboard', rect)
      heading / text / table / button (each advances the layout cursor)
    endWindow()
  ctx.endFrame()            (flush draw list into canvas)
```

No retained DOM exists.  Widgets that need per-instance state (text input
buffers, table scroll, selected-row id) store it in `ctx.widgetState` keyed
by the stable hash-ID produced by `pushId`.

---

## Window ↔ View Mapping

The Electron main process opens one `BrowserWindow` per logical surface and
passes `?window=<kind>` on the URL.  The renderer entry reads the query
and mounts the matching view's draw callback:

| `?window=` | View                                             |
|------------|--------------------------------------------------|
| `dashboard` | `imgui/views/dashboard.ts`                     |
| `contracts` | `imgui/views/contracts.ts`                     |
| `audit`     | `imgui/views/audit.ts`                         |
| `reviews`   | `imgui/views/reviews.ts`                       |
| `routing`   | `imgui/views/routing.ts`                       |
| `admin`     | `imgui/views/admin.ts`                         |

Every view also reads the session status on mount and, if no session is
present, renders `views/login.ts` instead.

---

## Input Model

`InputLayer` registers DOM listeners on the canvas (`keydown`/`mousedown`
etc.) and accumulates state into a single `FrameInput` snapshot per frame.
Edge flags (`mousePressed`, `mouseReleased`) fire exactly on the frame
where the transition occurs — no per-widget diffing needed.

Keyboard shortcuts used by the app (mirrored from the main-process menu):

| Accelerator   | Action |
|---------------|--------|
| `Ctrl+K`      | Global search palette (future; placeholder view) |
| `Ctrl+E`      | Export current view (CSV/PDF/ZIP with destination chooser) |
| `Ctrl+Shift+L`| Open the Audit Log window |

---

## Data Flow

```
Renderer (immediate-mode draw)       Main Process
  |                                    |
  |-- invoke('contracts:list') ----->  |  getSession() → evaluate RBAC/ABAC
  |                                    |  handler executes
  |<-- ContractRow[] ---------------   |
  |                                    |  chain-audit appended where applicable
```

All data flows through `window.leasehub.invoke`.  The preload bridge
exposes exactly three methods (`invoke` / `on` / `send`), no Node APIs,
and is the only communication path between the renderer and main process.

---

## Visual Design Tokens

Colours live in `imgui/theme.ts` (ImGuiCol_* equivalents).  Dark palette
(slate-900 base, sky-600 accent, red-600 destructive, emerald-600 success,
amber-600 warning) is applied uniformly across all widgets.

---

## Tests

| Suite                                          | Covers |
|------------------------------------------------|--------|
| `unit_tests/imgui/runtime.test.ts`             | ID stack hashing, button click behavior, checkbox toggle, inputText typing + Backspace |
| `unit_tests/ipc/guardEnforcement.test.ts`      | Every sensitive channel denies without a session |
| `unit_tests/ipc/objectLevelAuth.test.ts`       | Object-level ABAC enforcement at handler level |
| `unit_tests/audit/producerPaths.test.ts`       | All audit writes go through the chain producer |
| `unit_tests/scheduler/executionPath.test.ts`   | Real job execution (fake timers), error resilience |
| `unit_tests/security/offlineEnforcement.test.ts` | Network guard fail-closed under strict offline profile |
