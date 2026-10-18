/**
 * The live progress panel of a bt-profile dashboard: what the profile is doing right now, its stages, its fixes and
 * the numbers so far — read from `data/progress.js` (written by `progress.mjs`) and refreshed while the run goes on.
 *
 * Used twice: `report.mjs` puts it at the top of the finished report, and `progress.mjs start` writes a live page
 * around it when a slug has no report yet. A page opened from disk (`file://`) may load a neighbouring `<script src>`
 * but not fetch a JSON file, so the data is a script that sets `window.PROFILE_PROGRESS`, re-loaded to check for
 * changes. The panel takes the report's colours where they exist and falls back to its own on the live page.
 */

/** Marks a page that carries the panel; `progress.mjs start` replaces a dashboard without it. */
export const PROGRESS_MARKER = "<!-- bt-profile progress panel -->";

export const PROGRESS_STYLES = `
.bt-progress, .btp-toolbar { --btp-surface: var(--surface-1, #1a1a19); --btp-sunken: var(--surface-0, #111110); --btp-line: var(--surface-3, #2d2d2a);
  --btp-text: var(--text-primary, #f0efec); --btp-muted: var(--text-secondary, #c3c2b7); --btp-faint: var(--text-muted, #8f8e86);
  --btp-good: var(--good, #3fae5a); --btp-active: var(--warning, #c98500); --btp-bad: var(--critical, #e66767); --btp-accent: var(--accent, #3987e5);
  --btp-mono: var(--mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
  margin: 18px 0 8px; display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); color: var(--btp-text); }
.bt-progress:empty { display: none; }
.btp-card { background: var(--btp-surface); border: 1px solid var(--btp-line); border-radius: 10px; padding: 16px 18px; min-width: 0; }
.btp-kicker { font: 600 11px/1.5 var(--btp-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--btp-faint); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.btp-kicker b { color: var(--btp-text); font-weight: 700; }
.btp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--btp-active); animation: btp-pulse 1.6s ease-in-out infinite; }
@keyframes btp-pulse { 50% { opacity: 0.3; } }
.btp-next { display: grid; gap: 6px; margin: 10px 0; }
.btp-next-row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 13px; color: var(--btp-muted); }
.btp-next-row code { font: 600 12px/1.4 var(--btp-mono); color: var(--btp-text); background: var(--btp-sunken); border: 1px solid var(--btp-line); border-radius: 6px; padding: 3px 8px; overflow-wrap: anywhere; }
.btp-copy { font: 600 11px/1 var(--btp-mono); color: var(--btp-muted); background: transparent; border: 1px solid var(--btp-line); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
.btp-copy:hover { color: var(--btp-text); border-color: var(--btp-active); }
@media screen {
  html.btp-running main > :not(header):not(h1):not(.lede):not(.btp-toolbar):not(#bt-progress):not(footer):not(script):not(style) { display: none !important; }
  html.btp-running #print, html.btp-running #pdf { display: none !important; }
}
.btp-pending-report { margin: 4px 0 0; color: var(--btp-muted); font-size: 13px; }
footer.generated-by { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--surface-3, #2d2d2a); color: var(--text-muted, #8f8e86); font-size: 12.5px; }
footer.generated-by a { color: inherit; }
.btp-toolbar[hidden] { display: none !important; }
.btp-toolbar { display: flex; justify-content: flex-end; margin: 0 0 8px; }
.btp-live-toggle { display: inline-flex; gap: 8px; align-items: center; padding: 6px 12px; border: 1px solid var(--btp-line); border-radius: 999px; background: var(--btp-surface); color: var(--btp-muted); font: 600 12px/1 var(--btp-mono); cursor: pointer; white-space: nowrap; }
.btp-live-toggle[aria-pressed="true"] { color: var(--btp-active); border-color: var(--btp-active); }
.btp-live-toggle[aria-pressed="true"]::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--btp-active); animation: btp-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .btp-dot { animation: none; } }
.btp-now { border-left: 3px solid var(--btp-active); }
.btp-now.is-stale { border-left-color: var(--btp-bad); }
.btp-age { text-transform: none; letter-spacing: 0; font-weight: 500; }
.btp-now.is-stale .btp-age { color: var(--btp-bad); font-weight: 700; }
.btp-activity { margin: 8px 0 0; font-size: 17px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.btp-warning { margin: 10px 0 0; padding: 8px 12px; border-radius: 6px; background: color-mix(in srgb, var(--btp-bad) 14%, transparent); font-size: 13.5px; }
.btp-steps { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; font-size: 13.5px; color: var(--btp-muted); }
.btp-steps li { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; overflow-wrap: anywhere; }
.btp-steps time { font: 600 12px/1.6 var(--btp-mono); color: var(--btp-faint); }
.btp-steps li:last-child { color: var(--btp-text); font-weight: 600; }
.btp-tag { padding: 1px 7px; border-radius: 5px; border: 1px solid var(--btp-line); font: 600 10.5px/1.5 var(--btp-mono); letter-spacing: 0.06em; text-transform: uppercase; }
.btp-tag.is-watchdog { color: var(--btp-active); border-color: color-mix(in srgb, var(--btp-active) 45%, transparent); }
.btp-stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
.btp-stage { min-width: 0; display: flex; flex-direction: column; }
.btp-bar { height: 8px; border-radius: 999px; background: var(--btp-line); overflow: hidden; }
.btp-fill { height: 100%; width: 0; border-radius: 999px; background: var(--btp-good); }
.btp-stage.is-done .btp-fill { width: 100%; }
.btp-stage.is-active .btp-fill { width: 50%; background: var(--btp-active); }
.btp-stage.is-skipped .btp-bar { background: repeating-linear-gradient(90deg, var(--btp-line) 0 6px, transparent 6px 10px); }
.btp-stage-label { flex: 1; margin-top: 7px; padding: 7px 9px; border: 1px solid var(--btp-line); border-radius: 8px; background: var(--btp-sunken); font: 500 11.5px/1.3 var(--btp-mono); color: var(--btp-muted); min-width: 0; }
.btp-stage.is-active .btp-stage-label { border-color: color-mix(in srgb, var(--btp-active) 45%, transparent); color: var(--btp-text); }
.btp-stage-name { display: block; font-weight: 700; color: var(--btp-text); }
.btp-stage-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; margin-top: 2px; }
.btp-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.btp-metric { background: var(--btp-sunken); border: 1px solid var(--btp-line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.btp-metric-label { font: 600 10.5px/1.4 var(--btp-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--btp-faint); }
.btp-metric-value { margin-top: 4px; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
.btp-metric-note { margin-top: 2px; font-size: 12.5px; color: var(--btp-muted); overflow-wrap: anywhere; }
.btp-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 13.5px; }
.btp-table th { text-align: left; padding: 6px 8px; font: 600 10.5px/1.4 var(--btp-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--btp-faint); border-bottom: 1px solid var(--btp-line); }
.btp-table td { padding: 8px; vertical-align: top; border-bottom: 1px solid var(--btp-line); overflow-wrap: anywhere; }
.btp-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font: 700 11px/1.6 var(--btp-mono); text-transform: uppercase; letter-spacing: 0.04em; background: var(--btp-sunken); color: var(--btp-muted); }
.btp-chip.is-kept { color: var(--btp-good); background: color-mix(in srgb, var(--btp-good) 15%, transparent); }
.btp-chip.is-reverted, .btp-chip.is-failed { color: var(--btp-bad); background: color-mix(in srgb, var(--btp-bad) 14%, transparent); }
.btp-chip.is-trying, .btp-chip.is-measuring { color: var(--btp-active); background: color-mix(in srgb, var(--btp-active) 15%, transparent); }
.btp-section-title { margin: 0 0 10px; font: 700 11px/1.5 var(--btp-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--btp-faint); }
.btp-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13.5px; max-height: 320px; overflow-y: auto; }
.btp-log li { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 10px; overflow-wrap: anywhere; }
.btp-log time { font: 600 12px/1.6 var(--btp-mono); color: var(--btp-faint); }
.btp-done > summary { cursor: pointer; list-style: none; }
.btp-done > summary::-webkit-details-marker { display: none; }
.btp-done > summary::before { content: "▸ "; color: var(--btp-faint); }
.btp-done[open] > summary::before { content: "▾ "; }
.btp-done[open] > summary { margin-bottom: 14px; }
.btp-done-body { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
.btp-summary { margin: 8px 0 0; color: var(--btp-muted); font-size: 14px; }
.btp-stopped { border-left: 3px solid var(--btp-bad); }
.btp-hint { margin: 0; color: var(--btp-muted); font-size: 14px; }
@media (max-width: 640px) {
  .btp-table, .btp-table tbody, .btp-table tr, .btp-table td { display: block; width: 100%; }
  .btp-table thead { display: none; }
  .btp-table tr { padding: 8px 0; border-bottom: 1px solid var(--btp-line); }
  .btp-table td { border: 0; padding: 2px 0; }
  .btp-table td:empty { display: none; }
  .btp-table td::before { content: attr(data-label); display: block; font: 600 10.5px/1.6 var(--btp-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--btp-faint); }
}
`;

