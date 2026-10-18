---
name: bt-profile
description: "The Babylon Toolkit Profile Skill finds what makes a web app slow and lists the fixes (applying them one at a time with --auto-fix) — built for BabylonJS / Babylon Toolkit games, and just as usable on any front end with no Babylon in it (point it at a URL and the project folder). It drives the running game in a real Chrome over the DevTools protocol through a repeatable scenario (a cold load, a level start, a countdown, a boss fight), records a full CPU profile, per-phase allocation profiles, every frame's CPU work and Babylon timers, and maps every sampled millisecond back to the original source line and its owner — your game code, a project-owned script bundle (e.g. the Unity exporter's project bundle), the Babylon Toolkit runtime, BabylonJS, Havok, shader translation, React, the browser. It charges library work to the code of yours that triggered it, splits everything by phase and by second, then diagnoses each bottleneck and lists the fixes — each with its expected gain and risk, ready to spec one by one or as a group with bt-spec — and, with --auto-fix, applies them one at a time, re-measuring the same scenario to prove each gain (reverting anything that does not help), and writes a code-dashboard report to `.agents/profile/<slug>/dashboard.html` (everything the slug's runs produced sits beside it in `.agents/profile/<slug>/data/`). Use when the user says the game is slow, stutters, crawls at a moment (load, start, many particles), or wants a performance analysis (e.g. `/bt-profile the race start crawls for a minute`, `/bt-profile --auto-fix the race start crawls`, `/bt-profile http://localhost:5173/play --scenario level-start`)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

You are an EXPERT BabylonJS, Babylon Toolkit and browser performance engineer. The skill is built for Babylon Toolkit projects but profiles **any web app**: a page with no Babylon engine gets everything except the engine-only numbers (see *Any web app*). Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md).

Use the user's message after the skill name as the `arguments`.

---

# Invocation

```
/bt-profile [<brief: what is slow, when>] [--project:<path>] [--url:<game URL>] [--scenario:<name|path>] [--slug:<name>]
            [--auto-fix] [--snapshots] [--watch] [--gpu-cold] [--no-warm] [--settle:<seconds>] [--runs:<n>] [--trace]
            [--stop[:<slug>]] [--resume[:<slug>]] [--restart[:<slug>]]
            [--max-fixes:<n>] [--target-fps:<n>] [--dpr:<n>] [--args:key=value,…]
```

