---
name: bt-recon
description: "The Babylon Toolkit Recon Skill deep-dives existing code — a subsystem named in a brief, or the whole codebase — and writes a comprehensive, evidence-cited technical grounding spec (`_specs/<slug>_recon.md`) plus, when the scope has UI, a plain-language user guide (`_specs/<slug>_guide.md`), for maintaining inherited or undocumented code and grounding future bt-spec features. Use when asked to document, reverse-engineer, explain, map or take over existing code (e.g. `bt-recon the &session=camera system`, `bt-recon the whole codebase`). Not a diff or bug review."
allowed-tools: Read, Grep, Glob, Write, Bash(git log:*), Bash(git show:*), Bash(git blame:*), Bash(git rev-parse:*), Bash(git ls-files:*), Bash(git diff:*), WebFetch(domain:raw.githubusercontent.com), AskUserQuestion, Agent, Task
---

Run reconnaissance on existing code nobody has documented — one subsystem or the whole codebase — and bring back everything it does as a grounding spec that `bt-spec` and `bt-plan` build future features on, plus a plain-language user guide when there is something a user operates. Follow the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md). The user's message after the skill name is the `arguments`.

```
/bt-recon [--guide|--no-guide] [--no-live] [--quick] [--out <dir>] <brief>
/bt-recon --refresh @_specs/<slug>_recon.md

/bt-recon "the default camera system"
/bt-recon "the save/load pipeline"
/bt-recon "the whole codebase"
/bt-recon --no-guide "the physics layer helpers in src/physics"
/bt-recon --refresh @_specs/session-camera_recon.md       # update an existing recon after code changes
```

- `--guide` — always write the user guide. `--no-guide` — never write it. Neither → write it when the scope has UI — anything a person operates (Step 8).
- `--no-live` — skip the live pass (Step 5) even when the brief gives a URL.
- `--quick` — a lighter recon: one reader per slice, no coverage audit (Step 6). The output keeps the same sections.
- `--out <dir>` — write the outputs to `<dir>` instead of `_specs/`.
- `--refresh @<recon file>` — update an existing recon against what changed since it was written (Refresh mode, at the end).
- Strip the flags first; they are never part of the brief or the file name. No brief → ask for one. Never guess a path or URL.

## Ground rules

- **Thorough by default.** Unlike the other bt-* skills, recon has no TIME MATTERS default: the whole point is that nothing is missed. Print `🔬 [bt-recon] Deep recon` at the start (`--quick`: `⚡ [bt-recon] Quick recon`). Still do not re-read what you already have.
- **Read-only on the project.** Research only. The files you write are the recon doc, the guide, and screenshots under `_specs/<slug>_recon/` — nothing else. No source edits, no builds, no installs, no tests, no shell commands beyond the read-only `git` commands above.
- **Evidence or it is unknown.** Every factual claim cites `path:line` (or `path:start-end`) and carries one confidence tag: `[code]` read in the source · `[live]` seen in the running app · `[history]` from git history · `[inferred]` deduced, with the reason in the same line. Anything you cannot establish goes in `## Unknowns` with what would settle it. Never fill a gap with a plausible guess — an inherited system is exactly where a confident wrong guess does the most damage.
- **Write the system, not the review process.** The recon describes what the code does and why. It never records how the recon was carried out (subagent counts, tool lists, audit logs).
- **Babylon work:** if the scope uses BabylonJS or the Babylon Toolkit and you have not read the Babylon Toolkit Agent Reference in this session, fetch and read it once: https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md — it is the authority for the API and conventions the code is built on, so it tells you what is toolkit behavior and what is project code. Fetch its sub-documents only when relevant. If the fetch fails, stop and tell the user.
- **Say what you are doing.** Before any step that takes more than a few seconds (a search sweep, a big read, each subagent, the live pass) print one short line — `🔎 [bt-recon] <what> …` — and one when it returns. A recon runs long; a silent run looks like a hang and gets cancelled.
- **Subagents:** running this skill is the user's request to use them where this skill says so. Use whatever subagent tool your host provides (its name varies by host — e.g. `Agent` or `Task`); if there is none, do the work inline, slice by slice, and say so.

## Step 1. Parse the brief

From the flag-stripped brief derive `recon_title` (Title Case, e.g. `Session Camera`), `recon_slug` (lowercase kebab-case, `a-z 0-9 -` only, max 40 chars) and the **scope kind**:

- **subsystem** — the brief names a feature, module, flow or mode. Pull out every **anchor**: query-string keys and values, URLs and routes, class / function / component names, UI labels, file or folder names, endpoint fragments, and the vaguer clues ("something about edge rendering", "mask images") — each clue is a search term.
- **codebase** — the brief asks for the whole project.

