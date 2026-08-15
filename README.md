# Babylon Toolkit Agent Skills (1.0.0)

Universal [Agent Skills](https://agentskills.io) for the `Babylon Toolkit` web game development framework.
Each `SKILL.md` follows the open standard, so the **same file works unchanged** in Claude Code, Codex CLI, and GitHub Copilot.

## Install

```bash
npm install -g @babylonjs-toolkit/agent
```

or, without installing anything globally:

```bash
npx @babylonjs-toolkit/agent install
```

That installs **every skill** into every skills directory and the **Agent Persona** into every
global instruction file, on macOS, Linux and Windows. Then restart your agent session — skills
and instruction files are only read at session start.

### Commands

| Command | What it does |
|---------|--------------|
| `bt-agent install` | Install skills + persona into every target (the default) |
| `bt-agent update` | Reinstall, and remove skills this package no longer ships |
| `bt-agent uninstall` | Remove what it installed — and nothing else |
| `bt-agent doctor` | Verify the install; prints `INSTALL OK` or lists what is missing |
| `bt-agent targets` | Show every target and the paths it writes to |

| Option | Effect |
|--------|--------|
| `--project` | Install into the current directory instead of your home directory |
| `--targets claude,agents` | Restrict to specific targets |
| `--legacy-codex` | Also write `~/.codex/skills` for pre-`.agents` Codex builds |
| `--no-persona` | Install skills only; leave instruction files alone |
| `--persona-only` | Install/refresh the Agent Persona only; do not copy skills |
| `--dry-run` | Print what would happen and change nothing |
| `--json` | Machine-readable output |

### What it writes

| Target | Skills | Agent Persona |
|--------|--------|---------------|
| Claude Code | `~/.claude/skills/` | `~/.claude/CLAUDE.md` |
| Codex / Copilot / Antigravity | `~/.agents/skills/` | `~/.agents/AGENTS.md` |
| Codex chat clients | — | `~/.codex/AGENTS.md` |
| Gemini CLI | — | `~/.gemini/GEMINI.md` |
| Legacy Codex CLI (`--legacy-codex`) | `~/.codex/skills/` | — |

Gemini CLI is a separate entry on purpose: it reads `GEMINI.md`, **not** `AGENTS.md`, so
`~/.agents/AGENTS.md` alone never reaches it.

Your instruction files are never truncated. The persona goes in as a managed block:

```markdown
<!-- BEGIN BABYLON TOOLKIT PERSONA v1 -->
...
<!-- END BABYLON TOOLKIT PERSONA -->
```

Re-running rewrites only what is between those markers, so the persona can be revised in a
later release while everything else in the file is left exactly as you wrote it. An older
unmarked persona is converted to a managed block automatically; a persona you have reworded
yourself is detected and left alone. Every modified file is backed up to `<file>.bak` first.

Skill folders are tracked in `~/.babylon-toolkit/install-manifest.json`, so `update` and
`uninstall` only ever touch folders this package installed — a skill you wrote yourself that
happens to be named `bt-something` is safe.

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| [`bt-spec`](skills/bt-spec/SKILL.md) | `/bt-spec` | Turn a short idea into a feature spec file on a new git branch. |
| [`bt-plan`](skills/bt-plan/SKILL.md) | `/bt-plan` | Produce a detailed, task-checklist technical plan from a spec. |
| [`bt-execute`](skills/bt-execute/SKILL.md) | `/bt-execute` | Implement one task (or all remaining tasks) from a plan/spec. |
| [`bt-convert`](skills/bt-convert/SKILL.md) | `/bt-convert` | Convert source code to Babylon Toolkit TypeScript. |
| [`bt-copycat`](skills/bt-copycat/SKILL.md) | `/bt-copycat` | Re-create the specified website adapted to specified genre. |
| [`bt-landing`](skills/bt-landing/SKILL.md) | `/bt-landing` | Re-design the landing page, splash screen, preloader and custom overlays. |
| [`bt-gauntlet`](skills/bt-gauntlet/SKILL.md) | `/bt-gauntlet` | Agent based gauntlet loop engineering. ([usage guide](gauntletusage.md)) |
| [`bt-prototype`](skills/bt-prototype/SKILL.md) | `/bt-prototype` | Create any number of award winning frontend prototypes. |
| [`bt-design`](skills/bt-design/SKILL.md) | `/bt-design` | Implement high quality frontend and in-game designs. |
| [`bt-hero`](skills/bt-hero/SKILL.md) | `/bt-hero` | Create smooth cinematic 3D scrolling hero sections. |
| [`bt-atlas`](skills/bt-atlas/SKILL.md) | `/bt-atlas` | Generate texture atlas skin variations. |

Every tool derives the slash-command from the **folder name** (`bt-spec/` → `/bt-spec`) and reads
the frontmatter `name` + `description` to decide when the skill applies. The `allowed-tools`
line is honored by Claude Code (auto-approves those tools) and safely ignored by Codex and
Copilot.

## Universal Installations

Where each tool looks for GLOBAL skills (**Default Installation** — `~` = your home directory):

| Tool | macOS / Linux | Windows |
|------|---------------|---------|
| Claude Code | `~/.claude/skills/` | `%USERPROFILE%\.claude\skills\` |
| OpenAI Codex | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |
| GitHub Copilot | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |
| Gemini CLI / Antigravity | `~/.agents/skills/` | `%USERPROFILE%\.agents\skills\` |

> On macOS `~` expands to `/Users/<user>/`, on Linux to `/home/<user>/`,
> and on Windows `%USERPROFILE%` expands to `C:\Users\<user>\`.

Where each tool looks for PROJECT-LOCAL skills (only when the user explicitly requests a project install):

| Tool | Project skills directory |
|------|--------------------------|
| Claude Code | `.claude/skills/` |
| OpenAI Codex | `.agents/skills/` |
| GitHub Copilot | `.agents/skills/` |
| Gemini CLI / Antigravity | `.agents/skills/` |

> **Note:** Install skills into **BOTH** the `.claude/skills/` and `.agents/skills/`
> locations for maximum coverage — `.claude/skills/` for Claude Code, `.agents/skills/`
> for everything else (Codex, Copilot, Gemini CLI, Antigravity). By default use the
> GLOBAL (per-user home) locations; use the project-local locations only when the user
> explicitly asks for a project install. Copy **whole folders** into each — the
> `bt-atlas/scripts/` assets must be present in every location.


# Babylon Toolkit Loop Engineering (Gauntlet Loop)

**What it is in one line:** you give it a game brief and a quality bar; it interviews you, writes a loop card, then runs rounds of *build → capture real browser evidence → fresh harsh critic vs your reference (blind A/B) → record* until the success condition passes or a boundary fires — building with **BabylonJS + the Babylon Toolkit, never Three.js**. All state lives in `_gauntlet/<name>/`, so you can stop any time and resume days or weeks later.

---

## 1. Start a new gauntlet (the normal way)

```
/bt-gauntlet I want you to build a first-person shooter at the level of the most
recent Call of Duty games. It should be utterly perfect, visually beautiful, with
every single thing done at AAA quality—from textures to physics to anything you
could think of.
```

What happens:

1. It derives a job name from the brief (e.g. `cod-fps`) and runs the **interview** — deliverable, objective, reference/benchmark media (attach screenshots!), success condition, boundaries, Babylon-specific game questions, loop mechanics.
2. It shows you the filled **loop card** and waits for your confirmation.
3. It runs up to **5 rounds** (the default session cap), then parks with a status report and the exact resume command.

Name it yourself and pick the template explicitly:

```
/bt-gauntlet --name:cod-fps --template:gauntlet I want you to build a first-person shooter ...
```

Attach reference screenshots/clips with the message — they become the critics' benchmark in `_gauntlet/cod-fps/reference/`.

## 2. Choose a template

| | `--template:gauntlet` (default) | `--template:bounded` |
| --- | --- | --- |
| Style | Full Shumer-style: decompose into parts, fan out builders, fresh harsh critic per part, blind A/B vs reference | Single-track loop card: one coherent improvement per round against an objective/metric/boundary checklist |
| Best for | One ambitious visual artifact chasing a reference bar ("CoD-level FPS") | Reliability- and cost-sensitive work with objective verifiers ("60 FPS, zero console errors, all checks green") |
| Cost profile | Heavier (builder + critic subagents per part) | Lighter (one improvement, one verifier per round) |

Both templates live verbatim in the SKILL.md, so you can edit their wording there.

## 3. Control how much one session does

```
/bt-gauntlet --rounds:20 --name:cod-fps <brief>     # a long night: up to 20 rounds
/bt-gauntlet --rounds:1 --resume cod-fps            # one careful round, then park
/bt-gauntlet --resume cod-fps                       # default: up to 5 rounds
```

`--rounds:N` caps THIS invocation only. State is persisted after **every** round regardless, so even a hard cutoff (usage limit, closed laptop) loses at most the round in flight.

## 4. Stop, check things out, come back later (the resume cycle)

This is the core workflow the skill was built for:

```
# Tuesday night — start, run 5 rounds, it parks itself
/bt-gauntlet --name:cod-fps I want you to build a first-person shooter ...

# (any time) — peek without running anything
/bt-gauntlet --status cod-fps

# ...daily limit resets, or a week later, brand-new session, zero memory of the chat:
/bt-gauntlet --resume cod-fps
```

`--resume` works because nothing lives in the conversation: the fresh session re-reads the Agent Reference, then `loop-card.md` → `progress.md` → the last round journals, sanity-checks them against the real project, reports "resuming from round N", and executes the recorded `NEXT ACTION`. Budgets count in **rounds/attempts (cumulative across sessions)**, never wall-clock, so a two-week gap changes nothing.

Park a job deliberately mid-session:

```
/bt-gauntlet --stop cod-fps
```

You can also just interrupt at any time — parking is only the polite version.

## 5. Run several gauntlets side by side

Each job owns its own `_gauntlet/<name>/` folder — as many as you like, fully independent budgets, rounds, references, and evidence:

```
/bt-gauntlet --name:cod-fps <FPS brief>
/bt-gauntlet --name:racing-demo <racing brief>

/bt-gauntlet --status               # index of ALL jobs, one line each
/bt-gauntlet --resume racing-demo   # continue just that one
/bt-gauntlet --resume               # only ONE job exists → resumes it;
                                    # several exist → lists them and asks
```

A new gauntlet whose name collides with an existing job is an error — it will offer `--resume <name>` or a different name, never overwrite.

## 6. Read the workspace while it's parked

Everything is plain markdown/media under `_gauntlet/<name>/` — inspect it in your editor between sessions:

| File | What you'll find |
| --- | --- |
| `loop-card.md` | The confirmed template: objective, benchmark, success condition, boundaries. The loop never edits it. |
| `brief.md` | Your full interview answers. |
| `progress.md` | **The resume brain**: part checklist (`- [ ]` / `- [~]` / `- [x]`), attempt counts, failed-approaches log, budgets spent, and the one-line `NEXT ACTION`. |
| `rounds/round-NN.md` | Per-round journal: what was built, the critic's verdict and the largest gap it named, evidence links. |
| `reference/` | Your benchmark screenshots/clips — what critics compare against, blind. |
| `evidence/` | Captured browser screenshots + perf numbers from our side of the A/B. |

Want to redirect the loop? Edit `progress.md`'s `NEXT ACTION` (or part priorities) before resuming — the loop trusts the files.

## 7. Skip the interview (`--card:` — non-interactive start)

Hand it a **pre-filled loop card** (either template with every slot answered, including `<NAME>`) and it starts immediately, no questions:

```
/bt-gauntlet --card:_specs/racing-game_gauntlet-card.md --rounds:10
```

If any slot is unfilled or vague it STOPS and tells you which — it never guesses. This is the entry point used by the spec workflow below, and handy any time you want to author the card by hand.

## 8. Use it with the spec workflow (bt-spec / bt-plan / bt-execute)

**The gauntlet contains its own plan — never run bt-plan on gauntlet work.** Its loop card is the spec, its part checklist in `progress.md` is the plan, its rounds are the execution.

Rule of thumb:

- Acceptance criteria you can enumerate up front, each done in one pass → **bt-spec → bt-plan → bt-execute**.
- "As good as *that reference*", unknown number of iterations → **bt-gauntlet**.

Typical two-phase sequence for a real game:

```
# Phase 1 — foundation (checklist-shaped work: scaffold, controller, physics, HUD)
/bt-spec <feature brief>
/bt-plan @_specs/<feature>_spec.md
/bt-execute @_specs/<feature>_plan.md ALL

# Phase 2 — quality (reference-bar work on top of what now exists)
/bt-gauntlet --name:aaa-polish <polish brief + reference media>
```

Or fold the gauntlet INTO a spec run by naming it in the brief:

```
/bt-spec Build the racing game, then polish it to Gran Turismo quality using bt-gauntlet
```

In that flow, bt-spec runs the gauntlet interview at spec time and writes the pre-filled card (`_specs/<feature>_gauntlet-card.md`); bt-plan makes the gauntlet the final task invoking `--card:`; bt-execute re-enters a parked job via `--resume <name>` on each `NEXT` and flips the task's checkbox only when the job genuinely reports DONE.

## 9. Which method should I use for making games? (recommendation)

**Recommendation: the two-phase hybrid — spec/plan/execute for the foundation, then a gauntlet job for the quality bar.** One-shot gauntlet looping is the demo; the hybrid is how you'd actually ship.

Here's the reasoning:

**Why not one-shot gauntlet from a cold start** (the pure Claude-of-Duty move): it makes the loop do work loops are bad at. Scaffolding, the player controller, physics wiring, input, level loading — these have *crisp, enumerable acceptance* ("Havok is initialized, capsule controller walks the test level at 60 FPS"). Running builder-vs-critic rounds on that is paying five critics to confirm a checkbox. It's also where the loop's weaknesses bite: the decomposition emerges mid-run instead of being engineered, coupled foundation systems tempt bad fan-out, and — worth remembering — even Shumer's original run *never won a single blind A/B against real CoD*. The honest lesson of that experiment is that the demanding reference kept the agent improving; not that one prompt replaces engineering.

**Why not spec/plan/execute alone:** it terminates at "acceptance met," which for visuals means "good for AI." There's no mechanism that keeps pushing after the box is checked — no reference comparison, no fresh critic naming the largest gap, no "go again." That's precisely the gap the gauntlet fills.

**So the playbook for a real game:**

```
# Phase 1 — foundation (cheap, deterministic, checkbox-resumable)
/bt-spec  <game systems brief>
/bt-plan  @_specs/<feature>_spec.md
/bt-execute @_specs/<feature>_plan.md ALL

# Phase 2 — quality (reference-chasing, critic-judged, round-resumable)
/bt-gauntlet --name:aaa-polish <polish brief + reference screenshots>
```

Two refinements on top:

1. **Scope each gauntlet job tightly.** Rather than one giant `aaa-polish` job, consider a couple of focused jobs — e.g. `visuals` (lighting, materials, post-processing vs reference frames) and `game-feel` (movement, weapon feedback, hit reactions). Focused jobs give critics sharper rubrics, keep parts genuinely independent for fan-out, and let you park/resume/abandon them separately.
2. **Reserve true one-shot gauntlet** (`/bt-gauntlet <ambitious brief>` on an empty folder) for what it's genuinely great at: prototypes, jams, and "show me what's possible" experiments where you *want* the decomposition to emerge and the ride is the point. That's the mode the Call-of-Duty example lives in, and it works — it's just not the cost-efficient path to a shippable game.

The interplay is already wired for this: phase 2's interview can point its reference media and priorities at exactly what phase 1 built, and if you want it fully hands-off you can fold phase 2 into the spec run itself (`/bt-spec … then polish to <reference> quality using bt-gauntlet`), which pre-fills the loop card and drives it via `--card:` — per section 8 above.

## 10. Unattended runs (optional native loop drivers)

The gauntlet needs **no** native loop tool — the round protocol is the loop, and `--resume` is the continuation. But because state persists after every round, you can safely layer a host's re-invocation driver *on top* for hands-off runs:

```
# Claude Code — keep re-invoking resume rounds while you sleep
/loop /bt-gauntlet --resume cod-fps

# Hosts with a persistent goal feature (e.g. /goal) — same idea:
# keep "/bt-gauntlet --resume cod-fps until the job reports DONE" alive across turns
```

Why this is safe: whenever the native driver dies — daily/weekly limit, session end, closed laptop — the job is simply *parked*, exactly as if you had stopped it yourself. Nothing is lost beyond the round in flight, and `/bt-gauntlet --resume cod-fps` in a fresh session continues where it left off.

Keep the layering straight:

| | The native driver (`/loop`, `/goal`) | The gauntlet |
| --- | --- | --- |
| Job | *When* to re-poke the agent | *What* a round is: build → evidence → fresh critic → record |
| Survives session end / limits | No | Yes — `_gauntlet/<name>/` + `--resume` |
| Portable across hosts | Each host different; some have nothing | Identical everywhere |

This is an operator convenience you apply from the outside. The SKILL.md deliberately never references any native loop tool, so the skill stays fully portable — on a host with no such feature, you just re-invoke `--resume` yourself.

## 11. How a gauntlet ends

In order of precedence, a round's gate check ends things when:

1. **Success condition met** → one final fresh **integration critic** inspects the whole game for seams and consistency → report DONE with the evidence summary.
2. **A loop-card boundary fires** (total rounds exhausted, attempts-per-part hit without a new strategy, repeated blocker, permission needed) → park + escalate to you with specifics.
3. **The `--rounds` session cap is reached** → park cleanly and print `/bt-gauntlet --resume <name>`.

Deploy, spending, credentials, deletion, and messaging are always behind your explicit approval, no matter what the brief says.

## Quick reference

| Command | Effect |
| --- | --- |
| `/bt-gauntlet <brief>` | New gauntlet: interview → confirm card → loop (≤5 rounds) → park |
| `/bt-gauntlet --name:x --template:bounded --rounds:10 <brief>` | New named job, bounded template, 10-round session |
| `/bt-gauntlet --card:<file> [--rounds:N]` | New job from a pre-filled card, zero questions |
| `/bt-gauntlet --resume [x]` | Continue a job in any (brand-new) session |
| `/bt-gauntlet --status [x]` | Read-only: one job's detail, or the index of all jobs |
| `/bt-gauntlet --stop [x]` | Park a job deliberately, print its resume command |

# Babylon Toolkit Agent Persona (@babylonjs-toolkit/agent)

Simply ask your agent to install the `Babylon Toolkit Agent` for you.
