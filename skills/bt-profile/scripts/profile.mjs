/**
 * bt-profile capture: opens a Babylon Toolkit web game in a real Chrome (GPU on, fresh profile = cold shader and HTTP
 * caches), runs a scenario (a small module that drives the game: open the page, wait for phases, hold keys, mark
 * phases, take screenshots), and records everything needed to name the code behind every slow frame:
 *
 * - a V8 sampling CPU profile of the whole scenario (`cpu.cpuprofile`, opens in DevTools too);
 * - a sampling allocation profile that includes collected objects (`heap.heapprofile`) — who feeds the GC;
 * - the in-page probe's per-frame CPU work, Babylon timers, scene counters, phase marks and long animation frames;
 * - the source text and source map of every script the profile hit (`scripts/`), so analysis can map minified or
 *   transformed positions back to original files offline;
 * - optional: a full DevTools performance trace (`--trace true`), and a second, warm load in the same browser
 *   (`--warm true`) to separate first-use costs (shader compiles, decoding) from steady per-frame work;
 * - optional (`--snapshots true`): the scenario's phase screenshots plus a filmstrip — about one small frame per
 *   second from Chrome's screencast, timed on the same clock as the frames. Off by default: a full-size screenshot
 *   stalls the game for a moment and would show up in the very profile it is meant to explain.
 *
 * Usage (from `.agents/profile/<slug>/data`, whose profile.config.json supplies the defaults for --url and --scenario):
 *   node ../../.tools/profile.mjs --out runs/baseline [--url http://localhost:5173/play] [--scenario scenario.mjs]
 *   [--seconds 150] [--dpr 2] [--width 1600] [--height 900] [--headed true] [--interval 250] [--warm true]
 *   [--trace true] [--uncapped true] [--heap false] [--snapshots true] [--filmstrip-interval 1] [--autoplay gesture] [--watch true]
 *   [--gpu-cold true] [--args key=value,key2=value2]
 *
 * `--gpu-cold true` makes every fragment shader unique to the load, so the GPU compiles every pipeline as on a first visit
 * (a fresh Chrome profile alone does not: macOS keeps compiled Metal pipelines in a system cache outside it).
 *
 * A scenario that fails or runs past --seconds still ends the capture: every step after it has a time limit, and the run
 * folder gets `shots/failed.png` plus the page's address, title and console errors in the log.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { installProbe, installGpuCold } from "./lib/probe.mjs";
import { findChrome } from "./lib/chrome.mjs";

/** Default sampling interval of the CPU profiler, in microseconds (DevTools uses 100–1000). */
const DEFAULT_SAMPLING_INTERVAL_US = 250;
/** Console lines a dev server's client prints when it hot-patches or reloads the page (Vite, webpack, Parcel, Next). */
const DEV_SERVER_UPDATE = /^\[vite\] (hot updated|page reload|.*full reload)|^\[HMR\]|^\[webpack-dev-server\].*(reload|updated)|^\[parcel\].*(updated|reload)|^\[Fast Refresh\]/i;
/** Allocation sampling interval, in bytes: one sample per this many bytes allocated, on average. */
const HEAP_SAMPLING_INTERVAL_BYTES = 32768;
/** Hard ceiling on one scenario run, in seconds, so a stuck scenario never hangs the capture. */
const DEFAULT_MAX_SECONDS = 240;
/** Name of the busy-wait function that ties CPU-profile timestamps to page epoch time. */
const SYNC_MARKER_NAME = "__btProfileSyncMarker";
/** How long the sync marker busy-waits, in milliseconds — long enough to be sampled many times. */
const SYNC_MARKER_MS = 4;
/** Trace categories DevTools' Performance panel records, so `trace.json` opens there with a flame chart. */
const TRACE_CATEGORIES = [
    "-*", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
    "v8.execute", "blink.user_timing", "loading", "latencyInfo", "disabled-by-default-v8.cpu_profiler", "v8", "gpu",
    "disabled-by-default-devtools.timeline.stack",
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

/**
 * Parses `key=value,key2=value2` into an object of strings, for scenario options.
 * @param {string|undefined} text - the raw `--args` value
 * @returns {Record<string, string>} the options
 */
function parseScenarioArguments(text) {
    const options = {};
    for (const pair of (text || "").split(",").filter(Boolean)) {
        const [key, ...rest] = pair.split("=");
        options[key.trim()] = rest.join("=").trim();
    }
    return options;
}

/** Pauses for the given number of seconds. */
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Waits for a DevTools call at most `seconds`. The browser has no per-call timeout (a scenario may wait minutes), so every
 * step after the scenario uses this: a stuck page must never keep the capture from finishing.
 * @returns {Promise<*>} the call's result, or `fallback` when it fails or takes too long
 */
async function limit(promise, seconds, fallback, log, what) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(limit.TIMED_OUT), seconds * 1000); });
    try {
        const result = await Promise.race([promise, timeout]);
        if (result === limit.TIMED_OUT) { log(`${what}: no answer within ${seconds} s — skipped`); return fallback; }
        return result;
    } catch (error) {
        log(`${what}: ${String(error && error.message ? error.message : error).split("\n")[0]}`);
        return fallback;
    } finally {
        clearTimeout(timer);
    }
}
limit.TIMED_OUT = Symbol("timed out");

