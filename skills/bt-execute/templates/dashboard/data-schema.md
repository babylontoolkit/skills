# Feature Dashboard data

`dashboard.html` renders everything from two data files in the feature folder's `documents/`:

| File | Holds | Written |
|---|---|---|
| `<slug>_dashboard.js` | the feature's record — status, phases, tasks and their results, decisions, snapshots, the After Action Report | at every task boundary (bt-plan creates it from `dashboard.template.js`) |
| `<slug>_live.js` | what is happening this minute — the current task, one sentence, its step log | at every meaningful step of a run (from `live.template.js`) |

They are **data, not code.** Each file is exactly one line of prefix and one strict-JSON value:

```js
window.FEATURE_DASHBOARD = { "schema": 1, "status": "planned", … };
window.FEATURE_LIVE = { "updatedAt": "2026-01-01 09:00", … };
```

The `window.… =` prefix exists only because a page opened from disk (`file://`) may load a neighbouring
`<script src>` but may not fetch a `.json` file. Everything after `=` and before the final `;` is strict
JSON — double-quoted keys and strings, no comments, no trailing commas — so any JSON parser can read it.
The status of the plan itself lives in the plan file's checkboxes; the dashboard mirrors it (see *Status*).

## Updating a data file

Use bt-execute's helper — `node <skills>/bt-execute/scripts/dashboard.mjs live|task|activity|status|check|watch <feature-folder> …`
(every option is in its header). It parses, checks field shapes and writes atomically. Its `watch` command is the
watchdog that writes a heartbeat into the live file when an agent has been quiet for 10 minutes.

### Fallback — parse, change, write back

Never edit the text by hand: one stray comma blanks the page. Read the file, parse the JSON, change the
fields, and write the whole file back. Every write then produces valid data by construction.

```bash
python3 - "$DATA" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
prefix, body = text.split("=", 1)
data = json.loads(body.strip().rstrip(";"))
# … change `data` here, e.g. data["status"] = "in-progress" …
path.write_text(prefix.strip() + " = " + json.dumps(data, indent=2, ensure_ascii=False) + ";\n", encoding="utf-8")
PY
```

Node works the same way (`JSON.parse` / `JSON.stringify(data, null, 2)`). Where neither runs, write the
whole file from a complete JSON value, never a partial patch. `<slug>_live.js` is small — always write it whole.

**Keep every field its documented shape.** Valid JSON is not enough: a list field written as plain text
(`"updates": "note"` instead of `"updates": [{ "at", "by", "note" }]`) once blanked a dashboard mid-run. The
lists are `updates`, `snapshots`, `files`, `decisions`, `activity`, `followUps`, `phases`, `tasks`, a snapshot's
`frames`, and in `details` the tables `changes`, `testCases`, `acceptance`, `problems` and the list `notes`.
Add to a list (`.append(...)`), never assign a string to it, and when you give a helper script to subagents,
make it check these shapes before it writes. The page repairs the common slips on load (a text `updates`
becomes one note, a text `notes` a one-item list, any other non-list an empty list) and shows an error panel
instead of a blank page if something still cannot render — it keeps checking and redraws once the file is fixed.

## Conventions

- **Paths** (documents, snapshots) are relative to the feature folder: `"snapshots/…"`, `"documents/…"`.
- **Timestamps** are local time from the shell, `"YYYY-MM-DD HH:MM"` (`date '+%Y-%m-%d %H:%M'`). The page
  orders entries and flags "new since your last visit" by plain string comparison.
- **Text** may use `` `code` `` and `**bold**`; everything else is shown as plain text.
- **Updated notifications.** Never silently rewrite an earlier phase, task, snapshot, decision or the After
  Action Report. Change it and append `{ "at", "by", "note" }` to its `updates` list — the page shows an
  **Updated** badge on it and lists it under *Updates and revisions*.

## Status

| Field | Values |
|---|---|
| `status` | `planned` · `in-progress` (a run is executing right now) · `paused` (a run ended, the plan is not finished) · `complete` · `incomplete` (finished with deferrals) |
| phase `status` | `pending` · `in-progress` · `done` · `partial` · `deferred` |
| task `status` | `pending` · `in-progress` · `built` (awaiting the verifier) · `verifying` · `done` · `deferred` · `failed` |

