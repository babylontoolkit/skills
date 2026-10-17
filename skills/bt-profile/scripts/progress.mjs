#!/usr/bin/env node
/**
 * bt-profile progress: the one way the agent tells the dashboard what a profile run is doing, plus the watchdog
 * that keeps it honest while a long capture or analysis runs and the agent is silent.
 *
 * Every write reads `data/progress.js`, parses its strict JSON, changes it and writes it back atomically (a temp file
 * renamed over the original), so the page never loads a half-written file.
 *
 *   node progress.mjs start  <slug-folder> [--title "…"] [--brief "…"] [--project <path>] [--url <url>] [--mode fix|analyze]
 *   node progress.mjs stage  <slug-folder> <preflight|baseline|diagnose|fix|verify|report> [--status active|done|skipped] [--note "…"]
 *   node progress.mjs now    <slug-folder> "<what is happening this minute>" [--step "<log line, if different>"]
 *   node progress.mjs fix    <slug-folder> <F1> [--title "…"] [--status planned|trying|measuring|kept|reverted|skipped] [--before "…"] [--after "…"] [--note "…"]
 *   node progress.mjs metric <slug-folder> "<label>" "<value>" [--note "…"]
 *   node progress.mjs note   <slug-folder> "<milestone>"
 *   node progress.mjs end    <slug-folder> [--status done|stopped|failed] [--summary "…"]
 *   node progress.mjs check  <slug-folder>
 *   node progress.mjs watch  <slug-folder> [--watch <folder>]… [--interval-seconds 60] [--quiet-minutes 5] [--stall-minutes 30] [--max-hours 12]
 *
 * <slug-folder> is .agents/profile/<slug> (it holds dashboard.html and data/). Timestamps are this machine's local time.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { PROGRESS_MARKER, livePage } from "./lib/progress-panel.mjs";

const PREFIX = "window.PROFILE_PROGRESS";
/** The stages every profile run goes through, in order. */
const STAGES = [
    { id: "preflight", name: "Preflight" },
    { id: "baseline", name: "Baseline" },
    { id: "diagnose", name: "Diagnose" },
    { id: "fix", name: "Fix" },
    { id: "verify", name: "Verify" },
    { id: "report", name: "Report" },
];
/** How the watchdog says what each stage is doing ("Still measuring the baseline …"). */
const STAGE_DOING = {
    preflight: "preparing the run",
    baseline: "measuring the baseline",
    diagnose: "diagnosing",
    fix: "working on fixes",
    verify: "verifying",
    report: "writing the report",
};
const STAGE_STATUSES = new Set(["pending", "active", "done", "skipped"]);
const FIX_STATUSES = new Set(["planned", "trying", "measuring", "kept", "reverted", "skipped"]);
const END_STATUSES = new Set(["done", "stopped", "failed"]);
/** How many lines the live step log keeps. */
const MAXIMUM_STEPS = 12;
/** Folders the watchdog never descends into. */
const IGNORED_FOLDERS = new Set(["node_modules", ".git", ".tools", "Library", "Temp", "Logs", "obj", "dist", "build", ".cache", ".vite", ".vite-profile-cache"]);
const MAXIMUM_SCAN_DEPTH = 6;

const [command, slugFolder, ...rest] = process.argv.slice(2);

const progressPath = (folder) => join(folder, "data", "progress.js");

function localTime(moment = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    const clock = `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
    return { stamp: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${clock}`, clock };
}

function parseStamp(stamp) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp || ""));
    if (!match) return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute);
}

/** Reads `--name value` options; names listed in `repeatable` collect every occurrence. */
function parseOptions(argumentList, repeatable = []) {
    const options = Object.fromEntries(repeatable.map((name) => [name, []]));
    const positional = [];
    for (let index = 0; index < argumentList.length; index += 1) {
        const argument = argumentList[index];
        if (!argument.startsWith("--")) {
            positional.push(argument);
            continue;
        }
        const name = argument.slice(2);
        const next = argumentList[index + 1];
        const value = next === undefined || next.startsWith("--") ? true : argumentList[++index];
        if (repeatable.includes(name)) options[name].push(value);
        else options[name] = value;
    }
    return { options, positional };
}

function readProgress(folder) {
    const file = progressPath(folder);
    if (!existsSync(file)) throw new Error(`${file} does not exist — run "progress.mjs start" first`);
    const text = readFileSync(file, "utf8");
    const separator = text.indexOf("=");
    if (separator < 0) throw new Error(`${file} has no "${PREFIX} =" prefix`);
    return JSON.parse(text.slice(separator + 1).trim().replace(/;\s*$/, ""));
}