export const PROGRESS_SCRIPT = String.raw`
(function () {
  "use strict";
  // How often the page checks the progress file while a run is going, and while it is not.
  var RUNNING_CHECK_SECONDS = 10;
  var IDLE_CHECK_SECONDS = 30;
  // A run that has written nothing for this long is flagged on the page.
  var STALE_MINUTES = 10;
  var DATA_SOURCE = "data/progress.js";
  var root = document.getElementById("bt-progress");
  if (!root) return;
  var lastFingerprint = null;
  var sawRunning = false;

  // While a run is going the page shows its progress only; the report (charts, findings, tables) appears when it ends.
  // The last known state is remembered per page, so a reload during a run does not flash the previous report.
  var STATE_KEY = "bt-profile:" + location.pathname + ":running";
  function setRunning(running) {
    document.documentElement.classList.toggle("btp-running", running);
    try { sessionStorage.setItem(STATE_KEY, running ? "1" : "0"); } catch (error) { /* private window */ }
  }
  try { if (sessionStorage.getItem(STATE_KEY) === "1") document.documentElement.classList.add("btp-running"); } catch (error) { /* private window */ }

  // Auto-update on / off (as on the bt-execute dashboard): remembered per page; off pauses the checks until turned on.
  var LIVE_KEY = "bt-profile:" + location.pathname + ":live";
  // The button is hidden for now (the page always auto-updates); set to true to show it again.
  var SHOW_LIVE_TOGGLE = false;
  function readLive() { try { return localStorage.getItem(LIVE_KEY) !== "off"; } catch (error) { return true; } }
  function writeLive(on) { try { localStorage.setItem(LIVE_KEY, on ? "on" : "off"); } catch (error) { /* private window: this visit only */ } }
  var liveEnabled = SHOW_LIVE_TOGGLE ? readLive() : true;
  var toolbar = document.createElement("div");
  toolbar.className = "btp-toolbar";
  toolbar.innerHTML = '<button class="btp-live-toggle" id="btp-live-toggle" type="button"></button>';
  toolbar.hidden = !SHOW_LIVE_TOGGLE;
  root.parentNode.insertBefore(toolbar, root);
  var toggle = toolbar.querySelector("button");
  function showToggle() {
    toggle.setAttribute("aria-pressed", String(liveEnabled));
    toggle.textContent = "Auto-update " + (liveEnabled ? "on" : "off");
    toggle.title = liveEnabled ? "Checks the run's progress every " + RUNNING_CHECK_SECONDS + " s and refreshes when it changes" : "Paused — click to check the run's progress again";
  }
  root.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".btp-copy") : null;
    if (!button) return;
    var text = button.getAttribute("data-copy");
    var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  });
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); } catch (error) { /* the command stays visible to copy by hand */ }
    area.remove();
  }
  toggle.addEventListener("click", function () {
    liveEnabled = !liveEnabled;
    writeLive(liveEnabled);
    showToggle();
    if (liveEnabled) load();
  });
  showToggle();

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function parseStamp(stamp) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp || ""));
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }
  function minutesSince(stamp) {
    var at = parseStamp(stamp);
    return at ? Math.max(0, Math.floor((Date.now() - at) / 60000)) : null;
  }
  function duration(minutes) {
    if (minutes == null) return "";
    return minutes >= 60 ? Math.floor(minutes / 60) + " h " + (minutes % 60) + " min" : minutes + " min";
  }
  function ago(stamp) {
    var minutes = minutesSince(stamp);
    return minutes == null ? "" : minutes < 1 ? "just now" : duration(minutes) + " ago";
  }
  function between(start, end) {
    var a = parseStamp(start), b = parseStamp(end);
    return a && b ? Math.max(0, Math.round((b - a) / 60000)) : null;
  }
  function list(value) { return Array.isArray(value) ? value : []; }

  function renderStages(progress) {
    return '<div class="btp-stages">' + list(progress.stages).map(function (stage) {
      var times = stage.started ? esc(stage.started) + (stage.finished ? "–" + esc(stage.finished) : "") : "";
      var note = stage.note || (stage.status === "skipped" ? "skipped" : times);
      return '<div class="btp-stage is-' + esc(stage.status || "pending") + '" title="' + esc(stage.name + (stage.note ? " — " + stage.note : "") + (times ? " · " + times : "")) + '">' +
        '<div class="btp-bar"><div class="btp-fill"></div></div>' +
        '<div class="btp-stage-label"><span class="btp-stage-name">' + esc(stage.name) + '</span><span class="btp-stage-note">' + esc(note) + "</span></div></div>";
    }).join("") + "</div>";
  }

  function renderMetrics(progress) {
    var metrics = list(progress.metrics);
    if (!metrics.length) return "";
    return '<div class="btp-metrics">' + metrics.map(function (metric) {
      return '<div class="btp-metric"><div class="btp-metric-label">' + esc(metric.label) + '</div><div class="btp-metric-value">' + esc(metric.value) + "</div>" +
        (metric.note ? '<div class="btp-metric-note">' + esc(metric.note) + "</div>" : "") + "</div>";
    }).join("") + "</div>";
  }

  function renderFixes(progress) {
    var fixes = list(progress.fixes);
    if (!fixes.length) return "";
    var headings = ["Fix", "Status", "Before → after", "Note"];
    return '<div class="btp-card"><h3 class="btp-section-title">Fixes · ' + fixes.filter(function (f) { return f.status === "kept"; }).length + " kept · " +
      fixes.filter(function (f) { return f.status === "reverted"; }).length + ' reverted</h3><table class="btp-table"><colgroup><col style="width:34%"><col style="width:14%"><col style="width:22%"><col style="width:30%"></colgroup>' +
      "<thead><tr>" + headings.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      fixes.map(function (fix) {
        var change = fix.before || fix.after ? esc(fix.before || "–") + " → " + esc(fix.after || "…") : "–";
        return '<tr><td data-label="Fix"><b>' + esc(fix.id) + "</b> " + esc(fix.title) + '</td><td data-label="Status"><span class="btp-chip is-' + esc(fix.status) + '">' + esc(fix.status) +
          '</span></td><td data-label="Before → after">' + change + '</td><td data-label="Note">' + esc(fix.note) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function renderLog(progress, limit) {
    var entries = list(progress.activity).slice().reverse();
    if (!entries.length) return "";
    return '<div class="btp-card"><h3 class="btp-section-title">Milestones</h3><ul class="btp-log">' +
      entries.slice(0, limit || entries.length).map(function (entry) {
        var clock = String(entry.at || "").slice(11, 16) || esc(entry.at);
        return "<li><time>" + esc(clock) + "</time><span>" + esc(entry.text) + "</span></li>";
      }).join("") + "</ul></div>";
  }

  function renderNow(progress) {
    var now = progress.now || {};
    var quiet = minutesSince(now.updatedAt);
    var stale = quiet != null && quiet >= STALE_MINUTES;
    var active = list(progress.stages).filter(function (s) { return s.status === "active"; })[0];
    var steps = list(now.steps);
    var elapsed = minutesSince(progress.startedAt);
    return '<div class="btp-card btp-now' + (stale ? " is-stale" : "") + '">' +
      '<div class="btp-kicker"><span class="btp-dot"></span><b>Profiling now</b>' + (active ? "<span>· " + esc(active.name) + "</span>" : "") +
      (now.source === "watchdog" ? '<span class="btp-tag is-watchdog" title="Written by the watchdog because the agent has been quiet">watchdog</span>' : "") +
      '<span class="btp-age" data-btp-age="' + esc(now.updatedAt) + '">' + esc(ago(now.updatedAt)) + "</span>" +
      (elapsed != null ? "<span>· running " + esc(duration(elapsed)) + "</span>" : "") + "</div>" +
      '<p class="btp-activity">' + esc(now.activity || "Starting…") + "</p>" +
      (stale ? '<p class="btp-warning">Nothing written for ' + esc(duration(quiet)) + ". The run may be busy with a long capture, waiting, or stopped — check the session.</p>" : "") +
      (steps.length ? '<ol class="btp-steps">' + steps.map(function (step) { return "<li><time>" + esc(step.at) + "</time><span>" + esc(step.text) + "</span></li>"; }).join("") + "</ol>" : "") +
      "</div>";
  }

  /** The commands that act on this run (type them in Claude Code): stop it while it runs, resume or restart it after. */
  function renderNext(progress) {
    var slug = progress.slug || "";
    var command = function (name) { return "/bt-profile --" + name + (slug ? ":" + slug : ""); };
    var rows = progress.status === "running" ? [["Stop this run", command("stop")]]
      : progress.status === "done" ? [["Profile it again from a fresh baseline", command("restart")]]
      : [["Continue where it stopped", command("resume")], ["Start over from a fresh baseline", command("restart")]];
    return '<div class="btp-next">' + rows.map(function (row) {
      return '<div class="btp-next-row"><span>' + esc(row[0]) + "</span><code>" + esc(row[1]) + '</code><button type="button" class="btp-copy" data-copy="' + esc(row[1]) + '">Copy</button></div>';
    }).join("") + "</div>";
  }

  function render(progress) {
    var running = progress.status === "running";
    setRunning(running);
    var title = esc(progress.title || "Profile run");
    if (running) {
      sawRunning = true;
      root.innerHTML = renderNow(progress) + '<p class="btp-pending-report">The full report — findings, charts and tables — appears here when the profile finishes.</p>' + renderNext(progress) + '<div class="btp-card">' + renderStages(progress) + "</div>" + renderMetrics(progress) + renderFixes(progress) + renderLog(progress, 12);
      return;
    }
    var stages = list(progress.stages);
    var stoppedAt = stages.filter(function (s) { return s.status === "active"; })[0];
    var fixes = list(progress.fixes);
    var kept = fixes.filter(function (f) { return f.status === "kept"; }).length;
    var reverted = fixes.filter(function (f) { return f.status === "reverted"; }).length;
    var total = between(progress.startedAt, progress.finishedAt);
    var headline = (progress.status === "done" ? "Profile finished" : progress.status === "failed" ? "Profile failed" : "Profile stopped") +
      (progress.finishedAt ? " " + esc(progress.finishedAt) : "") + (total != null ? " · " + esc(duration(total)) : "") +
      (fixes.length ? " · " + kept + " fix" + (kept === 1 ? "" : "es") + " kept, " + reverted + " reverted" : "");
    var body = '<div class="btp-done-body"><div class="btp-card">' + renderStages(progress) + "</div>" + renderMetrics(progress) + renderFixes(progress) + renderLog(progress) + "</div>";
    if (progress.status === "done") {
      root.innerHTML = '<details class="btp-card btp-done"><summary class="btp-kicker"><b>How this profile ran</b><span>' + headline + "</span></summary>" +
        (progress.summary ? '<p class="btp-summary">' + esc(progress.summary) + "</p>" : "") + renderNext(progress) + body + "</details>";
    } else {
      root.innerHTML = '<div class="btp-card btp-stopped"><div class="btp-kicker"><b>' + title + "</b><span>" + headline + "</span></div>" +
        '<p class="btp-activity">' + esc(progress.summary || (stoppedAt ? "It ended during " + stoppedAt.name + "." : "It ended before the report was written.")) + "</p>" + renderNext(progress) + "</div>" + body;
    }
  }

  function fingerprint(progress) { return JSON.stringify(progress); }

  function load() {
    if (!liveEnabled && lastFingerprint != null) return; // paused: the click that turns it on loads again
    var script = document.createElement("script");
    script.src = DATA_SOURCE + "?check=" + Date.now();
    script.onload = function () {
      script.remove();
      var progress = window.PROFILE_PROGRESS;
      if (!progress || typeof progress !== "object") { setRunning(false); return schedule(IDLE_CHECK_SECONDS); }
      var print = fingerprint(progress);
      if (print !== lastFingerprint) {
        lastFingerprint = print;
        // A run this page watched has ended: reload once, so the page shows the report it wrote.
        if (sawRunning && progress.status !== "running") return setTimeout(function () { location.reload(); }, 3000);
        try { render(progress); } catch (error) { root.innerHTML = '<div class="btp-card btp-stopped"><p class="btp-hint">The progress file could not be shown: ' + esc(error.message) + "</p></div>"; }
      }
      schedule(progress.status === "running" ? RUNNING_CHECK_SECONDS : IDLE_CHECK_SECONDS);
    };
    script.onerror = function () { script.remove(); setRunning(false); schedule(IDLE_CHECK_SECONDS); };
    document.head.appendChild(script);
  }
  function schedule(seconds) { setTimeout(load, seconds * 1000); }
  // Ages move on between checks.
  setInterval(function () {
    document.querySelectorAll("[data-btp-age]").forEach(function (element) { element.textContent = ago(element.getAttribute("data-btp-age")); });
  }, 30000);
  load();
})();
`;

