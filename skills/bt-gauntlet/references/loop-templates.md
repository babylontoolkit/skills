# Loop Card Templates

The interview fills the `<SLOTS>` — including `<NAME>` and `<DELIVERABLE KIND>` — and the filled copy
becomes `_gauntlet/<name>/loop-card.md`. Kept verbatim here so they are easy to modify. A job never mixes
templates.

---

## Template A — Universal Gauntlet Loop (`--template:gauntlet`, default)

```
I want you to create <DELIVERABLE> that achieves <OBJECTIVE> at the quality
level of <CONCRETE REFERENCE OR MEASURABLE BENCHMARK>.

DELIVERABLE KIND: <web-game | unity>
Follow the matching pipeline reference for how to build and how to verify.

Build it with BabylonJS and the Babylon Toolkit (NOT Three.js), following the
Babylon Toolkit Agent Reference conventions already loaded in this session.

This gauntlet job is named <NAME>; all of its loop state lives in
_gauntlet/<NAME>/ and never anywhere else.

THE BAR IS AN IMAGE. The target lives at _gauntlet/<NAME>/reference/ and is
LOCKED — one target per locked camera in _gauntlet/<NAME>/cameras.md. Every
round captures evidence from those exact camera transforms and no others, so
the comparison is like for like.

OUT OF REACH (do not raise gaps against these):
<the elements of the target the pipeline physically cannot deliver>

Choose the approach. Break the work into the smallest important parts that can
be improved and judged independently, and record that decomposition as the part
checklist in _gauntlet/<NAME>/progress.md. Fan out builder subagents only where
the work is genuinely independent; keep tightly coupled systems under one owner.
Give every important part a separate, harsh critic with fresh context.

If the supplied assets include GLTF/GLB files carrying Babylon Toolkit component
metadata (extras.metadata.components), write the component inventory to
_gauntlet/<NAME>/components.md in round 1 and honor it every round: TOOLKIT.*
components are first-class — compose and tune them through PROJECT.* scripts,
never reimplement, bypass, or delete them (see the Agent Reference's
"Babylon Toolkit Component Authority" section). Critics fail violations.

Each critic must inspect the REAL artifact — evidence captured into
_gauntlet/<NAME>/evidence/ — never the builder's summary, and compare it
directly with the target in _gauntlet/<NAME>/reference/. It scores the rubric,
returns the FULL prioritized gap list (not one gap), and applies every hard
gate. It receives the previous round's screenshot and verdict so scores stay
comparable and regressions are caught.

Apply the stall ladder. If the best score has not improved by a full point in
two rounds, or the same top gap is named twice in a row, incremental tweaks are
FORBIDDEN — make one dramatic architectural change and record it as a STRATEGY
line. If that swing scores the same or worse, stop and escalate to me.

After EVERY round, update _gauntlet/<NAME>/progress.md and append
_gauntlet/<NAME>/rounds/round-NN.md before starting the next round, so a
brand-new session can resume this loop with `/bt-gauntlet --resume <NAME>`
at any time.

Keep looping until the output meets <SUCCESS CONDITION>, improvements no longer
justify another round, or one of these boundaries fires: <TIME / COST / ATTEMPT /
PERMISSION / SAFETY BOUNDARIES>. Escalate blockers that require human judgment.

Finish with one fresh integration critic that checks the complete artifact for
consistency, correctness, and fit with the original objective.

Do not deploy, spend money, use credentials, contact people, or make
irreversible changes without explicit approval.
```

---

## Template B — Bounded AI Loop Card (`--template:bounded`)

Use when reliability and cost matter more than dramatic language. Same slots.

```
OBJECTIVE
<OBJECTIVE — the exact outcome that should become true for <DELIVERABLE>>

DELIVERABLE KIND
<web-game | unity> — build and verify per the matching
pipeline reference.

ENGINE
BabylonJS + Babylon Toolkit (NOT Three.js), per the Babylon Toolkit Agent
Reference conventions already loaded in this session.

INPUTS AND STATE
This gauntlet job is named <NAME>; all of its loop state lives in
_gauntlet/<NAME>/ and never anywhere else.
Use: _gauntlet/<NAME>/loop-card.md, brief.md, cameras.md, pipeline.md,
progress.md, reference/, and the project sources. Record after every round in
progress.md and rounds/: what changed, evidence, score, the full gap list,
failed approach, next action, and remaining budget — so
`/bt-gauntlet --resume <NAME>` can continue from a brand-new session.

METRIC / VERIFIER
Success requires all of the following:
- Rubric score >= <PASS THRESHOLD>/10 from a fresh critic, scored on the axes in
  references/critic-rubrics.md, against the LOCKED target in reference/ captured
  from the LOCKED cameras in cameras.md
- <CONCRETE REFERENCE OR MEASURABLE BENCHMARK — objective test or benchmark>
- Every hard gate passes: perf budget, console clean, camera lock, component
  authority, and the pipeline gate for this deliverable kind
- Final fresh integration review of the complete artifact

OUT OF REACH
<elements of the target the pipeline cannot deliver — never raise gaps on these>

PROCESS
1. Inspect the current state (progress.md + pipeline.md + the actual project).
2. Choose the highest-impact unmet criterion, from the standing gap list.
3. Make one coherent improvement.
4. Run the real verifier (build/bake/export, capture from the locked camera,
   collect metrics).
5. If it fails, feed the FULL gap list into the next round. Apply the stall
   ladder: two rounds without a full point of improvement, or the same top gap
   twice, forbids incremental tweaks and forces one architectural change; if
   that fails too, stop and escalate.
6. If it passes, run a fresh independent final review.

BOUNDARIES
Allowed actions: read, draft, edit, build, bake, test, render, screenshot.
Forbidden without approval: deploy, delete, purchase, publish, message, secrets.
Stop, park state, and report when: <SUCCESS CONDITION> passes; <TIME / COST /
ATTEMPT / PERMISSION / SAFETY BOUNDARIES> is reached; the same blocker repeats;
the stall ladder reaches STALLED; or uncertainty requires human judgment.
```
