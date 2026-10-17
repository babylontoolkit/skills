/**
 * bt-profile analysis: reads one capture folder (written by profile.mjs) and works out where the time goes —
 * per phase of the scenario, per second, per function and per owner — and, most importantly, which of YOUR
 * functions is responsible for it, including the library work they trigger (a `scene.pick` called from your
 * update loop is charged to your update loop).
 *
 * Writes analysis.json next to the capture and prints a plain-text summary for the agent.
 *
 * Usage:
 *   node analyze.mjs --capture runs/<run>/cold [--config profile.config.json] [--project /abs/project] [--top 25]
 *   (run from `.agents/profile/<slug>/data`; the config is found by walking up from the capture)
 */
import fs from "node:fs";
import path from "node:path";
import { createSymbolizer } from "./lib/symbolize.mjs";

/** Frame budget used for "slow frame" counts, in milliseconds (60 FPS). */
const FRAME_BUDGET_MS = 1000 / 60;
/** Width of the timeline buckets, in seconds. */
const BUCKET_SECONDS = 1;
/** Lines shown around a function in a code excerpt. */
const EXCERPT_LINES_BEFORE = 2;
const EXCERPT_LINES_AFTER = 28;
/**
 * Engine entry points that run a whole frame. Work beneath them belongs to the engine's frame (or to the deeper
 * code of yours that it calls back — component updates, observers), not to the render-loop callback that started it.
 */
const FRAME_DRIVERS = /^(Scene\.render|Scene\._renderFrame|AbstractEngine\._renderLoop|AbstractEngine\._processFrame|AbstractEngine\._renderFrame|(Abstract)?Engine\.runRenderLoop|.*_boundRenderFunction)$/;
/** Time before the first phase mark shorter than this joins the first phase (ms). */
const MIN_LEAD_IN_PHASE_MS = 1500;
/** Inclusive entries above this share of busy time are frame shells (render loop wrappers), not causes. */
const SHELL_PCT = 75;

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

/** Rounds to the given number of decimals. */
const round = (value, decimals = 1) => (value == null || Number.isNaN(value) ? null : +value.toFixed(decimals));

/** Percentile of an already sorted array. */
const percentile = (sorted, fraction) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);

/**
 * Loads the slug's config (`.agents/profile/<slug>/data/profile.config.json`, the nearest one above the capture).
 * @returns {{projectRoot: string, owners: object[]}} the config with an absolute project root
 */
function loadConfig(flags, captureDir) {
    const configPath = flags.config ? path.resolve(flags.config) : findUp(captureDir, "profile.config.json");
    const config = configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const configDir = configPath ? path.dirname(configPath) : captureDir;
    const projectRoot = flags.project ? path.resolve(flags.project)
        : config.projectRoot ? path.resolve(configDir, config.projectRoot) : projectRootAbove(configDir);
    return { ...config, projectRoot, owners: config.owners || [], configPath };
}

/** The project that holds a folder inside its `.agents/`: the parent of the nearest `.agents` above it (else the folder). */
function projectRootAbove(dir) {
    for (let current = path.resolve(dir); path.dirname(current) !== current; current = path.dirname(current)) {
        if (path.basename(current) === ".agents") return path.dirname(current);
    }
    return path.resolve(dir);
}