function writeProgress(folder, progress) {
    const file = progressPath(folder);
    mkdirSync(dirname(file), { recursive: true });
    progress.updatedAt = localTime().stamp;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${PREFIX} = ${JSON.stringify(progress, null, 2)};\n`, "utf8");
    renameSync(temporary, file);
}

/** Adds a milestone and, unless the step says otherwise, the same line to the live step log. */
function addMilestone(progress, text) {
    progress.activity = Array.isArray(progress.activity) ? progress.activity : [];
    progress.activity.push({ at: localTime().stamp, text });
}

function setNow(progress, activity, step, source = "agent") {
    const now = progress.now && typeof progress.now === "object" ? progress.now : {};
    const steps = Array.isArray(now.steps) ? now.steps : [];
    if (step) steps.push({ at: localTime().clock, text: step });
    progress.now = { ...now, updatedAt: localTime().stamp, activity, source, steps: steps.slice(-MAXIMUM_STEPS) };
}

/** Starts a run: a fresh progress file, and a live dashboard when the slug has none that carries the panel. */
function start(folder, argumentList) {
    const { options } = parseOptions(argumentList);
    const mode = options.mode === "analyze" ? "analyze" : "fix";
    const stamp = localTime().stamp;
    const stages = STAGES.map((stage) => ({ ...stage, status: "pending", started: "", finished: "", note: "" }));
    stages[0].status = "active";
    stages[0].started = localTime().clock;
    if (mode === "analyze") Object.assign(stages.find((stage) => stage.id === "fix"), { status: "skipped", note: "--analyze: no code changes" });
    const progress = {
        schema: 1,
        status: "running",
        title: String(options.title || `${basename(folder)} profile`),
        brief: String(options.brief || ""),
        project: String(options.project || ""),
        url: String(options.url || ""),
        mode,
        startedAt: stamp,
        finishedAt: "",
        summary: "",
        stages,
        metrics: [],
        fixes: [],
        now: { updatedAt: stamp, activity: "Starting the profile — checking the project, the dev server and the scenario.", source: "agent", steps: [] },
        activity: [],
    };
    addMilestone(progress, `Profile started${progress.brief ? ` — ${progress.brief}` : ""}`);
    writeProgress(folder, progress);

    const dashboard = join(folder, "dashboard.html");
    const current = existsSync(dashboard) ? readFileSync(dashboard, "utf8") : "";
    if (!current.includes(PROGRESS_MARKER)) {
        // A report from before the panel existed is kept beside the data, not lost while the run replaces it.
        if (current) writeFileSync(join(folder, "data", "previous-dashboard.html"), current);
        writeFileSync(dashboard, livePage({ title: progress.title }));
        console.log(`wrote the live page ${dashboard}${current ? " (the previous report is in data/previous-dashboard.html)" : ""}`);
    }
    console.log(`progress: started ${progress.title} (${mode})`);
}

function stage(folder, argumentList) {
    const { options, positional } = parseOptions(argumentList);
    const id = positional[0];
    const status = String(options.status || "active");
    if (!STAGE_STATUSES.has(status)) throw new Error(`stage status must be one of ${[...STAGE_STATUSES].join(", ")}`);
    const progress = readProgress(folder);
    const target = (progress.stages || []).find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown stage "${id}" — one of ${STAGES.map((candidate) => candidate.id).join(", ")}`);
    const clock = localTime().clock;
    if (status === "active") {
        // One stage is active at a time: starting one finishes the one before it.
        for (const other of progress.stages) {
            if (other !== target && other.status === "active") Object.assign(other, { status: "done", finished: clock });
        }
        Object.assign(target, { status, started: target.started || clock, finished: "" });
        progress.now = { ...(progress.now || {}), steps: [] };
        setNow(progress, options.note ? String(options.note) : `${target.name} started.`, `${target.name} started`);
        addMilestone(progress, `${target.name} started${options.note ? ` — ${options.note}` : ""}`);
    } else {
        Object.assign(target, { status, finished: status === "done" ? clock : target.finished });
        addMilestone(progress, `${target.name} ${status}${options.note ? ` — ${options.note}` : ""}`);
    }
    if (options.note) target.note = String(options.note);
    writeProgress(folder, progress);
}

