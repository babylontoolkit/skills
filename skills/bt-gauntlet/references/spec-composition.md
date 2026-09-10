# Composition with the Spec Workflow, and Cross-Host Notes

## Composition with bt-spec / bt-plan / bt-execute

**The gauntlet contains its own plan — never run bt-plan on gauntlet work.** The mapping to the sibling
skills:

| Spec workflow | Gauntlet equivalent |
| --- | --- |
| `_specs/<feature>_spec.md` (bt-spec) | `_gauntlet/<name>/loop-card.md` — objective, benchmark, rubric, success condition, boundaries |
| `_specs/<feature>_plan.md` (bt-plan) | the part checklist in `_gauntlet/<name>/progress.md` — the lead agent's round-1 decomposition |
| bt-execute `ALL` (checkbox resume) | the round protocol + `--resume <name>` |

The difference is when a box may flip. A **bt-plan task** is feed-forward: known work, visited once, `- [x]`
when its acceptance verifies. A **gauntlet part** is feedback: `- [x]` only when a fresh critic scores it at
or above the pass threshold with every gate green, however many rounds that takes.

**Rule of thumb:** acceptance criteria you can enumerate up front, each satisfiable in one pass →
**bt-spec → bt-plan → bt-execute**. "As good as *that*" against a reference, unknown iteration count →
**bt-gauntlet**.

**Typical sequence for a real game — use both:**

1. **Foundation via the spec workflow** — scaffold, player controller, physics, level loading, weapon
   systems, HUD. Checklist-shaped work with crisp acceptance; cheaper and faster than critic rounds.
2. **Quality via a gauntlet job** — once the game exists, `/bt-gauntlet --name:aaa-polish <brief>` with the
   reference media. The loop builds on whatever the plan produced.

For a `unity-level` deliverable the same split applies, one layer down: use the spec workflow to scaffold
the Unity project, install the three packages and get a first export working end to end (that work is
enumerable and verifiable in one pass), then hand the *fidelity* problem to a gauntlet job. The Unity
Exporter reference points at this skill for exactly that step.

### Inside the spec loop (bt-gauntlet named in a bt-spec brief)

When a bt-spec / bt-plan / bt-execute run encounters this skill named in its brief (e.g. `/bt-spec Build the
racing game, then polish it to Gran Turismo quality using bt-gauntlet`), the composition follows the same
idiom bt-prototype uses with bt-hero — **pre-resolve everything at spec time so nothing prompts mid-run**:

- **bt-spec:** the interview happens HERE, at spec time — the spec answers every loop-card slot (including
  `<NAME>`, `<DELIVERABLE KIND>`, the reference media or target-generation prompt, the locked cameras, the
  `OUT OF REACH` list and the boundaries) and writes the **pre-filled loop card** as a spec artifact
  (e.g. `_specs/<feature>_gauntlet-card.md`).
- **bt-plan:** the gauntlet becomes one task (usually the last), whose Details invoke
  `/bt-gauntlet --card:_specs/<feature>_gauntlet-card.md --rounds:N`. Its **Acceptance** is observable:
  "gauntlet job `<name>` reports DONE — success condition met and the integration critic passed — as
  evidenced by `_gauntlet/<name>/progress.md` and the final round journal."
- **bt-execute:** runs the task by invoking the gauntlet non-interactively. Because a gauntlet may outlast
  one session, the task's checkbox stays `- [ ]` while the job is merely parked; each later
  `bt-execute <plan> NEXT` run re-enters via `/bt-gauntlet --resume <name>` and the box flips only when the
  job genuinely reports DONE (or a loop-card boundary fires and the user accepts the parked result — record
  which). The gauntlet's own critic evidence IS the acceptance evidence; the bt-execute verifier reads
  `progress.md` + the last round journal rather than re-judging the art.

bt-gauntlet never orchestrates bt-spec itself — composition is always initiated from the spec side.

---

## Cross-Host Notes

This skill runs the same everywhere because resumability depends on nothing but the `_gauntlet/` files and
re-invocation — no host loop feature is required.

- **Subagents:** tool names differ (Claude Code `Agent`/`Task`; other hosts their own equivalent). Check the
  tools you actually have; never call one you don't. No subagent tool → inline with the fresh-context
  discipline.
- **Browser evidence:** chrome-devtools MCP on Claude Code; other hosts use their browser/screenshot tool.
  None available → parts are `unverified`, never passed.
- **Image generation:** the toolkit's `kie-image` MCP (`generate_image`) where configured; any host image
  tool otherwise. None available and no user-supplied reference → stop and ask (see `target-images.md`).
- **Interview:** `AskUserQuestion` where the host has it; plain numbered questions otherwise.
- **Unity / Blender CLIs:** shell tools, so they work on any host with a shell. A host with no shell cannot
  run the `unity-level` or `blender-model` pipelines — say so rather than degrading silently.
- **Skill loading:** where skills are loaded with a tool (the Babylon Toolkit App Builder platform),
  `load_skill('bt-gauntlet')`; where skills are files on disk (Claude Code), this folder lives in
  `~/.claude/skills/` or the project's `.claude/skills/`. **Copy the entire folder — SKILL.md alone is not
  the skill**, the `references/` are loaded on demand.

### What an `unverified` part means

A part is `unverified` when the host cannot produce the evidence its rubric needs (no browser tool, no
graphics device for a Unity capture, no image tool for a target). An `unverified` part:

- can **never** be flipped to `- [x]` on the builder's word;
- does not block other parts — keep looping on parts that *can* be verified;
- is reported explicitly at every park, with what is missing, so the user can supply the tool and re-run;
- makes the job ineligible for DONE. A gauntlet with unverified parts parks as `PARTIAL`, never `DONE`.