/** Walks up from a folder looking for a relative path; returns the first match or null. */
function findUp(startDir, relative) {
    let directory = startDir;
    for (;;) {
        const candidate = path.join(directory, relative);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

/**
 * Prepares the CPU profile: parent links, each sample's epoch time (synced to the page clock through the sync
 * marker) and duration.
 * @returns {{byId: Map, sampleNodes: number[], sampleTimes: Float64Array, sampleWeights: Float64Array}}
 */
function prepareProfile(profile, sync) {
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    for (const node of profile.nodes) for (const child of node.children || []) byId.get(child).parent = node.id;
    const count = profile.samples.length;
    const timestampsUs = new Float64Array(count);
    let time = profile.startTime;
    for (let i = 0; i < count; i++) { time += profile.timeDeltas[i] || 0; timestampsUs[i] = time; }
    const markerIds = new Set(profile.nodes.filter((node) => node.callFrame.functionName === sync.markerName).map((node) => node.id));
    let offsetMs = null;
    for (let i = 0; i < count; i++) {
        if (markerIds.has(profile.samples[i])) { offsetMs = sync.epochMs - timestampsUs[i] / 1000; break; }
    }
    if (offsetMs == null) offsetMs = sync.epochMs - profile.startTime / 1000;
    const sampleTimes = new Float64Array(count);
    const sampleWeights = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        sampleTimes[i] = timestampsUs[i] / 1000 + offsetMs;
        const nextUs = i + 1 < count ? timestampsUs[i + 1] : timestampsUs[i];
        sampleWeights[i] = Math.max(0, (nextUs - timestampsUs[i]) / 1000);
    }
    return { byId, sampleNodes: profile.samples, sampleTimes, sampleWeights, markerIds, offsetMs };
}

/**
 * Precomputes, for every profile node: its symbol, its effective owner (browser API calls take their caller's
 * owner), the unique function keys on its stack (for inclusive time), the nearest of YOUR frames on its stack
 * ("who is responsible"), and the first non-yours frame called from it ("what it spent the time in").
 */
function annotateNodes(prepared, symbolizer) {
    const { byId } = prepared;
    const info = new Map();
    const visit = (id) => {
        if (info.has(id)) return info.get(id);
        const node = byId.get(id);
        const symbol = symbolizer.frame(node.callFrame);
        const parentInfo = node.parent != null ? visit(node.parent) : null;
        let owner = symbol.owner;
        if (owner === "native" && parentInfo && !["root", "idle", "program", "gc"].includes(parentInfo.owner)) owner = parentInfo.owner;
        const stackKeys = parentInfo ? parentInfo.stackKeys : new Set();
        let keys = stackKeys;
        if (!["root", "idle"].includes(symbol.special) && !stackKeys.has(symbol.key)) { keys = new Set(stackKeys); keys.add(symbol.key); }
        const isYours = symbolizer.yours.has(symbol.owner);
        const isFrameDriver = !isYours && FRAME_DRIVERS.test(symbol.name);
        const inherited = parentInfo ? parentInfo.responsible : null;
        const responsible = isYours ? symbol : isFrameDriver ? null : inherited;
        // The library entry point your code called: the first non-yours frame below your nearest frame.
        let calledInto = null;
        if (!isYours && !isFrameDriver && parentInfo) calledInto = parentInfo.isYours ? symbol : parentInfo.calledInto;
        // Where this owner's code was entered from: the nearest caller that belongs to a different owner.
        const crossing = !parentInfo || parentInfo.owner === "root" ? null : parentInfo.owner === owner ? parentInfo.crossing : parentInfo.symbol;
        const entry = {
            symbol, owner, stackKeys: keys, isYours, responsible, calledInto, crossing, parent: parentInfo ? parentInfo.symbol : null,
            positionTicks: node.positionTicks || null, scriptId: node.callFrame.scriptId, url: node.callFrame.url,
        };
        info.set(id, entry);
        return entry;
    };
    for (const id of byId.keys()) visit(id);
    return info;
}

/**
 * Aggregates the samples that fall inside [from, to) epoch ms.
 * @returns {object} self / inclusive time per function, time per owner, responsible-function time, totals
 */
function aggregateWindow(prepared, info, from, to) {
    const self = new Map();
    const inclusive = new Map();
    const owners = new Map();
    const responsible = new Map();
    const symbols = new Map();
    const selfDetail = new Map();
    let totalMs = 0;
    let idleMs = 0;
    const { sampleNodes, sampleTimes, sampleWeights, markerIds } = prepared;
    for (let i = 0; i < sampleNodes.length; i++) {
        const time = sampleTimes[i];
        if (time < from || time >= to) continue;
        const nodeId = sampleNodes[i];
        if (markerIds.has(nodeId)) continue;
        const weight = sampleWeights[i];
        const entry = info.get(nodeId);
        totalMs += weight;
        if (entry.owner === "idle") { idleMs += weight; continue; }
        if (entry.owner === "root") continue;
        owners.set(entry.owner, (owners.get(entry.owner) || 0) + weight);
        const key = entry.symbol.key;
        symbols.set(key, entry.symbol);
        self.set(key, (self.get(key) || 0) + weight);
        const detail = selfDetail.get(key) || { parents: new Map(), crossings: new Map(), yours: new Map() };
        const tally = (map, symbol) => { if (symbol) map.set(symbol.name, (map.get(symbol.name) || 0) + weight); };
        tally(detail.parents, entry.parent);
        tally(detail.crossings, entry.crossing);
        tally(detail.yours, entry.responsible);
        selfDetail.set(key, detail);
        for (const stackKey of entry.stackKeys) inclusive.set(stackKey, (inclusive.get(stackKey) || 0) + weight);
        if (entry.responsible) {
            const blame = responsible.get(entry.responsible.key) || { symbol: entry.responsible, totalMs: 0, selfMs: 0, callees: new Map(), owners: new Map() };
            blame.totalMs += weight;
            if (entry.isYours) blame.selfMs += weight;
            else {
                const callee = entry.calledInto || entry.symbol;
                const calleeEntry = blame.callees.get(callee.key) || { symbol: callee, ms: 0 };
                calleeEntry.ms += weight;
                blame.callees.set(callee.key, calleeEntry);
                blame.owners.set(entry.owner, (blame.owners.get(entry.owner) || 0) + weight);
            }
            responsible.set(entry.responsible.key, blame);
            symbols.set(entry.responsible.key, entry.responsible);
        }
    }
    for (const [id, entry] of info) for (const key of entry.stackKeys) if (!symbols.has(key) && inclusive.has(key)) symbols.set(key, entry.symbol.key === key ? entry.symbol : symbols.get(key));
    return { self, inclusive, owners, responsible, symbols, selfDetail, totalMs, idleMs, busyMs: totalMs - idleMs };
}

/** Summarizes the probe's frames inside a window. */
function frameStats(frames, from, to) {
    const inside = frames.filter((frame) => frame.at >= from && frame.at < to);
    if (inside.length < 2) return { frames: inside.length, fps: inside.length ? null : 0 };
    const intervals = [];
    for (let i = 1; i < inside.length; i++) intervals.push(inside[i].at - inside[i - 1].at);
    const sortedIntervals = [...intervals].sort((first, second) => first - second);
    const cpu = inside.map((frame) => frame.cpuMs).sort((first, second) => first - second);
    const seconds = (inside[inside.length - 1].at - inside[0].at) / 1000;
    const mean = (key) => {
        const values = inside.map((frame) => frame[key]).filter((value) => typeof value === "number");
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return {
        frames: inside.length,
        fps: round((inside.length - 1) / Math.max(seconds, 1e-3)),
        intervalP50Ms: round(percentile(sortedIntervals, 0.5)),
        intervalP95Ms: round(percentile(sortedIntervals, 0.95)),
        worstIntervalMs: round(sortedIntervals[sortedIntervals.length - 1]),
        slowFrames: intervals.filter((interval) => interval > FRAME_BUDGET_MS * 1.5).length,
        cpuMeanMs: round(cpu.reduce((sum, value) => sum + value, 0) / cpu.length, 2),
        cpuP95Ms: round(percentile(cpu, 0.95), 2),
        draws: round(mean("draws"), 0),
        activeMeshes: round(mean("activeMeshes"), 0),
        particles: round(mean("particles"), 0),
        renderMs: round(mean("renderMs"), 2),
        targetsMs: round(mean("targetsMs"), 2),
        evaluateMs: round(mean("evaluateMs"), 2),
        animationsMs: round(mean("animationsMs"), 2),
        physicsMs: round(mean("physicsMs"), 2),
        particlesMs: round(mean("particlesMs"), 2),
    };
}

/** Converts a window aggregate into sorted, serializable top lists. */
function topLists(aggregate, frames, top, labels) {
    const perFrame = (ms) => (frames > 0 ? round(ms / frames, 3) : null);
    const pct = (ms) => round((ms / Math.max(aggregate.busyMs, 1e-6)) * 100, 1);
    const describe = (key, ms) => {
        const symbol = aggregate.symbols.get(key);
        return { key, name: symbol ? symbol.name : key, owner: symbol ? symbol.owner : "?", file: symbol ? symbol.file : null, line: symbol ? symbol.line : null, url: symbol ? symbol.url : "", ms: round(ms), msPerFrame: perFrame(ms), pctBusy: pct(ms) };
    };
    const topOf = (map, count) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => ({ name, ms: round(ms) }));
    const selfTop = [...aggregate.self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, ms]) => {
        const detail = aggregate.selfDetail.get(key);
        return { ...describe(key, ms), callers: detail ? topOf(detail.parents, 3) : [], enteredFrom: detail ? topOf(detail.crossings, 3) : [], yours: detail ? topOf(detail.yours, 3) : [] };
    });
    const inclusiveTop = [...aggregate.inclusive].filter(([key]) => !["root", "program", "gc", "idle"].includes(key)).sort((a, b) => b[1] - a[1]).slice(0, top * 2)
        .map(([key, ms]) => ({ ...describe(key, ms), selfMs: round(aggregate.self.get(key) || 0) }))
        .map((entry) => ({ ...entry, shell: entry.pctBusy >= SHELL_PCT }));
    const yoursTop = [...aggregate.responsible.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, top).map((blame) => ({
        key: blame.symbol.key, name: blame.symbol.name, owner: blame.symbol.owner, file: blame.symbol.file, line: blame.symbol.line,
        ms: round(blame.totalMs), msPerFrame: perFrame(blame.totalMs), pctBusy: pct(blame.totalMs), ownCodeMs: round(blame.selfMs),
        triggered: [...blame.owners].sort((a, b) => b[1] - a[1]).map(([owner, ms]) => ({ owner, label: labels[owner] || owner, ms: round(ms) })),
        callees: [...blame.callees.values()].sort((a, b) => b.ms - a.ms).slice(0, 6).map((callee) => ({ name: callee.symbol.name, owner: callee.symbol.owner, file: callee.symbol.file, line: callee.symbol.line, ms: round(callee.ms) })),
    }));
    const owners = [...aggregate.owners].sort((a, b) => b[1] - a[1]).map(([owner, ms]) => ({ owner, label: labels[owner] || owner, ms: round(ms), pctBusy: pct(ms), msPerFrame: perFrame(ms) }));
    const yoursMs = [...aggregate.responsible.values()].reduce((sum, blame) => sum + blame.totalMs, 0);
    return { selfTop, inclusiveTop, yoursTop, owners, busyMs: round(aggregate.busyMs), idleMs: round(aggregate.idleMs), yoursMs: round(yoursMs), yoursPct: pct(yoursMs) };
}