- **`<brief>`** — the user's words about the slowdown ("the race start crawls for a minute", "stutters when particles spawn"). It decides the scenario and which phases matter most.
- **`--project:`** — the web project to profile: its folder, or any folder or file inside it (absolute, `~/…`, or relative to the working directory). Default: the working directory's project (see **Which project** below).
- **`--url:`** — the page the scenario opens. Default: `profile.config.json` → `url`, else the page a player opens first on the dev server (usually `/`) — the scenario then clicks through to the slow moment the way a player does.
- **`--scenario:`** — the slug's `data/scenario.mjs`, or a path to copy into it. Default: the slug's own; with none, write one (Phase 0).
- **`--slug:`** — the profiled moment, and its folder: `.agents/profile/<slug>/` holds `dashboard.html` and `data/` (config, scenario, findings, runs, logs). Default: the scenario's name (e.g. `race-start`). A new moment gets a new slug; never mix two scenarios' runs in one slug.
- **`--auto-fix`** — also apply the fixes: one at a time, each re-measured and kept only when it wins (Phase 3). **Off by default**: a plain run measures and diagnoses, changes no code, and lists every fix. Either way the report has **The fixes** — every fix with its status, expected gain and risk — so the user can spec them one by one or as a group with `bt-spec` (the dashboard copies the command; `findings.md` beside it carries each fix's cause, evidence, code, proposed change, gain, risk and how to verify it). `--no-fix` / `--analyze` from earlier versions mean the default.
- **`--stop[:<slug>]`** — stop a running profile: ends its capture and Chrome (`progress.mjs stop`), marks the run stopped on the dashboard, rebuilds the report from what was captured. Without a slug: the one running profile in the project (ask when there are several).
- **`--resume[:<slug>]`** — continue a stopped profile where it stopped (`progress.mjs resume` prints the stage and the fixes' states): skip what is done, re-measure a fix left half-way, carry on. The dashboard shows it as the next run number.
- **`--restart[:<slug>]`** — profile the slug again from a fresh baseline with the same config and scenario (after code changes, a stopped run you do not want to continue, or a finished one): `progress.mjs restart` moves the earlier runs, findings and report to `data/archive/<date-time>/` — compare with them in the new report.
- **`--snapshots`** — phase screenshots plus a filmstrip (about one small frame per second, lined up under the frame-rate chart), and the before/after look comparison. **Off by default**: a full-size screenshot stalls the game for a moment and would show up in the very profile it explains. Turn it on for the visual verification runs, or whenever the user asks.
- **`--watch`** — show the Chrome window while the profile runs, so the user can see every capture as it happens (passes `--watch true` to every `profile.mjs` run). Off by default: headless captures are the steadiest. A watched window measures like a real browser (vsync, compositing), so compare watched runs with watched runs; tell the user to keep the window uncovered and not to click or type in it unless the scenario hands them the controls.
- **`--gpu-cold`** — make every capture a true first visit for the GPU (passes `--gpu-cold true` to `profile.mjs`): each fragment shader gets a never-taken branch unique to the load, so no compiled pipeline from an earlier visit is reused. A fresh Chrome profile alone is only browser-cold — on macOS the compiled Metal pipelines live in a system cache outside it, so without this only the first capture after a shader change is GPU-cold. Use it whenever the complaint is about a first load, a cold start, or a stutter that "only happens the first time". Nothing on disk is touched.
- **`--no-warm`** — skip the second, warm load in the same browser (on by default for the baseline: cold vs warm separates first-use costs from steady per-frame work).
- **`--settle:`** — seconds recorded after the scenario's main event (passed to the scenario as `--args settle=`).
- **`--runs:`** — baseline captures used to measure run-to-run noise (default 2).
- **`--trace`** — also save a full DevTools performance trace (`trace.json`, large) for the user to open in Chrome.
- **`--max-fixes:`** — stop after this many kept fixes (default: until the target is met or nothing worth fixing is left).
- **`--target-fps:`** — the goal for the phases the brief names (default 60).
- **`--dpr:`** — device pixel ratio of the profiled window (default 2, a Retina laptop).

---

# What this skill guarantees

1. **Measured, never guessed.** Every finding cites the profile: the function, its owner, its ms per frame, the phase, and the code of yours behind it. No fix is made on a hunch.
2. **Fixes are listed; applied only with `--auto-fix`, one at a time, proven.** Each applied fix is re-measured with the same scenario; it is kept only when its target cost falls and the phase it serves gets faster beyond the measured noise. Otherwise it is reverted, and the report says so.
3. **The user's work is safe.** Uncommitted changes in the working tree are recorded first and never reverted, stashed or committed. Fixes are made as small, reviewable edits; the report carries each diff. Nothing is committed unless the user asks.
4. **It still works and looks the same.** After the fixes: typecheck / build, the project's tests, a clean console, and (`--snapshots`) the same phases screenshotted before and after.
5. **Libraries are not patched.** BabylonJS, Havok, React and other node_modules code is never edited. When the time is spent inside a library, the fix changes how your code uses it (call it less, on less, configure it, cache, freeze, pool) — or, for a toolkit / engine defect, the report states it with evidence for its owner.

# Talk to the user while you work

Long runs lose people. At every phase change, post one short plain-language update: **Done** (with numbers) · **Doing now** · **Next**. **In chat too, never go more than about 5 minutes without a message** while working: before starting anything in the background, say what it is and how long it takes; when it finishes, say what it showed before moving on; when the user writes mid-run, answer them first. A silent agent looks stuck. When a finding is confirmed, say it in one sentence a non-specialist understands ("Physics copies every body's position back every step — 7 ms of each frame").

# Live progress — the dashboard follows the run

The user watches `dashboard.html` while the profile runs, not only after it. From the run's first minute the page shows **what is happening right now**, the stages (Preflight → Baseline → Diagnose → Fix → Verify → Report), every fix with its status and before → after, and the numbers so far; **while a run is going the page shows its progress only — the findings, charts and tables stay hidden (and Print / Download PDF with them) until it ends**; it checks for changes every 10 s and, when the run ends, reloads into the finished report (where the run folds into a *How this profile ran* summary). All of it comes from `data/progress.js`, which **only `progress.mjs` writes** — never edit it by hand:

```bash
node "$TOOLS/progress.mjs" start  "$S" --title "<Project> — <scenario> performance" --brief "<the user's words>" --project "$PROJ" --url "<url>" --open true [--mode auto-fix]
node "$TOOLS/progress.mjs" set    "$S" --url "<url>"                                      # details found after start (the URL, once the code is read)
node "$TOOLS/progress.mjs" stage  "$S" baseline --note "2 cold captures + 1 warm, 90 s settle"   # starting a stage finishes the one before
node "$TOOLS/progress.mjs" now    "$S" "Capturing baseline 1 of 2 — about 3 min"            # what is happening this minute
node "$TOOLS/progress.mjs" metric "$S" "Race start FPS" "24" --note "baseline · target 60"
node "$TOOLS/progress.mjs" fix    "$S" F1 --title "Stop forced world-matrix recomputes" --status trying   # then measuring → kept | reverted
node "$TOOLS/progress.mjs" fix    "$S" F1 --status kept --before "24 fps" --after "41 fps" --note "−14 ms/frame in the countdown"
node "$TOOLS/progress.mjs" note   "$S" "Noise floor ±1.8 fps — a fix must beat it"         # a milestone
node "$TOOLS/progress.mjs" end    "$S" --summary "<the verdict in one sentence>"          # or --status stopped|failed with why
```

- **Write every command out in full** as above — never through a variable that holds a command (`P="node …"; $P now …`): zsh, the macOS default shell, does not split it into words, the command fails, and an `&&` chain behind it silently skips the capture. `$TOOLS`, `$S` and the other names in this skill are shorthand for absolute paths: most agent shells keep no variables between commands, so write the paths out (or set the variables at the top of the same command).
- **Open the run before anything else** (the first lines of Phase 0): `start --open true` (it opens the dashboard in the browser once; the page reloads itself from then on), then the watchdog in the background — `node "$TOOLS/progress.mjs" watch "$S" --watch "$PROJ/src" > "$DATA/logs/watchdog.log" 2>&1 &` (add `--watch` for every other folder the fixes touch: a runtime, a Unity project's scripts). `start` writes a live page when the slug has no dashboard yet, and keeps an older report that has no panel in `data/previous-dashboard.html`. Without `--auto-fix`, the Fix and Verify stages start out skipped.
- **Write before every long command, never after only.** A capture, an analysis, a build or a test run gets a `now` line first that says what it is and roughly how long it takes; the result gets the next one. **Never let 5 minutes pass without a write during active work** — reading code, diagnosing, drilling, editing, waiting on a background command and checking its output all count as active work, and each gets its own `now` line. The run is not over until `end`: keep writing between the last capture and the report, and after it until `end`. The watchdog covers a silent stretch — after 5 quiet minutes it posts a heartbeat naming the newest file and the newest capture log's last line, after 30 without any file change it warns of a stall — but it is the backstop, not the narrator.
- **`stage`** at every phase change, **`metric`** for the figures the user cares about as soon as they are known (the brief's phases' FPS and CPU ms/frame, the noise floor, the target, the best so far — update the same label as they move), **`fix`** at every step of the fix loop: `planned` when diagnosed, `trying` while editing, `measuring` while re-capturing, then `kept` or `reverted` with before → after.
- **Plain language** a non-specialist follows: "Re-measuring the race start with the particle fix", not "runs/fix-3 cold".
- **Waiting on a background capture** counts as active work: poll its log with a bounded loop (`until grep -qE '"runDir"|failed|Error' "$DATA/logs/<run>.log"; do sleep 5; done`, with a timeout on the command) rather than one long `sleep`, and write a `now` line at least every 5 minutes while it runs. A capture that ends in `scenario failed` or `--seconds` logs its failure evidence (see Phase 0 › Smoke run) — read it before trying again.
- **Auto-update** is always on. The page's `Auto-update on / off` button (top right of the panel) is built but hidden for now — `SHOW_LIVE_TOGGLE` in `scripts/lib/progress-panel.mjs` shows it again.
- **End the run every time** — `end` after the report is written, or `end --status stopped|failed --summary "<why>"` when it cannot finish; a run left `running` keeps the page in live mode (the watchdog exits on its own after 12 hours).
- Subagents that capture or fix get these commands and the slug folder, and write their own `now` lines.

---

# How it works

`scripts/` holds four Node tools, installed once per project into `<project>/.agents/profile/.tools` — shared by every slug, since it is the tooling, not a run's data (never into the project's own package.json):

| Tool | Does |
|---|---|
| `profile.mjs` | Launches Chrome (GPU on, fresh profile = cold HTTP and browser caches), runs the scenario, records the V8 CPU profile, per-phase allocation profiles, the in-page probe (every frame's CPU work, draws, particles, SceneInstrumentation timers, scene counters, compiled shader count, every shader module / pipeline / program the page creates with its time, long animation frames, phase marks), and the source + source map of every sampled script. `--warm true` repeats the scenario in the same browser. `--snapshots true` adds screenshots and the filmstrip. `--gpu-cold true` makes the GPU compile every pipeline fresh. A failed or overrun scenario still ends the capture, with `shots/failed.png` and the page's address, title and console errors in the log |
| `analyze.mjs` | (`--drill "Class.fn,…"` breaks a function's time into its direct callees, per phase — use it on every heavy library function before deciding what to change.) Maps every sample to its original file / line / class (source maps, then class-span scan of the script, then the config's `sourceRoots` for bundles without maps), assigns owners, charges library time to the nearest code of yours (the render loop is a frame driver and never takes the blame), and writes `analysis.json`: per phase, per second, per function (self, inclusive, callers, "your code behind it"), allocations, worst frames, hot lines, code excerpts. Prints a summary to read |
| `compare.mjs` | Before → after per phase, owner and function, for the fix loop |
| `report.mjs` | Builds the dashboard HTML from an analysis, an optional baseline and warm analysis, and the agent's `findings.json`, with the live progress panel at its top |
| `progress.mjs` | Writes the run's live progress (`start`, `stage`, `now`, `metric`, `fix`, `note`, `end`) and runs the watchdog (`watch`) — see *Live progress*. No dependencies, so it runs before `npm install` |

The clock of the CPU profile is tied to the page's clock by a named busy-wait marker, so frames, phase marks and samples line up exactly.

---

# Pipeline

Read the Babylon Toolkit Agent Reference router and the sub-documents the project's code touches (`node-esm.md` or `classic.md`, `scene-components.md`, `react-framework.md` for a React host, `fusion-networking.md` for networked play) before the first run in a session — unless your prompt already carries those excerpts.

The names below are shorthand for absolute paths used throughout this skill — write them out in every command (or set them at the top of the same command): most agent shells keep no variables between commands.

```bash
PROJ=<absolute web project root>                  # holds package.json — resolved as in "Which project" below
SKILL_DIR=<absolute path of this skill's folder>
PROF="$PROJ/.agents/profile"; TOOLS="$PROF/.tools"                 # shared by every slug
SLUG=<slug>; S="$PROF/$SLUG"; DATA="$S/data"; DASHBOARD="$S/dashboard.html"
```

One folder per profiled moment — everything a slug's runs produce stays inside it:

```
.agents/profile/
  .tools/                         the installed scripts + node_modules (git-ignored, shared)
  <slug>/
    dashboard.html                the dashboard — live while a run goes on, the report once it is done
    data/
      progress.js                 the run's live progress, written by progress.mjs (git-ignored)
      profile.config.json         URL, scenario, owner rules (a new slug copies a sibling's owners)
      scenario.mjs                the repeatable scenario
      findings.json               the diagnosis, each fix's status, before / after, diff
      worktree-at-start.txt       the user's uncommitted work when the slug started
      runs/<run>/{cold,warm}/     captures and analyses (git-ignored)
      logs/<run>.log              capture logs (git-ignored)
```

Run every tool from `$DATA` (`cd "$DATA"`): run paths stay short (`runs/baseline`) and the tools read `profile.config.json` there.

## Which project

Resolve `$PROJ` before anything else, in this order, and say which project you picked and why in the first update:

1. **`--project:<path>`** — the folder (or any folder or file inside it) is the project root: the nearest folder above it with a `package.json`, else the folder itself.
2. **A project named in the brief** — a path, or a folder name ("profile BtMarioKartWeb's race start") that matches a project in or next to the working directory.
3. **The working directory** — walk up from it to the nearest `package.json`.
4. **One level down** — when the working directory holds no project (e.g. a folder of games), look in its immediate subfolders; use the one web project found.

The project is just **the root folder of the web app**: where its source lives (for code lines and excerpts), where `.agents/profile/` goes, and — when it has a `package.json` with a dev/start script — how to serve it. **Any web app counts**: a Babylon Toolkit game, a plain BabylonJS app, or a front end with no Babylon at all (React, Vue, Svelte, a static site). A `package.json` that is not an app (a tool, a library, the Babylon Toolkit runtime itself) is skipped and the walk goes on. When the user gives `--url` with no `package.json` to serve from — a deployed site, a static folder they already serve — the project is the folder given (or the working directory), used for the output and to map source. When steps 1–4 find none, or step 4 finds several, **ask the user** with the candidates listed — never guess between projects.

## Phase 0 — Preflight

```bash
mkdir -p "$TOOLS" "$DATA/runs" "$DATA/logs"
cp -R "$SKILL_DIR"/scripts/* "$TOOLS/"                                            # refresh on every skill update
node "$TOOLS/progress.mjs" start "$S" --title "<Project> — <scenario> performance" --brief "<the user's words>" --project "$PROJ" --url "<url, or the dev server's / until known>" --open true
node "$TOOLS/progress.mjs" watch "$S" --watch "$PROJ/src" > "$DATA/logs/watchdog.log" 2>&1 &   # the watchdog (see Live progress)
(cd "$TOOLS" && npm install --silent)                                             # puppeteer-core, source-map-js
for line in '.tools/' '*/data/runs/' '*/data/logs/' '*/data/progress.js' '*/data/previous-dashboard.html'; do
  grep -qxF "$line" "$PROF/.gitignore" 2>/dev/null || printf '%s\n' "$line" >> "$PROF/.gitignore"   # add what is missing, keep the rest
done
git -C "$PROJ" status --short > "$DATA/worktree-at-start.txt"                     # the user's own uncommitted work
```

1. **The app must be served.** With `--url` pointing at a site that already runs (a deployed URL, a server the user started), check it answers and use it. Otherwise: Find the dev server (package.json `dev` script, its port) and check it answers; start it in the background if it does not — with `BROWSER=none` (a Vite `server.open: true` would open a stray tab) and its output in `$DATA/logs/devserver.log`. When the usual port answers but serves **another** project (check the page title or a known path), do not touch that server: start this project's on a free port (Vite: `--port <n>`, or the `PORT` its config reads; a `strictPort` config fails loudly instead of moving), and record the URL with `progress.mjs set --url`. Stop the servers you started when the run ends. Content served from elsewhere (a Unity exporter dev server, a CDN) must answer too — read the project's CLAUDE.md / SPEC for how. Profile the **dev server** by default: modules arrive one file each with source maps, so attribution is exact. Mention that React runs in development mode there (its share is inflated); profile a source-mapped production build (`vite build --sourcemap` + `vite preview`) when the React share matters.
2. **`profile.config.json`** in `$DATA` (create it if missing; copy `owners` from a sibling slug's config when there is one):
   ```json
   { "projectRoot": "../../../..", "url": "http://localhost:5173/play", "scenario": "scenario.mjs",
     "owners": [ { "match": "/scenes/<project>\\.js", "owner": "kit", "label": "Project script bundle (Unity)", "yours": true,
                   "sourceRoots": ["/abs/UnityProject/Assets/Scripts"] } ] }
   ```
   Add an owner rule for every script **the user owns that ships without a source map** — typically the Unity exporter's project bundle (`scenes/<Product>.js`), compiled from TypeScript under the Unity project's `Assets/`. `sourceRoots` lets analysis find the class's `.ts` file and method line. Owners marked `yours` are charged with the library work they trigger.
3. **The scenario.** It must play the moment the user says is slow, the way a player would, and mark its phases. **Enter the app the way a player does**: open the page they open (usually the home page) and click through what they click (the menu, the level's button — `context.expectNavigation()` first when the click loads a new page). Use a URL you build yourself (query parameters, a route the UI never links to) only when that is how players really arrive: it can take a path they never take — in one game a `?scene=…gz.gltf` query made the dev server mislabel the page itself as gzip, and the capture recorded a white screen. Reuse `$DATA/scenario.mjs` when it exists; otherwise copy `templates/scenario.template.mjs` there and adapt it: read the game's code to find what to wait on (a component's phase field, a ready flag) and how to reach it from the page (`window.TOOLKIT.SceneManager.SearchForScriptComponentByName(scene, alias)`, `window.PROJECT.*`). Mark the **reveal** — the moment the loading screen goes away (for a toolkit splash: `#xbabylonjsSplashScreen` gets `opacity: 0`) — as its own phase: games often start their intro behind the splash, and hitches before the reveal are load time, not stutter the player sees. Hold input like a player (keys through `context.keyDown`). If the scenario must keep the game going without a player (a race after the start), hand the player's object to the game's own AI component — never skip or disable work to get there. **Size `settle`** (`--args settle=<seconds>`, the seconds recorded after the moment) to the moment: long enough to cover it and a calm stretch after it (a 3-second launch stutter needs ~15–20 s; a frame rate that sinks over a race needs 90), and short of where the scenario stops being realistic (the car reaches a wall, the level ends).
4. **Other sessions.** Find the other agent sessions on this machine — the harness's session-listing tool when it has one (Claude Code: `ListAgents`); otherwise the running dev servers and browsers (`ps`, `lsof -iTCP -sTCP:LISTEN`) and recent file times — and check `git status` / `git log` in every repo you may touch. Another session working in the same project or runtime shares the dev server, the runtime build and the commits: tell it which files you change (and ask it to leave them out of its commits), give a one-line heads-up before restarting a dev server or rebuilding a library it serves, and pause captures while it runs timing-sensitive checks. Its edits also move your numbers — compare runs taken on the same code, and say so in the report when you could not.
   While anyone else edits the project, **never capture on a watching dev server**: one save hot-patches or reloads the game mid-run (the capture logs `WARNING: … restarted` and the report shows a banner). Profile a frozen copy instead: `git archive HEAD | tar -x -C <scratchpad>/snapshot`, copy in your own uncommitted project changes, link `node_modules` to the live project's, and serve it on a spare port with a config that wraps the project's — `mergeConfig(base, { cacheDir: ".vite-profile-cache", server: { watch: null, hmr: false, fs: { strict: false } } })` (its own optimizer cache, since `node_modules` is shared). Warm it once, then capture against that port. Library builds the project links to (a runtime) are still live — keep the heads-up for those.
5. **Smoke run** (`node "$TOOLS/profile.mjs" --out runs/smoke --args settle=15 --snapshots true`, from `$DATA`): look at the screenshots and confirm the scenario really did what the user described (the countdown ran, the player moved, the particles fired). Fix the scenario before measuring anything.
   - **When it fails** (`scenario failed` or `--seconds` in the log), the log names the evidence: `shots/failed.png` (what the page showed), the page's address and title, its visible text, and its console errors and failed document / script loads. A white page with a failed document load is a server or routing problem, not the game.
   - **Never read the smoke run for stutter**: each screenshot stalls the page 0.5–2 s — a long frame with no script in it, lined up with a `shot` line in the log. It looks exactly like a hitch.
   - **The first capture of a session may be the only GPU-cold one** (see `--gpu-cold`): if it shows a hitch the later ones do not, that is a first-visit cost, not noise — re-capture with `--gpu-cold true` to reproduce it at will.

## Phase 1 — Measure the baseline

`progress.mjs stage "$S" baseline`, a `now` line before each capture and analysis, and `metric`s for the baseline figures and the noise floor as soon as they are known.

```bash
cd "$DATA"                                         # --url / --scenario default to profile.config.json here
node "$TOOLS/profile.mjs" --out runs/baseline --warm true --args settle=90 > logs/baseline.log 2>&1
node "$TOOLS/profile.mjs" --out runs/baseline-2 --args settle=90 > logs/baseline-2.log 2>&1      # noise
node "$TOOLS/analyze.mjs" --capture runs/baseline/cold  > runs/baseline/cold/summary.txt
node "$TOOLS/analyze.mjs" --capture runs/baseline/warm  > runs/baseline/warm/summary.txt
node "$TOOLS/analyze.mjs" --capture runs/baseline-2/cold --quiet true
node "$TOOLS/compare.mjs" --before runs/baseline/cold/analysis.json --after runs/baseline-2/cold/analysis.json   # = the noise floor
```

(With `--gpu-cold`, add `--gpu-cold true` to every capture.) **When the baseline does not show the problem**, close the gap before diagnosing (Troubleshooting › *The profile is smooth*), and keep each attempt as its own run (`runs/repro-<what changed>`). The run that shows it — the **reproduction run** — is what Phase 2 diagnoses and Phase 5 reports.

**A capture right after a dev-server restart is not comparable:** Vite's first load after `--force` re-optimizes dependencies and transforms every module (seconds of `(program)` time in the first phase). Load the page once (a throwaway headless visit) before every capture that follows a restart.

Read `summary.txt` in full. Check first: the engine is the one the game uses (WebGPU vs WebGL — a fallback changes everything), the console errors, and that each phase lasted as long as it should. **The noise floor** is the per-phase FPS and CPU ms/frame difference between the two baseline captures; a fix must beat it.

## Phase 2 — Diagnose

`progress.mjs stage "$S" diagnose`; a `now` line for each drill or census; a `fix … --status planned` for each confirmed finding.

Work from the brief's phases outward. For each phase that misses the target:

1. **Is the main thread the limit?** `busy` near 100% with CPU ms/frame near the frame interval → CPU-bound: find the code. `busy` low with long frame intervals → GPU-bound or waiting: draw calls, fill rate, render scale (the toolkit's `bt-optimize` skill owns scene-side GPU work). The summary's **WORST FRAMES** says which: `cpu` (the frame's own work) or `wait` (a gap the main thread sat through, with its script ms and the pipelines created just before it). A `wait` of hundreds of ms with almost no script, right after new pipelines, is the GPU process compiling shaders — see the hot-spots row *Long frame, almost no script*.
2. **Visible or hidden?** Judge stutter only in phases after the reveal mark; a worst frame behind the loading screen costs load time (still worth shortening) but the player never sees it. Check the filmstrip when unsure.
3. **Owners.** Which owner grew in this phase compared with the calm phases? A phase that is slow only cold (compare the warm summary) is first-use work: downloads, decoding, shader compilation, pipeline creation, JIT.
4. **Subtrees, then functions.** In `inclusiveTop` (frame shells removed) find the subtree that dominates, then its heaviest self-time functions and their `callers` / `enteredFrom` / `yours` columns: those name the code that asks for the work. Re-run `analyze.mjs --drill "<function>"` to split a heavy function into its callees per phase — a cost that **grows** phase by phase while the scene stays the same is accumulating state (more systems switched on, caches invalidated), not load.
5. **Count, live, when the profile cannot say why.** A function that is cheap per call but runs too often needs a census: copy `templates/census.template.mjs` to the scratchpad (outside the project), adapt how it reaches the moment, and run it with `--args method=TransformNode.prototype.computeWorldMatrix,seconds=1`: it wraps the method for that long and counts calls per object with a sample stack. It names the object and the caller in one run — the Mario Kart run found 16,000 world-matrix recomputes per frame this way. GPU pipelines need no census: every capture records each shader module / pipeline / program with its time (`gpuCompiles` in `analysis.json`, per phase in the summary); line them up with the marks and the scenario's own progress (a distance, a spawn) to name what first drew them.
6. **Read the code.** Open the files and lines named (`yoursTop`, `excerpts`, `hotLines`) and the library function the time lands in. Find the mechanism — what runs, how often, on how many objects, why. A finding is not done until you can say *why* it costs what it costs.
7. **Worst frames** name the spikes (a spawn, a burst, a compile) that averages hide.
8. **Allocations**: phase `heap` lists show who feeds the garbage collector while playing.

Write `$DATA/findings.json` (schema in `scripts/report.mjs`): per finding a severity, the phases, the cost in ms/frame and % of the phase, the cause in plain language, the evidence (numbers from the analysis), the code locations, the planned fix. Rank by the time it would win in the phases the user cares about.

## Phase 3 — Fix, one at a time (only with `--auto-fix`)

Without `--auto-fix`, skip this phase: no code changes. Every finding still carries its proposed `fix`, `gain`, `risk` and `verify`, so **The fixes** and `findings.md` are a complete brief for a later spec.

`progress.mjs stage "$S" fix`; each fix moves `trying` → `measuring` → `kept` or `reverted`, with before → after (see *Live progress*).

For each finding, highest win first:

1. **Change the cause, not the symptom.** Prefer the smallest change that removes the work: cache instead of recompute, compute once instead of per frame, per object instead of per child, configure the library (freeze, static, refresh rate, capacity), pool instead of create, pre-warm at load instead of at first use. Follow the Agent Reference's coding rules; never disable a feature the user can see or hear to win time.
2. **Where the code lives decides how it ships.** Project source: edit it; the dev server reloads. The Babylon Toolkit runtime, when the user owns its source (they say so, or its repo is theirs): fix it there with a regression test in its own test suite, run the suites that touch the area, rebuild the way that repo documents (never a step that copies the build into other repos), and restart the dev server with `--force` so it serves the new build. A project-owned bundle (Unity exporter project bundle): edit its source under the Unity project and rebuild the bundle the way the project documents (e.g. `unity command bt_build_project`), then confirm the served bundle changed. The Babylon Toolkit runtime / BabylonJS / other libraries: do not edit — change the calling code, or record the defect as a finding for the library's owner.
3. **Re-measure** with the same scenario and flags (warm the dev server first if it restarted), into `runs/fix-<n>-<short-name>`; analyze; `compare.mjs --before <last kept> --after <this> --focus "<the functions the fix targets>"`.
4. **Keep or revert.** Keep when the targeted cost fell and the phase's CPU ms/frame or FPS improved beyond the noise floor without another phase getting worse. Otherwise revert this fix only (never touch lines that were already uncommitted at the start) and record it as `reverted` with the numbers. Update `findings.json` (`status`, `before`, `after`, `diff`).
5. Run the project's typecheck / tests after every kept fix that touched code they cover.

Stop when the target FPS is met in the brief's phases, `--max-fixes` is reached, or what is left is not worth the change (say what it would take).

## Phase 4 — Verify (only with `--auto-fix`)

Without `--auto-fix` no code changed: skip it (the stage is already marked skipped) and go to the report.

`progress.mjs stage "$S" verify`, with a `now` line for the final captures, the tests and the screenshots.

```bash
node "$TOOLS/profile.mjs" --out runs/final --warm true --args settle=90 > logs/final.log 2>&1
node "$TOOLS/analyze.mjs" --capture runs/final/cold > runs/final/cold/summary.txt
node "$TOOLS/analyze.mjs" --capture runs/final/warm --quiet true
```

With `--snapshots` (or when any kept fix could change what is drawn): capture `runs/final-shots` and, on the original code, `runs/baseline-shots` with `--snapshots true` (the smoke run's shots serve as the "before" when the code has already changed), and compare the phase screenshots side by side — same effects, same lighting, same HUD. Typecheck / build and tests must pass; the console must hold no new errors.

## Phase 5 — Report

`progress.mjs stage "$S" report`.

```bash
node "$TOOLS/report.mjs" --analysis runs/final/cold/analysis.json --baseline runs/baseline/cold/analysis.json \
  --warm runs/final/warm/analysis.json --findings findings.json --title "<Project> — <scenario> performance" \
  [--snapshots runs/final-shots/cold --snapshots-before runs/baseline-shots/cold]      # writes $DASHBOARD (../dashboard.html)
```

(Without `--auto-fix`: `--analysis` is the run that shows the problem — the baseline, or the reproduction run when the baseline did not — and `--warm` its own warm capture when it has one: `--analysis runs/baseline/cold/analysis.json --warm runs/baseline/warm/analysis.json`. Every finding carries `fix` (the proposed change), `gain`, `risk` and `verify`; name the reproduction run and how it differs from a plain capture in the findings' evidence.) Every report lists **The fixes** (each with a copy-able `/bt-spec` command, and one for any group the user ticks) whether they were applied or not. The report also writes `dashboard.pdf` (its **Download PDF** button; `--pdf false` skips it) and `findings.md` (the spec-ready diagnosis). The page has **Print** too. Then end the run — `node "$TOOLS/progress.mjs" end "$S" --summary "<the verdict in one sentence>"` — so the page leaves live mode and the watchdog exits. The dashboard is already open (`start --open true`) and reloads into the report by itself — do not open a second tab; check it renders at desktop and phone width with no console errors (a headless screenshot of the file is enough). Stop every dev server and Chrome the run started. Then tell the user: the verdict in two sentences, each finding with its before → after, what was reverted and why, what remains and what it would take, and the report path.

---

# Any web app

A page with no Babylon engine is profiled the same way — scenario, cold and warm captures, phases, the CPU profile mapped to source lines and owners (`project`, `react`, `vendor`, `program`, `gc`), allocations, long animation frames, screenshots, the dashboard and the fix loop. The differences:

- **Frames come from the browser** (`requestAnimationFrame`, `frameSource: "raf"` in the capture): FPS, frame gaps, the worst frames and the per-second timeline are there; the per-frame CPU time, draw calls, particles, compiled shaders and the engine timers are Babylon-only and stay empty. A worst frame's window is the gap the main thread held the next frame back.
- **The scenario drives the page the way a user does**: clicks (`context.page.click(selector)`, or an `evaluate` that clicks; `context.expectNavigation()` first when it loads a new page), typing, scrolling (`context.evaluate(() => window.scrollBy(0, 800))`), route changes — with a mark per step the user calls slow.
- **What to look for:**

| Hot in the profile | Usually means | Look at |
|---|---|---|
| `renderRootSync` / `performWorkOnRoot` / `commitRoot` / `jsxDEV` (React), `patch` (Vue), `flush` (Svelte) | Re-rendering more than the change needs. **During gameplay, any React share at all is a HUD pushing per-frame values through state** — a violation of the Agent Reference's *Game UI Performance — ENFORCED* | Which component re-renders per frame / per keystroke (`yours` names it). A game HUD: the per-frame `setState` / store / EventBus calls in its loop — the fix is the reference's *Live HUD Values* pattern (render once, one frame loop, refs, write on change), and the finding cites it. Elsewhere: memoization, state placed too high, context that changes every render |
| `(program)` large during play, `Layout` / `Recalculate Style` in a `--trace` | Layout thrashing or style recalculation | Reads of layout (`offsetHeight`, `getBoundingClientRect`) after writes in a loop; animations on layout properties instead of `transform` / `opacity` |
| `(garbage collector)` | Short-lived allocations per frame or per event | Phase `heap` lists: arrays / objects / closures created in handlers and render functions |
| One long task at load | Parsing and running a large bundle | Code splitting, deferring what the first view does not need |
| `JSON.parse` / `stringify`, large `map` / `filter` chains | Big data work on the main thread | Paging, memoizing, moving it to a worker |

# Reading BabylonJS hot spots

What a heavy function usually means, and where to look. Always confirm with `callers` / `yours` before acting.

| Hot in the profile | Usually means | Look at |
|---|---|---|
| `TransformNode.computeWorldMatrix` (deep self-recursion) | **Forced recomputes** (`computeWorldMatrix(true)`): a forced recompute forces every ancestor and bumps its child-update id, which marks every sibling subtree out of date, so the render and the next forced call recompute everything again — a feedback loop. Count recomputes per node live before blaming the scene size | Who calls `computeWorldMatrix(true)` per frame / per physics step (Havok pre-step, sync helpers, animator root motion, particle emitters): one forced call per frame on any node under a level's root invalidates the whole level. Probe the level root's `_childUpdateId` per frame and the forcing stacks. Fix: read the current matrix with `TOOLKIT.Utilities.CurrentWorldMatrix(node)` (recomputes only the changed nodes of the chain); static props never frozen |
| `HavokPlugin.setPhysicsBodyTransformation` / `_getTransformInfos` | Havok TELEPORT pre-step: each body whose `disablePreStep` is false is force-synced from its node before every step. Should only be bodies that move by transform (kinematic) | Count bodies by motion type × pre-step live. Static colliders with pre-step on are pure cost (the Babylon Toolkit runtime turned it on for every exported collider before 9.30.x) |
| `Node._getDescendants` / `getChildMeshes` / `getChildren` | A hierarchy walk — expensive when done per frame or per object | Per-frame lookups that should be cached at start |
| **Long frame, almost no script** — a `wait` in WORST FRAMES (LoAF `blockingMs` ≈ 0), right after new pipelines / programs were created (`pipelines near`, `gpu:` per phase) | **The GPU process compiling pipelines** for shaders drawn for the first time. The main thread is idle, so the CPU profile shows nothing; the browser's and the OS's shader caches hide it on later visits, so it is a **first-visit** stutter — every capture after the first may be smooth | Reproduce with `--gpu-cold true`. Which materials / effects are first drawn after the loading screen lifts (the car, the road 10 m in, a first particle burst). Fix: compile them behind the loading screen — wait for the scene and those materials to be ready (`scene.whenReadyAsync()`, `material.forceCompilationAsync(mesh)`, the toolkit's shader warm-up) and render a few frames hidden before revealing, instead of revealing on a fixed timer |
| `ProcessIncludes`, `MaterialPluginManager` code injection, `Effect` / `ShaderProcessor`, shader regexes, `glslang` / `twgsl` wasm | A **new shader variant** being built: a material's defines changed, a new material / particle system appeared, a plugin toggled | New materials or defines appearing after load (first particle burst, boost flames, item effects) — pre-warm them at load |
| `WebGPUEngine._draw`, `getBindGroups`, `setSubData`, `UniformBuffer.update*`, `Mesh.render`, `SubMesh.render` | Per-draw CPU cost: the frame has too many draws (meshes × passes) | Draw counts per phase, shadow casters, hidden-but-rendered meshes, instancing / merging (`bt-optimize`) |
| `ShadowGenerator._renderSubMeshForShadowMap` | Shadow passes re-drawing casters every frame | Casters list, refresh rate, number of shadowed lights |
| `Scene._evaluateActiveMeshes` | Culling every mesh every frame | `freezeActiveMeshes` for static content, `alwaysSelectAsActiveMesh`, mesh count |
| `ThinParticleSystem.animate` → `Buffer.updateDirectly` / `WebGPUBufferManager.setRawData` | A **started system with zero particles still uploads its whole vertex buffer** every frame (Babylon reads a vertex count of 0 as "all"). Cost grows as more effects get their first play and stay started while idle | Started-but-empty systems × capacity (census `particleSystems`); the toolkit's `ShurikenParticles.SkipEmptyVertexUploads` guard |
| `ParticleSystem.animate` / `_update`, `ShurikenParticles.sys._update` | CPU particle simulation: emit rate × lifetime × systems | Systems started together at an event, capacity, GPU particles |
| `(garbage collector)` | Short-lived allocations per frame | Phase `heap` lists: vectors / arrays / closures created in update loops |
| `(program)` | Browser-internal work (parse, compile, style, layout, GPU IPC) | Large during load = script parse / compile; during play = DOM / layout churn (HUD) |
| React (`react` owner) above ~0% during play, `jsxDEV` among the heaviest functions | A HUD re-rendering every frame: speed, timers, needles or bars pushed through React state, props or per-frame EventBus messages | The HUD's frame loop (`yours` names the component). Fix: the Agent Reference's *Live HUD Values — ENFORCED* — render once, one frame loop, write through refs only on change. Budget: ≤ 0.5 ms/frame, `react` near 0% in play phases |
| `AdvancedDynamicTexture._checkUpdate` / `_render`, `updateDynamicTexture` every frame | A Babylon GUI control assigned every frame: each change re-lays out, redraws and re-uploads the whole GUI texture | Assign a control only when its shown value changes (*Game UI Performance — ENFORCED*) |

---

# Files

| Path | Holds |
|---|---|
| `.agents/profile/.tools/` | The installed scripts and their node_modules, shared by every slug (git-ignored) |
| `.agents/profile/<slug>/dashboard.html` | The dashboard — follows the run live, then holds the report |
| `.agents/profile/<slug>/data/progress.js` | The run's live progress: status, stages, fixes, numbers, what is happening now (written only by `progress.mjs`; git-ignored) |
| `.agents/profile/<slug>/data/profile.config.json` | URL, scenario, owner rules and source roots |
| `.agents/profile/<slug>/data/scenario.mjs` | The repeatable scenario |
| `.agents/profile/<slug>/data/findings.json` | The diagnosis and each fix's status, before / after and diff |
| `.agents/profile/<slug>/data/runs/<run>/{cold,warm}/` | `capture.json`, `cpu.cpuprofile` (opens in DevTools), `heap/`, `scripts/`, `analysis.json`, `summary.txt`, `shots/`, `filmstrip/` (git-ignored) |
| `.agents/profile/<slug>/data/logs/` | Capture logs (git-ignored) |

# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `engine` is WebGL when the game asks for WebGPU, or the adapter is SwiftShader | Chrome fell back: the numbers do not represent the user's machine. Run `--headed true` or check the GPU flags |
| No frames recorded | The page never set `window.BABYLON` (a pure ESM build without the toolkit globals): expose the engine on `window.BABYLON.EngineStore` or extend the probe |
| A phase lasts far longer than expected | The scenario waited on the wrong condition — check its log lines and the screenshots |
| Functions show `(anonymous)` in a bundle | Minified without names and without a source map: profile a dev build or a `--sourcemap` build |
| Capture logs `WARNING: … restarted`, a phase shows 0 FPS, or the compiled-shader count drops mid-run | The dev server reloaded or hot-patched the game because someone saved a file. Discard the run and capture a frozen snapshot (Phase 0 › Other sessions) |
| The profile is smooth but the user feels a stutter | The scenario does not play the way the user does. Close the gap one difference at a time, each as its own run: **`--gpu-cold true` first** when the user says "cold", "first time" or "after loading" (later captures reuse compiled GPU pipelines — see the row below), `--headed true` (a visible window), `--autoplay gesture` (audio stays locked until the first key, as in a normal browser — the unlock can be the hitch), no idle waits where the player acts at once (throttle the moment the loading screen lifts), the same build and URL the user plays (dev server vs a deployed site). If it is still smooth, **let the user drive**: give the scenario a watch-only mode (`--args driver=human`: it loads the moment cold, waits for the player's first move, marks progress such as distance travelled, and sends no keys), run it `--headed true` with `--seconds 900` (the default 240 s cap ends the capture before most people start), and tell the user exactly what to do, when, and for how long — in chat and in a `now` line (a subagent has only the `now` line: say so in its brief, and have it give up after a set wait and carry on) |
| Only the first capture of the session shows the hitch | A **first-visit GPU cost**: the GPU compiled the pipelines in that capture and every later one reused them (macOS keeps compiled Metal pipelines in a system cache that a fresh Chrome profile does not reset). Re-capture with `--gpu-cold true` — never delete the system's shader cache, it belongs to the user's everyday browser |
| A capture fails: `scenario failed`, `--seconds`, or a white page in the watched window | Read the failure evidence in the log (`shots/failed.png`, the page's address and title, its console errors and failed document / script loads). A white page with a failed document (`ERR_CONTENT_DECODING_FAILED`, 404) is the server or the route: start the app the way a player does (Phase 0 › The scenario) |
| Numbers jump between runs | Background load on the machine, a different rival / random seed, or a cold vs warm mix-up: compare cold with cold, and use the noise floor |
