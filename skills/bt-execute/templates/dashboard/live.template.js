/*
 * Feature Dashboard live status — .agents/specs/<slug>/documents/<slug>_live.js
 *
 * "What are you doing right now?" — answered on the page without asking. Whoever is doing the work writes
 * this file: the implementer while it builds, the verifier while it checks, the orchestrator between them.
 * Rewrite the WHOLE file each time (it is small; never patch it in place) at every meaningful step:
 * starting a task, each milestone inside it, starting a build / export / capture / test run, a fix attempt,
 * handing over to the verifier, committing. A quiet gap of 20 minutes shows as a warning on the page.
 *
 * Rules: valid JavaScript, one assignment. `updatedAt` is the shell clock, "YYYY-MM-DD HH:MM".
 * `steps` is the current task's log, oldest first — start a fresh list when a new task starts; keep the
 * last 12. Plain language a non-developer understands: "Painting the road mask from the spline", not
 * "edit RoadNetwork.ts L120". The page shows it only while the dashboard's status is "in-progress".
 */
window.FEATURE_LIVE = {
  updatedAt: "2026-01-01 09:00",
  phase: 1,
  task: "T1",                       // the task being worked on; "" between tasks
  title: "",                        // only when no task: e.g. "Verifying phase 1", "Committing phase 1"
  role: "implementer",              // implementer | verifier | orchestrator
  activity: "One sentence: what is happening this minute.",
  steps: [
    { at: "09:00", text: "Started T1 — read the plan's task block and the files it touches." }
  ]
};
