/*
 * Feature Dashboard data — .agents/specs/<slug>/documents/<slug>_dashboard.js
 *
 * dashboard.html (copied from this template folder) renders everything from this one object. It is plain
 * JavaScript loaded with <script src>, so the page works opened straight from disk. Rules:
 *   - Keep it valid JavaScript: one `window.FEATURE_DASHBOARD = { … };` assignment, JSON-style values.
 *   - Paths (documents, snapshots) are relative to the feature folder: "snapshots/…", "documents/…".
 *   - Every timestamp is local time from the shell, formatted "YYYY-MM-DD HH:MM" (the page orders and
 *     flags "new since your last visit" by plain string comparison).
 *   - Text fields may use `code` and **bold**; everything else is shown as plain text.
 *   - Never silently rewrite an earlier phase, task, snapshot, decision or the After Action Report. Change it and append
 *     an entry to its `updates` list: { at, by, note } — the page shows an "Updated" badge on it and lists
 *     it under "Updates and revisions".
 *
 * Status values — report: planned | in-progress (a run is executing right now) | paused (a run ended, plan not
 *                         finished) | complete | incomplete (plan finished with deferrals)
 *   Decide it from the plan file's checkboxes. The page only believes "complete" when every task here is done;
 *   otherwise it shows the plan as paused with a warning. A task added to the plan after it was complete is
 *   added here as "pending" (with an `updates` note) and the status becomes "paused".
 *   The status picks the page's top slot: in-progress shows Current run activity (the live file + milestones);
 *   paused / complete / incomplete show the After Action Report instead (paused marks it Interim).
 *                 phase:  pending | in-progress | done | partial | deferred
 *                 task:   pending | in-progress | built (awaiting the verifier) | verifying | done | deferred | failed
 *
 * Update cadence: per TASK, not per phase. A task's entry changes the moment it starts (in-progress), the moment
 * it is built (built — with its summary, files, tests and snapshots filled in right then), while the verifier
 * checks it (verifying) and when it passes (done — verifier, commit, done time). The minute-by-minute "what is
 * happening now" lives in the separate live file, documents/<slug>_live.js (schema: live.template.js).
 *
 * Snapshot shapes (any list of snapshots may mix them):
 *   progression — the build told stage by stage, from the same camera, in the order it happened:
 *     { title, caption, source, frames: [ { src, stage, caption, task, at }, … ], updates }
 *   comparison  — one change, side by side (drag slider):
 *     { title, caption, source, before: { src, caption }, after: { src, caption }, updates }
 *   still       — one image that proves one thing:
 *     { title, caption, source, src, updates }
 *   `source` names where the image came from: "browser", "unity", "blender", "reference".
 */
window.FEATURE_DASHBOARD = {
  schema: 1,

  feature: {
    title: "Feature Title",
    slug: "feature-slug",
    branch: "project/feature/feature-slug",
    origin: "spec",                       // "spec" (bt-spec) or "quick-plan" (bt-plan Quick Plan)
    size: "medium",
    proof: "functional",
    summary: "One paragraph: what this feature is and why it exists, in plain language."
  },

  documents: [
    { label: "Spec", path: "documents/feature-slug_spec.md" },          // omit for a Quick Plan
    { label: "Plan", path: "documents/feature-slug_plan.md" },
    { label: "Run log", path: "documents/feature-slug_autopilot.md" }   // add once bt-execute has run
  ],

  status: "planned",
  detail: "normal",                      // "verbose" once any run used bt-execute --verbose (never set back)
  updatedAt: "2026-01-01 09:00",
  estimate: "3–6 h",                      // the plan's Total line
  activeTime: "",                         // from the run log's ⏱ lines, e.g. "2 h 10 min"
  runs: 0,

  // The After Action Report — the whole plan's execution, start to finish. Empty while planned; written by
  // bt-execute at the end of every run, and shown in the top slot once no run is executing ("Interim" while paused).
  afterAction: {
    writtenAt: "",                        // "YYYY-MM-DD HH:MM"
    headline: "",                         // one sentence: what the plan delivered
    body: [],                             // 2–4 paragraphs: what was built, how it was proven, what surprised
    highlights: [],                       // the results worth remembering
    // ONE before/after for the plan as a whole: "before" captured before T1 started, "after" at the end,
    // from the same camera or viewport. null when the plan has nothing to see.
    comparison: null,                     // { title, caption, source, before: { src, caption }, after: { src, caption } }
    snapshots: [],                        // optional: the plan's key progression, or the end-to-end proof
    // --verbose only: the full debrief, one card per section, in this order where they apply —
    // Architecture · Phase by phase · Problems and resolutions · Deviations from the plan · Known limitations ·
    // Lessons learned · Estimate vs actual · Recommended next steps
    sections: [],                         // { title, body: [paragraphs], items: [bullets] }
    updates: []
  },

  phases: [
    {
      number: 1,
      name: "Phase name from the plan",
      status: "pending",
      started: "",                        // "HH:MM" — from the ⏱ phase line
      finished: "",
      minutes: 0,
      summary: "",                        // what this phase delivered, in two or three sentences
      verifier: null,                     // { result: "PASS" | "FAIL → PASS on attempt 2", note: "…" }
      snapshots: [],                      // phase-level story: progressions spanning several tasks
      updates: [],
      tasks: [
        {
          id: "T1",
          title: "Task title from the plan",
          kind: "code",                   // code | live | unity — the plan's estimate kind
          verifyLevel: "standard",        // standard | live
          status: "pending",
          summary: "",                    // what was actually done, and anything surprising
          files: [],
          tests: null,                    // { passed: 4, failed: 0, files: [".agents/specs/<slug>/tests/…"], note: "" }
          verifier: "",                   // "PASS — independent subagent; live check in Chrome"
          attempts: 0,
          commit: "",
          doneAt: "",
          deferredReason: "",
          decisions: [],                  // "DECISION T1: … — source"
          snapshots: [],                  // this task's progression / comparisons / stills
          // --verbose only: the task's full write-up. Every field optional; the page shows what is present.
          details: null,                  // {
                                          //   approach: ["how it was built, how the pieces fit, why this way and not the alternatives"],
                                          //   changes: [{ file, change: "what changed in it and why" }],
                                          //   testCases: [{ name, expected, result: "PASS" | "FAIL …" }],
                                          //   acceptance: [{ criterion, result: "PASS" | "FAIL", evidence }],
                                          //   problems: [{ attempt: "1", failed, cause, fix }],
                                          //   liveCheck: "what was looked at, where, at what resolution, what was judged",
                                          //   notes: ["anything a maintainer should know"],
                                          //   timing: { build: 12, verify: 6, fix: 4 }   // minutes
                                          // }
          updates: []
        }
      ]
    }
  ],

  decisions: [],                          // { id: "D1" | "T7", text, source, updates }
  followUps: [],                          // plain strings: what a human should look at next
  activity: [                             // oldest first; the page shows newest first
    { at: "2026-01-01 09:00", text: "Plan written — 1 task in 1 phase, estimated 3–6 h." }
  ]
};