/**
 * Runs the sync marker in the page: a named function that busy-waits a few milliseconds. Its first sample in the CPU
 * profile and the epoch time it returns pin the profile's clock to the page's clock.
 * @param {import("puppeteer-core").Page} page - the profiled page
 * @returns {Promise<number>} epoch milliseconds at which the marker started
 */
async function runSyncMarker(page) {
    return page.evaluate(`(function ${SYNC_MARKER_NAME}() {
        const startedAt = performance.timeOrigin + performance.now();
        const until = performance.now() + ${SYNC_MARKER_MS};
        let spins = 0;
        while (performance.now() < until) spins++;
        return startedAt;
    })()`);
}

/**
 * Loads the scenario module. A scenario exports `meta` ({ name, description }) and `async run(context)`.
 * @param {string|undefined} scenarioPath - path of the scenario module, or undefined for the built-in idle scenario
 * @returns {Promise<{meta: object, run: Function}>} the scenario
 */
async function loadScenario(scenarioPath) {
    if (!scenarioPath) {
        return {
            meta: { name: "idle", description: "Opens the URL and records for --idle seconds (default 60) after the first frame." },
            run: async (context) => {
                await context.open();
                await context.waitForFrames();
                context.mark("running");
                await context.sleep(Number(context.options.idle || 60));
            },
        };
    }
    const module = await import(pathToFileURL(path.resolve(scenarioPath)).href);
    if (typeof module.run !== "function") throw new Error(`Scenario ${scenarioPath} must export an async run(context) function.`);
    return { meta: module.meta || { name: path.basename(scenarioPath, path.extname(scenarioPath)) }, run: module.run };
}

/**
 * Says whether the game restarted under the capture without the scenario asking: a document load after the first
 * open() with no open() since the previous load, or the dev server hot-patching the page.
 * @returns {{reason: string, unexpectedNavigations: object[], devServerUpdates: object[], scenesSeen: number}|null}
 */
function disturbance(context, navigations, devServerUpdates, probe) {
    const opens = context.openTimes;
    const unexpectedNavigations = [];
    let previousLoad = opens.length ? opens[0] : Infinity;
    for (const navigation of navigations) {
        if (navigation.at < previousLoad) continue; // the start page, or the first load the scenario asked for
        if (!opens.some((at) => at >= previousLoad && at <= navigation.at)) unexpectedNavigations.push(navigation);
        previousLoad = navigation.at;
    }
    if (unexpectedNavigations.length === 0 && devServerUpdates.length === 0) return null;
    const parts = [];
    if (unexpectedNavigations.length) parts.push(`${unexpectedNavigations.length} page reload(s) the scenario did not ask for`);
    if (devServerUpdates.length) parts.push(`${devServerUpdates.length} dev-server update(s) (${devServerUpdates[0].text})`);
    return { reason: parts.join(", "), unexpectedNavigations, devServerUpdates: devServerUpdates.slice(0, 40), scenesSeen: probe ? probe.scenesSeen : null };
}

/**
 * Builds the object a scenario drives the game through.
 * @returns {object} the scenario context
 */