/** Builds the scenario phases from the probe's marks (each runs until the next mark). */
function buildPhases(marks, startMs, endMs) {
    const sorted = [...marks].sort((a, b) => a.at - b.at).filter((mark) => mark.name !== "end");
    const phases = [];
    // Time before the first mark only becomes its own phase when it is long enough to matter; otherwise it belongs
    // to the first phase, so runs whose first mark lands a little later still compare phase by phase.
    const leadIn = sorted.length ? sorted[0].at - startMs : endMs - startMs;
    if (sorted.length === 0 || leadIn > MIN_LEAD_IN_PHASE_MS) phases.push({ name: "start", from: startMs, to: sorted.length ? sorted[0].at : endMs });
    sorted.forEach((mark, index) => phases.push({ name: mark.name, from: index === 0 && leadIn <= MIN_LEAD_IN_PHASE_MS ? startMs : mark.at, to: index + 1 < sorted.length ? sorted[index + 1].at : endMs }));
    return phases.filter((phase) => phase.to > phase.from);
}

/**
 * Reads the allocation profiles of a capture: one per phase (heap/<index>-<phase>.heapprofile) or a single
 * heap.heapprofile from older captures.
 * @returns {{phase: string, profile: object}[]} the profiles in phase order
 */
function loadHeapProfiles(captureDir) {
    const heapDir = path.join(captureDir, "heap");
    if (fs.existsSync(heapDir)) {
        return fs.readdirSync(heapDir).filter((name) => name.endsWith(".heapprofile")).sort().map((name) => ({
            phase: name.replace(/^\d+-/, "").replace(/\.heapprofile$/, ""),
            profile: JSON.parse(fs.readFileSync(path.join(heapDir, name), "utf8")),
        }));
    }
    const single = path.join(captureDir, "heap.heapprofile");
    return fs.existsSync(single) ? [{ phase: "all", profile: JSON.parse(fs.readFileSync(single, "utf8")) }] : [];
}