function now(folder, argumentList) {
    const { options, positional } = parseOptions(argumentList);
    const activity = positional.join(" ").trim();
    if (!activity) throw new Error('say what is happening: progress.mjs now <slug-folder> "<sentence>"');
    const progress = readProgress(folder);
    setNow(progress, activity, options.step ? String(options.step) : activity);
    writeProgress(folder, progress);
}

function fix(folder, argumentList) {
    const { options, positional } = parseOptions(argumentList);
    const id = positional[0];
    if (!id) throw new Error("name the fix: progress.mjs fix <slug-folder> F1 …");
    if (options.status && !FIX_STATUSES.has(options.status)) throw new Error(`fix status must be one of ${[...FIX_STATUSES].join(", ")}`);
    const progress = readProgress(folder);
    progress.fixes = Array.isArray(progress.fixes) ? progress.fixes : [];
    let entry = progress.fixes.find((candidate) => candidate.id === id);
    if (!entry) {
        entry = { id, title: "", status: "planned", before: "", after: "", note: "" };
        progress.fixes.push(entry);
    }
    const previousStatus = entry.status;
    for (const field of ["title", "status", "before", "after", "note"]) if (options[field] !== undefined && options[field] !== true) entry[field] = String(options[field]);
    if (entry.status !== previousStatus || !previousStatus) {
        const line = `${id} ${entry.status}: ${entry.title}${entry.before || entry.after ? ` (${entry.before || "–"} → ${entry.after || "…"})` : ""}`;
        addMilestone(progress, line);
        setNow(progress, progress.now && progress.now.activity ? progress.now.activity : line, line);
    }
    writeProgress(folder, progress);
}

function metric(folder, argumentList) {
    const { options, positional } = parseOptions(argumentList);
    const [label, value] = positional;
    if (!label || value === undefined) throw new Error('progress.mjs metric <slug-folder> "<label>" "<value>" [--note "…"]');
    const progress = readProgress(folder);
    progress.metrics = Array.isArray(progress.metrics) ? progress.metrics : [];
    const entry = progress.metrics.find((candidate) => candidate.label === label);
    const note = options.note && options.note !== true ? String(options.note) : entry ? entry.note : "";
    if (entry) Object.assign(entry, { value: String(value), note });
    else progress.metrics.push({ label, value: String(value), note });
    writeProgress(folder, progress);
}

function note(folder, argumentList) {
    const text = argumentList.join(" ").trim();
    if (!text) throw new Error('progress.mjs note <slug-folder> "<milestone>"');
    const progress = readProgress(folder);
    addMilestone(progress, text);
    writeProgress(folder, progress);
}

function end(folder, argumentList) {
    const { options } = parseOptions(argumentList);
    const status = String(options.status || "done");
    if (!END_STATUSES.has(status)) throw new Error(`end status must be one of ${[...END_STATUSES].join(", ")}`);
    const progress = readProgress(folder);
    const clock = localTime().clock;
    for (const candidate of progress.stages || []) {
        if (candidate.status === "active" && status === "done") Object.assign(candidate, { status: "done", finished: clock });
    }
    Object.assign(progress, { status, finishedAt: localTime().stamp, summary: options.summary && options.summary !== true ? String(options.summary) : progress.summary });
    setNow(progress, status === "done" ? "Finished — the report is written." : `Ended (${status}).`, `Run ${status}`);
    addMilestone(progress, `Profile ${status}${progress.summary ? ` — ${progress.summary}` : ""}`);
    writeProgress(folder, progress);
}

function check(folder) {
    const progress = readProgress(folder);
    const problems = [];
    for (const field of ["stages", "metrics", "fixes", "activity"]) if (!Array.isArray(progress[field])) problems.push(`${field} is not a list`);
    if (!progress.now || typeof progress.now !== "object") problems.push("now is not an object");
    else if (!Array.isArray(progress.now.steps)) problems.push("now.steps is not a list");
    if (problems.length) throw new Error(problems.join("; "));
    console.log(`progress.js is valid — ${progress.status}, ${progress.fixes.length} fixes, ${progress.activity.length} milestones`);
}

/* ===================== Watchdog ===================== */

/** The most recently changed file under some folders, skipping dependency, build and cache folders. */
function latestChange(roots) {
    let latest = null;
    const visit = (folder, depth) => {
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                if (depth < MAXIMUM_SCAN_DEPTH && !IGNORED_FOLDERS.has(entry.name)) visit(path, depth + 1);
                continue;
            }
            // The progress file and the page are written by the agent and the watchdog — not a sign of work.
            if (!entry.isFile() || entry.name.endsWith(".tmp") || entry.name === "progress.js" || entry.name === "dashboard.html") continue;
            try {
                const modified = statSync(path).mtimeMs;
                if (!latest || modified > latest.modified) latest = { path, modified };
            } catch {
                /* the file vanished between listing and stat */
            }
        }
    };
    roots.forEach((root) => visit(root, 0));
    return latest;
}

