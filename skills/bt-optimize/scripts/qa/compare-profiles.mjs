/**
 * bt-optimize report table: compares profile-browser.mjs runs of the same views (pinned with --poses, or timeline
 * runs with the same --times) and prints a Markdown table — FPS, frame times, draws per pass, active meshes.
 *
 * Usage:
 *   node compare-profiles.mjs --label Original,Optimized before-pinned.json after-pinned.json [more.json …]
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Reads `--name value` pairs and positional file arguments.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{flags: Record<string, string>, files: string[]}}
 */
function parseArguments(argv) {
    const flags = {};
    const files = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
        else files.push(argv[i]);
    }
    return { flags, files };
}

/** Formats a number change as "a → b (±x%)". */
function change(before, after, digits = 0) {
    if (before == null || after == null) return "—";
    const percent = before !== 0 ? Math.round(((after - before) / before) * 100) : 0;
    return `${before.toFixed(digits)} → **${after.toFixed(digits)}** (${percent >= 0 ? "+" : ""}${percent}%)`;
}

/** How many owners and repeated shapes each pin's accounting tables list. */
const DRAW_OWNER_ROWS = 12;

/** The owner name profile-browser.mjs gives main-pass draws no scene object's render call made. */
const UNOWNED = "(unowned)";

/**
 * Whether a run's accounting measured its draws per render call (profiles from before that have no frameMainDraws
 * and no "(unowned)" entry, so a missing owner there means "not measured", not "no draws").
 * @param {object|null} accounting - one run's drawOwners at a pin
 */
function isMeasured(accounting) {
    return accounting != null && accounting.frameMainDraws != null;
}

/**
 * The owner names one pin's table lists: the top DRAW_OWNER_ROWS of every run, plus "(unowned)" whenever a run
 * measured its draws, so a draw no object owns is never cut off the table (and a measured 0 shows every draw owned).
 * @param {(object|null)[]} accountings - each run's drawOwners at this pin (null when the run has none)
 * @returns {string[]} the owner names, in first-seen order
 */
function tableOwnerNames(accountings) {
    const present = accountings.filter(Boolean);
    const topOwners = present.flatMap((accounting) => accounting.owners.slice(0, DRAW_OWNER_ROWS).map((owner) => owner.owner));
    const showUnowned = present.some((accounting) => isMeasured(accounting) || accounting.owners.some((owner) => owner.owner === UNOWNED));
    return [...new Set(showUnowned ? [...topOwners, UNOWNED] : topOwners)];
}

/**
 * One run's draws for one owner: its draws, 0 when the run lists no such owner, "—" when the run has no accounting
 * (or, for "(unowned)", did not measure draws per render call).
 * @param {object|null} accounting - the run's drawOwners at this pin
 * @param {string} ownerName - the owner of this table row
 * @returns {number|string} the cell value
 */
function ownerDrawsCell(accounting, ownerName) {
    if (accounting == null) return "—";
    const owner = accounting.owners.find((candidate) => candidate.owner === ownerName);
    if (owner) return owner.draws;
    if (ownerName === UNOWNED && !isMeasured(accounting)) return "—";
    return 0;
}

/**
 * The last run's description column for one owner: its skinned / instanced / lightmapped mesh counts, or for
 * "(unowned)" the classes whose render made those draws.
 * @param {object|undefined} latest - the owner's entry in the last run, if it has one
 * @returns {string} the cell text
 */
function ownerKinds(latest) {
    if (!latest) return "—";
    if (latest.sources) return `made by ${latest.sources.join(", ")}`;
    return `${latest.skinned} / ${latest.instances} / ${latest.lightmapped}`;
}

/**
 * Appends, per pinned view, the main-pass draws by owning scene object for every run side by side (with any
 * "(unowned)" draws), the accounted total beside the frame's measured main-pass draws, then the last run's repeated
 * shapes that still cost one draw per copy and why. A pin the last run has no accounting for is skipped, and a run
 * without accounting shows "—"; runs profiled before draws were measured per render call have no frameMainDraws (and
 * no "(unowned)" entry) and show "—" in those rows.
 * @param {string[]} lines - the report lines to append to
 * @param {object[]} runs - the parsed profile runs, in label order
 * @param {(index: number) => string} name - the label of run `index`
 */