/** The panel's place in a page. */
export function progressMarkup() {
    return `${PROGRESS_MARKER}\n<section class="bt-progress" id="bt-progress" aria-live="polite"></section>`;
}

/**
 * An existing report (written before the panel existed) with the live panel added — its charts, tables and findings all
 * kept: the panel's styles go into <head>, the panel to the top of <main> (else <body>), its script before </body>.
 * @returns {string|null} the report with the panel, or null when the HTML has no place for it
 */
export function withProgressPanel(html) {
    const mainOpen = html.match(/<main[^>]*>/i) || html.match(/<body[^>]*>/i);
    if (!mainOpen || !/<\/head>/i.test(html) || !/<\/body>/i.test(html)) return null;
    return html
        .replace(/<\/head>/i, `<style>${PROGRESS_STYLES}</style>\n</head>`)
        .replace(mainOpen[0], `${mainOpen[0]}\n${progressMarkup()}`)
        .replace(/<\/body>(?![\s\S]*<\/body>)/i, `<script>${PROGRESS_SCRIPT}</script>\n</body>`);
}

/** The live page for a slug that has no report yet: the panel alone, until `report.mjs` writes the report. */
export function livePage({ title }) {
    const safeTitle = String(title || "Profile").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { color-scheme: dark; --surface-0: #111110; --surface-1: #1a1a19; --surface-3: #2d2d2a; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #8f8e86; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --surface-0: #f4f4f2; --surface-1: #fcfcfb; --surface-3: #e4e3df; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77766f; } }
body { margin: 0; background: var(--surface-0); color: var(--text-primary); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 28px 16px 60px; }
h1 { margin: 0; font-size: 24px; }
.lede { margin: 6px 0 0; color: var(--text-secondary); }
${PROGRESS_STYLES}
</style>
</head>
<body>
<main>
  <h1>${safeTitle}</h1>
  <p class="lede">The performance report appears here when the profile finishes. Until then this page follows the run.</p>
  ${progressMarkup()}
  <footer class="generated-by">Generated by the <a href="https://www.npmjs.com/package/@babylonjs-toolkit/agent" target="_blank" rel="noopener noreferrer">Babylon Toolkit Desktop Agent</a></footer>
</main>
<script>${PROGRESS_SCRIPT}</script>
</body>
</html>`;
}