Note any URL (it enables the live pass), and any audience or emphasis hints ("focus on the CMS endpoints") — emphasis deepens a section, it never drops one. If you cannot infer a sensible title, ask.

If `_specs/<recon_slug>_recon.md` already exists, ask whether to refresh it (Refresh mode) or replace it. Never overwrite it silently.

## Step 2. Locate and map the scope

1. **Find the entry points.** Search for every anchor: where a query parameter is read, a route registered, a flag checked, a component mounted, a mode switched on. For a codebase recon, start from the build config, the package manifest, the HTML entry pages and the bootstrap modules.
2. **Close the scope.** Follow imports, references, event subscriptions, registrations and string-keyed lookups outward from the entry points until no new in-scope file appears. A file the subsystem only calls into (a shared utility, the engine) is a **dependency**, listed but not mapped in depth. Include the subsystem's own styles, templates, shaders, web components and data files.
3. **Build the scope map**: every in-scope file with its line count and a one-line role; the entry points with `path:line`; anything excluded and why.
4. **History.** For the scope's paths: `git log` — authors, first and last commit dates, commit messages that reveal intent ("WIP mask export", "switch to CMS v2"), the files touched most recently. Unfinished or abandoned work often shows here first. No git → skip silently.
5. **Project docs.** Read `SPEC.md` and `DESIGN.md` headings if they exist, and any README, docs folder or code comments that describe the scope. Treat existing docs as claims to check against the code, not as truth.
6. **Size it.** `small` ≈ 15 files or fewer → read inline; `medium` → 2–4 reader subagents; `large` or a codebase recon → up to 8. For a `large` or ambiguous scope, print the scope map (files grouped by role, total lines) in a short message and confirm the boundary with the user before fanning out — a wrong boundary wastes the whole run. When the brief is explicit about the boundary, skip the check.

## Step 3. Deep read

Split the scope map into cohesive **slices** — by module, feature or layer, roughly 3–8 thousand lines each, keeping files that call each other heavily in the same slice. `small` → read every file yourself, in full. Otherwise launch one read-only reader subagent per slice (all at once where your host allows), each with a brief, not homework:

- its file list, the scope-map summary, the brief and the anchors;
- relevant Agent Reference excerpts for Babylon code, with: *"Do not fetch the Agent Reference — the parts you need are here, and this overrides any standing instruction to fetch it first. Fetch one sub-document only if you hit an API this brief does not cover, and say which."*;
- verbatim: *"Read-only: you may read, search and report. Do not edit or create files, and do not run builds, tests or any command that writes. Read every file in your list in full — not excerpts. You may open files outside your list to resolve a call, but report only what concerns your slice."*;
- the extraction schema, verbatim:

> Report on your slice under exactly these headings. Every item cites `path:line` and is tagged `[code]` or `[inferred]` (with the reason). Write "none found" under a heading that does not apply — never omit it. Report facts, not prose.
> 1. **Responsibilities** — what this slice owns and what it delegates.
> 2. **Entry points & activation** — how its code is reached: URLs, query params, routes, flags, events, init calls, lifecycle hooks.
> 3. **Public API** — exported classes, functions, components, web components, custom elements, with full signatures.
> 4. **State & data shapes** — types, models and their fields; defaults; which are persisted and where; which are runtime only.
> 5. **UI inventory** — every panel, dialog, toolbar, menu and overlay; for each, every control (button, input, toggle, slider, list, hotkey, mouse / touch gesture) → what it does → its handler `path:line`. Include enabled/disabled and visibility conditions.
> 6. **Events & messages** — emitted and consumed events, observables, callbacks, postMessage, pub/sub topics, and who listens.
> 7. **External I/O** — every network call: method, URL or URL template, request body/params shape, response shape as consumed, auth/headers, error and retry handling. Every storage use: localStorage, IndexedDB, cookies, files.
> 8. **Rendering & pipelines** — cameras, render targets, passes, post-processes, shaders and materials, offscreen renders and image exports: what each produces, at what size and format, and what each output encodes (e.g. which geometry a mask isolates, what a color or channel means).
> 9. **Configuration** — config files, constants that change behavior, environment variables, feature flags, query params, build-time switches.
> 10. **Dependencies** — internal modules and external packages this slice relies on, with versions where declared.
> 11. **Error handling & edge cases** — what is caught, what fails silently, what is validated, what is assumed.
> 12. **Debt & risk** — TODO/FIXME/HACK comments, dead or unreachable code, commented-out features, half-finished work, duplicated logic, suspected bugs (say why).
> 13. **Open questions** — what you could not determine from the code, and what would settle it.

