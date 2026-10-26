# Feature Dashboard data

`dashboard.html` renders everything from two data files in the feature folder's `documents/`:

| File | Holds | Written |
|---|---|---|
| `<slug>_dashboard.js` | the feature's record — status, phases, tasks and their results, decisions, snapshots, the After Action Report | bt-spec creates it from `dashboard.template.js` (`specified`), bt-plan fills in the plan (`planned`), bt-execute writes it at every task boundary; a Quick Plan creates it at bt-plan |
| `<slug>_live.js` | what is happening this minute — the current task, one sentence, its step log | by bt-execute's helper: every `dashboard.mjs task` write that changes a task's status, every `snapshot` and every `status` write; between them every `live` write an agent makes at a meaningful step, and the watchdog's heartbeat after 10 quiet minutes (bt-plan creates it from `live.template.js`) |
| `<slug>_followups.md` | every follow-up in full under its id, and the bt-spec commands that spec them — the document the dashboard's `/bt-spec Fix F1 from @…` commands point at | by bt-execute's helper, from `followUps`: every `followup` write and every `check` (never by hand) |

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

Use bt-execute's helper — `node <skills>/bt-execute/scripts/dashboard.mjs task|snapshot|followup|live|activity|status|check <feature-folder> …`
(every option is in its header). It parses, checks field shapes and writes atomically. Its `task`, `snapshot` and
`status` commands also rewrite the live file; between them agents write it with `live` at each meaningful step, never
15 minutes apart. `watch` is the watchdog bt-execute launches in the background at run start: a heartbeat into the
live file when nothing has been written for 10 minutes, naming the latest file that changed.

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
| `status` | `specified` (bt-spec wrote the spec; no plan yet — no phases) · `planned` · `in-progress` (a run is executing right now) · `paused` (a run ended, the plan is not finished) · `complete` · `incomplete` (finished with deferrals) |
| phase `status` | `pending` · `in-progress` · `done` · `partial` · `deferred` |
| task `status` | `pending` · `in-progress` · `built` (awaiting the verifier) · `verifying` · `done` · `deferred` · `failed` |

- Decide `status` from the plan file's checkboxes, never from memory. The page only believes `complete` when
  every task here is `done`; otherwise it shows the plan as paused with a warning.
- A task added to the plan after it was complete is added here as `pending`, in plan order, with an `updates`
  note saying why — and `complete` becomes `paused`.
- The status picks the page's top slot: `specified` shows *Plan this feature* (the `bt-plan` commands to copy, and a builder for its options and a brief); `planned` shows *Start this plan* (the `bt-execute` commands, and a builder for any task range and its options); `in-progress` shows *Current run activity* (the live file and the
  milestones); `paused`, `complete` and `incomplete` show *Execution debrief* (the After Action Report card, marked
  *Interim* while paused), with *Continue this plan* — the commands that pick up where it stopped — above it.
- **Cadence is per task — three writes**, each with `dashboard.mjs task`: when it starts (`in-progress`), the moment
  it is built (`built` — summary, files and tests filled in right then, after its frames were added with
  `dashboard.mjs snapshot`) and when it passes (`done` — verifier, attempts, done time, `checkedLive`). The verifier
  adds `verifying` while it checks; a FAIL sends the task back to `in-progress` with `attempts` + 1. Each status write
  also updates the live file. A move to `built`, `verifying` or `done` is refused while a `snapshots/T<n>-…` frame of
  that task is on no dashboard entry, and a visual task's move to `built` is refused with no snapshot at all unless
  `--no-frame "<why>"` says it has nothing to show yet.

## `<slug>_dashboard.js` fields

