/**
 * bt-profile report: turns an analysis (and optionally a baseline analysis and the agent's findings file) into one
 * self-contained HTML dashboard — `.agents/profile/<slug>/dashboard.html`, beside the slug's `data/` folder.
 *
 * Usage (from `.agents/profile/<slug>/data`):
 *   node ../../.tools/report.mjs --analysis runs/<run>/cold/analysis.json [--out ../dashboard.html]
 *     [--baseline runs/<baseline>/cold/analysis.json] [--warm runs/<run>/warm/analysis.json]
 *     [--findings ./findings.json] [--title "Race start"] [--pdf false]
 *     [--snapshots runs/<snapshots run>/cold] [--snapshots-before <dir of earlier shots>]
 * `--snapshots` shows the screenshots of a separate `--snapshots true` capture (so the measured run stays free of
 * screenshot overhead); `--snapshots-before` sets them beside earlier shots of the same names (e.g. the smoke run).
 *
 * findings.json (written by the agent — the diagnosis in plain language):
 *   { "title", "summary", "findings": [{ "id", "title", "severity": "critical|major|minor", "status": "fixed|proposed|reverted|not-fixed",
 *     "phases": [..], "cost", "cause", "evidence": [..], "code": [{ "file", "line", "label" }], "fix", "before", "after", "diff",
 *     "gain", "risk", "verify",
 *     "subsystem", "recon", "confidence": "confirmed|inferred", "guards": [..] }] }
 *   gain / risk / verify: optional — the expected win, what could break, how to prove it.
 *   subsystem: the code the fix lives in, in a few words ("Shadow rendering"); fixes that share one share a recon.
 *   recon: the bt-recon doc of that code, from the project root — the profile's own (".agents/profile/<slug>/recon/
 *     shadow-rendering_recon.md") or a general one (".agents/recon/shadow-rendering_recon.md").
 *   confidence: "confirmed" once the cause is traced in the code, "inferred" while it rests on the profile's shape alone.
 *   guards: what a change there must not break — callers, invariants, the tests that cover it (from the recon).
 * Every build also writes findings.md beside the dashboard: the same diagnosis as a spec-ready document (one section per
 * finding — cause, evidence, code, proposed fix, gain, risk, how to verify) to fix later with a full spec (bt-spec).
 * Both list a bt-recon command per subsystem (the code behind the fixes, mapped for the spec) and bt-spec commands that
 * cite those recon docs.
 */
import fs from "node:fs";
import path from "node:path";

import { PROGRESS_SCRIPT, PROGRESS_STYLES, progressMarkup } from "./lib/progress-panel.mjs";

/** Owner groups drawn in the charts, in fixed categorical slot order (slot colours never move between charts). */
const OWNER_GROUPS = [
    { id: "babylon", label: "BabylonJS engine", owners: ["babylon"], slot: 1 },
    { id: "yours", label: "Your code", owners: [], slot: 2 },
    { id: "toolkit", label: "Babylon Toolkit", owners: ["toolkit"], slot: 3 },
    { id: "physics", label: "Havok physics", owners: ["physics"], slot: 4 },
    { id: "shader", label: "Shader translation", owners: ["shader"], slot: 5 },
    { id: "gc", label: "Garbage collection", owners: ["gc"], slot: 6 },
    { id: "program", label: "Browser", owners: ["program", "native"], slot: 7 },
    { id: "other", label: "Other libraries", owners: ["react", "vendor"], slot: 0 },
];

/**
 * Reads `--name value` pairs from the command line.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Record<string, string>} the parsed flags
 */
function parseArguments(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, "")] = argv[i + 1];
    return flags;
}

/** Reads a JSON file, or returns null when the flag is absent. */
/** Walks up from a folder to the first one holding `name`; returns the path found (the file) or null. */
function findUp(dir, name) {
    for (let current = dir; current; current = path.dirname(current) === current ? null : path.dirname(current)) {
        if (fs.existsSync(path.join(current, name))) return path.join(current, name);
    }
    return null;
}

/** The slug folder of a run folder laid out as `<slug>/data/runs/<run>/<cold|warm>` (no config needed), else null. */
function slugDirOfRun(dir) {
    for (let current = dir; current && path.dirname(current) !== current; current = path.dirname(current)) {
        if (path.basename(current) === "runs" && path.basename(path.dirname(current)) === "data") return path.dirname(path.dirname(current));
    }
    return null;
}

const readJson = (file) => (file ? JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) : null);

/** Escapes text for HTML. */
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);

/** Maps an owner id to its chart group id, given the capture's own "yours" owners. */
function groupOf(owner, yourOwners) {
    if (yourOwners.includes(owner)) return "yours";
    const group = OWNER_GROUPS.find((candidate) => candidate.owners.includes(owner));
    return group ? group.id : "other";
}

/**
 * Reduces an analysis to what the page draws: timeline buckets grouped by owner group, phases, tables, excerpts.
 * Run files are found beside the analysis file (not at the path recorded in it), so a slug folder can be moved.
 * @returns {object} the page data for one run
 */
function pageData(analysis, reportDir, captureDir) {
    const yourOwners = analysis.yourOwners || ["project"];
    const timeline = analysis.timeline.map((bucket) => {
        const groups = {};
        for (const [owner, ms] of Object.entries(bucket.owners || {})) {
            const group = groupOf(owner, yourOwners);
            groups[group] = (groups[group] || 0) + ms;
        }
        return { t: bucket.t, fps: bucket.fps, cpu: bucket.cpuMeanMs, busy: bucket.busyPct, worst: bucket.worstMs, shaders: bucket.newShaders, particles: bucket.particles, draws: bucket.draws, heap: bucket.heapMb, groups, top: bucket.top, topYours: bucket.topYours };
    });
    const relative = (file) => path.relative(reportDir, path.join(captureDir, file)).split(path.sep).join("/");
    return {
        capture: analysis.capture,
        ownerLabels: analysis.ownerLabels,
        yourOwners,
        overall: analysis.overall,
        phases: analysis.phases,
        timeline,
        marks: analysis.marks,
        worstFrames: analysis.worstFrames,
        lateStutter: analysis.lateStutter || null,
        hotLines: analysis.hotLines,
        excerpts: analysis.excerpts,
        heap: analysis.heap,
        loaf: analysis.loaf,
        signals: analysis.signals,
        shots: (analysis.shots || []).map((name) => ({ name: name.replace(/\.png$/, ""), src: relative(path.join("shots", name)) })),
        filmstrip: (analysis.filmstrip || []).map((frame) => ({ t: frame.t, src: relative(frame.file) })),
        cpuprofile: path.join(captureDir, "cpu.cpuprofile"),
    };
}