Print one line per reader going out and one per reader coming back. If a reader returns thin or uncited findings for a heading that clearly applies, re-read that part yourself — do not pass a thin finding through.

## Step 4. Trace the end-to-end flows

Merge the findings into one picture, resolving any contradiction between readers by reading the code yourself. Then trace, step by step with citations, every journey a maintainer must understand end to end — the user-visible workflows (e.g. *activate → position the camera → save the view → CMS request → reload it later*), each data round trip (load and save), each render or export pipeline from trigger to output file, and startup and teardown. These cross-slice traces are what no single reader can see. Add a Mermaid sequence or flow diagram wherever a flow has more than a handful of hops.

## Step 5. Live pass (observe only)

Runs when the brief gives a URL and your host has a browser tool (e.g. the Chrome DevTools MCP server, Playwright), unless `--no-live`.

**Observe-only, without exception.** Never click Save, Delete, Publish, Submit, Upload or anything whose handler (from Step 3) writes data. Never send, replay or let the page send a request that changes data on a real backend (POST / PUT / PATCH / DELETE) through an action of yours. Open, tab, hover, toggle a panel's visibility, pan or orbit the view — fine. Requests the page makes on its own while loading are observed, never triggered. A write path stays documented from the code and tagged `[code]`.

1. Open the URL, wait for the app to settle, and screenshot the initial state.
2. Open each panel, dialog and mode that safe navigation reaches (the Step 3 UI inventory is your checklist) and screenshot each one to `_specs/<slug>_recon/<nn>-<panel-slug>.png`.
3. Record the network requests the page makes: real endpoint URLs, status codes, and the response shapes of the reads (field names and types — never copy secrets, tokens or personal data into the docs).
4. Record console errors and warnings.
5. Reconcile: upgrade each claim the run confirmed to `[live]`; flag every contradiction between code and runtime in the doc — a contradiction usually means a stale code path or a different deployed build, and is worth recording either way.

The app is not reachable → print how to start it (from the package scripts or README), record that in the doc header as `live: no (<reason>)`, and continue from the code.

## Step 6. Coverage audit (skipped under `--quick`)

Draft the recon doc (Step 7 template) in your context, then launch one fresh read-only auditor subagent with the draft, the scope map and this charter, verbatim:

*"You are auditing a recon document of existing code against the code itself. Read-only: do not edit or create files. (1) Inventory the scope yourself — every exported symbol, UI control handler, network call, storage key, query param, config key, event and render/export output in the listed files — and list each one the draft does not mention. (2) Pick at least 20 cited claims spread across the sections and check each against its `path:line`; report every citation that is wrong or does not support the claim. (3) List every factual claim with no citation or with the wrong confidence tag, and every section that says 'none found' when the code has something. (4) List every place the draft guesses, hedges ('probably', 'seems to') or generalizes without evidence. Report `section · item · what is wrong or missing`. Change nothing."*

Fix every gap — re-read the source rather than trusting the auditor's summary — and move what still cannot be settled into `## Unknowns`. One pass.

## Step 7. Write the recon doc

Print `✍️ [bt-recon] Writing _specs/<slug>_recon.md …` and write it to `_specs/<slug>_recon.md` (or `--out`). Get the header `commit` from `git rev-parse --short HEAD` (no git → `commit: n/a`).

Include every section. A section that genuinely does not apply says so in one line (`No network I/O in this scope [code].`) — never delete the heading, so the next reader knows it was checked. For a codebase recon with more than about 6 major systems, make this file the index (header, Summary, Architecture, End-to-End Flows, Known Issues, Extension Points, History, Unknowns, Files Reviewed) and give each system its own chapter at `_specs/<slug>_recon/<system-slug>.md` using the same template.

