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