/** The page's stylesheet: a dark code-dashboard look, with a selected light variant. */
const STYLES = `
:root {
  color-scheme: dark;
  --surface-0: #111110; --surface-1: #1a1a19; --surface-2: #232321; --surface-3: #2d2d2a;
  --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
  --grid: #34342f; --accent: #3987e5;
  --good: #3fae5a; --warning: #c98500; --serious: #d95926; --critical: #e66767;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-0: #77766f;
  --code-bg: #141413; --hot: rgba(217, 89, 38, 0.22);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root:where(:not([data-theme="dark"])) {
    color-scheme: light;
    --surface-0: #f4f4f2; --surface-1: #fcfcfb; --surface-2: #f0efec; --surface-3: #e4e3df;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77766f;
    --grid: #e4e3df; --accent: #2a78d6;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
    --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --series-0: #9a998f;
    --code-bg: #f6f6f4; --hot: rgba(235, 104, 52, 0.18);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --surface-0: #f4f4f2; --surface-1: #fcfcfb; --surface-2: #f0efec; --surface-3: #e4e3df;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77766f;
  --grid: #e4e3df; --accent: #2a78d6;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --series-0: #9a998f;
  --code-bg: #f6f6f4; --hot: rgba(235, 104, 52, 0.18);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-0); color: var(--text-primary); font: 14px/1.5 var(--sans); }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
header.top { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); margin: 40px 0 12px; font-weight: 600; }
h3 { font-size: 15px; margin: 0 0 6px; }
.meta { color: var(--text-muted); font: 12px/1.6 var(--mono); }
.verdict.disturbed { border-left-color: var(--serious); }
.verdict { background: var(--surface-1); border: 1px solid var(--surface-3); border-left: 3px solid var(--accent); border-radius: 8px; padding: 14px 16px; margin: 16px 0; color: var(--text-primary); font-size: 15px; }
/* Balanced rows of equal tiles: renderTiles sets --tile-columns (8 tiles → 2 × 4, 6 → 2 × 3); two per row on a phone */
.tiles { display: grid; grid-template-columns: repeat(var(--tile-columns, 4), minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 10px; }
@media (max-width: 720px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.tile { background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 8px; padding: 12px 14px; }
.tile .label { color: var(--text-secondary); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.tile .delta { font: 12px var(--mono); margin-top: 2px; }
.delta.better { color: var(--good); } .delta.worse { color: var(--critical); } .delta.same { color: var(--text-muted); }
.panel { background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 10px; padding: 16px; overflow-x: auto; }
.finding a, .finding li { overflow-wrap: anywhere; }
main { overflow-wrap: anywhere; }
.chart { width: 100%; height: auto; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.tooltip { position: fixed; pointer-events: none; z-index: 10; background: var(--surface-2); border: 1px solid var(--surface-3); border-radius: 6px; padding: 8px 10px; font: 12px/1.5 var(--mono); color: var(--text-primary); max-width: 360px; box-shadow: 0 6px 24px rgba(0,0,0,0.35); display: none; }
.tooltip b { font-family: var(--sans); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--text-muted); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--surface-3); white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid var(--surface-2); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); white-space: nowrap; }
.scroll { overflow-x: auto; }
.fn { font-family: var(--mono); font-size: 12.5px; word-break: break-word; }
.where { font: 11.5px var(--mono); color: var(--text-muted); word-break: break-all; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.owner { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-secondary); }
.phase .owner { display: flex; margin-top: 2px; }
.owner i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.bar { height: 8px; border-radius: 0 4px 4px 0; display: block; min-width: 2px; }
.finding { background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.finding header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 6px; }
.badge { font: 600 11px var(--sans); text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.badge.critical { color: var(--critical); } .badge.major { color: var(--serious); } .badge.minor { color: var(--warning); }
.badge.fixed { color: var(--good); } .badge.proposed, .badge.not-fixed { color: var(--text-muted); } .badge.reverted { color: var(--warning); }
.finding .cost { font: 600 13px var(--mono); color: var(--text-primary); }
.finding p { margin: 6px 0; color: var(--text-secondary); }
.finding p strong { color: var(--text-primary); font-weight: 600; }
.finding ul { margin: 6px 0 6px 18px; padding: 0; color: var(--text-secondary); }
.beforeafter { display: flex; flex-wrap: wrap; gap: 8px 24px; font: 12.5px var(--mono); margin-top: 8px; }
pre.code { background: var(--code-bg); border: 1px solid var(--surface-3); border-radius: 8px; margin: 8px 0 0; padding: 8px 0; overflow-x: auto; font: 12px/1.55 var(--mono); }
pre.code .row { display: flex; padding: 0 12px 0 0; white-space: pre; }
pre.code .row.hot { background: var(--hot); }
pre.code .ln { color: var(--text-muted); width: 56px; text-align: right; padding-right: 12px; flex: none; user-select: none; }
pre.code .ms { color: var(--serious); margin-left: 16px; }
pre.diff .add { color: var(--good); } pre.diff .del { color: var(--critical); }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.phases { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 10px; }
.phase { background: var(--surface-1); border: 1px solid var(--surface-3); border-radius: 8px; padding: 12px 14px; }
.phase .name { font: 600 13px var(--mono); }
.phase .fps { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.phase .small { font-size: 12px; color: var(--text-secondary); }
.phase ol { margin: 6px 0 0 16px; padding: 0; font-size: 12px; color: var(--text-secondary); }
.film { display: flex; gap: 4px; overflow-x: auto; padding: 8px 0 0; }
.film figure { margin: 0; flex: none; text-align: center; }
.film img { height: 72px; border-radius: 4px; display: block; }
.film figcaption { font: 10.5px var(--mono); color: var(--text-muted); }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.shots figure { margin: 0; } .shots img { width: 100%; border-radius: 6px; display: block; }
.shots figcaption { font: 12px var(--mono); color: var(--text-muted); margin-top: 4px; }
.signals li { margin: 4px 0; color: var(--text-secondary); }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 12px; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } .tile .value { font-size: 22px; } }
footer.generated-by { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--surface-3); color: var(--text-muted); font-size: 12.5px; }
footer.generated-by a { color: inherit; }
table.fixes td.pick, table.fixes th.pick { width: 28px; } table.fixes td.id { font: 600 12px var(--mono); white-space: nowrap; }
table.fixes td.act { text-align: right; white-space: nowrap; }
table.fixes .badge { white-space: nowrap; }
table.fixes td.act { white-space: nowrap; } table.fixes td.act .copy-spec + .copy-spec { margin-left: 6px; }
.badge.confirmed, .badge.recon-deep { color: var(--good); } .badge.inferred, .badge.recon-quick { color: var(--warning); } .badge.recon-none { color: var(--text-muted); }
.spec-bar code { white-space: pre-wrap; }
td.nw { white-space: nowrap; }
.hint { color: var(--text-secondary); font-size: 13px; margin: 0 0 10px; }
.copy-spec { background: var(--surface-2); color: var(--text-secondary); border: 1px solid var(--surface-3); border-radius: 6px; font-size: 12px; padding: 4px 10px; cursor: pointer; }
.copy-spec:disabled { opacity: 0.5; cursor: default; }
.spec-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.spec-bar code { flex: 1 1 320px; font: 12px var(--mono); background: var(--surface-0); border: 1px solid var(--surface-3); border-radius: 6px; padding: 6px 10px; overflow-wrap: anywhere; }
@media print { .pick, .act, .spec-bar, #fixes .hint { display: none !important; } }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
a.toggle { text-decoration: none; display: inline-block; }
@media print {
  :root, :root[data-theme] { color-scheme: light; --surface-0: #ffffff; --surface-1: #ffffff; --surface-2: #f4f4f2; --surface-3: #d9d8d3; --text-primary: #0b0b0b; --text-secondary: #3d3c39; --text-muted: #5f5e59; }
  body { background: #ffffff !important; }
  main { max-width: none !important; padding: 0 !important; }
  .actions, .btp-toolbar, .btp-next, .btp-copy { display: none !important; }
  .panel, .finding, .tile, .verdict, figure, tr, .btp-card { break-inside: avoid; page-break-inside: avoid; }
  h2 { break-after: avoid; page-break-after: avoid; }
  .panel { overflow: visible !important; }
  a { color: inherit; text-decoration: none; }
}
.toggle { background: var(--surface-2); color: var(--text-secondary); border: 1px solid var(--surface-3); border-radius: 6px; font-size: 12px; padding: 4px 10px; cursor: pointer; }
`;

