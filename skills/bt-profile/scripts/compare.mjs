/**
 * bt-profile compare: prints before → after for two analyses of the same scenario — per phase (FPS, CPU ms/frame,
 * busy, draws), per owner (ms/frame) and the functions whose time changed most — so a fix is kept or reverted on
 * numbers, not impressions.
 *
 * Usage:
 *   node compare.mjs --before runs/baseline/cold/analysis.json --after runs/fix-1/cold/analysis.json [--focus "Name.fn,Other.fn"]
 */
import fs from "node:fs";
import path from "node:path";

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

/** Formats a signed change. */
const signed = (value, digits = 1) => (value == null || Number.isNaN(value) ? "   –" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`);

/** Total ms per frame of a function (inclusive) in a phase list, by display name. */
function inclusiveByName(lists) {
    const map = new Map();
    for (const entry of lists.inclusiveTop) map.set(entry.name, (map.get(entry.name) || 0) + (entry.msPerFrame || 0));
    return map;
}

/** Entry point. */
function main() {
    const flags = parseArguments(process.argv.slice(2));
    const before = JSON.parse(fs.readFileSync(path.resolve(flags.before), "utf8"));
    const after = JSON.parse(fs.readFileSync(path.resolve(flags.after), "utf8"));
    const out = [];
    const line = (text = "") => out.push(text);
    line(`before: ${path.dirname(path.resolve(flags.before))} (${before.capture.capturedAt})`);
    line(`after:  ${path.dirname(path.resolve(flags.after))} (${after.capture.capturedAt})`);
    line();
    line("PHASE            fps before → after        CPU ms/frame before → after     busy%        draws");
    for (const phase of after.phases) {
        const previous = before.phases.find((candidate) => candidate.name === phase.name);
        if (!previous) { line(`  ${phase.name.padEnd(14)} (new phase)`); continue; }
        const fps = `${String(previous.frames.fps).padStart(5)} → ${String(phase.frames.fps).padStart(5)} (${signed(phase.frames.fps - previous.frames.fps)})`;
        const cpu = `${String(previous.frames.cpuMeanMs).padStart(6)} → ${String(phase.frames.cpuMeanMs).padStart(6)} (${signed(phase.frames.cpuMeanMs - previous.frames.cpuMeanMs, 2)})`;
        line(`  ${phase.name.padEnd(14)} ${fps.padEnd(26)} ${cpu.padEnd(31)} ${String(previous.busyPct).padStart(3)}→${String(phase.busyPct).padEnd(3)}     ${previous.frames.draws}→${phase.frames.draws}`);
    }
    line();
    line("OWNER ms/frame (whole run)");
    const ownersBefore = new Map(before.overall.lists.owners.map((entry) => [entry.owner, entry.msPerFrame]));
    for (const entry of after.overall.lists.owners) {
        const previous = ownersBefore.get(entry.owner);
        line(`  ${entry.owner.padEnd(10)} ${String(previous ?? "–").padStart(8)} → ${String(entry.msPerFrame).padStart(8)}  (${signed(previous != null ? entry.msPerFrame - previous : null, 3)})`);
    }
    line();
    line("FUNCTIONS whose inclusive ms/frame changed most (whole run)");
    const inclusiveBefore = inclusiveByName(before.overall.lists);
    const inclusiveAfter = inclusiveByName(after.overall.lists);
    const names = new Set([...inclusiveBefore.keys(), ...inclusiveAfter.keys()]);
    const changes = [...names].map((name) => ({ name, before: inclusiveBefore.get(name) ?? 0, after: inclusiveAfter.get(name) ?? 0 }))
        .map((entry) => ({ ...entry, change: entry.after - entry.before }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 15);
    for (const entry of changes) line(`  ${signed(entry.change, 3).padStart(9)} ms/f   ${entry.before.toFixed(3)} → ${entry.after.toFixed(3)}   ${entry.name}`);
    if (flags.focus) {
        line();
        line("FOCUS");
        for (const name of flags.focus.split(",")) {
            for (const phase of after.phases) {
                const previous = before.phases.find((candidate) => candidate.name === phase.name);
                const now = inclusiveByName(phase.lists).get(name);
                const was = previous ? inclusiveByName(previous.lists).get(name) : null;
                if (now == null && was == null) continue;
                line(`  ${name} [${phase.name}]  ${was?.toFixed(3) ?? "–"} → ${now?.toFixed(3) ?? "–"} ms/frame`);
            }
        }
    }
    if (before.heap && after.heap) {
        line();
        line(`ALLOCATION  ${before.heap.mbPerSecond} → ${after.heap.mbPerSecond} MB/s`);
    }
    process.stdout.write(out.join("\n") + "\n");
}

main();
