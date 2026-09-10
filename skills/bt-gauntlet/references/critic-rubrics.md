# Critic Contract, Rubrics and the Stall Ladder

The critic is the only thing standing between a gauntlet and a builder that grades its own homework.
This document defines exactly what a critic receives, what it must return, and how the loop reacts.
`SKILL.md` § *The Round Protocol* step 5 is the entry point; everything below is the detail.

---

## 1. What a critic receives — and what it must never see

A critic is a **fresh-context subagent**. It gets a fixed input set:

| Input | Why |
|---|---|
| `loop-card.md` | the objective, the bar, the success condition |
| The part's entry from `progress.md` | what this round was trying to fix |
| `reference/` — the target image(s) for this part's camera | the bar, as pixels |
| `evidence/round-NN-<part>-<camera>.png` | our current result, from the **locked camera** |
| `evidence/round-NN-<part>-metrics.json` | FPS, draw calls, console errors, load time, export metadata |
| The **previous round's** screenshot and verdict for this part, when one exists | so scores are comparable and regressions are visible |
| `components.md` when it exists | component-authority enforcement |
| `cameras.md` | to confirm the evidence was shot from the locked transform |
| The pipeline's extra criteria (see the pipeline reference for the deliverable kind) | export boundary, GUID survival, etc. |

**It must never see:** the builder's rationale, its chain of decisions, its summary of what it did, its
own claim of success, or the round journal's narrative. The critic grades pixels, numbers and behaviour —
never effort or intent.

> If the host has no subagent tool, the critique step still runs, but under the same discipline: look only
> at the inputs above. Say `no subagent tool available` plainly in the round journal.

---

## 2. What a critic must return

### 2.1 A scored rubric — the same axes every round

Fractional scores allowed. The axes depend on the deliverable kind; the pipeline reference names which
table applies.

**Scene / level / in-game visual rubric** — for `web-game` jobs and for **scene parts** of a `unity` job (lighting, GI, IBL, probes, atmosphere, composition, set dressing) — **10 points**:

| Axis | Points | What it covers |
|---|---|---|
| **Composition** | 0–2 | Camera, framing, layout. Position and scale of every major element vs. the target. Silhouette of the scene as a whole. |
| **Lighting & Atmosphere** | 0–3 | Colour palette, exposure, contrast, shadow shape and softness, bounce/GI, ambient, fog and depth cueing, reflections, glow. Is the scene too dark or too bright vs. the target? |
| **Materials & Surfacing** | 0–2 | Every surface: albedo, roughness, metallic, normal detail, translucency, wetness. Nothing blocky, plasticky or fake unless the target is too. |
| **Detail & Density** | 0–2 | Set dressing, clutter, wear, edge damage, decals, scatter, small-scale variation. Does the frame hold up under a fine-toothed comb? |
| **Motion & Life** | 0–1 | Animation, wind, particles, flicker, ambient movement. Score `n/a` and redistribute to Detail when the part is genuinely static. |

**Model / asset rubric** — for **asset parts** of a `unity` job (an individual model: silhouette, UVs, bakes, materials, topology, rig) — **10 points**:

| Axis | Points | What it covers |
|---|---|---|
| **Silhouette & Proportion** | 0–2 | Read at thumbnail size; proportions against the target and against real-world reference. |
| **Surface & Material** | 0–3 | PBR maps, roughness variation, normal/AO detail, texel density, seams, no stretched UVs. |
| **Detail Density** | 0–2 | Panel lines, wear, bevels, small forms. Detail where the eye goes, not uniformly smeared. |
| **Topology & Efficiency** | 0–2 | Triangle budget, sensible edge flow, LOD chain, no n-gons where they matter, clean normals. |
| **Integration Readiness** | 0–1 | Scale, orientation, pivot, naming, ≤ 4 influences/vertex and weights normalised for skinned meshes. |

### 2.2 A full, prioritized gap list — not one gap

**This is the single most important change from earlier versions of this skill.** The critic returns
**every** gap it can find, ordered most-impactful first, each one actionable:

```
GAP 01  [Lighting]  Key light is ~40° too high and far too neutral. Target has a low
                    warm sun (~12° elevation, ~3200K) throwing long shadows across the
                    courtyard from camera-left. Fix: rotate the directional light to
                    (12, -145, 0), set colour to #FFB870, intensity ~2.4, re-bake.
GAP 02  [Materials] Cobblestones read as flat plastic — no normal map bound and roughness
                    is uniform 0.5. Fix: bake or generate a normal + roughness pair,
                    roughness range 0.35–0.8 with dirt in the crevices.
GAP 03  [Detail]    Target has standing water and wet edges along the gutters; ours is
                    bone dry. Fix: add a wetness mask ...
...
```