/** The page's script: renders every section from the embedded JSON. Kept dependency-free. */
const SCRIPT = String.raw`
const DATA = JSON.parse(document.getElementById("bt-data").textContent);
const run = DATA.run, base = DATA.baseline, warm = DATA.warm, findings = DATA.findings;
const GROUPS = DATA.groups;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (value, digits = 1) => value == null || Number.isNaN(value) ? "–" : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const seriesVar = (slot) => "var(--series-" + slot + ")";
const groupOf = (owner) => {
  if (run.yourOwners.includes(owner)) return GROUPS.find((g) => g.id === "yours");
  return GROUPS.find((g) => g.owners.includes(owner)) || GROUPS.find((g) => g.id === "other");
};
const ownerChip = (owner) => { const g = groupOf(owner); return '<span class="owner"><i style="background:' + seriesVar(g.slot) + '"></i>' + esc(run.ownerLabels[owner] || owner) + '</span>'; };
const shortPath = (file) => !file ? "" : file.replace(/^.*\/node_modules\//, "node_modules/").replace(/^\/Users\/[^/]+\//, "~/");
const link = (file, line, text) => file ? '<a href="vscode://file/' + encodeURI(file) + (line ? ":" + line : "") + '">' + esc(text || (shortPath(file) + (line ? ":" + line : ""))) + '</a>' : '<span class="where">' + esc(text || "") + '</span>';
const tooltip = $("#tooltip");
const showTip = (event, html) => { tooltip.innerHTML = html; tooltip.style.display = "block"; const x = Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 8); const y = Math.min(event.clientY + 14, innerHeight - tooltip.offsetHeight - 8); tooltip.style.left = x + "px"; tooltip.style.top = y + "px"; };
const hideTip = () => { tooltip.style.display = "none"; };

function delta(now, before, lowerIsBetter, unit = "", digits = 1) {
  if (before == null || now == null) return "";
  const change = now - before;
  if (Math.abs(change) < Math.pow(10, -digits)) return '<div class="delta same">= baseline</div>';
  const better = lowerIsBetter ? change < 0 : change > 0;
  return '<div class="delta ' + (better ? "better" : "worse") + '">' + (change > 0 ? "+" : "") + fmt(change, digits) + unit + " vs " + fmt(before, digits) + unit + '</div>';
}

function settledPhase(analysis) {
  const racing = analysis.phases.filter((p) => /^race/.test(p.name));
  return racing.length ? racing[racing.length - 1] : analysis.phases[analysis.phases.length - 1];
}

function renderTiles() {
  const settled = settledPhase(run), settledBase = base ? settledPhase(base) : null;
  const worstPhase = [...run.phases].filter((p) => !p.beforeFirstFrame && p.frames.fps != null && p.durationSeconds >= 1).sort((a, b) => a.frames.fps - b.frames.fps)[0];
  const worstBase = base && worstPhase ? base.phases.find((p) => p.name === worstPhase.name) : null;
  const gc = (a) => (a.overall.lists.owners.find((o) => o.owner === "gc") || { pctBusy: 0 }).pctBusy;
  const shaders = (a) => a.timeline.reduce((sum, b) => sum + (b.shaders || 0), 0);
  const tiles = [
    { label: "FPS, worst phase (" + (worstPhase ? worstPhase.name : "–") + ")", value: worstPhase ? fmt(worstPhase.frames.fps) : "–", delta: delta(worstPhase && worstPhase.frames.fps, worstBase && worstBase.frames.fps, false) },
    { label: "FPS, settled (" + settled.name + ")", value: fmt(settled.frames.fps), delta: delta(settled.frames.fps, settledBase && settledBase.frames.fps, false) },
    { label: "CPU per frame, settled", value: fmt(settled.frames.cpuMeanMs) + " ms", delta: delta(settled.frames.cpuMeanMs, settledBase && settledBase.frames.cpuMeanMs, true, " ms") },
    { label: "Main thread busy", value: fmt(run.overall.busyPct, 0) + "%", delta: delta(run.overall.busyPct, base && base.overall.busyPct, true, "%", 0) },
    { label: "Draw calls, settled", value: fmt(settled.frames.draws, 0), delta: delta(settled.frames.draws, settledBase && settledBase.frames.draws, true, "", 0) },
    { label: "Garbage collection", value: fmt(gc(run)) + "%", delta: base ? delta(gc(run), gc(base), true, "%") : "" },
    { label: "Allocated", value: run.heap ? fmt(run.heap.mbPerSecond, 0) + " MB/s" : "–", delta: base && base.heap && run.heap ? delta(run.heap.mbPerSecond, base.heap.mbPerSecond, true, " MB/s", 0) : "" },
    { label: "Shaders compiled in run", value: fmt(shaders(run), 0), delta: base ? delta(shaders(run), shaders(base), true, "", 0) : "" },
  ];
  const rows = Math.ceil(tiles.length / 4);
  $("#tiles").style.setProperty("--tile-columns", String(Math.max(1, Math.ceil(tiles.length / rows))));
  $("#tiles").innerHTML = tiles.map((t) => '<div class="tile"><div class="label">' + esc(t.label) + '</div><div class="value">' + t.value + '</div>' + (t.delta || "") + '</div>').join("");
}

function svgEl(tag, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function phaseBands(svg, x, top, bottom, marks, tMax) {
  let lastLabelX = -1e9, row = 0;
  for (const mark of marks) {
    if (mark.name === "end" || mark.t > tMax) continue;
    const px = x(mark.t);
    svg.appendChild(svgEl("line", { x1: px, x2: px, y1: top, y2: bottom, stroke: "var(--text-muted)", "stroke-width": 1, opacity: 0.45 }));
    // Labels closer than 70 px drop to a second row so they never overlap.
    row = (px - lastLabelX < 70) ? (row + 1) % 2 : 0;
    lastLabelX = px;
    svg.appendChild(svgEl("text", { x: px + 4, y: top + 11 + row * 12, fill: "var(--text-secondary)", "font-size": 11, "font-family": "var(--mono)" }, mark.name));
  }
}

function lineChart(target, series, options) {
  const width = target.clientWidth || 900, height = options.height || 220;
  const margin = { top: 22, right: 16, bottom: 26, left: 44 };
  const svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, class: "chart", role: "img", "aria-label": options.label });
  const tMax = Math.max(...series.flatMap((s) => s.points.map((p) => p.t)), 1);
  const yMax = niceMax(Math.max(options.minMax || 0, ...series.flatMap((s) => s.points.map((p) => p.v || 0))));
  const x = (t) => margin.left + (t / tMax) * (width - margin.left - margin.right);
  const y = (v) => margin.top + (1 - v / yMax) * (height - margin.top - margin.bottom);
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    svg.appendChild(svgEl("text", { x: margin.left - 6, y: y(v) + 4, "text-anchor": "end", fill: "var(--text-muted)", "font-size": 11 }, fmt(v, 0)));
  }
  for (let s = 0; s <= tMax; s += tMax > 120 ? 20 : 10) svg.appendChild(svgEl("text", { x: x(s), y: height - 8, "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11 }, s + "s"));
  if (options.budget) {
    svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(options.budget.value), y2: y(options.budget.value), stroke: "var(--good)", "stroke-width": 1, opacity: 0.7 }));
    svg.appendChild(svgEl("text", { x: width - margin.right - 4, y: y(options.budget.value) - 4, "text-anchor": "end", fill: "var(--text-secondary)", "font-size": 11 }, options.budget.label));
  }
  phaseBands(svg, x, margin.top - 14, height - margin.bottom, options.marks || [], tMax);
  for (const s of series) {
    const d = s.points.filter((p) => p.v != null).map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
    svg.appendChild(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: s.dim ? 0.45 : 1 }));
  }
  const cross = svgEl("line", { y1: margin.top, y2: height - margin.bottom, stroke: "var(--text-muted)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const hit = svgEl("rect", { x: margin.left, y: margin.top, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom, fill: "transparent" });
  hit.addEventListener("mousemove", (event) => {
    const box = svg.getBoundingClientRect();
    const t = ((event.clientX - box.left) * (width / box.width) - margin.left) / (width - margin.left - margin.right) * tMax;
    const index = Math.max(0, Math.round(t));
    cross.setAttribute("x1", x(index)); cross.setAttribute("x2", x(index)); cross.setAttribute("opacity", 0.6);
    showTip(event, options.tip(index));
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  svg.appendChild(hit);
  target.innerHTML = "";
  target.appendChild(svg);
}

function stackedColumns(target, buckets, marks) {
  const width = target.clientWidth || 900, height = 240;
  const margin = { top: 22, right: 16, bottom: 26, left: 44 };
  const svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, class: "chart", role: "img", "aria-label": "Main-thread time per second by owner" });
  const tMax = Math.max(buckets.length, 1);
  const yMax = 1000;
  const slotWidth = (width - margin.left - margin.right) / tMax;
  const barWidth = Math.max(1, Math.min(24, slotWidth - 2));
  const x = (t) => margin.left + t * slotWidth;
  const y = (v) => margin.top + (1 - v / yMax) * (height - margin.top - margin.bottom);
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    svg.appendChild(svgEl("text", { x: margin.left - 6, y: y(v) + 4, "text-anchor": "end", fill: "var(--text-muted)", "font-size": 11 }, (v / 10) + "%"));
  }
  for (let s = 0; s <= tMax; s += tMax > 120 ? 20 : 10) svg.appendChild(svgEl("text", { x: x(s) + slotWidth / 2, y: height - 8, "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 11 }, s + "s"));
  phaseBands(svg, (t) => x(t), margin.top - 14, height - margin.bottom, marks, tMax);
  buckets.forEach((bucket, index) => {
    let stacked = 0;
    const group = svgEl("g", {});
    for (const g of GROUPS) {
      const ms = bucket.groups[g.id] || 0;
      if (ms <= 0) continue;
      const top = y(Math.min(yMax, stacked + ms)), bottom = y(stacked);
      const h = Math.max(0, bottom - top - (stacked > 0 ? 1 : 0));
      if (h > 0) group.appendChild(svgEl("rect", { x: x(index) + (slotWidth - barWidth) / 2, y: top, width: barWidth, height: h, fill: seriesVar(g.slot) }));
      stacked += ms;
    }
    group.appendChild(svgEl("rect", { x: x(index), y: margin.top, width: slotWidth, height: height - margin.top - margin.bottom, fill: "transparent" }));
    group.addEventListener("mousemove", (event) => {
      const rows = GROUPS.filter((g) => bucket.groups[g.id] > 0).map((g) => '<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + seriesVar(g.slot) + '"></i> ' + esc(g.label) + ': ' + fmt(bucket.groups[g.id] / 10, 0) + '%</div>').join("");
      showTip(event, "<b>" + bucket.t + "–" + (bucket.t + 1) + " s</b> · " + fmt(bucket.fps) + " fps<br>" + rows + (bucket.top ? '<div style="margin-top:4px">hottest: ' + esc(bucket.top.name) + " " + bucket.top.ms + " ms</div>" : "") + (bucket.shaders ? "<div>new shaders: " + bucket.shaders + "</div>" : ""));
    });
    group.addEventListener("mouseleave", hideTip);
    svg.appendChild(group);
  });
  target.innerHTML = "";
  target.appendChild(svg);
}

function renderTimeline() {
  const tip = (index) => {
    const b = run.timeline[index]; if (!b) return "";
    const bb = base && base.timeline[index];
    return "<b>" + b.t + " s</b><br>FPS " + fmt(b.fps) + (bb ? " (baseline " + fmt(bb.fps) + ")" : "") + "<br>CPU " + fmt(b.cpu, 2) + " ms/frame · worst frame " + fmt(b.worst) + " ms<br>busy " + fmt(b.busy, 0) + "% · particles " + fmt(b.particles, 0) + " · draws " + fmt(b.draws, 0) + (b.shaders ? "<br>new shaders " + b.shaders : "") + (b.top ? "<br>hottest: " + esc(b.top.name) : "");
  };
  const fpsSeries = [{ points: run.timeline.map((b) => ({ t: b.t, v: b.fps })), color: "var(--series-1)" }];
  if (base) fpsSeries.unshift({ points: base.timeline.map((b) => ({ t: b.t, v: b.fps })), color: "var(--series-0)", dim: true });
  lineChart($("#chart-fps"), fpsSeries, { label: "Frames per second over the run", marks: run.marks, minMax: 60, budget: { value: 60, label: "60 fps" }, tip });
  $("#fps-legend").innerHTML = base ? '<span><i style="background:var(--series-1)"></i>This run</span><span><i style="background:var(--series-0)"></i>Baseline</span>' : "";
  stackedColumns($("#chart-owners"), run.timeline, run.marks);
  $("#owner-legend").innerHTML = GROUPS.map((g) => '<span><i style="background:' + seriesVar(g.slot) + '"></i>' + esc(g.label) + '</span>').join("");
  if (run.filmstrip.length) {
    $("#film").innerHTML = run.filmstrip.map((f) => '<figure><img loading="lazy" src="' + esc(f.src) + '" alt="frame at ' + f.t + ' s"><figcaption>' + fmt(f.t, 0) + 's</figcaption></figure>').join("");
  } else $("#film-wrap").style.display = "none";
}

/**
 * The fixes, listed whether or not they were applied, in two steps: recon the code behind them (one bt-recon per
 * subsystem, so the spec has the callers, invariants and tests mapped), then spec one (its row's button) or a group
 * (tick them) with bt-spec. The spec command points bt-spec at findings.md, which carries each fix's cause, evidence,
 * code, gain, risk and check, and cites the recon docs it rests on.
 */
function renderFixes() {
  const wrap = $("#fixes-wrap");
  const list = (findings && findings.findings ? findings.findings : []).filter((f) => f.fix);
  if (!list.length) { wrap.style.display = "none"; return; }
  const recon = DATA.recon || { groups: [], byId: {} };
  const groupOf = (id) => recon.groups.find((g) => g.slug === recon.byId[id]);
  const source = "@.agents/profile/" + DATA.slug + "/findings.md";
  const join = (ids) => ids.length <= 1 ? ids.join("") : ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1];
  const groupsFor = (ids) => [...new Set(ids.map(groupOf).filter(Boolean))];
  const using = (ids) => { const paths = groupsFor(ids).map((g) => "@" + g.path); return paths.length ? " using " + join(paths) : ""; };
  const specCommand = (ids) => "/bt-spec Fix " + join(ids) + " from " + source + using(ids);
  const reconCommands = (ids) => groupsFor(ids).map((g) => g.command).join("\n");
  // A fix is done once it is in the code: "kept" (applied and proven by the fix loop) or "fixed".
  const isDone = (f) => f.status === "kept" || f.status === "fixed";
  const open = list.filter((f) => !isDone(f)).map((f) => f.id);
  const reconCell = (f) => {
    const g = groupOf(f.id);
    if (!g) return "–";
    const state = g.exists ? '<span class="badge recon-' + esc(g.depth) + '" title="' + esc(g.path) + '">' + esc(g.depth) + "</span>" : '<span class="badge recon-none">none</span>';
    return state + ' <span class="where">' + esc(g.name) + "</span>";
  };
  const rows = list.map((f) => '<tr><td class="pick"><input type="checkbox" value="' + esc(f.id) + '"' + (!isDone(f) ? " checked" : "") + ' aria-label="Select ' + esc(f.id) + '"></td>' +
    '<td class="id"><a href="#' + esc(f.id) + '">' + esc(f.id) + '</a></td><td>' + esc(f.title) + '</td>' +
    '<td><span class="badge ' + esc(f.status) + '">' + esc(f.status) + '</span></td>' +
    '<td>' + (f.confidence ? '<span class="badge ' + esc(f.confidence) + '">' + esc(f.confidence) + "</span>" : "–") + '</td>' +
    '<td>' + reconCell(f) + '</td>' +
    '<td>' + esc(f.gain || f.cost || "–") + '</td><td>' + esc(f.risk || "–") + '</td>' +
    '<td class="act"><button type="button" class="copy-spec" data-kind="recon" data-ids="' + esc(f.id) + '">Copy recon command</button>' +
    '<button type="button" class="copy-spec" data-kind="spec" data-ids="' + esc(f.id) + '">Copy spec command</button></td></tr>').join("");
  $("#fixes").innerHTML = '<div class="panel"><p class="hint"><strong>1. Recon</strong> the code behind the fixes with <code>/bt-recon</code>: it maps how that code works, every caller, and what a change must not break. Fixes in the same code share one recon; run each command on its own. ' +
    '<strong>2. Spec</strong> them one at a time or several together with <code>/bt-spec</code>; the command cites the recon docs. ' +
    (open.length ? open.length + " not fixed yet." : "All of them are fixed.") + '</p>' +
    '<div class="scroll"><table class="fixes"><thead><tr><th class="pick"></th><th>ID</th><th>Fix</th><th>Status</th><th>Cause</th><th>Recon</th><th>Expected gain</th><th>Risk</th><th class="act"></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="spec-bar"><code id="recon-selected"></code><button type="button" class="copy-spec" data-kind="recon" id="copy-recon-selected">1. Copy recon for the selected</button></div>' +
    '<div class="spec-bar"><code id="spec-selected"></code><button type="button" class="copy-spec" data-kind="spec" id="copy-selected">2. Copy spec for the selected</button>' +
    (open.length ? '<button type="button" class="copy-spec" data-kind="spec" data-ids="' + esc(open.join(" ")) + '">Copy spec for all open fixes</button>' : "") + '</div></div>';
  const selected = () => [...document.querySelectorAll("#fixes input[type=checkbox]:checked")].map((box) => box.value);
  const refresh = () => {
    const ids = selected();
    $("#recon-selected").textContent = ids.length ? reconCommands(ids) : "Tick the fixes to recon together";
    $("#spec-selected").textContent = ids.length ? specCommand(ids) : "Tick the fixes to spec together";
    $("#copy-selected").disabled = $("#copy-recon-selected").disabled = !ids.length;
  };
  $("#fixes").addEventListener("change", refresh);
  $("#fixes").addEventListener("click", (event) => {
    const button = event.target.closest(".copy-spec");
    if (!button) return;
    const ids = button.id === "copy-selected" || button.id === "copy-recon-selected" ? selected() : button.dataset.ids.split(" ");
    if (!ids.length) return;
    const text = button.dataset.kind === "recon" ? reconCommands(ids) : specCommand(ids);
    const done = () => { const label = button.textContent; button.textContent = "Copied"; setTimeout(() => { button.textContent = label; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done); else done();
  });
  refresh();
}

function renderFindings() {
  const box = $("#findings");
  if (!findings || !findings.findings || !findings.findings.length) {
    box.innerHTML = '<div class="finding"><p>No diagnosis written yet — the automatic signals below point at where to look.</p><ul class="signals">' + run.signals.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ul></div>";
    return;
  }
  box.innerHTML = findings.findings.map((f) => {
    const code = (f.code || []).map((c) => "<li>" + link(c.file, c.line, (c.label ? c.label + " — " : "") + shortPath(c.file) + (c.line ? ":" + c.line : "")) + "</li>").join("");
    const diff = f.diff ? '<details><summary>The change</summary><pre class="code diff">' + f.diff.split("\n").map((l) => '<div class="row ' + (l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "") + '"><span class="ln"></span>' + esc(l) + '</div>').join("") + '</pre></details>' : "";
    return '<article class="finding" id="' + esc(f.id) + '"><header><span class="badge ' + esc(f.severity) + '">' + esc(f.severity) + '</span><span class="badge ' + esc(f.status) + '">' + esc(f.status) + '</span><h3>' + esc(f.id + " · " + f.title) + '</h3>' + (f.cost ? '<span class="cost">' + esc(f.cost) + '</span>' : "") + '</header>' +
      (f.phases && f.phases.length || f.subsystem ? '<div class="meta">' + [f.phases && f.phases.length ? "phases: " + esc(f.phases.join(", ")) : "", f.subsystem ? "code: " + esc(f.subsystem) : "", f.confidence ? "cause " + (f.confidence === "confirmed" ? "confirmed in the code" : "inferred from the profile") : ""].filter(Boolean).join(" · ") + '</div>' : "") +
      (f.cause ? "<p><strong>Why it is slow.</strong> " + esc(f.cause) + "</p>" : "") +
      (f.evidence && f.evidence.length ? "<p><strong>Evidence.</strong></p><ul>" + f.evidence.map((e) => "<li>" + esc(e) + "</li>").join("") + "</ul>" : "") +
      (code ? "<p><strong>Code.</strong></p><ul>" + code + "</ul>" : "") +
      (f.fix ? "<p><strong>Fix.</strong> " + esc(f.fix) + "</p>" : "") +
      (f.guards && f.guards.length ? "<p><strong>Must not break.</strong></p><ul>" + f.guards.map((g) => "<li>" + esc(g) + "</li>").join("") + "</ul>" : "") +
      (f.before || f.after ? '<div class="beforeafter">' + (f.before ? "<span>before: " + esc(f.before) + "</span>" : "") + (f.after ? "<span>after: " + esc(f.after) + "</span>" : "") + "</div>" : "") + diff + "</article>";
  }).join("");
}

function renderPhases() {
  $("#phases").innerHTML = run.phases.map((p) => {
    const b = base && base.phases.find((q) => q.name === p.name);
    const yours = p.lists.yoursTop.slice(0, 3).map((e) => "<li>" + esc(e.name) + " — " + fmt(e.msPerFrame, 2) + " ms/f</li>").join("");
    const hot = p.lists.inclusiveTop.filter((e) => !e.shell && e.owner !== "program").slice(0, 3).map((e) => "<li>" + esc(e.name) + " — " + fmt(e.pctBusy) + "%</li>").join("");
    const owners = p.lists.owners.slice(0, 4).map((o) => ownerChip(o.owner) + " " + fmt(o.pctBusy, 0) + "%").join(" ");
    return '<div class="phase"><div class="name">' + esc(p.name) + ' <span class="meta">' + fmt(p.startSeconds) + "s · " + fmt(p.durationSeconds) + 's</span></div><div class="fps">' + fmt(p.frames.fps) + ' <span class="small">fps</span></div>' + delta(p.frames.fps, b && b.frames.fps, false) +
      '<div class="small">CPU ' + fmt(p.frames.cpuMeanMs, 1) + " ms/f · p95 frame " + fmt(p.frames.intervalP95Ms) + " ms · busy " + fmt(p.busyPct, 0) + "%<br>draws " + fmt(p.frames.draws, 0) + " · particles " + fmt(p.frames.particles, 0) + (p.heap ? " · alloc " + fmt(p.heap.mbPerSecond, 0) + " MB/s" : "") + '</div><div class="small" style="margin-top:6px">' + owners + '</div>' +
      (hot ? '<div class="small" style="margin-top:6px">Heaviest work</div><ol>' + hot + "</ol>" : "") + (yours ? '<div class="small" style="margin-top:6px">Your heaviest code</div><ol>' + yours + "</ol>" : "") + "</div>";
  }).join("");
}

function renderOwners() {
  const owners = run.overall.lists.owners.filter((o) => o.owner !== "idle");
  const max = Math.max(...owners.map((o) => o.pctBusy), 1);
  $("#owners").innerHTML = "<table><thead><tr><th>Who</th><th class='num'>ms</th><th class='num'>% busy</th><th class='num'>ms/frame</th><th style='width:40%'></th></tr></thead><tbody>" + owners.map((o) => {
    const b = base && base.overall.lists.owners.find((q) => q.owner === o.owner);
    return "<tr><td>" + ownerChip(o.owner) + "</td><td class='num'>" + fmt(o.ms, 0) + "</td><td class='num'>" + fmt(o.pctBusy) + "%</td><td class='num'>" + fmt(o.msPerFrame, 2) + (b ? " <span class='where'>(was " + fmt(b.msPerFrame, 2) + ")</span>" : "") + "</td><td><span class='bar' style='width:" + (o.pctBusy / max * 100).toFixed(1) + "%;background:" + seriesVar(groupOf(o.owner).slot) + "'></span></td></tr>";
  }).join("") + "</tbody></table>";
}

function functionTable(rows, kind) {
  return "<div class='scroll'><table><thead><tr><th>Function</th><th>Owner</th><th class='num'>ms</th><th class='num'>ms/frame</th><th class='num'>% busy</th>" + (kind === "self" ? "<th>Called by / your code behind it</th>" : kind === "yours" ? "<th>Spends it in</th>" : "<th class='num'>self ms</th>") + "</tr></thead><tbody>" + rows.map((r) => {
    let extra = "";
    if (kind === "self") extra = "<td class='where'>" + esc((r.callers || []).map((c) => c.name + " " + c.ms).join(" · ")) + ((r.yours || []).length ? "<br>yours: " + esc(r.yours.map((c) => c.name + " " + c.ms).join(" · ")) : "") + "</td>";
    else if (kind === "yours") extra = "<td class='where'>own " + fmt(r.ownCodeMs) + " ms · " + esc((r.callees || []).slice(0, 4).map((c) => c.name + " " + c.ms).join(" · ")) + "</td>";
    else extra = "<td class='num'>" + fmt(r.selfMs) + "</td>";
    return "<tr><td><div class='fn'>" + esc(r.name) + "</div><div class='where'>" + link(r.file, r.line, r.file ? null : r.url + (r.line ? ":" + r.line : "")) + "</div></td><td>" + ownerChip(r.owner) + "</td><td class='num'>" + fmt(r.ms, 0) + "</td><td class='num'>" + fmt(r.msPerFrame, 2) + "</td><td class='num'>" + fmt(r.pctBusy) + "%</td>" + extra + "</tr>";
  }).join("") + "</tbody></table></div>";
}

function renderFunctions() {
  $("#yours").innerHTML = functionTable(run.overall.lists.yoursTop.slice(0, 20), "yours");
  $("#self").innerHTML = functionTable(run.overall.lists.selfTop.slice(0, 25), "self");
  $("#subtrees").innerHTML = functionTable(run.overall.lists.inclusiveTop.filter((r) => !r.shell && r.owner !== "program").slice(0, 25), "inclusive");
  $("#excerpts").innerHTML = run.excerpts.slice(0, 12).map((x) => "<details><summary>" + esc(x.name) + " — " + link(x.file, x.from + 2) + "</summary><pre class='code'>" + x.rows.map((row) => "<div class='row" + (row.hotMs ? " hot" : "") + "'><span class='ln'>" + row.number + "</span>" + esc(row.text) + (row.hotMs ? "<span class='ms'>" + fmt(row.hotMs) + " ms</span>" : "") + "</div>").join("") + "</pre></details>").join("") || "<p class='meta'>No source excerpts (no local files resolved).</p>";
}

function renderHeap() {
  if (!run.heap) { $("#heap").innerHTML = "<p class='meta'>Allocation sampling was off.</p>"; return; }
  const table = (rows) => "<table><thead><tr><th>Function</th><th>Owner</th><th class='num'>MB</th><th class='num'>MB/s</th></tr></thead><tbody>" + rows.map((r) => "<tr><td><div class='fn'>" + esc(r.name) + "</div><div class='where'>" + link(r.file, r.line) + "</div></td><td>" + ownerChip(r.owner) + "</td><td class='num'>" + fmt(r.mb) + "</td><td class='num'>" + fmt(r.mbPerSecond, 2) + "</td></tr>").join("") + "</tbody></table>";
  const racing = run.phases.filter((p) => p.heap && /^race|racing|takeoff|countdown/.test(p.name));
  $("#heap").innerHTML = "<p class='meta'>" + fmt(run.heap.totalMb, 0) + " MB allocated over the run (" + fmt(run.heap.mbPerSecond, 0) + " MB/s, collected objects " + (run.capture.heapIncludesCollected ? "included" : "not included") + "). Per phase: " + run.phases.filter((p) => p.heap).map((p) => esc(p.name) + " " + fmt(p.heap.mbPerSecond, 0) + " MB/s").join(" · ") + "</p><div class='two'><div><h3>Allocating functions (whole run)</h3>" + table(run.heap.selfTop.slice(0, 12)) + "</div><div><h3>Your code behind the allocations</h3>" + table(run.heap.yoursTop.slice(0, 12)) + "</div></div>" +
    (racing.length ? "<h3 style='margin-top:16px'>While racing (" + esc(racing.map((p) => p.name).join(", ")) + ")</h3>" + table(racing.flatMap((p) => p.heap.selfTop.slice(0, 4).map((r) => ({ ...r, name: r.name + "  [" + p.name + "]" })))) : "");
}

function renderWorst() {
  const kindLabel = { cpu: "CPU work", wait: "waited", gap: "gap" };
  $("#worst").innerHTML = "<div class='scroll'><table><thead><tr><th class='num'>at</th><th>Phase</th><th>Kind</th><th class='num'>CPU ms</th><th class='num'>gap ms</th><th class='num'>script ms</th><th class='num'>new pipelines</th><th>Filled by</th><th>Your code in it</th></tr></thead><tbody>" + run.worstFrames.map((f) => "<tr><td class='num'>" + fmt(f.t) + "s</td><td class='nw'>" + esc(f.phase || "") + "</td><td class='nw'>" + esc(kindLabel[f.kind] || "–") + "</td><td class='num'>" + fmt(f.cpuMs) + "</td><td class='num'>" + fmt(f.intervalMs) + "</td><td class='num'>" + fmt(f.scriptMs) + "</td><td class='num'>" + fmt(f.pipelinesNear) + "</td><td class='where'>" + esc(f.top.map((e) => e.name + " " + e.ms).join(" · ")) + "</td><td class='where'>" + (f.yours.map((e) => link(e.file, e.line, e.name + " " + e.ms + " ms")).join(" · ") || "–") + "</td></tr>").join("") + "</tbody></table></div>";
}

/**
 * Late stutter: what happened for the first time after the reveal, and the hitches it lined up with. Late compiles are
 * grouped by cause, each with the fix that usually removes it (the Babylon Toolkit's pre-warm rules).
 */
function renderLate() {
  const late = run.lateStutter;
  const wrap = $("#late-wrap");
  if (!late || (!late.hitchCount && !late.lateCompileCount && !late.pipelinesAfterReveal)) { wrap.style.display = "none"; return; }
  const kindFix = {
    particles: "Particles: pre-warm the system with TOOLKIT.SceneShaderWarmup.WarmParticleSystem(system), or register the prefab that spawns it with WarmPrefab.",
    postprocess: "Post processes: create them at load and toggle them; never create one during play.",
    renderpass: "Render passes: create render targets, mirrors, probes and cameras at load; stop their refresh instead of creating them later.",
    mesh: "Meshes: spawned during play → register the prefab with WarmPrefab before the reveal. Already in the scene → a variant change during play (a light added, fog or clip planes toggled, a first instance, a texture transform moved, a look-alike material) — or a pass the pre-warm never drew (see the passes above).",
    unknown: "Unknown cause: re-run on a development build so the toolkit's detector names it.",
  };
  const isMainPass = (name) => /^main$/i.test(name);
  const summary = '<p class="meta">Revealed at ' + (late.revealT != null ? fmt(late.revealT) + " s (" + esc(late.revealSource) + ")" : "— no reveal found") +
    " · " + fmt(late.hitchCount, 0) + " hitch(es) over " + fmt(late.hitchThresholdMs, 0) + " ms (" + fmt(late.hitchMs, 0) + " ms in all) · " + fmt(late.lateCompileCount, 0) + " late compile(s) · " +
    fmt(late.pipelinesAfterReveal, 0) + " pipelines · " + fmt(late.texturesAfterReveal, 0) + " textures · " + fmt(late.audioDecodesAfterReveal, 0) + " audio decodes · " + fmt((late.downloadsAfterReveal || []).length, 0) + " downloads after the reveal" +
    (late.toolkit && late.toolkit.safetyNet ? ". The WebGPU safety net is on: a late pipeline skips its draw for a frame or two, so it shows as pop-in rather than a freeze." : ".") + "</p>";
  const suspects = (h) => [
    h.lateCompileCount ? h.lateCompileCount + " late compile(s): " + h.lateCompiles.slice(0, 2).join("; ") : "",
    h.pipelines ? h.pipelines + " pipelines" : "", h.gcMs ? "GC " + fmt(h.gcMs) + " ms" : "", h.textures ? h.textures + " textures" : "",
    h.downloads.length ? "downloads " + h.downloads.map((d) => d.name).join(", ") : "", h.audioDecodes ? h.audioDecodes + " audio decode(s)" : "",
    Object.keys(h.growth).length ? "new " + Object.keys(h.growth).map((k) => h.growth[k] + " " + k).join(", ") : "",
  ].filter(Boolean).join(" · ");
  const hitches = late.hitches.length ? "<div class='scroll'><table><thead><tr><th class='num'>at</th><th class='num'>after reveal</th><th>Phase</th><th class='num'>frame ms</th><th>Likely cause</th><th class='num'>script ms</th><th>Suspects</th><th>Your code in it</th></tr></thead><tbody>" +
    late.hitches.map((h) => "<tr><td class='num'>" + fmt(h.t) + "s</td><td class='num'>" + (h.msAfterReveal != null ? fmt(h.msAfterReveal / 1000) + "s" : "–") + "</td><td class='nw'>" + esc(h.phase || "") + "</td><td class='num'>" + fmt(h.intervalMs) + "</td><td>" + esc(h.likely) + "</td><td class='num'>" + fmt(h.scriptMs) + "</td><td class='where'>" + esc(suspects(h) || "–") + "</td><td class='where'>" + (h.yours.map((e) => link(e.file, e.line, e.name + " " + e.ms + " ms")).join(" · ") || "–") + "</td></tr>").join("") + "</tbody></table></div>" : "<p class='meta'>No hitches after the reveal.</p>";
  const passes = (late.lateCompilePasses || []).length ? "<h3>Late compiles by render pass</h3><div class='scroll'><table><thead><tr><th class='num'>count</th><th>Render pass</th><th class='num'>causes</th><th class='num'>first after reveal</th><th>What it means</th></tr></thead><tbody>" +
    late.lateCompilePasses.map((p) => "<tr><td class='num'>" + fmt(p.count, 0) + "</td><td class='where'>" + esc(p.pass) + "</td><td class='num'>" + fmt(p.causes, 0) + "</td><td class='num'>" + fmt(p.firstMsAfterReveal / 1000) + "s</td><td>" +
      esc(isMainPass(p.pass) ? "The main pass: see the causes below." : "A camera or render target the pre-warm never drew: one created after the reveal (create it at load), or WarmAllCamerasOnReveal turned off. Toolkit 1.1.88+ warms every screen camera in the scene at the reveal; an older toolkit warms only the camera active while it runs.") + "</td></tr>").join("") + "</tbody></table></div>" : "";
  const kinds = [...new Set(late.lateCompiles.map((g) => g.causeKind || "unknown"))];
  const compiles = late.lateCompiles.length ? "<h3>Late compiles by cause</h3><div class='scroll'><table><thead><tr><th class='num'>count</th><th>Cause</th><th>Shader</th><th class='num'>first after reveal</th></tr></thead><tbody>" +
    late.lateCompiles.map((g) => "<tr><td class='num'>" + fmt(g.count, 0) + "</td><td class='where'>" + esc(g.cause) + "</td><td class='nw'>" + esc(g.effects.join(", ") || "–") + "</td><td class='num'>" + fmt(g.firstMsAfterReveal / 1000) + "s</td></tr>").join("") + "</tbody></table></div>" +
    "<p class='meta'><strong>What usually fixes them.</strong></p><ul class='meta'>" + kinds.map((k) => "<li>" + esc(kindFix[k] || kindFix.unknown) + "</li>").join("") + "</ul>" : "";
  const downloads = (late.downloadsAfterReveal || []).length ? "<h3>Downloads that finished after the reveal</h3><div class='scroll'><table><thead><tr><th class='num'>at</th><th>File</th><th>Type</th><th class='num'>KB</th><th class='num'>ms</th></tr></thead><tbody>" +
    late.downloadsAfterReveal.map((d) => "<tr><td class='num'>" + fmt(d.t) + "s</td><td class='where'>" + esc(d.name) + "</td><td class='nw'>" + esc(d.type) + "</td><td class='num'>" + fmt(d.kb, 0) + "</td><td class='num'>" + fmt(d.ms, 0) + "</td></tr>").join("") + "</tbody></table></div>" : "";
  $("#late").innerHTML = summary + hitches + passes + compiles + downloads;
}

function renderShots() {
  if (!run.shots.length) { $("#shots-wrap").style.display = "none"; return; }
  $("#shots").innerHTML = run.shots.map((s) => {
    const before = base && base.shots.find((b) => b.name === s.name);
    return (before ? "<figure><img loading='lazy' src='" + esc(before.src) + "' alt=''><figcaption>baseline · " + esc(s.name) + "</figcaption></figure>" : "") + "<figure><img loading='lazy' src='" + esc(s.src) + "' alt=''><figcaption>" + (base ? "this run · " : "") + esc(s.name) + "</figcaption></figure>";
  }).join("");
}

function renderWarm() {
  if (!warm) { $("#warm-wrap").style.display = "none"; return; }
  const rows = run.phases.map((p) => { const w = warm.phases.find((q) => q.name === p.name); return "<tr><td>" + esc(p.name) + "</td><td class='num'>" + fmt(p.frames.fps) + "</td><td class='num'>" + (w ? fmt(w.frames.fps) : "–") + "</td><td class='num'>" + fmt(p.frames.cpuMeanMs) + "</td><td class='num'>" + (w ? fmt(w.frames.cpuMeanMs) : "–") + "</td><td class='num'>" + fmt(p.durationSeconds) + "s</td><td class='num'>" + (w ? fmt(w.durationSeconds) + "s" : "–") + "</td></tr>"; }).join("");
  $("#warm").innerHTML = "<p class='meta'>Same scenario, second load in the same browser: the HTTP cache, compiled shaders and JIT are warm. Phases that are much faster warm pay first-use costs (downloads, decoding, shader compiles); phases that are just as slow warm are steady per-frame work.</p><table><thead><tr><th>Phase</th><th class='num'>cold fps</th><th class='num'>warm fps</th><th class='num'>cold CPU ms/f</th><th class='num'>warm CPU ms/f</th><th class='num'>cold length</th><th class='num'>warm length</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

function renderMeta() {
  const c = run.capture;
  const census = c.census || {};
  $("#capture").innerHTML = "<table><tbody>" + [
    ["Scenario", (c.scenario || "") + " — " + (c.scenarioDescription || "")],
    ["URL", c.url], ["Engine", c.engine + (census.adapter ? " · " + census.adapter.slice(0, 160) : "")],
    ["Browser", c.browser + " · " + c.platform], ["Viewport", c.viewport.width + "×" + c.viewport.height + " @" + c.viewport.deviceScaleFactor + "x · render " + (census.renderSize || []).join("×")],
    ["Scene at end", "meshes " + (census.meshes ?? "–") + " · materials " + (census.materials ?? "–") + " · textures " + (census.textures ?? "–") + " · lights " + (census.lights ?? "–") + " · shadow generators " + (census.shadowGenerators ?? "–") + " · particle systems " + ((census.particleSystems || []).length) + " · compiled effects " + (census.compiledEffects ?? "–")],
    ["Sampling", c.samplingIntervalUs + " µs CPU sampling · " + c.wallSeconds + " s recorded"],
    ["CPU profile", "<span class='where'>" + esc(DATA.run.cpuprofile) + "</span> — open in Chrome DevTools › Performance › Load profile"],
    ["Console errors", (c.consoleErrors || []).filter((e) => e.type !== "warning").length + " errors, " + (c.consoleErrors || []).filter((e) => e.type === "warning").length + " warnings"],
  ].map(([k, v]) => "<tr><th>" + esc(k) + "</th><td>" + (k === "CPU profile" ? v : esc(v)) + "</td></tr>").join("") + "</tbody></table>";
}

// Print (and Save as PDF from the print dialog): every collapsed section opens for the print and closes again after.
let openedForPrint = [];
addEventListener("beforeprint", () => {
  openedForPrint = [...document.querySelectorAll("details:not([open])")];
  openedForPrint.forEach((details) => { details.open = true; });
});
addEventListener("afterprint", () => { openedForPrint.forEach((details) => { details.open = false; }); openedForPrint = []; });
$("#print").addEventListener("click", () => window.print());
$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = dark ? "light" : "dark";
});
renderTiles(); renderFindings(); renderFixes(); renderTimeline(); renderPhases(); renderOwners(); renderFunctions(); renderHeap(); renderWorst(); renderLate(); renderShots(); renderWarm(); renderMeta();
let resizeTimer; addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTimeline, 150); });
`;

