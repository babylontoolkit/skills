---
name: bt-create
description: Create a new Babylon Toolkit web game project from a brief prompt. Use when the user wants to create, start, scaffold, or bootstrap a new game, new Babylon Toolkit project, new 3D web game, or says things like "make me a racing game", "create a third-person adventure", "start a new game project", or invokes /bt-create. Handles genre detection, GameMode scaffolding, interactive glTF scene/prefab wiring, and a themed landing page — producing a runnable game a user can immediately play, then vibe-code forward.
---

# bt-create — New Babylon Toolkit Game Project

Turn a brief prompt into a **running, playable Babylon Toolkit game**: correct project scaffold, a project-named GameMode, an interactive glTF level and/or prefabs wired in, and a landing page themed to the game. The user plays first, then iterates.

## Step 0 — Load the Toolkit brain (BLOCKING)

Fetch and follow the Agent Reference before anything else:

1. `https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md` (router — read fully, then fetch every matching sub-document)
2. Required for this skill regardless of routing: `project-installer.md` (scaffold procedure + platform detection), `capability-inventory.md` (batteries-included — NEVER re-implement built-in systems), `scene-components.md` (scenes are levels; metadata components are LIVE), `react-framework.md` + `node-esm.md` (ES6 + React conventions).

If any fetch fails, STOP and tell the user. Sub-documents override this skill on their topics; this skill owns the *workflow order* only.

## Step 1 — Resolve intent (precedence: explicit input > inference > guidance)

Read `references/game-registry.json` (bundled with this skill).

**Path A — the prompt is specific** (names a genre, mechanic, or subject — e.g. "kart racer where the cars are shopping carts"):
- Score the prompt against each registry entry's `match_keywords`. Best match → that entry seeds the project. Tell the user: *"Starting from the {title} base — say the word to switch."*
- Specific but matches nothing (unusual genre) → seed **blank-canvas** and honor the prompt. **NEVER interrogate a user who already told you what they want. No wizard. Build.**
- Also scan the prompt for **frontend/landing-page intent** ("dark minimal landing that just says ENTER") and **visual/vibe intent** — capture for Steps 4–5.