/**
 * Aggregates allocation profiles per function and per responsible function of yours. Sample sizes are already
 * scaled by the sampler, so their sum estimates the bytes allocated (collected objects included when supported).
 */
function analyzeHeap(heapProfiles, symbolizer, seconds, top) {
    if (!heapProfiles || heapProfiles.length === 0) return null;
    const self = new Map();
    const responsible = new Map();
    const symbols = new Map();
    let total = 0;
    for (const heapProfile of heapProfiles) {
        const bytesByNode = new Map();
        if (heapProfile.samples && heapProfile.samples.length) {
            for (const sample of heapProfile.samples) bytesByNode.set(sample.nodeId, (bytesByNode.get(sample.nodeId) || 0) + sample.size);
        }
        const walk = (node, responsibleSymbol) => {
            const symbol = symbolizer.frame(node.callFrame);
            const isYours = symbolizer.yours.has(symbol.owner);
            const mine = isYours ? symbol : FRAME_DRIVERS.test(symbol.name) ? null : responsibleSymbol;
            const bytes = bytesByNode.size ? bytesByNode.get(node.id) || 0 : node.selfSize || 0;
            if (bytes > 0 && symbol.special !== "root") {
                total += bytes;
                self.set(symbol.key, (self.get(symbol.key) || 0) + bytes);
                symbols.set(symbol.key, symbol);
                if (mine) { responsible.set(mine.key, (responsible.get(mine.key) || 0) + bytes); symbols.set(mine.key, mine); }
            }
            for (const child of node.children || []) walk(child, mine);
        };
        walk(heapProfile.head, null);
    }
    const wallSeconds = seconds;
    const describe = ([key, bytes]) => {
        const symbol = symbols.get(key);
        return { name: symbol.name, owner: symbol.owner, file: symbol.file, line: symbol.line, mb: round(bytes / 1048576, 2), mbPerSecond: round(bytes / 1048576 / Math.max(wallSeconds, 1), 2) };
    };
    return {
        totalMb: round(total / 1048576, 1),
        mbPerSecond: round(total / 1048576 / Math.max(wallSeconds, 1), 2),
        selfTop: [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(describe),
        yoursTop: [...responsible].sort((a, b) => b[1] - a[1]).slice(0, top).map(describe),
    };
}

/** Line-level self time inside your functions, from the profile's position ticks. */
function hotLines(prepared, info, symbolizer, top) {
    const lines = new Map();
    const totalByNode = new Map();
    for (let i = 0; i < prepared.sampleNodes.length; i++) totalByNode.set(prepared.sampleNodes[i], (totalByNode.get(prepared.sampleNodes[i]) || 0) + prepared.sampleWeights[i]);
    for (const [nodeId, entry] of info) {
        if (!entry.isYours || !entry.positionTicks) continue;
        const nodeMs = totalByNode.get(nodeId) || 0;
        const ticks = entry.positionTicks.reduce((sum, tick) => sum + tick.ticks, 0);
        if (ticks === 0 || nodeMs === 0) continue;
        for (const tick of entry.positionTicks) {
            const location = symbolizer.line(entry.scriptId, entry.url, tick.line);
            const key = `${location.file}:${location.line}`;
            const current = lines.get(key) || { file: location.file, line: location.line, function: entry.symbol.name, owner: entry.symbol.owner, ms: 0 };
            current.ms += (nodeMs * tick.ticks) / ticks;
            lines.set(key, current);
        }
    }
    return [...lines.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map((entry) => ({ ...entry, ms: round(entry.ms) }));
}

/** Reads a few lines of source around a function, marking the hot lines. */
function excerpt(symbolizer, file, line, hot) {
    if (!file || !line) return null;
    const text = symbolizer.readFile(file);
    if (!text) return null;
    const lines = text.split("\n");
    const from = Math.max(1, line - EXCERPT_LINES_BEFORE);
    const to = Math.min(lines.length, line + EXCERPT_LINES_AFTER);
    const hotSet = new Map((hot || []).filter((entry) => entry.file === file).map((entry) => [entry.line, entry.ms]));
    const rows = [];
    for (let number = from; number <= to; number++) rows.push({ number, text: lines[number - 1].replace(/\t/g, "    ").slice(0, 220), hotMs: hotSet.get(number) || null });
    return { file, from, to, rows };
}

/** The worst frames of the run, each with the functions and owners that filled it. */
function worstFrames(frames, prepared, info, phases, top) {
    const candidates = frames.map((frame, index) => ({ ...frame, intervalMs: index > 0 ? frame.at - frames[index - 1].at : null }));
    const worst = [...candidates].sort((a, b) => b.cpuMs - a.cpuMs).slice(0, top);
    return worst.map((frame) => {
        const aggregate = aggregateWindow(prepared, info, frame.at, frame.at + frame.cpuMs);
        const phase = phases.find((candidate) => frame.at >= candidate.from && frame.at < candidate.to);
        return {
            at: frame.at, cpuMs: round(frame.cpuMs), intervalMs: round(frame.intervalMs), phase: phase ? phase.name : null,
            draws: frame.draws, particles: frame.particles,
            top: [...aggregate.self].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, ms]) => ({ name: aggregate.symbols.get(key).name, owner: aggregate.symbols.get(key).owner, ms: round(ms) })),
            yours: [...aggregate.responsible.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 3).map((blame) => ({ name: blame.symbol.name, file: blame.symbol.file, line: blame.symbol.line, ms: round(blame.totalMs) })),
            owners: [...aggregate.owners].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([owner, ms]) => ({ owner, ms: round(ms) })),
        };
    });
}