Top level:

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `feature` | `{ "title", "slug", "branch", "origin": "spec" \| "quick-plan", "size", "proof", "summary" }` — `branch` is the branch that was checked out when the feature was specced (skills never create one); `summary` is one plain-language paragraph. A feature specced from another feature's follow-ups also has `addresses: [{ "folder", "slug", "ids": ["F1", "F3"] }]`, written by `dashboard.mjs addresses` (bt-spec runs it); every `status` write and `check` on this feature then updates those follow-ups on the source dashboard, finding a source the user has moved by its slug |
| `documents` | `[{ "label", "path" }]` — Spec (omitted for a Quick Plan), Plan, and Run log once bt-execute has run |
| `status` | see *Status* |
| `detail` | `"normal"`, or `"verbose"` once any run used `bt-execute --verbose` (never set back) |
| `updatedAt` | last write, `"YYYY-MM-DD HH:MM"` |
| `estimate` | the plan's Total, short: `"3–6 h"` or `"about 7 h"` — the card shows its hours; keep ranges and working-out in the plan |
| `activeTime` | the plan's total active time across **every run so far** — each run's `active` from its `⏱ Run <n> end` line, added up — as the duration only: `"14 h 10 min"`, no notes. The card shows it beside the estimate, so one run's time alone understates the plan |
| `runs` | number of bt-execute runs so far |
| `afterAction` | the After Action Report (below) |
| `phases` | the plan's phases, each with its tasks (below) |
| `decisions` | `[{ "id": "D1" \| "T7", "text", "source", "updates" }]` — objects, never plain `"D1 — …"` strings (the page and `check` repair one, but it is a slip) |
| `followUps` | what a human should look at next: `[{ "id": "F1", "title", "detail", "source", "files": [], "at", "updates": [] }]`, added with `dashboard.mjs followup` (it numbers them and writes `documents/<slug>_followups.md`; `--id F2 … --note` revises one). `title` is one line; `detail` carries enough to spec it alone — what is wrong, the evidence, where to look, what fixing it involves; `source` names who raised it (`T2 verifier`). The page gives each a `/bt-spec Fix F1 from @…_followups.md` command, plus one for those ticked together. A plain string (older dashboards) is repaired into an entry with the next free id. Once a later feature takes one on, the helper adds `status` (`specced` · `planned` · `in-progress` · `done` · `partial`; no status means open) and `addressedBy: { "folder", "slug", "title", "at" }` (`at`: when the state last changed — progress, not a revision, so no `updates` note); the page then shows a state badge and a link to that feature instead of the spec command (`partial` is open again) |
| `activity` | `[{ "at", "text" }]`, oldest first — the milestones (the page shows newest first) |

`afterAction` — empty while planned; written by bt-execute at the end of every run:

| Field | Meaning |
|---|---|
| `writtenAt` | `"YYYY-MM-DD HH:MM"` |
| `headline` | one sentence: what the plan delivered |
| `body` | 2–4 paragraphs: what was built, how it was proven, what surprised |
| `highlights` | the results worth remembering |
| `comparison` | ONE before/after for the plan as a whole — "before" captured before T1 started, "after" at the end, from the same camera or viewport: `{ "title", "caption", "source", "before": { "src", "caption" }, "after": { "src", "caption" } }`, written with `dashboard.mjs snapshot <feature-folder> comparison --before snapshots/plan-before.png --after snapshots/plan-after.png --caption "…"`; `null` when the plan has nothing to see |
| `snapshots` | optional: the plan's key progression, or the end-to-end proof |
| `testing` | how the plan was tested — every run, not only `--verbose` (below) |
| `sections` | `--verbose` only: `[{ "title", "body": [paragraphs], "items": [bullets] }]`, in this order where they apply — Architecture · Phase by phase · Problems and resolutions · Deviations from the plan · Known limitations · Lessons learned · Estimate vs actual · Recommended next steps |
| `planSummary` | `"documents/<slug>_summary.html"` once the plan is `complete` and its plain-language summary page is written (bt-execute's `templates/summary/summary-guide.md`); the report links to it while the plan is complete. Absent before that |
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
| `kind` | `code` · `live` · `game` · `unity` — the plan's estimate kind |
| `verifyLevel` | `standard` · `live` |
| `status` | see *Status* |
| `summary` | what was actually done, and anything surprising |
| `files` | paths changed |
| `tests` | `{ "passed", "failed", "files": [".agents/specs/<slug>/tests/…"], "note" }` or `null`. `files` holds **paths only**, each from the project root (a test outside the feature folder: its real path, e.g. `BtMarioKartWeb/tests/RaceConfig.test.ts`), because the page links each one to the file. Counts, suite names and commands go in `note` |
| `verifier` | `"PASS — independent subagent; live check in Chrome"` |
| `checkedLive` | every run, not only `--verbose`: one line on what the verifier ran live and where — `"two-tab Shared race in headless Chrome, 150 ms lag"`; `""` when it was proven by tests alone. The page's *live check* badge and column read it (a task the plan marked `live` always counts) |
| `attempts`, `doneAt` | as recorded (bt-execute never commits, so there is no commit to record) |
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

**Add snapshots with `node <skills>/bt-execute/scripts/dashboard.mjs snapshot <feature-folder> <T3|P1|plan> --src snapshots/… --caption "…"`** (`--before`/`--after` for a comparison, `--frame "src|stage|caption"` repeated for a progression) — never by writing the JSON yourself. The image key is **`src`**, relative to the feature folder; an entry with `path` (or `file`, `image`, `url`, `href`) instead would render as "No snapshot", so every helper write repairs it to `src` (and an unknown `source` to `"browser"`), `check` repairs any already in the file, and the page reads those keys too. An image that is not on disk is refused — `check` fails on it. **The snapshots are the chronicle of the build — they tell the story of how the plan came together: `check` passing is part of every phase boundary and of run end.** Every visual task (`kind` `live`, `game` or `unity`) leaves a progression from one camera as it is built — a before frame, a frame per meaningful layer, the built frame (the builder, added before its `built` write) and the verified frames (the verifier), usually 3–8 in all — plus any comparison or angle that proves the point; a task with nothing to see needs none. The plan as a whole gets `snapshots/plan-before.png` before T1 and one plan-wide before/after (target `comparison`) at run end. Frames come from the sessions and exports the work already runs, never an extra page session or re-export just for a picture; inside an open session a capture costs seconds, so take it. Who takes which frame: bt-execute's *Snapshots tell the story*.

Any list of snapshots may mix them. `source` names where the image came from: `"browser"`, `"unity"`,
`"blender"`, `"reference"`.

| Shape | Use | Fields |
|---|---|---|
| progression | the build told stage by stage, from the same camera, in the order it happened | `{ "title", "caption", "source", "frames": [{ "src", "stage", "caption", "task", "at" }], "updates" }` |
| comparison | one change, side by side (drag slider) | `{ "title", "caption", "source", "before": { "src", "caption" }, "after": { "src", "caption" }, "updates" }` |
| still | one image that proves one thing | `{ "title", "caption", "source", "src", "updates" }` |

## `<slug>_live.js` fields

"What are you doing right now?" — answered on the page without asking. bt-execute's helper rewrites this file
whole from each change it makes: a `task` write that sets a status names the task, its phase, the role the status
implies (`in-progress` / `built` → implementer, `verifying` → verifier, otherwise orchestrator), one sentence on the
new state plus the first sentence of the summary written with it, and appends that sentence to the task's step log;
a `snapshot` adds a step naming the frame; a `status` write records the run starting or ending. A `task` write
without a status leaves it untouched. Between those, the agent doing the work writes it with `dashboard.mjs live` at
each milestone, before anything slow and at each fix attempt, never 15 minutes apart, and the watchdog writes a
heartbeat after 10 quiet minutes. A 20-minute silence shows as a warning. The page shows it only while `status` is
`in-progress`.

| Field | Meaning |
|---|---|
| `updatedAt` | `"YYYY-MM-DD HH:MM"` from the shell clock |
| `phase` | the current phase number |
| `task` | the task being worked on; `""` between tasks |
| `title` | only when there is no task: `"Verifying phase 1"`, `"Closing phase 1"` |
| `role` | `implementer` · `verifier` · `orchestrator` |
| `activity` | one plain-language sentence on what is happening this minute |
| `source` | `agent` (the helper, from an agent's write) or `watchdog` (a heartbeat from the watchdog bt-execute launches at run start — the page tags it) |
| `steps` | `[{ "at": "HH:MM", "text" }]` — the current task's log, oldest first; fresh for each task, the last 12 kept. Plain language a non-developer follows, which is why a task's `summary` leads with a plain first sentence |

## `check` — the gate

`node <skills>/bt-execute/scripts/dashboard.mjs check <feature-folder>` runs at every phase boundary, at run end and
as bt-plan's last step. It repairs the slips it can (snapshot image keys, plain-text decisions), then fails — listing
every problem in one message — when a snapshot cannot show its image or a deliverable was skipped:

- `documents/<slug>_plan.md` exists without `dashboard.html`, `documents/<slug>_dashboard.js` or `documents/<slug>_live.js`;
- the dashboard's task ids differ from the plan's checklist (`- [ ]` / `- [x]` lines that start with a task id) in
  membership or order;
- `status` is `complete` while the plan has an unticked box, or without `documents/<slug>_summary.html`;
- a visual task (`kind` `live`, `game` or `unity`) is `done` with no snapshot of its own and no phase or After Action
  Report progression frame whose `task` is its id;
- frames were left behind in `snapshots/`: a `T<n>-…` image of a `built`, `verifying` or `done` task, a `P<N>-…` image
  of a closed phase (`done`, `partial`, `deferred`) or — once the run has ended (`paused`, `complete`, `incomplete`) —
  a `plan-before` image, that no dashboard entry shows. Fix it by adding the frames, never by moving or deleting them;
- a task ticked in the plan has no `verifier` result.

With no plan in the folder (a legacy flat plan) the plan checks are skipped.