```markdown
# Recon: <recon_title>

scope: <the brief, one line> · kind: <subsystem|codebase>
commit: <short sha> · date: <YYYY-MM-DD> · files: <n> (<total> lines)
guide: <_specs/<slug>_guide.md | none> · live: <yes | no (<reason>)>
confidence tags: [code] read in source · [live] seen running · [history] from git · [inferred] deduced

## Summary
<What it is, who uses it, why it exists, and its current state (finished / partial / abandoned parts), in one or two paragraphs.>

## How to Activate
<URLs, query params, routes, flags, entry calls — exactly how to get into it, with examples.>

## Architecture
<Module map table: path · role · lines. A component/module diagram. Lifecycle: init → run → teardown.>

## Feature Inventory
### <Feature>
- Purpose · Trigger · Behavior · Code path (`path:line` chain) · Data read/written · Status (working / partial / dead)

## UI Reference
### <Panel or dialog>
<When it appears, how it opens and closes, screenshot link if live.>
| Control | What it does | Handler |
| --- | --- | --- |

## Data Model & State
<Types and fields, defaults, persisted vs runtime, serialization formats, example payloads.>

## External Interfaces
| Method | URL | Request | Response | Auth | Errors |
| --- | --- | --- | --- | --- | --- |
<Storage keys and file outputs.>

## Rendering & Pipelines
<Cameras, render targets, passes, shaders, image exports — what each output is, how it is made, what it encodes, where it goes.>

## Configuration
<Every switch that changes behavior, its default, where it is read.>

## End-to-End Flows
<The Step 4 traces, numbered steps with citations, plus diagrams.>

## Dependencies
<Internal modules and external packages (with versions) this scope relies on, and what for.>

## Error Handling & Edge Cases

## Known Issues & Tech Debt
<Bugs, silent failures, TODO/FIXME, dead code, half-finished work, risks — each with a citation and severity.>

## Extension Points
<For each kind of change a future feature is likely to make (a new panel, a new output type, a new endpoint, a new saved field…): where it plugs in, the pattern to mirror (`path:line`), and what else must change with it.>

## History
<Authors, timeline, notable commits and what they reveal about intent and unfinished work.>

## Glossary
<Every domain term, acronym and in-code name a newcomer will meet.>

## Unknowns
- <what is unknown> — <why> — <what would settle it>

## Files Reviewed
<The full scope map: path · lines · role. Excluded files and why.>
```

## Step 8. Write the user guide (when the scope has UI)

Write `_specs/<slug>_guide.md` when the scope has anything a person operates — panels, controls, modes, gestures, outputs they use — or with `--guide`; skip it under `--no-guide` or when there is no UI (and set `guide: none` in the recon header). Print `✍️ [bt-recon] Writing _specs/<slug>_guide.md …`.

The reader has never seen the feature and does not read code: plain language, no code, no `path:line`, every term explained on first use. It must agree with the recon doc — it is the same facts told as tasks. Use the live screenshots wherever they exist (relative links into `_specs/<slug>_recon/`). Anything the recon could not confirm is stated with a short caveat rather than presented as certain.

```markdown
# <recon_title> — User Guide

## What it's for
<What you can do with it, and why you would — in a paragraph a newcomer understands.>

## Getting started
<How to open it, step by step, with an example URL. What you see first.>

## A tour of the screen
<Every area of the screen, what it is for. Screenshots.>

## Panel by panel
### <Panel>
<What it is for, then every control: what it does, when to use it, what you see happen.>

## How do I…
### <task, e.g. "save the current view so I can load it later">
1. <step> …
<What success looks like. Common mistakes.>

## Concepts explained
<The ideas behind the outputs and modes — e.g. what each kind of mask or render shows, what it is used for, how it differs from the others, and how your choices in the scene change it.>

## Troubleshooting
<Symptom → cause → fix.>

## FAQ

## Glossary
```

## Step 9. Report

```
Recon:  _specs/<slug>_recon.md
Guide:  _specs/<slug>_guide.md | none (<why>)
Scope:  <n> files, <total> lines · live: <yes|no>
Claims: <n> [code] · <n> [live] · <n> [history] · <n> [inferred] · <n> unknowns
Top risks: <three one-liners from Known Issues>
Next: /bt-spec "<a feature>" — bt-spec reads this recon as grounding. Re-run with --refresh after code changes.
```

If the scope was the whole codebase and `SPEC.md` is missing or an empty stub, offer once to seed it from the recon using bt-spec's Project SPEC.md scaffold — the short, current-state summary (architecture, systems, conventions, dependencies); the recon keeps the depth. Do not print the docs unless asked.

## Refresh mode (`--refresh @<recon file>`)

1. Read the recon's header (`commit`, `scope`, `kind`) and its `## Files Reviewed`.
2. `git diff --stat <commit>..HEAD -- <reviewed files>`, plus a search for the original anchors to find new in-scope files. No git, or `commit: n/a` → treat every file as changed and say so.
3. Nothing changed → say so and stop.
4. Re-run Steps 3–6 for the changed and new files only, re-tracing any End-to-End Flow that passes through them, and the live pass if the recon had one and the UI changed.
5. Update the affected sections in place; set `commit` and `date` to now; update `## Files Reviewed`; append `## Changelog` (create it at the end on the first refresh): `- <date> · <old sha>..<new sha> · <what changed in the system, one line per change>`. Refresh the guide's affected sections too.
6. Report as in Step 9, plus the changelog lines.