/** One entry per timeline bucket: frame rate, CPU work, busy time per owner, new shader programs, top function. */
function buildTimeline(prepared, info, frames, counters, startMs, endMs) {
    const buckets = [];
    for (let from = startMs; from < endMs; from += BUCKET_SECONDS * 1000) {
        const to = Math.min(endMs, from + BUCKET_SECONDS * 1000);
        const aggregate = aggregateWindow(prepared, info, from, to);
        const stats = frameStats(frames, from, to);
        const counterInside = counters.filter((counter) => counter.at >= from && counter.at < to);
        const counterBefore = counters.filter((counter) => counter.at < from).pop();
        const lastCounter = counterInside[counterInside.length - 1] || counterBefore || {};
        const firstCompiled = (counterBefore && counterBefore.compiledEffects) ?? (counterInside[0] && counterInside[0].compiledEffects) ?? null;
        const topSelf = [...aggregate.self].sort((a, b) => b[1] - a[1])[0];
        const topYours = [...aggregate.responsible.values()].sort((a, b) => b.totalMs - a.totalMs)[0];
        buckets.push({
            t: round((from - startMs) / 1000, 1),
            fps: stats.fps ?? 0,
            frames: stats.frames,
            worstMs: stats.worstIntervalMs,
            cpuMeanMs: stats.cpuMeanMs ?? null,
            busyPct: round((aggregate.busyMs / Math.max(aggregate.totalMs, 1e-6)) * 100, 0),
            owners: Object.fromEntries([...aggregate.owners].map(([owner, ms]) => [owner, round(ms, 0)])),
            newShaders: lastCounter.compiledEffects != null && firstCompiled != null ? lastCounter.compiledEffects - firstCompiled : null,
            compiledEffects: lastCounter.compiledEffects ?? null,
            particles: stats.particles ?? null,
            draws: stats.draws ?? null,
            heapMb: lastCounter.heapMb ?? null,
            meshes: lastCounter.meshes ?? null,
            materials: lastCounter.materials ?? null,
            top: topSelf ? { name: aggregate.symbols.get(topSelf[0]).name, owner: aggregate.symbols.get(topSelf[0]).owner, ms: round(topSelf[1], 0) } : null,
            topYours: topYours ? { name: topYours.symbol.name, ms: round(topYours.totalMs, 0) } : null,
        });
    }
    return buckets;
}