Rules the critic must follow:

- **Be nitpicky and precise.** A gigantic list is correct when the product is nowhere near the target.
- **Never write non-actionable feedback.** "This tree looks fake" is banned. Name *what* creates the
  impression and *how* to fix it: "the trunk has no bark normal map and the canopy is a single opaque
  card — swap to layered alpha-tested branch planes with a translucency map."
- **Say when something needs to be thrown away.** If the model, layout or lighting rig needs a full
  redesign, say so. Do not sugarcoat and do not settle.
- **Stay inside the reachable set.** The loop card's `OUT OF REACH` list names things the pipeline
  physically cannot deliver (§ target-image reachability in `SKILL.md`). Do not raise gaps against those.

The **top gap** — `GAP 01` — is what gets recorded in `progress.md` as the named gap for the round, and is
what the stall ladder watches. The rest of the list stays in the round journal and is the builder's queue.

### 2.3 Hard gates — pass/fail, never scored

Scores can be gamed; gates cannot. **A part PASSES only when the rubric score meets the loop card's
threshold AND every gate passes.**

| Gate | Fails when |
|---|---|
| **Perf** | the loop card's FPS / draw-call / load-time / memory budget is missed |
| **Console** | any error in the browser console (warnings are reported, not fatal, unless the card says otherwise) |
| **Component authority** | a protected `TOOLKIT.*` component was reimplemented, bypassed or deleted without the full replacement-evidence checklist in the round journal |
| **Camera lock** | the evidence was not captured from the transform recorded in `cameras.md` |
| **Pipeline gate** | whatever the deliverable kind's pipeline reference declares (export-boundary integrity, GUID survival, licence tier …) |

### 2.4 The verdict line

```
PART: P3 Level lighting & atmosphere
SCORE: 6.5 / 10   (Comp 1.5 · Light 1.5 · Mat 1.5 · Detail 1.5 · Motion 0.5)
PREVIOUS: 5.0 / 10 (round 09)
GATES: perf PASS · console PASS · authority PASS · camera PASS · export PASS
VERDICT: FAIL
TOP GAP: GAP 01 — key light elevation and colour temperature
REGRESSION: none
```

---

## 3. Continuity between rounds

The critic is fresh-context, but it is **not** memoryless about the score. It always receives the previous
round's screenshot and verdict for that part, with this instruction:

> Maintain consistency with the prior judgment — the same axes, the same standards, so the two scores are
> comparable. Do not feel obliged to match or increase the score. **If the product regressed, score it
> worse and say what regressed.**

Without this, round-over-round scores are not on the same scale, and the no-improvement counter in
`progress.md` measures nothing.

---

## 4. The stall ladder

Repetition without a changed strategy is a boundary event, not persistence. Two tiers, both with concrete
triggers, both checked in the round protocol's gate check.

### Tier 1 — STALL APPROACHING

Fires when **either** is true for a part:

- the best score for that part has not improved by **≥ 1.0 point in 2 rounds**, or
- the critic has named the **same top gap twice in a row**.

Response — **incremental tweaks are forbidden for the next round on that part.** Step back and look for the
architectural cause: the assets are simply not good enough; the lighting rig is wrong in kind, not degree;
the camera is in the wrong place; the layout does not match the target's structure; the material system
cannot express what the target shows. Make **one dramatic change** and record it in the round journal as:

```
STRATEGY: <what is being thrown away and what replaces it>
```

### Tier 2 — STALLED

Fires when the Tier 1 architectural swing scored **the same or worse**.

Response — **stop. Do not spend another round guessing at a different dramatic change.** Park the job,
write the status, and escalate to the user with:

- the target image and the two most recent evidence screenshots side by side,
- the standing gap list,
- what the architectural swing changed and what it scored,
- a specific question: is the current state good enough, or is something fundamental wrong with the target?

Record both tiers in `progress.md` under `Budgets:` as `stall: none | approaching | stalled`.

---

## 5. The integration critic

Run once, when the success condition is met, before reporting DONE. Fresh context, sees the whole artifact
end to end rather than one part. Local quality can rise while the whole becomes inconsistent — this is the
pass that catches it.

It checks: consistency of lighting and material language across parts, seams and transitions, whether the
sum still answers the loop card's OBJECTIVE, and every hard gate measured on the complete artifact rather
than per part. It returns the same rubric + gap list shape. A FAIL here reopens the parts it names.