- Decide `status` from the plan file's checkboxes, never from memory. The page only believes `complete` when
  every task here is `done`; otherwise it shows the plan as paused with a warning.
- A task added to the plan after it was complete is added here as `pending`, in plan order, with an `updates`
  note saying why — and `complete` becomes `paused`.
- The status picks the page's top slot: `in-progress` shows *Current run activity* (the live file and the
  milestones); `paused`, `complete` and `incomplete` show *The plan summary* (the After Action Report, marked
  *Interim* while paused).
- **Cadence is per task.** A task's entry changes the moment it starts (`in-progress`), the moment it is built
  (`built` — summary, files, tests and snapshots filled in right then), while the verifier checks it
  (`verifying`) and when it passes (`done` — verifier, commit, done time).

## `<slug>_dashboard.js` fields

Top level:

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `feature` | `{ "title", "slug", "branch", "origin": "spec" \| "quick-plan", "size", "proof", "summary" }` — `summary` is one plain-language paragraph |
| `documents` | `[{ "label", "path" }]` — Spec (omitted for a Quick Plan), Plan, and Run log once bt-execute has run |
| `status` | see *Status* |
| `detail` | `"normal"`, or `"verbose"` once any run used `bt-execute --verbose` (never set back) |
| `updatedAt` | last write, `"YYYY-MM-DD HH:MM"` |
| `estimate` | the plan's Total line, e.g. `"3–6 h"` |
| `activeTime` | from the run log's `⏱` lines, e.g. `"2 h 10 min"` |
| `runs` | number of bt-execute runs so far |
| `afterAction` | the After Action Report (below) |
| `phases` | the plan's phases, each with its tasks (below) |
| `decisions` | `[{ "id": "D1" \| "T7", "text", "source", "updates" }]` |
| `followUps` | plain strings — what a human should look at next |
| `activity` | `[{ "at", "text" }]`, oldest first — the milestones (the page shows newest first) |

`afterAction` — empty while planned; written by bt-execute at the end of every run:

| Field | Meaning |
|---|---|
| `writtenAt` | `"YYYY-MM-DD HH:MM"` |
| `headline` | one sentence: what the plan delivered |
| `body` | 2–4 paragraphs: what was built, how it was proven, what surprised |
| `highlights` | the results worth remembering |
| `comparison` | ONE before/after for the plan as a whole — "before" captured before T1 started, "after" at the end, from the same camera or viewport: `{ "title", "caption", "source", "before": { "src", "caption" }, "after": { "src", "caption" } }`; `null` when the plan has nothing to see |
| `snapshots` | optional: the plan's key progression, or the end-to-end proof |
| `testing` | how the plan was tested — every run, not only `--verbose` (below) |
| `sections` | `--verbose` only: `[{ "title", "body": [paragraphs], "items": [bullets] }]`, in this order where they apply — Architecture · Phase by phase · Problems and resolutions · Deviations from the plan · Known limitations · Lessons learned · Estimate vs actual · Recommended next steps |
| `updates` | see *Updated notifications* |

`afterAction.testing` — the page shows it as *Testing and verification*, beside a task-by-task table and
every test case that it reads from the tasks themselves:

| Field | Meaning |
|---|---|
| `summary` | paragraphs: how the plan was tested — unit tests, the verifier's re-runs, what was checked live and on what, the end-to-end check |
| `suites` | `[{ "name", "command", "passed", "failed", "added", "note" }]` — every suite the plan touched, from **one last full run of each at run end**, never added up from the tasks (each task reports the whole suite it ran, so a sum counts the same tests many times). `added` is how many tests this plan wrote; `note` explains any failure that pre-dates the plan |
| `gaps` | what is not covered by a test or a live check, one string per point |

The page's *Tests passing* figure is the sum of `suites`; without them it shows how many tasks have tests.

Each phase:

| Field | Meaning |
|---|---|
| `number`, `name` | from the plan |
| `status` | see *Status* |
| `started`, `finished`, `minutes` | `"HH:MM"` and minutes, from the phase's `⏱` line |
| `summary` | what the phase delivered, in two or three sentences |
| `verifier` | `{ "result": "PASS" \| "FAIL → PASS on attempt 2", "note" }` or `null` |
| `snapshots` | phase-level story — progressions spanning several tasks |
| `tasks` | below |
| `updates` | see *Updated notifications* |

Each task:

| Field | Meaning |
|---|---|
| `id`, `title` | from the plan (`T1`, `T3.1` …) |
| `kind` | `code` · `live` · `unity` — the plan's estimate kind |
| `verifyLevel` | `standard` · `live` |
| `status` | see *Status* |
| `summary` | what was actually done, and anything surprising |
| `files` | paths changed |
| `tests` | `{ "passed", "failed", "files": [".agents/specs/<slug>/tests/…"], "note" }` or `null` |
| `verifier` | `"PASS — independent subagent; live check in Chrome"` |
| `attempts`, `commit`, `doneAt` | as recorded |
| `deferredReason` | why it was deferred, if it was |
| `decisions` | `"DECISION T1: … — source"` lines |
| `snapshots` | this task's progression, comparisons and stills |
| `details` | `--verbose` only, else `null` — see below |
| `updates` | see *Updated notifications* |

`details` (`--verbose`) — every field optional; the page shows what is present:

| Field | Meaning |
|---|---|
| `approach` | paragraphs: how it was built, how the pieces fit, why this way and not the alternatives |
| `changes` | `[{ "file", "change": "what changed in it and why" }]` |
| `testCases` | `[{ "name", "expected", "result" }]` — `result` leads with `PASS` or `FAIL`, then what was observed: `"PASS — 0→74 km/h on held W"` |
| `acceptance` | `[{ "criterion", "result": "PASS" \| "FAIL", "evidence" }]` |
| `problems` | `[{ "attempt": "1", "failed", "cause", "fix" }]` |
| `liveCheck` | what was looked at, where, at what resolution, how it was judged |
| `notes` | `["…"]` — anything a maintainer should know, one string per point |
| `timing` | `{ "build": 12, "verify": 6, "fix": 4 }` — minutes |

## Snapshot shapes

Any list of snapshots may mix them. `source` names where the image came from: `"browser"`, `"unity"`,
`"blender"`, `"reference"`.

| Shape | Use | Fields |
|---|---|---|
| progression | the build told stage by stage, from the same camera, in the order it happened | `{ "title", "caption", "source", "frames": [{ "src", "stage", "caption", "task", "at" }], "updates" }` |
| comparison | one change, side by side (drag slider) | `{ "title", "caption", "source", "before": { "src", "caption" }, "after": { "src", "caption" }, "updates" }` |
| still | one image that proves one thing | `{ "title", "caption", "source", "src", "updates" }` |

## `<slug>_live.js` fields

"What are you doing right now?" — answered on the page without asking. Whoever is doing the work rewrites
this file whole: the implementer while it builds, the verifier while it checks, the orchestrator between them —
at every meaningful step (starting a task, each milestone inside it, before a build / export / bake / capture /
test run, a fix attempt, the hand-over to the verifier, the commit). A 20-minute silence shows as a warning.
The page shows it only while `status` is `in-progress`.

| Field | Meaning |
|---|---|
| `updatedAt` | `"YYYY-MM-DD HH:MM"` from the shell clock |
| `phase` | the current phase number |
| `task` | the task being worked on; `""` between tasks |
| `title` | only when there is no task: `"Verifying phase 1"`, `"Committing phase 1"` |
| `role` | `implementer` · `verifier` · `orchestrator` |
| `activity` | one plain-language sentence on what is happening this minute |
| `source` | `agent` (an agent wrote it) or `watchdog` (a heartbeat written because the agent was quiet — the page tags it) |
| `steps` | `[{ "at": "HH:MM", "text" }]` — the current task's log, oldest first; start fresh for each task, keep the last 12. Plain language a non-developer follows: "Painting the road mask from the spline", not "edit RoadNetwork.ts L120" |