/** Groups long-animation-frame script attributions by function. */
function summarizeLoafs(loafs, top) {
    const groups = new Map();
    for (const loaf of loafs || []) {
        for (const script of loaf.scripts || []) {
            const key = `${script.sourceFunction || script.invoker}|${(script.sourceUrl || "").replace(/\?.*$/, "")}`;
            const group = groups.get(key) || { function: script.sourceFunction || script.invoker, url: (script.sourceUrl || "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, ""), invokerType: script.invokerType, count: 0, ms: 0 };
            group.count++;
            group.ms += script.durationMs;
            groups.set(key, group);
        }
    }
    return { longFrames: (loafs || []).length, scripts: [...groups.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map((group) => ({ ...group, ms: round(group.ms) })) };
}

/** Plain-language signals the agent should look at first. They point; the agent diagnoses. */
function signals(analysis) {
    const notes = [];
    const overall = analysis.overall.lists;
    const ownerPct = (owner) => (overall.owners.find((entry) => entry.owner === owner) || { pctBusy: 0 }).pctBusy;
    if (ownerPct("gc") >= 5) notes.push(`Garbage collection takes ${ownerPct("gc")}% of busy time — look at the allocation list (heap.yoursTop) for per-frame garbage.`);
    if (ownerPct("shader") >= 5) notes.push(`GLSL → WGSL shader translation takes ${ownerPct("shader")}% of busy time — new material / particle shader variants are being compiled on the main thread.`);
    for (const phase of analysis.phases) {
        if (phase.frames.fps != null && phase.frames.fps < 45 && phase.durationSeconds >= 1) {
            const lead = phase.lists.inclusiveTop.find((entry) => !entry.shell && entry.owner !== "program");
            notes.push(`Phase "${phase.name}" runs at ${phase.frames.fps} FPS (CPU ${phase.frames.cpuMeanMs} ms/frame, main thread ${phase.busyPct}% busy)${phase.lists.yoursTop[0] ? `; your heaviest code: ${phase.lists.yoursTop[0].name} (${phase.lists.yoursTop[0].msPerFrame} ms/frame)` : ""}${lead ? `; heaviest stack entry: ${lead.name}` : ""}.`);
        }
    }
    const shaderBuckets = analysis.timeline.filter((bucket) => bucket.newShaders > 0);
    if (shaderBuckets.length) {
        const late = shaderBuckets.filter((bucket) => bucket.t > 0.6 * analysis.timeline.length);
        notes.push(`${shaderBuckets.reduce((sum, bucket) => sum + bucket.newShaders, 0)} new shader programs / pipelines were created during the run${late.length ? `, ${late.reduce((sum, bucket) => sum + bucket.newShaders, 0)} of them late (after 60% of the run)` : ""}.`);
    }
    return notes;
}

/**
 * Breaks a function's time into what it calls: for every sample under a frame named `name` (outermost occurrence),
 * the time goes to the frame directly below it ("(self)" when the sample is in the function itself).
 * @returns {{totalMs: number, callees: {name: string, owner: string, ms: number}[]}} the breakdown inside the window
 */
function drillDown(prepared, info, byId, name, from, to, top) {
    const callees = new Map();
    let totalMs = 0;
    const { sampleNodes, sampleTimes, sampleWeights } = prepared;
    for (let i = 0; i < sampleNodes.length; i++) {
        if (sampleTimes[i] < from || sampleTimes[i] >= to) continue;
        let calleeOfOutermost;
        let below = null;
        for (let nodeId = sampleNodes[i]; nodeId != null; nodeId = byId.get(nodeId).parent) {
            const symbol = info.get(nodeId).symbol;
            if (symbol.name === name) calleeOfOutermost = below;
            below = symbol;
        }
        if (calleeOfOutermost === undefined) continue;
        totalMs += sampleWeights[i];
        const key = calleeOfOutermost ? calleeOfOutermost.name : "(self)";
        const current = callees.get(key) || { name: key, owner: calleeOfOutermost ? calleeOfOutermost.owner : "", ms: 0 };
        current.ms += sampleWeights[i];
        callees.set(key, current);
    }
    return { totalMs: round(totalMs), callees: [...callees.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map((entry) => ({ ...entry, ms: round(entry.ms) })) };
}

/**
 * Who calls a function: for every sample under a frame named `name` (outermost occurrence), the time goes to that
 * occurrence's direct caller, and separately to the nearest caller from a different owner (where the work was asked for).
 * @returns {{totalMs: number, callers: object[], from: object[]}} the breakdown inside the window
 */
function callersOf(prepared, info, byId, name, from, to, top) {
    const direct = new Map();
    const crossing = new Map();
    let totalMs = 0;
    const { sampleNodes, sampleTimes, sampleWeights } = prepared;
    const tally = (map, symbol, weight) => {
        const key = symbol ? symbol.name : "(root)";
        const current = map.get(key) || { name: key, owner: symbol ? symbol.owner : "", file: symbol ? symbol.file : null, line: symbol ? symbol.line : null, ms: 0 };
        current.ms += weight;
        map.set(key, current);
    };
    for (let i = 0; i < sampleNodes.length; i++) {
        if (sampleTimes[i] < from || sampleTimes[i] >= to) continue;
        let outermost = null;
        for (let nodeId = sampleNodes[i]; nodeId != null; nodeId = byId.get(nodeId).parent) if (info.get(nodeId).symbol.name === name) outermost = nodeId;
        if (outermost == null) continue;
        const weight = sampleWeights[i];
        totalMs += weight;
        const ownOwner = info.get(outermost).owner;
        const parentId = byId.get(outermost).parent;
        tally(direct, parentId != null ? info.get(parentId).symbol : null, weight);
        let crossingSymbol = null;
        for (let nodeId = parentId; nodeId != null; nodeId = byId.get(nodeId).parent) {
            const entry = info.get(nodeId);
            if (entry.owner !== ownOwner && !["native", "root"].includes(entry.owner)) { crossingSymbol = entry.symbol; break; }
        }
        tally(crossing, crossingSymbol, weight);
    }
    const sorted = (map) => [...map.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map((entry) => ({ ...entry, ms: round(entry.ms) }));
    return { totalMs: round(totalMs), callers: sorted(direct), from: sorted(crossing) };
}

/** Prints the summary the agent reads. */
function printSummary(analysis) {
    const out = [];
    const line = (text = "") => out.push(text);
    line(`bt-profile analysis — ${analysis.capture.label} capture of ${analysis.capture.url} (${analysis.capture.engine}, scenario ${analysis.capture.scenario})`);
    if (analysis.capture.disturbed) line(`WARNING: the game restarted under this capture — ${analysis.capture.disturbed.reason}. Not comparable: re-capture on a server with file watching off.`);
    line(`Wall ${analysis.capture.wallSeconds}s · main thread busy ${analysis.overall.busyPct}% · your code (incl. what it triggers) ${analysis.overall.lists.yoursPct}% of busy time · heap ${analysis.heap ? analysis.heap.mbPerSecond + " MB/s allocated" : "n/a"}`);
    line();
    line("PHASES");
    for (const phase of analysis.phases) {
        line(`  ${phase.name.padEnd(14)} ${String(phase.durationSeconds + "s").padStart(6)}  ${String(phase.frames.fps ?? "-").padStart(5)} fps  p95 ${String(phase.frames.intervalP95Ms ?? "-").padStart(6)} ms  cpu ${String(phase.frames.cpuMeanMs ?? "-").padStart(6)} ms/frame  busy ${String(phase.busyPct).padStart(3)}%  particles ${phase.frames.particles ?? "-"}  draws ${phase.frames.draws ?? "-"}`);
        line(`      owners: ${phase.lists.owners.slice(0, 6).map((entry) => `${entry.owner} ${entry.pctBusy}%`).join(" · ")}`);
        line(`      yours:  ${phase.lists.yoursTop.slice(0, 3).map((entry) => `${entry.name} ${entry.msPerFrame}ms/f`).join(" · ") || "-"}`);
        if (phase.heap) line(`      alloc:  ${phase.heap.mbPerSecond} MB/s · ${phase.heap.selfTop.slice(0, 3).map((entry) => `${entry.name} ${entry.mbPerSecond}MB/s`).join(" · ")}`);
        line(`      hot:    ${phase.lists.inclusiveTop.filter((entry) => entry.owner !== "program" && !entry.shell).slice(0, 5).map((entry) => `${entry.name} ${entry.pctBusy}%`).join(" · ")}`);
    }
    line();
    line("YOUR CODE — time spent, including the library work it triggers (whole run)");
    for (const entry of analysis.overall.lists.yoursTop.slice(0, 15)) {
        line(`  ${String(entry.ms).padStart(8)} ms  ${String(entry.pctBusy).padStart(5)}%  ${entry.name}  ${shortFile(entry.file)}:${entry.line}  [own ${entry.ownCodeMs} ms; ${entry.callees.slice(0, 3).map((callee) => `${callee.name} ${callee.ms}`).join(", ")}]`);
    }
    line();
    line("HEAVIEST FUNCTIONS — self time (whole run)");
    for (const entry of analysis.overall.lists.selfTop.slice(0, 15)) {
        line(`  ${String(entry.ms).padStart(8)} ms  ${String(entry.pctBusy).padStart(5)}%  [${entry.owner}] ${entry.name}  ${shortFile(entry.file) || entry.url}:${entry.line ?? ""}`);
        line(`               called by: ${entry.callers.map((caller) => `${caller.name} ${caller.ms}`).join(", ")}${entry.yours.length ? ` · yours: ${entry.yours.map((owner) => `${owner.name} ${owner.ms}`).join(", ")}` : ""}`);
    }
    line();
    line("HEAVIEST SUBTREES — inclusive time, frame shells removed (whole run)");
    for (const entry of analysis.overall.lists.inclusiveTop.filter((candidate) => !candidate.shell).slice(0, 20)) line(`  ${String(entry.ms).padStart(8)} ms  ${String(entry.pctBusy).padStart(5)}%  [${entry.owner}] ${entry.name}  (self ${entry.selfMs})`);
    if (analysis.heap) {
        line();
        line(`ALLOCATIONS — ${analysis.heap.totalMb} MB sampled (${analysis.heap.mbPerSecond} MB/s); top responsible of yours:`);
        for (const entry of analysis.heap.yoursTop.slice(0, 8)) line(`  ${String(entry.mb).padStart(8)} MB  ${entry.name}  ${shortFile(entry.file)}:${entry.line}`);
    }
    line();
    line("SIGNALS");
    for (const note of analysis.signals) line(`  - ${note}`);
    process.stdout.write(out.join("\n") + "\n");
}

/** Shortens an absolute path for printing. */
function shortFile(file) {
    if (!file) return "";
    return file.replace(/^.*\/node_modules\//, "node_modules/").replace(/^\/Users\/[^/]+\//, "~/");
}

/** Entry point. */
function main() {
    const flags = parseArguments(process.argv.slice(2));
    if (!flags.capture) throw new Error("Pass --capture <run>/cold (a folder written by profile.mjs)");
    const captureDir = path.resolve(flags.capture);
    const top = Number(flags.top || 25);
    const config = loadConfig(flags, captureDir);
    const capture = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8"));
    const profile = JSON.parse(fs.readFileSync(path.join(captureDir, "cpu.cpuprofile"), "utf8"));
    const heapProfiles = loadHeapProfiles(captureDir);
    const symbolizer = createSymbolizer({ scriptsDir: path.join(captureDir, "scripts"), projectRoot: config.projectRoot, owners: config.owners });

    const prepared = prepareProfile(profile, capture.sync);
    const info = annotateNodes(prepared, symbolizer);
    const probe = capture.probe || { frames: [], counters: [], marks: [], loafs: [] };
    const startMs = capture.sync.epochMs;
    const endMark = probe.marks.find((mark) => mark.name === "end");
    const endMs = endMark ? endMark.at : prepared.sampleTimes[prepared.sampleTimes.length - 1];
    const frames = probe.frames;
    const phases = buildPhases(probe.marks, startMs, endMs);

    const overallAggregate = aggregateWindow(prepared, info, startMs, endMs);
    const overallFrames = frameStats(frames, startMs, endMs);
    const overallLists = topLists(overallAggregate, overallFrames.frames, top, symbolizer.labels);
    const lines = hotLines(prepared, info, symbolizer, 40);

    const phaseResults = phases.map((phase) => {
        const aggregate = aggregateWindow(prepared, info, phase.from, phase.to);
        const stats = frameStats(frames, phase.from, phase.to);
        return {
            name: phase.name,
            startSeconds: round((phase.from - startMs) / 1000, 1),
            durationSeconds: round((phase.to - phase.from) / 1000, 1),
            busyPct: round((aggregate.busyMs / Math.max(aggregate.totalMs, 1e-6)) * 100, 0),
            frames: stats,
            lists: topLists(aggregate, stats.frames, Math.min(top, 15), symbolizer.labels),
        };
    });

    for (const phase of phaseResults) {
        const profiles = heapProfiles.filter((entry) => entry.phase === phase.name.replace(/[^\w+.-]+/g, "_")).map((entry) => entry.profile);
        phase.heap = profiles.length ? analyzeHeap(profiles, symbolizer, phase.durationSeconds, 8) : null;
    }

    const excerptsFor = new Map();
    const addExcerpt = (entry) => {
        if (!entry.file || !entry.line || excerptsFor.has(`${entry.file}:${entry.line}`)) return;
        const block = excerpt(symbolizer, entry.file, entry.line, lines);
        if (block) excerptsFor.set(`${entry.file}:${entry.line}`, { name: entry.name, owner: entry.owner, ...block });
    };
    overallLists.yoursTop.slice(0, 15).forEach(addExcerpt);
    for (const phase of phaseResults) phase.lists.yoursTop.slice(0, 5).forEach(addExcerpt);

    const analysis = {
        version: 1,
        capture: {
            dir: captureDir, label: capture.label, url: capture.url, engine: probe.engine, scenario: capture.scenario && capture.scenario.name,
            scenarioDescription: capture.scenario && capture.scenario.description, capturedAt: capture.capturedAt, browser: capture.browser, platform: capture.platform,
            viewport: capture.viewport, wallSeconds: round((endMs - startMs) / 1000, 1), samplingIntervalUs: capture.samplingIntervalUs,
            heapIncludesCollected: capture.heapIncludesCollected, scenarioError: capture.scenarioError, consoleErrors: capture.consoleErrors, census: capture.census,
            disturbed: capture.disturbed || null,
            clockOffsetMs: round(prepared.offsetMs, 3), startEpochMs: startMs,
        },
        ownerLabels: symbolizer.labels,
        yourOwners: [...symbolizer.yours],
        overall: { busyPct: round((overallAggregate.busyMs / Math.max(overallAggregate.totalMs, 1e-6)) * 100, 0), frames: overallFrames, lists: overallLists },
        phases: phaseResults,
        timeline: buildTimeline(prepared, info, frames, probe.counters, startMs, endMs),
        marks: probe.marks.map((mark) => ({ name: mark.name, t: round((mark.at - startMs) / 1000, 2) })),
        worstFrames: worstFrames(frames, prepared, info, phases, 15).map((frame) => ({ ...frame, t: round((frame.at - startMs) / 1000, 2) })),
        hotLines: lines,
        excerpts: [...excerptsFor.values()],
        heap: analyzeHeap(heapProfiles.map((entry) => entry.profile), symbolizer, (endMs - startMs) / 1000, top),
        loaf: summarizeLoafs(probe.loafs, 15),
        counters: probe.counters.map((counter) => ({ ...counter, t: round((counter.at - startMs) / 1000, 1) })),
        shots: fs.existsSync(path.join(captureDir, "shots")) ? fs.readdirSync(path.join(captureDir, "shots")).filter((name) => name.endsWith(".png")) : [],
        filmstrip: fs.existsSync(path.join(captureDir, "filmstrip.json")) ? JSON.parse(fs.readFileSync(path.join(captureDir, "filmstrip.json"), "utf8")).map((frame) => ({ ...frame, t: round((frame.at - startMs) / 1000, 2) })) : [],
    };
    analysis.signals = signals(analysis);
    if (flags.drill) {
        analysis.drill = flags.drill.split(",").map((name) => ({
            name,
            overall: drillDown(prepared, info, prepared.byId, name, startMs, endMs, 20),
            phases: phases.map((phase) => ({ phase: phase.name, ...drillDown(prepared, info, prepared.byId, name, phase.from, phase.to, 6) })),
        }));
    }
    const outFile = path.join(captureDir, "analysis.json");
    fs.writeFileSync(outFile, JSON.stringify(analysis));
    if (flags.callers) {
        analysis.callers = flags.callers.split(",").map((name) => ({
            name,
            overall: callersOf(prepared, info, prepared.byId, name, startMs, endMs, 15),
            phases: phases.map((phase) => ({ phase: phase.name, ...callersOf(prepared, info, prepared.byId, name, phase.from, phase.to, 4) })),
        }));
    }
    if (flags.quiet !== "true") printSummary(analysis);
    for (const entry of analysis.callers || []) {
        process.stdout.write(`\nCALLERS ${entry.name} — ${entry.overall.totalMs} ms over the run\n  direct:\n`);
        for (const caller of entry.overall.callers) process.stdout.write(`  ${String(caller.ms).padStart(9)} ms  [${caller.owner}] ${caller.name}  ${shortFile(caller.file)}${caller.line ? ":" + caller.line : ""}\n`);
        process.stdout.write("  asked for by (nearest other owner):\n");
        for (const caller of entry.overall.from) process.stdout.write(`  ${String(caller.ms).padStart(9)} ms  [${caller.owner}] ${caller.name}  ${shortFile(caller.file)}${caller.line ? ":" + caller.line : ""}\n`);
        for (const phase of entry.phases) if (phase.totalMs > 0) process.stdout.write(`  ${phase.phase.padEnd(12)} ${String(phase.totalMs).padStart(8)} ms · ${phase.from.slice(0, 3).map((caller) => `${caller.name} ${caller.ms}`).join(" · ")}\n`);
    }
    for (const drill of analysis.drill || []) {
        process.stdout.write(`\nDRILL ${drill.name} — ${drill.overall.totalMs} ms over the run\n`);
        for (const callee of drill.overall.callees) process.stdout.write(`  ${String(callee.ms).padStart(9)} ms  [${callee.owner}] ${callee.name}\n`);
        for (const phase of drill.phases) if (phase.totalMs > 0) process.stdout.write(`  ${phase.phase.padEnd(12)} ${String(phase.totalMs).padStart(8)} ms · ${phase.callees.slice(0, 4).map((callee) => `${callee.name} ${callee.ms}`).join(" · ")}\n`);
    }
    process.stderr.write(`wrote ${outFile}\n`);
}

main();