function createScenarioContext(page, targetUrl, shotsDir, options, log, snapshots, onMark) {
    const nodeMarks = [];
    const context = {
        nodeMarks,
        /** When the scenario asked for a navigation (a document load no open() asked for is a dev-server reload). */
        openTimes: [],
        page,
        options,
        url: targetUrl,
        log,
        sleep,
        /** Navigates to the target URL (or another URL / path on the same origin). */
        open: async (urlOrPath) => {
            const destination = urlOrPath ? new URL(urlOrPath, targetUrl).href : targetUrl;
            log(`open ${destination}`);
            context.openTimes.push(Date.now());
            await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 600000 });
        },
        /**
         * Says the next page load is the scenario's own doing (a click on a link or button that navigates), so the
         * capture does not report it as a dev-server reload. Call it just before the click.
         */
        expectNavigation: () => { context.openTimes.push(Date.now()); },
        /** Records a phase boundary in the page's clock. */
        mark: async (name) => {
            log(`mark ${name}`);
            // Kept on this side too: a mark sent while a navigation commits can miss the page's recorder.
            nodeMarks.push({ name, at: Date.now() });
            await page.evaluate((markName) => window.__btProfile && window.__btProfile.mark(markName), name);
            if (onMark) await onMark(name);
        },
        /** Waits until a page function returns truthy (polls every 100 ms). */
        waitFor: (pageFunction, { timeout = 600000, polling = 100, args = [] } = {}) =>
            page.waitForFunction(pageFunction, { timeout, polling }, ...args),
        /** Waits until the page has rendered at least `count` frames (Babylon frames on a Babylon page, else browser frames). */
        waitForFrames: (count = 10, timeout = 600000) =>
            // Babylon frames on a Babylon page; the browser's own frames on any other page
            page.waitForFunction((minimum) => window.__btProfile && (window.BABYLON ? window.__btProfile.frames.length : window.__btProfile.rafFrames.length) >= minimum, { timeout, polling: 100 }, count),
        evaluate: (pageFunction, ...args) => page.evaluate(pageFunction, ...args),
        keyDown: (key) => page.keyboard.down(key),
        keyUp: (key) => page.keyboard.up(key),
        press: (key) => page.keyboard.press(key),
        /** Saves a screenshot under shots/<name>.png — only with --snapshots true; otherwise a no-op returning null. */
        shot: async (name) => {
            if (!snapshots) return null;
            const file = path.join(shotsDir, `${name}.png`);
            await page.screenshot({ path: file });
            log(`shot ${path.basename(file)}`);
            return file;
        },
    };
    return context;
}

/**
 * Fetches a script's source map: inline `data:` URLs are decoded, anything else is fetched relative to the script.
 * @returns {Promise<string|null>} the source map JSON text, or null when there is none or it cannot be fetched
 */