/** The last meaningful line of the newest capture log — what profile.mjs or analyze.mjs is doing right now. */
function latestLogLine(folder) {
    const logs = join(folder, "data", "logs");
    let newest = null;
    try {
        for (const name of readdirSync(logs)) {
            const path = join(logs, name);
            const modified = statSync(path).mtimeMs;
            if (!newest || modified > newest.modified) newest = { path, name, modified };
        }
    } catch {
        return null;
    }
    if (!newest) return null;
    const lines = readFileSync(newest.path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.pop();
    return line ? { log: newest.name, line: line.length > 160 ? `${line.slice(0, 157)}…` : line } : null;
}

/**
 * The watchdog. While the run is in progress it checks every interval; when the agent has written nothing for
 * `quiet-minutes` it writes a heartbeat naming the newest file and the newest capture log's last line, and when no
 * file has changed for `stall-minutes` either, it says the run may be stalled. It exits when the run ends, or
 * after `max-hours` (a killed run leaves the status at running, and the watchdog must not outlive it forever).
 */
async function watch(folder, argumentList) {
    const { options } = parseOptions(argumentList, ["watch"]);
    const intervalSeconds = Number(options["interval-seconds"] || 60);
    const quietMinutes = Number(options["quiet-minutes"] || 5);
    const stallMinutes = Number(options["stall-minutes"] || 30);
    const stopAt = Date.now() + Number(options["max-hours"] || 12) * 3600000;
    const roots = [folder, ...options.watch.map(String)];
    console.log(`watchdog: watching ${roots.join(", ")} every ${intervalSeconds} s (quiet after ${quietMinutes} min, stalled after ${stallMinutes} min)`);
    for (;;) {
        if (Date.now() > stopAt) return console.log("watchdog: reached its maximum lifetime — exiting");
        let progress = null;
        try {
            progress = readProgress(folder);
        } catch {
            /* caught mid-write or briefly missing — try again next round */
        }
        if (progress && progress.status !== "running") return console.log(`watchdog: the run is ${progress.status} — exiting`);
        if (progress) {
            try {
                heartbeat(folder, progress, roots, quietMinutes, stallMinutes);
            } catch (error) {
                console.log(`watchdog: skipped a round — ${error.message}`);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }
}

function heartbeat(folder, progress, roots, quietMinutes, stallMinutes) {
    const moment = new Date();
    const lastWrite = parseStamp(progress.now && progress.now.updatedAt);
    const quietFor = lastWrite ? Math.floor((moment - lastWrite) / 60000) : Infinity;
    if (quietFor < quietMinutes) return;
    const change = latestChange(roots);
    const changedAgo = change ? Math.floor((moment - change.modified) / 60000) : Infinity;
    const where = change ? `${relative(folder, change.path) || change.path} at ${localTime(new Date(change.modified)).clock}` : "no file changes found";
    const log = latestLogLine(folder);
    const logText = log ? ` — ${log.log}: "${log.line}"` : "";
    const activeStage = (progress.stages || []).find((candidate) => candidate.status === "active");
    let activity;
    let step;
    if (changedAgo >= stallMinutes) {
        activity = `No update for ${quietFor} min and no file has changed for ${changedAgo === Infinity ? "the whole watch" : `${changedAgo} min`} — the run may be stalled or waiting on something.`;
        step = `Watchdog: possible stall — last change: ${where}`;
    } else {
        activity = `Still ${(activeStage && STAGE_DOING[activeStage.id]) || "working"} — no update from the agent for ${quietFor} min; latest: ${where}${logText}.`;
        step = `Watchdog: still working — ${where}`;
    }
    setNow(progress, activity, step, "watchdog");
    writeProgress(folder, progress);
    console.log(`watchdog ${localTime(moment).clock}: ${activity}`);
}

const commands = { start, stage, now, fix, metric, note, end, check, watch };

if (!commands[command] || !slugFolder) {
    console.error("usage: node progress.mjs <start|stage|now|fix|metric|note|end|check|watch> <slug-folder> [options] — see the header of this file");
    process.exit(2);
}
try {
    await commands[command](slugFolder, rest);
} catch (error) {
    console.error(`progress.mjs ${command}: ${error.message}`);
    process.exit(1);
}