/** Builds the HTML page. */
function buildPage({ title, verdict, data, pdfName }) {
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}${PROGRESS_STYLES}</style>
</head>
<body>
<main>
  <header class="top">
    <h1>${escapeHtml(title)}</h1>
    <div class="actions">
      <button class="toggle" id="print" type="button" title="Print the report, or choose Save as PDF in the print dialog">Print</button>
      ${pdfName ? `<a class="toggle" id="pdf" href="${escapeHtml(pdfName)}" download title="The report as a PDF, written with it">Download PDF</a>` : ""}
      <button class="toggle" id="theme" type="button">Light / dark</button>
    </div>
  </header>
  ${progressMarkup()}
  <div class="meta">${escapeHtml(data.run.capture.capturedAt)} · ${escapeHtml(data.run.capture.engine || "")} · scenario ${escapeHtml(data.run.capture.scenario || "")} · ${escapeHtml(data.run.capture.wallSeconds)} s${data.baseline ? " · compared with baseline " + escapeHtml(data.baseline.capture.capturedAt) : ""}</div>
  ${verdict ? `<div class="verdict">${escapeHtml(verdict)}</div>` : ""}
  ${[["This run", data.run], ["The baseline", data.baseline]].filter(([, run]) => run && run.capture.disturbed).map(([who, run]) => `<div class="verdict disturbed">${escapeHtml(who)} restarted mid-capture (${escapeHtml(run.capture.disturbed.reason)}), so its numbers are not comparable.</div>`).join("")}
  <section class="tiles" id="tiles"></section>

  <h2>The bottlenecks</h2>
  <section id="findings"></section>

  <div id="fixes-wrap"><h2>The fixes</h2><section id="fixes"></section></div>

  <h2>Frame rate over the run</h2>
  <section class="panel"><div class="legend" id="fps-legend"></div><div id="chart-fps"></div></section>

  <h2>Who uses the main thread, second by second</h2>
  <section class="panel"><div class="legend" id="owner-legend"></div><div id="chart-owners"></div>
    <div id="film-wrap"><div class="film" id="film"></div></div></section>

  <div id="late-wrap"><h2>Late stutter — after the reveal</h2>
  <p class="meta">What happened for the first time after the loading screen lifted, and the hitches it lined up with. A finished game drives the late compiles to zero: everything it draws is compiled behind the splash.</p>
  <section class="panel" id="late"></section></div>

  <h2>Phases</h2>
  <section class="phases" id="phases"></section>

  <h2>Who owns the time (whole run)</h2>
  <section class="panel" id="owners"></section>

  <h2>Your code — time spent, including the library work it triggers</h2>
  <section class="panel" id="yours"></section>
  <section id="excerpts" style="margin-top:10px"></section>

  <h2>Heaviest functions — self time</h2>
  <section class="panel" id="self"></section>

  <h2>Heaviest subtrees — inclusive time</h2>
  <section class="panel" id="subtrees"></section>

  <h2>Allocations (garbage-collector pressure)</h2>
  <section class="panel" id="heap"></section>

  <h2>Worst frames</h2>
  <p class="meta">“CPU work”: the frame's own script was the cost. “Waited”: a long gap the main thread mostly sat through — the GPU process compiling pipelines (new pipelines just before it), a GPU-bound frame, or browser work.</p>
  <section class="panel" id="worst"></section>

  <div id="warm-wrap"><h2>Cold load vs warm load</h2><section class="panel" id="warm"></section></div>
  <div id="shots-wrap"><h2>Snapshots</h2><section class="shots" id="shots"></section></div>

  <h2>Capture</h2>
  <section class="panel" id="capture"></section>
  <footer class="generated-by">Generated by the <a href="https://www.npmjs.com/package/@babylonjs-toolkit/agent" target="_blank" rel="noopener noreferrer">Babylon Toolkit Desktop Agent</a></footer>