function appendDrawOwners(lines, runs, name) {
    const last = runs[runs.length - 1];
    for (const pin of last.pins) {
        const accountings = runs.map((run) => (run.pins || []).find((candidate) => candidate.atSeconds === pin.atSeconds)?.drawOwners ?? null);
        const lastAccounting = accountings[accountings.length - 1];
        if (lastAccounting == null) continue;
        lines.push(`**Main-pass draws by owner — ${pin.atSeconds} s view**`);
        lines.push("");
        lines.push(`| Owner | ${runs.map((_, index) => name(index)).join(" | ")} | Skinned / instanced / lightmapped meshes (${name(runs.length - 1)}) | Shadow-map casters (${name(runs.length - 1)}) |`);
        lines.push(`|---|${runs.map(() => "---").join("|")}|---|---|`);
        for (const ownerName of tableOwnerNames(accountings)) {
            const cells = accountings.map((accounting) => ownerDrawsCell(accounting, ownerName));
            const latest = lastAccounting.owners.find((owner) => owner.owner === ownerName);
            lines.push(`| ${ownerName} | ${cells.join(" | ")} | ${ownerKinds(latest)} | ${latest?.shadowCasters ?? "—"} |`);
        }
        lines.push(`| **All main-pass draws** (mainDraws) | ${accountings.map((accounting) => (accounting ? `**${accounting.mainDraws}**` : "—")).join(" | ")} | | |`);
        lines.push(`| Main-pass draws of the same frame (frameMainDraws) | ${accountings.map((accounting) => accounting?.frameMainDraws ?? "—").join(" | ")} | | |`);
        lines.push("");
        const costly = lastAccounting.repeats.filter((repeat) => repeat.blocker != null).slice(0, DRAW_OWNER_ROWS);
        if (costly.length === 0) continue;
        lines.push(`Repeated shapes still drawn once per copy (${name(runs.length - 1)}):`);
        lines.push("");
        lines.push("| Shape | Owner | Copies | Draws | Why the copies do not share one draw |");
        lines.push("|---|---|---|---|---|");
        for (const repeat of costly) lines.push(`| ${repeat.shape} | ${repeat.owner} | ${repeat.copies} | ${repeat.draws} | ${repeat.blocker} |`);
        lines.push("");
    }
}

/** Entry point. */
function main() {
    const { flags, files } = parseArguments(process.argv.slice(2));
    if (files.length < 2) throw new Error("Pass at least two profile JSON files (before, after).");
    const runs = files.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
    const labels = (flags.label || "").split(",").filter(Boolean);
    const name = (index) => labels[index] || path.basename(files[index], ".json");
    const lines = [];

    lines.push(`| | ${runs.map((_, i) => name(i)).join(" | ")} |`);
    lines.push(`|---|${runs.map(() => "---").join("|")}|`);
    const census = (key) => runs.map((run) => (run.census ? run.census[key] : "")).join(" | ");
    lines.push(`| Meshes | ${census("meshes")} |`);
    lines.push(`| Materials | ${census("materials")} |`);
    lines.push(`| Lights / shadow generators | ${runs.map((run) => run.census ? `${run.census.lights.length} / ${run.census.shadows.length}` : "").join(" | ")} |`);
    lines.push(`| Post passes | ${census("postProcesses")} |`);
    lines.push("");

    const first = runs[0], last = runs[runs.length - 1];
    if (first.pins && last.pins) {
        lines.push(`| View | FPS | p50 frame ms | p95 frame ms | Draws / frame | Shadow-map draws | Depth / other target draws | Main-pass draws | Active meshes |`);
        lines.push(`|---|---|---|---|---|---|---|---|---|`);
        for (const pin of first.pins) {
            const other = last.pins.find((candidate) => candidate.atSeconds === pin.atSeconds);
            if (!other) continue;
            const a = pin.baseline, b = other.baseline;
            lines.push(`| ${pin.atSeconds} s @ ${pin.pinned.position ? pin.pinned.position.map((v) => v.toFixed(1)).join(",") : pin.pinned} | ${change(a.fps, b.fps, 1)} | ${change(a.p50Ms, b.p50Ms, 1)} | ${change(a.p95Ms, b.p95Ms, 1)} | ${change(a.drawCalls, b.drawCalls)} | ${change(a.passes.shadowMaps, b.passes.shadowMaps)} | ${change(a.passes.otherTargets, b.passes.otherTargets)} | ${change(a.passes.main, b.passes.main)} | ${change(a.activeMeshes, b.activeMeshes)} |`);
        }
        lines.push("");
        appendDrawOwners(lines, runs, name);
    }
    if (first.samples && last.samples) {
        lines.push(`| Timeline | FPS | p95 frame ms | Worst frame ms | Draws / frame |`);
        lines.push(`|---|---|---|---|---|`);
        for (const sample of first.samples) {
            const other = last.samples.find((candidate) => candidate.atSeconds === sample.atSeconds);
            if (!other) continue;
            lines.push(`| ${sample.atSeconds} s | ${change(sample.fps, other.fps, 1)} | ${change(sample.p95Ms, other.p95Ms)} | ${change(sample.worstMs, other.worstMs)} | ${change(sample.drawCalls, other.drawCalls)} |`);
        }
        const mean = (run, key) => run.samples.reduce((sum, s) => sum + s[key], 0) / run.samples.length;
        const worst = (run) => Math.max(...run.samples.map((s) => s.worstMs));
        lines.push(`| **Average / worst** | ${change(mean(first, "fps"), mean(last, "fps"), 1)} | ${change(mean(first, "p95Ms"), mean(last, "p95Ms"))} | ${change(worst(first), worst(last))} | ${change(mean(first, "drawCalls"), mean(last, "drawCalls"))} |`);
        lines.push("");
        lines.push("Timeline rows are moments after load; a lighter scene loads sooner, so its tour can be ahead — compare pinned views for like-for-like numbers.");
    }
    process.stdout.write(lines.join("\n") + "\n");
}

main();