async function fetchSourceMap(scriptUrl, sourceMapUrl) {
    if (!sourceMapUrl) return null;
    try {
        if (sourceMapUrl.startsWith("data:")) {
            const comma = sourceMapUrl.indexOf(",");
            const header = sourceMapUrl.slice(0, comma);
            const body = sourceMapUrl.slice(comma + 1);
            return header.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
        }
        const absolute = new URL(sourceMapUrl, scriptUrl).href;
        const response = await fetch(absolute);
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

/**
 * Saves the source and source map of every script the CPU profile sampled. Enabling the debugger after the profile
 * stops replays `scriptParsed` for every live script, so the profiled run itself never ran with the debugger on.
 * @returns {Promise<object[]>} the script index written to scripts/index.json
 */
async function saveProfiledScripts(session, profile, scriptsDir) {
    const sampledIds = new Set(profile.nodes.map((node) => node.callFrame.scriptId).filter((id) => id && id !== "0"));
    const parsed = new Map();
    session.on("Debugger.scriptParsed", (event) => parsed.set(event.scriptId, event));
    await session.send("Debugger.enable");
    await sleep(1);
    const index = [];
    for (const scriptId of sampledIds) {
        const info = parsed.get(scriptId);
        const entry = { scriptId, url: info ? info.url : "", sourceMapUrl: info ? info.sourceMapURL || "" : "", hasSource: false, hasMap: false };
        try {
            const { scriptSource } = await session.send("Debugger.getScriptSource", { scriptId });
            fs.writeFileSync(path.join(scriptsDir, `${scriptId}.js`), scriptSource);
            entry.hasSource = true;
            if (!entry.sourceMapUrl) {
                const inline = scriptSource.match(/\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/);
                if (inline) entry.sourceMapUrl = inline[1];
            }
        } catch {
            // Wasm modules and scripts from a navigated-away document have no retrievable source.
        }
        const mapText = entry.url ? await fetchSourceMap(entry.url, entry.sourceMapUrl) : null;
        if (mapText) {
            fs.writeFileSync(path.join(scriptsDir, `${scriptId}.map.json`), mapText);
            entry.hasMap = true;
        }
        index.push(entry);
    }
    await session.send("Debugger.disable");
    fs.writeFileSync(path.join(scriptsDir, "index.json"), JSON.stringify(index, null, 1));
    return index;
}

/**
 * Starts the allocation sampler, including objects the GC already collected, so short-lived per-frame garbage counts.
 * Older Chrome versions reject the include flags; the sampler then reports only objects still alive at the end.
 * @returns {Promise<boolean>} true when collected objects are included
 */
async function startHeapSampling(session) {
    await session.send("HeapProfiler.enable");
    try {
        await session.send("HeapProfiler.startSampling", {
            samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        return true;
    } catch {
        await session.send("HeapProfiler.startSampling", { samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES });
        return false;
    }
}

/**
 * Records a DevTools trace into trace.json (streamed, it can be large).
 * @returns {Promise<() => Promise<void>>} a function that stops the trace and writes the file
 */
async function startTrace(session, traceFile) {
    await session.send("Tracing.start", { traceConfig: { includedCategories: TRACE_CATEGORIES.filter((category) => category !== "-*"), excludedCategories: ["*"] }, transferMode: "ReturnAsStream" });
    return async () => {
        const complete = new Promise((resolve) => session.once("Tracing.tracingComplete", resolve));
        await session.send("Tracing.end");
        const { stream } = await complete;
        const output = fs.createWriteStream(traceFile);
        for (;;) {
            const chunk = await session.send("IO.read", { handle: stream });
            output.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
            if (chunk.eof) break;
        }
        await session.send("IO.close", { handle: stream });
        await new Promise((resolve) => output.end(resolve));
    };
}

/**
 * Records a filmstrip with Chrome's screencast: the compositor hands over frames it already produced, encoded off
 * the page's main thread, and every `intervalSeconds` one is kept as a small JPEG under filmstrip/.
 * @returns {Promise<() => Promise<object[]>>} a function that stops the screencast and returns [{ at, file }]
 */
async function startFilmstrip(session, runDir, intervalSeconds) {
    const filmstripDir = path.join(runDir, "filmstrip");
    fs.mkdirSync(filmstripDir, { recursive: true });
    const frames = [];
    let lastKeptAt = 0;
    const onFrame = (event) => {
        session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        const at = event.metadata.timestamp * 1000;
        if (at - lastKeptAt < intervalSeconds * 1000) return;
        lastKeptAt = at;
        const file = `${String(frames.length).padStart(4, "0")}.jpg`;
        fs.writeFileSync(path.join(filmstripDir, file), Buffer.from(event.data, "base64"));
        frames.push({ at, file: `filmstrip/${file}` });
    };
    session.on("Page.screencastFrame", onFrame);
    await session.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 480, maxHeight: 270, everyNthFrame: 4 });
    return async () => {
        await session.send("Page.stopScreencast").catch(() => {});
        session.off("Page.screencastFrame", onFrame);
        fs.writeFileSync(path.join(runDir, "filmstrip.json"), JSON.stringify(frames));
        return frames;
    };
}

/**
 * Runs the scenario once in a new page of the given browser and writes the whole capture into runDir.
 * @returns {Promise<object>} the capture summary (also written to capture.json)
 */
async function captureOnce(browser, flags, scenario, runDir, label) {
    const shotsDir = path.join(runDir, "shots");
    const scriptsDir = path.join(runDir, "scripts");
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    const log = (message) => process.stderr.write(`[bt-profile ${label} +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
    const startedAt = Date.now();
    const targetUrl = flags.url;
    const deviceScaleFactor = Number(flags.dpr || 2);
    const page = await browser.newPage();
    await page.setViewport({ width: Number(flags.width || 1600), height: Number(flags.height || 900), deviceScaleFactor });
    const consoleErrors = [];
    // A dev server that watches files reloads or hot-patches the game when anyone edits the project (another agent session,
    // an editor's save): the scene restarts mid-capture and the numbers are worthless. Both are recorded and flagged.
    const devServerUpdates = [];
    const navigations = [];
    page.on("console", (message) => {
        const text = message.text();
        if (DEV_SERVER_UPDATE.test(text)) devServerUpdates.push({ at: Date.now(), text: text.slice(0, 200) });
        if (message.type() === "error" || message.type() === "warning") consoleErrors.push({ type: message.type(), text: text.slice(0, 600) });
    });
    // Document loads only: a router's history.pushState / replaceState is a same-document "navigation" and is not a reload.
    page.on("domcontentloaded", () => navigations.push({ at: Date.now(), url: page.url() }));
    page.on("pageerror", (error) => consoleErrors.push({ type: "pageerror", text: String(error).slice(0, 600) }));
    // A document that fails to load (a bad response, a decoding error) shows a white page and no console line of its own.
    page.on("requestfailed", (request) => {
        if (request.resourceType() === "document" || request.resourceType() === "script") consoleErrors.push({ type: "requestfailed", text: `${request.resourceType()} ${request.url().slice(0, 300)} — ${request.failure() ? request.failure().errorText : "failed"}` });
    });
    if (flags["gpu-cold"] === "true") await page.evaluateOnNewDocument(installGpuCold);
    await page.evaluateOnNewDocument(installProbe);

    // Start on a same-origin document so the renderer process (and the V8 isolate the profiler is attached to)
    // stays the same when the scenario navigates to the game.
    const origin = new URL(targetUrl).origin;
    await page.goto(`${origin}/favicon.ico`, { waitUntil: "load" }).catch(() => page.goto("about:blank"));

    const session = await page.createCDPSession();
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: Number(flags.interval || DEFAULT_SAMPLING_INTERVAL_US) });
    const heapEnabled = flags.heap !== "false";
    const heapIncludesCollected = heapEnabled ? await startHeapSampling(session) : false;
    const stopTrace = flags.trace === "true" ? await startTrace(session, path.join(runDir, "trace.json")) : null;
    await session.send("Profiler.start");
    const syncEpochMs = await runSyncMarker(page);
    const snapshots = flags.snapshots === "true";
    const stopFilmstrip = snapshots ? await startFilmstrip(session, runDir, Number(flags["filmstrip-interval"] || 1)) : null;

    // The allocation sampler has no timestamps, so it is restarted at every phase mark: one profile per phase
    // (heap/<index>-<phase>.heapprofile) separates load-time buffers from per-frame garbage.
    const heapDir = path.join(runDir, "heap");
    if (heapEnabled) fs.mkdirSync(heapDir, { recursive: true });
    let heapPhase = "start";
    let heapIndex = 0;
    const rotateHeap = async (nextPhase) => {
        if (!heapEnabled) return;
        const { profile: phaseProfile } = await session.send("HeapProfiler.stopSampling");
        const safeName = heapPhase.replace(/[^\w+.-]+/g, "_");
        fs.writeFileSync(path.join(heapDir, `${String(heapIndex).padStart(2, "0")}-${safeName}.heapprofile`), JSON.stringify(phaseProfile));
        heapIndex++;
        heapPhase = nextPhase;
        if (nextPhase !== "end") await startHeapSampling(session);
    };
    const context = createScenarioContext(page, targetUrl, shotsDir, parseScenarioArguments(flags.args), log, snapshots, rotateHeap);
    const maxSeconds = Number(flags.seconds || DEFAULT_MAX_SECONDS);
    let scenarioError = null;
    let timedOut = false;
    try {
        await Promise.race([
            scenario.run(context),
            sleep(maxSeconds).then(() => { timedOut = true; }),
        ]);
    } catch (error) {
        scenarioError = String(error && error.stack ? error.stack : error);
        log(`scenario failed: ${scenarioError.split("\n")[0]}`);
    }
    if (timedOut) log(`scenario still running after --seconds ${maxSeconds}; stopping the capture there`);
    // From here on the page may be stuck (a failed load, a hung game): every call has a time limit.
    await limit(context.mark("end"), 10, null, log, "mark end");

    const filmstrip = stopFilmstrip ? await limit(stopFilmstrip(), 15, [], log, "filmstrip") : [];
    const stopped = await limit(session.send("Profiler.stop"), 120, null, log, "CPU profile");
    const profile = stopped ? stopped.profile : { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 };
    fs.writeFileSync(path.join(runDir, "cpu.cpuprofile"), JSON.stringify(profile));
    if (heapEnabled && heapPhase !== "end") await limit(rotateHeap("end"), 60, null, log, "allocation profile");
    if (stopTrace) await limit(stopTrace(), 180, null, log, "trace");
    const probe = await limit(page.evaluate(() => (window.__btProfile ? window.__btProfile.dump() : null)), 30, null, log, "probe");
    if (probe) {
        const recorded = new Set(probe.marks.map((mark) => mark.name));
        for (const mark of context.nodeMarks) if (!recorded.has(mark.name)) probe.marks.push({ ...mark, fromNode: true });
        probe.marks.sort((first, second) => first.at - second.at);
    }
    const census = await limit(page.evaluate(() => (window.__btProfile ? window.__btProfile.census() : null)), 20, null, log, "census");
    if (snapshots) await limit(page.screenshot({ path: path.join(shotsDir, "end.png") }), 20, null, log, "end screenshot");
    // A failed or overrun scenario leaves the evidence behind: what the page showed, where it was, what it complained about.
    if (scenarioError || timedOut) {
        const failedShot = path.join(shotsDir, "failed.png");
        const shot = await limit(page.screenshot({ path: failedShot }), 20, null, log, "failure screenshot");
        const where = await limit(page.evaluate(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").trim().slice(0, 300) })), 10, null, log, "page state");
        log(`failure evidence: ${shot ? "shots/failed.png" : "no screenshot"} · page ${where ? `${where.url} "${where.title}" · text: ${JSON.stringify(where.text) || "(none)"}` : "not answering"}`);
        for (const entry of consoleErrors.slice(-12)) log(`  console ${entry.type}: ${entry.text.split("\n")[0].slice(0, 240)}`);
        if (consoleErrors.length === 0) log("  console: no errors or warnings");
    }
    const scripts = stopped ? await limit(saveProfiledScripts(session, profile, scriptsDir), 300, [], log, "saving scripts") : [];
    await limit(session.detach(), 10, null, log, "detach");
    await limit(page.close(), 15, null, log, "closing the page");

    const capture = {
        label,
        url: targetUrl,
        scenario: scenario.meta,
        scenarioOptions: context.options,
        scenarioError,
        timedOut,
        capturedAt: new Date().toISOString(),
        browser: await browser.version(),
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        viewport: { width: Number(flags.width || 1600), height: Number(flags.height || 900), deviceScaleFactor },
        samplingIntervalUs: Number(flags.interval || DEFAULT_SAMPLING_INTERVAL_US),
        heapIncludesCollected,
        snapshots,
        gpuCold: flags["gpu-cold"] === "true" ? (probe && probe.gpuCold) || { tagged: 0, untagged: 0 } : null,
        filmstripFrames: filmstrip.length,
        sync: { markerName: SYNC_MARKER_NAME, epochMs: syncEpochMs },
        census,
        probe,
        scripts: scripts.length,
        consoleErrors: consoleErrors.slice(0, 60),
        disturbed: disturbance(context, navigations, devServerUpdates, probe),
        wallSeconds: +((Date.now() - startedAt) / 1000).toFixed(1),
    };
    fs.writeFileSync(path.join(runDir, "capture.json"), JSON.stringify(capture));
    if (capture.disturbed) log(`WARNING: ${capture.disturbed.reason} — this capture is not comparable; profile a server with file watching off (SKILL.md › Other sessions)`);
    if (capture.gpuCold) log(`gpu-cold: ${capture.gpuCold.tagged} fragment shader(s) made unique${capture.gpuCold.untagged ? `, ${capture.gpuCold.untagged} left as they were (no fragment entry found)` : ""}`);
    const compiles = probe && probe.gpuCompiles ? probe.gpuCompiles.filter((entry) => entry.kind !== "shaderModule").length : 0;
    log(`done: ${probe ? probe.frames.length : 0} frames, ${profile.samples.length} CPU samples, ${scripts.length} scripts, ${compiles} pipelines / programs created, engine ${probe && probe.engine}`);
    return capture;
}

/**
 * Entry point: launches Chrome, runs the cold capture and, with --warm true, a warm one in the same browser.
 */
async function main() {
    const flags = parseArguments(process.argv.slice(2));
    // The slug's config (in the working folder, `.agents/profile/<slug>/data`) supplies the URL and scenario by default.
    const configPath = path.resolve("profile.config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    if (!flags.url && config.url) flags.url = config.url;
    if (!flags.scenario && config.scenario) flags.scenario = config.scenario;
    if (!flags.url) throw new Error("Pass --url <game URL>, e.g. --url http://localhost:5173/play");
    if (!flags.out) throw new Error("Pass --out <run folder>");
    const runDir = path.resolve(flags.out);
    fs.mkdirSync(runDir, { recursive: true });
    const scenario = await loadScenario(flags.scenario);
    const width = Number(flags.width || 1600);
    const height = Number(flags.height || 900);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-profile-chrome-"));
    const args = [
        "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
        "--enable-precise-memory-info", `--window-size=${width},${height}`,
    ];
    // Audio: by default it may start without a user gesture, so it starts during the load. `--autoplay gesture` keeps a real
    // browser's rule — audio stays locked until the first key or click — when the slow moment may be the audio unlock itself.
    if (flags.autoplay !== "gesture") args.push("--autoplay-policy=no-user-gesture-required");
    if (flags.uncapped === "true") args.push("--disable-frame-rate-limit", "--disable-gpu-vsync");
    const browser = await puppeteer.launch({
        // No 180 s cap on one DevTools call: a scenario may wait minutes (a slow load, a user who drives the run).
        protocolTimeout: 0,
        executablePath: findChrome(),
        // --watch true (or --headed true): a visible window the user can watch while the profile runs
        headless: (flags.headed === "true" || flags.watch === "true") ? false : "new",
        defaultViewport: null,
        userDataDir,
        args,
    });
    // The lock names this capture's process and its Chrome, so `progress.mjs stop` (/bt-profile --stop) can end both. It
    // lives in the slug's data folder (the working folder of every capture), and goes when the capture ends.
    const lockPath = fs.existsSync("profile.config.json") ? path.resolve("capture.lock.json") : path.join(runDir, "capture.lock.json");
    const browserProcess = typeof browser.process === "function" ? browser.process() : null;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, browserPid: browserProcess ? browserProcess.pid : null, out: runDir, startedAt: new Date().toISOString() }, null, 2));
    const removeLock = () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
    process.on("exit", removeLock);
    const removeProfile = () => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* Chrome still letting go */ } };
    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            removeLock();
            try { browser.process()?.kill("SIGKILL"); } catch { /* gone */ }
            removeProfile();
            process.exit(130);
        });
    }
    try {
        const cold = await captureOnce(browser, flags, scenario, path.join(runDir, "cold"), "cold");
        const summary = { runDir, cold: path.join(runDir, "cold") };
        if (flags.warm === "true") {
            await captureOnce(browser, flags, scenario, path.join(runDir, "warm"), "warm");
            summary.warm = path.join(runDir, "warm");
        }
        if (cold.scenarioError || cold.timedOut) process.stderr.write("WARNING: the scenario did not finish — this capture shows the failure, not the moment; see the failure evidence above.\n");
        else if (cold.probe && cold.probe.engine == null) process.stderr.write("note: no Babylon engine on this page — frames are browser frames (requestAnimationFrame): FPS and frame gaps, no draw calls or engine timers.\n");
        if (cold.census && /swiftshader|llvmpipe|software/i.test(cold.census.adapter || "")) process.stderr.write("WARNING: Chrome rendered with a software adapter — GPU numbers are not representative.\n");
        fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ ...summary, flags, scenario: scenario.meta }, null, 2));
        process.stdout.write(JSON.stringify(summary) + "\n");
    } finally {
        const closed = await limit(browser.close(), 20, null, (message) => process.stderr.write(`[bt-profile] ${message}\n`), "closing Chrome");
        if (closed === null) try { browser.process()?.kill("SIGKILL"); } catch { /* gone */ }
        removeProfile();
    }
}

main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