</main>
<div class="tooltip" id="tooltip" role="status"></div>
<script type="application/json" id="bt-data">${json}</script>
<script>${SCRIPT}</script>
<script>${PROGRESS_SCRIPT}</script>
</body>
</html>`;
}

/**
 * The screenshots of a run directory (its `shots/`, or the directory itself), as page entries relative to the report.
 * @returns {{name: string, src: string}[]}
 */
function shotsFrom(dir, reportDir) {
    const folder = fs.existsSync(path.join(dir, "shots")) ? path.join(dir, "shots") : dir;
    if (!fs.existsSync(folder)) throw new Error(`No screenshots at ${dir}`);
    return fs.readdirSync(folder).filter((name) => name.endsWith(".png")).sort().map((name) => ({
        name: name.replace(/\.png$/, ""), src: path.relative(reportDir, path.join(folder, name)).split(path.sep).join("/"),
    }));
}

/** Lowercase kebab-case, `a-z 0-9 -` only, at most 40 characters — bt-recon's slug rule. */
function kebab(text) {
    const slug = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug.length <= 40) return slug;
    // Cut at the last whole word that fits, so a long title never ends mid-word.
    const cut = slug.slice(0, 41);
    return (cut.lastIndexOf("-") > 0 ? cut.slice(0, cut.lastIndexOf("-")) : slug.slice(0, 40)).replace(/-+$/g, "");
}

/** Reads a recon doc's depth from its header (`depth: quick`); a recon written before the field existed is deep. */
function reconDepth(file) {
    try {
        const head = fs.readFileSync(file, "utf8").slice(0, 2000);
        const match = head.match(/depth:\s*(quick|deep)/);
        return match ? match[1] : "deep";
    } catch {
        return null;
    }
}

/**
 * Groups the fixes by the code they live in — one bt-recon per subsystem — and builds each group's recon command.
 * A finding's `recon` path names its group; else its `subsystem`; else its own title. A profile's recons live in its
 * own `recon/` folder; a general recon of the same name in the project's `.agents/recon/` is used when the profile has
 * none. The folders are read to tell which recons exist and how deep they are.
 * @param {object[]} list the findings
 * @param {string} profileSlug the profile's slug
 * @param {string} projectAgents the project's `.agents` folder
 * @returns {{ groups: object[], byId: Object<string, string> }} the groups, and each finding id's group slug
 */
function reconGroups(list, profileSlug, projectAgents) {
    const ownFolder = `.agents/profile/${profileSlug}/recon`;
    const groups = new Map();
    const byId = {};
    for (const finding of list.filter((item) => item.fix)) {
        const fromPath = finding.recon ? path.basename(String(finding.recon)).replace(/_recon\.md$/, "") : "";
        const slug = kebab(fromPath || finding.subsystem || finding.title) || kebab(finding.id);
        if (!groups.has(slug)) {
            // The profile's own recon first, then a general one; a new recon goes in the profile's folder.
            const candidates = [`${ownFolder}/${slug}_recon.md`, `.agents/recon/${slug}_recon.md`];
            if (finding.recon) candidates.unshift(String(finding.recon).replace(/^\.?\//, ""));
            const found = candidates.map((relative) => ({ relative, depth: reconDepth(path.join(projectAgents, "..", relative)) })).find((candidate) => candidate.depth !== null);
            groups.set(slug, {
                slug, name: finding.subsystem || finding.title,
                path: found ? found.relative : candidates[candidates.length - 2], exists: Boolean(found), depth: found ? found.depth : null,
                ids: [], code: [],
            });
        }
        const group = groups.get(slug);
        group.ids.push(finding.id);
        for (const location of finding.code || []) {
            const where = `${location.file}${location.line ? `:${location.line}` : ""}`;
            if (!group.code.includes(where)) group.code.push(where);
        }
        byId[finding.id] = slug;
    }
    for (const group of groups.values()) {
        const ids = group.ids.length <= 1 ? group.ids.join("") : `${group.ids.slice(0, -1).join(", ")} and ${group.ids[group.ids.length - 1]}`;
        const anchors = group.code.slice(0, 6).join(", ");
        // A deep recon that exists only needs refreshing after code changes; a quick one (or none) gets a deep one,
        // written into the profile's own recon folder.
        if (group.exists && group.depth === "deep") {
            group.command = `/bt-recon --refresh @${group.path}`;
        } else {
            group.path = `${ownFolder}/${group.slug}_recon.md`;
            group.command = `/bt-recon --slug ${group.slug} --out ${ownFolder} --no-guide "${group.name.replace(/"/g, "'")} — the code behind ${ids} in @.agents/profile/${profileSlug}/findings.md${anchors ? ` (${anchors})` : ""}: how it works, every caller, what drives its per-frame cost, and what a change there must not break"`;
        }
    }
    return { groups: [...groups.values()], byId };
}