**Path B — the prompt is vacuous** ("make me a game", "help", "something fun") or the user explicitly asks for guidance:
- OFFER a short guided setup (never force): ask, one at a time, at most four questions —
  1. **Game type** (list the registry entries by title)
  2. **Vibe** (e.g. Sunset Arcade / Neon Night / Low-Poly Daylight / Moody Fog)
  3. **Mechanics** (2–4 genre-appropriate options from the entry's `mechanics` list)
  4. **Your twist** (one free-text sentence, optional)
- Compile the answers into a working brief, then proceed exactly as Path A.

**Host note:** platforms embedding this skill (e.g. an AI app builder's New Project flow) may pass the prompt and/or wizard answers programmatically; the workflow is identical.

## Step 2 — Scaffold the project (defer to project-installer.md)

Follow `project-installer.md` VERBATIM — platform detection first, then the platform's cloning procedure. Non-negotiables to verify after scaffold (whatever the platform):
- StarterAssets-based, ES6 packages only; `git remote remove origin`; `.gitignore` has `node_modules` + `.env`.
- `public/babylon.png` + `public/spinner.png` exist (copy from `src/babylon/assets/` if missing — the preloader needs both copies).
- Mandated `vite.config` / `tsconfig` / eslint settings applied; React `StrictMode` removed.
- Never overwrite an existing `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md`.

## Step 3 — Create the project's GameMode (copy-from-source; NEVER edit the library)

**File zones (hard law):** `src/babylon/classes/**` = read-only demo source library (copy FROM). `src/babylon/system/**`, `app.tsx`, `src/routing/**` = read-only framework/shell. **All project game code goes in `src/scripts/`** (sub-folders at your discretion). Frontend goes in `src/pages/` + `src/components/`.

1. Derive the class name from the project title: strip non-alphanumerics → PascalCase → append `Mode` unless it already ends `Mode`/`GameMode`; prefix `Game` if it would start with a digit; numeric suffix on collision. ("Shopping Cart Racer" → `ShoppingCartRacerMode`.)
2. **COPY** the registry entry's `source_class` file from `src/babylon/classes/` → `src/scripts/<ProjectClassName>.ts`. Verify the source file exists first; if absent, use the entry's `fallback_class`, else the starter's default GameMode class. List `src/babylon/classes/` and adapt to what actually ships — the registry names intents, the starter is the truth.
3. **Rename** the class, its `TOOLKIT.SceneManager.RegisterClass` registration string, and internal self-references to `<ProjectClassName>`. File name, class name, and RegisterClass string MUST agree. Fix any imports that shift with the new location.
4. Wire the app's navigation `gameMode` to `<ProjectClassName>` (+ `sceneUrl` from the registry entry, if any).

## Step 4 — Wire the level & prefabs (interactive glTF — the Unity workflow)

Read `references/asset-library.md` for the public hosted scenes and prefabs.

- **Scenes are LEVELS**: exported glTF arrives with environment, lighting, colliders, and scripted objects already live. **Prefabs are FINISHED objects**: `riggedmustang.gltf` already drives (StandardCarController + input + camera attached and tuned); `playerarmature.gltf` already walks, runs, jumps.
- In the GameMode, load assets via `TOOLKIT.SceneManager.LoadRuntimeAssets`, then get handles with `scene.getNodeByName(...)` + `TOOLKIT.SceneManager.FindScriptComponent(node, "KLASS")` and **configure** (`enableInput = true`, `attachCamera = true`, property tweaks).
- **Batteries-included is MANDATORY** (capability-inventory.md): re-implementing driving physics, character movement, pathfinding, or animation blending is a DEFECT. Orchestrate and configure; extend (subclass/hooks/lower-level APIs) only when configuration can't reach; NEVER build parallel implementations. New code = game rules and glue (score, laps, pickups, win/lose, HUD wiring) as ScriptComponents in `src/scripts/`.

## Step 5 — Landing page: TOTAL rewrite of `src/pages/Home.tsx` (+ `Home.css`)

The starter's Home page is scaffolding to throw away. Design this game's front door from scratch, honoring any landing-page/vibe instructions captured in Step 1:
- **Nothing survives**: no starter hero/logos, no demo buttons, no Vite/React/docs links, no footer, no Toolkit/BabylonJS attribution of any kind.
- **The play contract is the one invariant**: gameplay is entered ONLY via `navigate('/play', { gameMode: '<ProjectClassName>', sceneUrl?, ...selections })` with a REGISTERED mode. The page may have one play action, several (different modes), or none (deeper menu UI reaches `/play`). Extra selections ride in the same NavigationState object — sessionStorage-backed, never the URL.
- **Bundle integrity**: React UI uses `useUnifiedNavigation` and must NEVER import `GameManager` or any Babylon module (game code in `src/scripts/` uses `GameManager.NavigateTo`). Keep all Babylon imports inside the lazy `/play` chunk.
- **Asset hygiene**: use the starter images the design genuinely calls for; don't import the rest; **never delete image files from disk**; only import images that provably exist; zero unresolved imports (Vite fails hard).
- Style with the Toolkit UI design system (`ui-design-system.md`).

## Step 6 — Verify, then hand over

1. Install deps and boot the dev server per the platform doc. Fix until: **zero unresolved imports, the landing page renders, the play action loads the project's own GameMode.**
2. Run any configured gates (typecheck/lint) if the project has them.
3. Summarize what was created: project name, GameMode class, seeded genre, scene/prefabs wired, landing-page theme.
4. **After-action questions** (per project-installer.md) — offer next steps, e.g.: "Add a new game mode?", "Design the game's UI/HUD?", "Add AI opponents?", "Swap the level scene?", "Set up mobile touch controls?"

From here the user vibe-codes the rest of the game — every subsequent request follows the Agent Reference and the capability inventory's Decision Ladder.