/**
 * The diagnosis as a spec-ready Markdown document (findings.md beside the dashboard): what was measured and how, what is
 * still to fix, then one section per finding with its cause, evidence, code, proposed fix, expected gain, risk and how
 * to verify it — the input for a later fix with a full spec (`bt-spec @.agents/profile/<slug>/findings.md`).
 * @returns {string} the Markdown
 */
function findingsMarkdown(findings, analysis, slugName, recon) {
    const capture = analysis.capture || {};
    const list = (findings && Array.isArray(findings.findings)) ? findings.findings : [];
    // A fix is done once it is in the code: "kept" (applied and proven by the fix loop) or "fixed".
    const isDone = (finding) => finding.status === "kept" || finding.status === "fixed";
    const open = list.filter((finding) => !isDone(finding));
    const lines = [];
    const push = (text = "") => lines.push(text);
    push(`# ${findings && findings.title ? findings.title : "Performance findings"}`);
    push();
    if (findings && findings.summary) { push(findings.summary); push(); }
    push(`- **Measured:** ${capture.url || "–"} · scenario \`${capture.scenario || "–"}\` · ${capture.engine || "no Babylon engine (browser frames)"} · captured ${capture.capturedAt || "–"}`);
    push(`- **Dashboard:** \`dashboard.html\` beside this file · **Data:** \`data/\` (runs, findings.json)`);
    push(`- **Re-measure after a fix:** \`/bt-profile --slug:${slugName}\` (same scenario) and compare the phases named below`);
    push();
    const fixable = list.filter((finding) => finding.fix);
    const source = `@.agents/profile/${slugName}/findings.md`;
    const join = (ids) => ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
    const cell = (text) => String(text || "–").replace(/\|/g, "\\|").replace(/\n/g, " ");
    push(`## The fixes (${open.length} not fixed yet)`);
    push();
    push("Two steps: **recon** the code behind the fixes (bt-recon maps how it works, every caller and what a change must not break), then **spec** them one at a time or several together. Each spec command points bt-spec at this file, which carries every fix's cause, evidence, code, gain, risk and how to verify it, and cites the recon docs as its grounding.");
    push();
    // The recon docs a set of fixes rests on, as bt-spec's `using` clause.
    const using = (ids) => {
        const paths = [...new Set(ids.map((id) => recon.byId[id]).filter(Boolean))].map((slug) => `@${recon.groups.find((group) => group.slug === slug).path}`);
        return paths.length ? ` using ${join(paths)}` : "";
    };
    const specCommand = (ids) => `/bt-spec Fix ${join(ids)} from ${source}${using(ids)}`;
    if (fixable.length) {
        push("### 1. Recon the code behind them");
        push();
        push("One recon per subsystem — fixes in the same code share it. Run each command on its own.");
        push();
        push("| Subsystem | Fixes | Recon | Command |");
        push("|---|---|---|---|");
        for (const group of recon.groups) push(`| ${cell(group.name)} | ${group.ids.join(", ")} | ${group.exists ? `\`${group.path}\` (${group.depth})` : "not yet"} | \`${cell(group.command)}\` |`);
        push();
        push("### 2. Spec them");
        push();
        push("| ID | Fix | Status | Cause | Expected gain | Risk | Spec it |");
        push("|---|---|---|---|---|---|---|");
        for (const finding of fixable) push(`| ${finding.id} | ${cell(finding.title)} | ${finding.status || "proposed"} | ${finding.confidence || "–"} | ${cell(finding.gain || finding.cost)} | ${cell(finding.risk)} | \`${specCommand([finding.id])}\` |`);
        push();
        const openIds = open.filter((finding) => finding.fix).map((finding) => finding.id);
        if (openIds.length > 1) { push(`**All open fixes together:** \`${specCommand(openIds)}\``); push(); }
        // The example group names real fixes: the first and last open ones, or the first two in the table.
        const exampleIds = openIds.length > 2 ? [openIds[0], openIds[openIds.length - 1]] : fixable.slice(0, 2).map((finding) => finding.id);
        if (exampleIds.length > 1) push(`**A group of your choice:** \`${specCommand(exampleIds)}\` (any IDs from the table)`);
    } else {
        push("No fixes proposed.");
    }
    push();
    for (const finding of list) {
        push(`## ${finding.id} · ${finding.title}`);
        push();
        push(`**Severity:** ${finding.severity || "–"} · **Status:** ${finding.status || "–"} · **Phases:** ${(finding.phases || []).join(", ") || "–"}${finding.cost ? ` · **Cost:** ${finding.cost}` : ""}`);
        push();
        const group = recon.groups.find((candidate) => candidate.slug === recon.byId[finding.id]);
        if (finding.confidence || finding.subsystem || group) {
            push(`**Cause:** ${finding.confidence === "confirmed" ? "confirmed in the code" : finding.confidence === "inferred" ? "inferred from the profile — not yet traced in the code" : "–"}${finding.subsystem ? ` · **Subsystem:** ${finding.subsystem}` : ""}${group ? ` · **Recon:** \`${group.path}\` ${group.exists ? `(${group.depth})` : "(not yet — run the command above)"}` : ""}`);
            push();
        }
        if (finding.cause) { push("### Why it is slow"); push(); push(finding.cause); push(); }
        if (finding.evidence && finding.evidence.length) { push("### Evidence"); push(); for (const item of finding.evidence) push(`- ${item}`); push(); }
        if (finding.code && finding.code.length) { push("### Code"); push(); for (const location of finding.code) push(`- \`${location.file}${location.line ? `:${location.line}` : ""}\`${location.label ? ` — ${location.label}` : ""}`); push(); }
        if (finding.fix) { push(isDone(finding) ? "### The fix" : "### Proposed fix"); push(); push(finding.fix); push(); }
        if (finding.gain) { push(`**Expected gain:** ${finding.gain}`); push(); }
        if (finding.risk) { push(`**Risk:** ${finding.risk}`); push(); }
        if (finding.guards && finding.guards.length) { push("### Must not break"); push(); for (const guard of finding.guards) push(`- ${guard}`); push(); }
        if (finding.verify) { push(`**How to verify:** ${finding.verify}`); push(); }
        if (finding.before || finding.after) { push(`**Before:** ${finding.before || "–"} · **After:** ${finding.after || "not fixed yet"}`); push(); }
        if (finding.diff) { push("<details><summary>The change</summary>"); push(); push("```diff"); push(finding.diff); push("```"); push(); push("</details>"); push(); }
    }
    return lines.join("\n");
}

/**
 * Prints the report to a PDF beside it (the page's Download PDF button), with the Chrome the capture drives: the print
 * stylesheet, every collapsed section open, backgrounds kept. A machine without puppeteer or Chrome only skips the PDF.
 */
async function writePdf(htmlFile, pdfFile) {
    let puppeteer = null;
    try {
        puppeteer = (await import("puppeteer-core")).default;
    } catch {
        process.stdout.write("skipped the PDF (puppeteer-core is not installed next to report.mjs)\n");
        return;
    }
    let browser = null;
    try {
        const { findChrome } = await import("./lib/chrome.mjs");
        browser = await puppeteer.launch({ executablePath: findChrome(), headless: "new", args: ["--allow-file-access-from-files"] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
        await page.goto("file://" + path.resolve(htmlFile), { waitUntil: "load" });
        await new Promise((resolve) => setTimeout(resolve, 1200)); // charts and the progress panel render after load
        await page.evaluate(() => {
            // The PDF is the report: a run still marked running (the report is written just before the run ends) keeps
            // its live panel off the page.
            if (document.documentElement.classList.contains("btp-running")) document.querySelectorAll("#bt-progress, .btp-toolbar").forEach((element) => element.remove());
            document.querySelectorAll("details").forEach((details) => { details.open = true; });
        });
        await page.emulateMediaType("print");
        await page.pdf({ path: pdfFile, format: "A4", printBackground: true, margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" } });
        process.stdout.write(`wrote ${pdfFile}\n`);
    } catch (error) {
        process.stdout.write(`skipped the PDF: ${error.message}\n`);
    } finally {
        if (browser) await browser.close();
    }
}

/** Entry point. */
async function main() {
    const flags = parseArguments(process.argv.slice(2));
    if (!flags.analysis) throw new Error("Pass --analysis <analysis.json> [--out <dashboard.html>]");
    const runDir = (file) => (file ? path.dirname(path.resolve(file)) : null);
    // Default: the slug's dashboard.html — next to the `data/` folder that holds the analysis's runs.
    const configFile = findUp(runDir(flags.analysis), "profile.config.json"); // <slug>/data/profile.config.json
    const slugDir = configFile ? path.dirname(path.dirname(configFile)) : slugDirOfRun(runDir(flags.analysis));
    const outFile = path.resolve(flags.out || (slugDir ? path.join(slugDir, "dashboard.html") : "dashboard.html"));
    const reportDir = path.dirname(outFile);
    fs.mkdirSync(reportDir, { recursive: true });
    const analysis = readJson(flags.analysis);
    const baseline = readJson(flags.baseline);
    const warm = readJson(flags.warm);
    const findings = readJson(flags.findings);
    const title = flags.title || (findings && findings.title) || `Performance report — ${analysis.capture.scenario || "scenario"}`;
    const data = {
        run: pageData(analysis, reportDir, runDir(flags.analysis)),
        baseline: baseline ? pageData(baseline, reportDir, runDir(flags.baseline)) : null,
        warm: warm ? pageData(warm, reportDir, runDir(flags.warm)) : null,
        findings,
        groups: OWNER_GROUPS,
        slug: path.basename(reportDir),
    };
    // The profile's slug folder is <project>/.agents/profile/<slug>/: its recons sit in recon/ inside it, general ones in
    // <project>/.agents/recon/.
    data.recon = reconGroups(findings && Array.isArray(findings.findings) ? findings.findings : [], data.slug, path.join(reportDir, "..", ".."));
    if (flags.snapshots) data.run.shots = shotsFrom(path.resolve(flags.snapshots), reportDir);
    if (flags["snapshots-before"]) {
        // Shown beside this run's shots of the same names (needs --baseline, whose own shots they replace).
        if (data.baseline) data.baseline.shots = shotsFrom(path.resolve(flags["snapshots-before"]), reportDir);
    }
    const pdfFile = flags.pdf === "false" ? null : outFile.replace(/\.html?$/i, "") + ".pdf";
    fs.writeFileSync(outFile, buildPage({ title, verdict: findings && findings.summary, data, pdfName: pdfFile ? path.basename(pdfFile) : null }));
    process.stdout.write(`wrote ${outFile}\n`);
    if (findings) {
        const markdownFile = path.join(path.dirname(outFile), "findings.md");
        fs.writeFileSync(markdownFile, findingsMarkdown(findings, analysis, path.basename(path.dirname(outFile)), data.recon));
        process.stdout.write(`wrote ${markdownFile}\n`);
    }
    if (pdfFile) return writePdf(outFile, pdfFile);
}

main().catch((error) => { process.stderr.write(String(error && error.stack ? error.stack : error) + "\n"); process.exit(1); });
