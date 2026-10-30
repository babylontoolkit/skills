/**
 * bt-optimize browser profiler: loads one exported scene in the toolkit's player page (engine.html), samples frame rate
 * and render statistics at moments along the scene's own timeline, then turns off one runtime cost at a time (device
 * pixel ratio, shadows, post-processing, realtime reflection probes) and measures again. The deltas say which cost
 * dominates the frame, so the fix goes where the time actually goes rather than where it is guessed to go.
 *
 * Usage:
 *   node profile-browser.mjs --base http://localhost:8888 --scene level.gltf --times 15,30,45 --out ./profile.json
 *   node profile-browser.mjs --scene level.gltf --pin 20,35 --toggles dpr,taa,motionblur,bloom,post,shadows,lights
 *   node profile-browser.mjs --scene optimized.gltf --poses ./before-pinned.json --toggles none   (same views as an earlier run)
 *   [--headed true] [--dpr 2] [--window 3] [--settle 4] [--shots ./shots] [--cpuprofile true] [--toggles none]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

/** Default sample moments, in seconds after the scene reports it is ready. */
const DEFAULT_TIMES = "10,20,30,45";

/** Seconds of rendering each sample averages over. */
const DEFAULT_WINDOW_SECONDS = 3;

/** How long to wait for the scene to finish loading, in milliseconds. */
const READY_TIMEOUT_MS = 600000;

/**
 * Reads `--name value` pairs from the command line.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Record<string, string>} the parsed flags
 */
function parseArguments(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) {
        flags[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
    return flags;
}

/**
 * Finds a Chrome or Chromium executable: CHROME_PATH, the usual install locations, then puppeteer's own cache.
 * @returns {string} absolute path of the browser executable
 * @throws {Error} when no browser can be found
 */
function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
    const cacheRoot = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    if (fs.existsSync(cacheRoot)) {
        for (const version of fs.readdirSync(cacheRoot)) {
            const cached = [
                path.join(cacheRoot, version, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
                path.join(cacheRoot, version, "chrome-linux64", "chrome"),
                path.join(cacheRoot, version, "chrome-win64", "chrome.exe"),
            ].find((candidate) => fs.existsSync(candidate));
            if (cached) return cached;
        }
    }
    throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium executable.");
}

/**
 * Runs inside the page: installs the frame sampler and the static scene census on window.__btProfile.
 * Kept self-contained because puppeteer serialises it into the page.
 */
function installProbe() {
    const state = { frames: [], recording: false };
    window.__btProfile = state;

    /** @returns {any} the toolkit's scene, once one exists */
    state.scene = () => (window.BABYLON && BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) || null;

    /** Starts recording frame timestamps and per-frame counters. */
    state.start = () => {
        const scene = state.scene();
        state.frames = [];
        state.recording = true;
        if (!state.instrumentation) {
            state.instrumentation = new BABYLON.SceneInstrumentation(scene);
            state.instrumentation.captureFrameTime = true;
            state.instrumentation.captureActiveMeshesEvaluationTime = true;
            state.instrumentation.captureRenderTargetsRenderTime = true;
            state.instrumentation.captureRenderTime = true;
            state.observer = scene.onAfterRenderObservable.add(() => {
                if (!state.recording) return;
                const engine = scene.getEngine();
                const instrumentation = state.instrumentation;
                const drawCalls = (engine._drawCalls && engine._drawCalls.current) || (instrumentation.drawCallsCounter && instrumentation.drawCallsCounter.current) || 0;
                state.frames.push({
                    t: performance.now(),
                    drawCalls,
                    activeMeshes: scene.getActiveMeshes().length,
                    activeIndices: scene.getActiveIndices(),
                    evaluateMs: instrumentation.activeMeshesEvaluationTimeCounter.current,
                    targetsMs: instrumentation.renderTargetsRenderTimeCounter.current,
                    renderMs: instrumentation.renderTimeCounter.current,
                    frameMs: instrumentation.frameTimeCounter.current,
                });
            });
        }
    };

    /** Stops recording and returns the window's summary. */
    state.stop = () => {
        state.recording = false;
        const frames = state.frames;
        if (frames.length < 2) return { frames: frames.length };
        const intervals = [];
        for (let i = 1; i < frames.length; i++) intervals.push(frames[i].t - frames[i - 1].t);
        intervals.sort((first, second) => first - second);
        const average = (key) => frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length;
        const seconds = (frames[frames.length - 1].t - frames[0].t) / 1000;
        const camera = state.scene().activeCamera;
        const watch = state.targetWatch;
        const perFrame = (key) => (watch && watch.frames ? Math.round(watch[key] / watch.frames) : null);
        const passes = { shadowMaps: perFrame("shadow"), otherTargets: perFrame("targets"), main: perFrame("main"), afterMain: perFrame("after") };
        const byTarget = {};
        if (watch && watch.frames) for (const [key, entry] of Object.entries(watch.byTarget)) byTarget[key] = { drawsPerFrame: Math.round(entry.draws / watch.frames), rendersPerFrame: +(entry.renders / watch.frames).toFixed(2) };
        if (watch) { watch.shadow = watch.targets = watch.main = watch.after = watch.frames = 0; watch.byTarget = {}; }
        return {
            passes,
            byTarget,
            fps: +((frames.length - 1) / seconds).toFixed(1),
            p50Ms: +intervals[Math.floor(intervals.length * 0.5)].toFixed(1),
            p95Ms: +intervals[Math.floor(intervals.length * 0.95)].toFixed(1),
            worstMs: +intervals[intervals.length - 1].toFixed(1),
            drawCalls: Math.round(average("drawCalls")),
            activeMeshes: Math.round(average("activeMeshes")),
            activeTriangles: Math.round(average("activeIndices") / 3),
            cpuEvaluateMs: +average("evaluateMs").toFixed(2),
            cpuRenderTargetsMs: +average("targetsMs").toFixed(2),
            cpuRenderMs: +average("renderMs").toFixed(2),
            cpuFrameMs: +average("frameMs").toFixed(2),
            camera: camera ? [camera.globalPosition.x, camera.globalPosition.y, camera.globalPosition.z].map((v) => +v.toFixed(1)) : null,
        };
    };

    /** Static census of what the scene asks the GPU to do every frame. */
    state.census = () => {
        const scene = state.scene();
        const engine = scene.getEngine();
        const shadows = [];
        for (const light of scene.lights) {
            const generator = light.getShadowGenerator && light.getShadowGenerator();
            if (!generator) continue;
            const map = generator.getShadowMap();
            shadows.push({
                light: light.name,
                type: light.getClassName(),
                enabled: light.isEnabled(),
                mapSize: map ? map.getSize().width : 0,
                cascades: generator.numCascades || 1,
                casters: map && map.renderList ? map.renderList.length : -1,
                refreshRate: map ? map.refreshRate : -1,
            });
        }
        let textureBytes = 0;
        for (const texture of scene.textures) {
            const size = texture.getSize ? texture.getSize() : { width: 0, height: 0 };
            textureBytes += size.width * size.height * 4 * (texture.isCube ? 6 : 1) * 1.33;
        }
        const meshes = scene.meshes;
        const drawn = meshes.filter((mesh) => mesh.getTotalVertices && mesh.getTotalVertices() > 0);
        const lights = scene.lights.map((light) => ({ name: light.name, type: light.getClassName(), enabled: light.isEnabled(), intensity: +light.intensity.toFixed(2) }));
        const renderTargets = scene.customRenderTargets.map((target) => ({ name: target.name, size: target.getSize().width, list: target.renderList ? target.renderList.length : -1, refreshRate: target.refreshRate }));
        const probes = (scene.reflectionProbes || []).map((probe) => ({ name: probe.name, size: probe.cubeTexture.getSize().width, list: probe.renderList.length, refreshRate: probe.refreshRate }));
        const materialsByClass = {};
        for (const material of scene.materials) materialsByClass[material.getClassName()] = (materialsByClass[material.getClassName()] || 0) + 1;
        return {
            engine: engine.isWebGPU ? "WebGPU" : "WebGL" + engine.webGLVersion,
            adapter: engine.getGlInfo ? engine.getGlInfo().renderer : "",
            hardwareScaling: engine.getHardwareScalingLevel(),
            renderSize: [engine.getRenderWidth(), engine.getRenderHeight()],
            devicePixelRatio: window.devicePixelRatio,
            snapshotRendering: engine.snapshotRendering === true,
            meshes: meshes.length,
            drawnMeshes: drawn.length,
            instancedMeshes: meshes.filter((mesh) => mesh.getClassName() === "InstancedMesh").length,
            thinInstanced: drawn.filter((mesh) => mesh.thinInstanceCount > 0).length,
            frozenWorldMatrices: drawn.filter((mesh) => mesh.isWorldMatrixFrozen).length,
            totalVertices: scene.getTotalVertices(),
            materials: scene.materials.length,
            materialsByClass,
            textures: scene.textures.length,
            textureMegabytesEstimate: Math.round(textureBytes / 1048576),
            lights,
            shadows,
            renderTargets,
            reflectionProbes: probes,
            postProcesses: scene.postProcesses.length + (scene.activeCamera ? scene.activeCamera._postProcesses.filter(Boolean).length : 0),
            postProcessNames: scene.activeCamera ? scene.activeCamera._postProcesses.filter(Boolean).map((p) => p.name) : [],
            skipFrustumClipping: scene.skipFrustumClipping === true,
            prePassRenderer: !!(scene.prePassRenderer && scene.prePassRenderer.enabled),
            geometryBufferRenderer: !!(scene.geometryBufferRenderer && scene.geometryBufferRenderer.enabled !== false),
            renderQuality: (window.TOOLKIT && TOOLKIT.SceneManager && TOOLKIT.SceneManager.GetRenderQuality) ? TOOLKIT.SceneManager.GetRenderQuality() : null,
            activeMeshesFrozen: scene._activeMeshesFrozen === true,
        };
    };

    /**
     * Pins the active camera at its current world pose: detaches it from its rig so whatever animates the rig
     * (a Timeline, a controller) no longer moves the view, keeping its post-processes attached.
     * @returns {number[]} the pinned position
     */
    state.pin = () => {
        const camera = state.scene().activeCamera;
        const scale = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
        camera.computeWorldMatrix(true).decompose(scale, rotation, position);
        camera.parent = null;
        camera.position.copyFrom(position);
        camera.rotationQuaternion = rotation;
        if (camera.inputs) camera.inputs.clear();
        state.lockLens(camera, { fov: camera.fov, fovMode: camera.fovMode, minZ: camera.minZ, maxZ: camera.maxZ });
        // The lens is part of the view: Timeline / Cinemachine tracks animate the field of view too.
        return { position: [position.x, position.y, position.z].map((v) => +v.toFixed(4)), rotation: [rotation.x, rotation.y, rotation.z, rotation.w].map((v) => +v.toFixed(6)),
            fov: +camera.fov.toFixed(6), fovMode: camera.fovMode, minZ: camera.minZ, maxZ: camera.maxZ };
    };

    /** The active camera's current world pose and lens, to prove a pinned view did not drift. */
    state.actualPose = () => {
        const camera = state.scene().activeCamera;
        const p = camera.globalPosition;
        return { camera: camera.name, position: [p.x, p.y, p.z].map((v) => +v.toFixed(3)), fov: +camera.fov.toFixed(4), parent: camera.parent ? camera.parent.name : null };
    };

    /** Holds the camera's lens before every render, so an animation track that writes the field of view cannot change the view. */
    state.lockLens = (camera, lens) => {
        state.lens = lens;
        // A Timeline / Cinemachine lens track keeps writing the field of view every frame, and TAA builds its jittered
        // projection from it before any render observer could restore ours — so the lens fields become read-only.
        for (const key of ["fov", "fovMode", "minZ", "maxZ"]) {
            Object.defineProperty(camera, key, { configurable: true, enumerable: true, get: () => state.lens[key], set: () => {} });
        }
        camera.getProjectionMatrix(true);
    };

    /** Pins the active camera at a pose recorded by an earlier run (same view in a different export). */
    state.pose = (pose) => {
        state.pin();
        const camera = state.scene().activeCamera;
        camera.position.copyFromFloats(pose.position[0], pose.position[1], pose.position[2]);
        camera.rotationQuaternion = new BABYLON.Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
        if (pose.fov != null) state.lockLens(camera, { fov: pose.fov, fovMode: pose.fovMode, minZ: pose.minZ, maxZ: pose.maxZ });
        camera.computeWorldMatrix(true);
        return pose;
    };

    /**
     * Splits each frame's draw calls by pass, read from the engine's running draw counter: shadow maps, other render
     * targets before the main pass (geometry / velocity buffers for motion blur, TAA, SSAO; realtime probes), the main
     * camera pass, and everything after it (post-processes, GUI).
     */
    state.watchTargets = () => {
        const scene = state.scene();
        const engine = scene.getEngine();
        const counter = engine._drawCalls;
        if (!counter || state.targetWatch) return;
        const watch = state.targetWatch = { shadow: 0, targets: 0, main: 0, after: 0, frames: 0 };
        let frameStart = 0, mainStart = 0, mainEnd = 0, shadowFrame = 0;
        const hookShadowMaps = () => {
            for (const light of scene.lights) {
                const generator = light.getShadowGenerator && light.getShadowGenerator();
                const map = generator && generator.getShadowMap();
                if (!map || map.__btHooked) continue;
                map.__btHooked = true;
                let before = 0;
                map.onBeforeRenderObservable.add(() => { before = counter._current; });
                map.onAfterRenderObservable.add(() => { shadowFrame += counter._current - before; });
            }
        };
        hookShadowMaps();
        // Attribute every render-target pass to its target by name (shadow maps, depth / velocity / geometry buffers,
        // realtime probes, mirrors): wraps RenderTargetTexture.render once per page.
        watch.byTarget = {};
        const proto = BABYLON.RenderTargetTexture.prototype;
        if (!proto.__btWrapped) {
            proto.__btWrapped = true;
            const original = proto.render;
            proto.render = function (...args) {
                const before = counter._current;
                const result = original.apply(this, args);
                if (state.recording && state.targetWatch) {
                    const key = (this.name || this.getClassName()).replace(/[0-9]+/g, "#");
                    const entry = state.targetWatch.byTarget[key] || (state.targetWatch.byTarget[key] = { draws: 0, renders: 0 });
                    entry.draws += counter._current - before;
                    entry.renders++;
                }
                return result;
            };
        }
        scene.onBeforeRenderObservable.add(() => { frameStart = counter._current; shadowFrame = 0; hookShadowMaps(); });
        scene.onBeforeDrawPhaseObservable.add(() => { mainStart = counter._current; });
        scene.onAfterDrawPhaseObservable.add(() => { mainEnd = counter._current; });
        engine.onEndFrameObservable.add(() => {
            if (!state.recording) return;
            const total = counter._current;
            watch.shadow += shadowFrame;
            watch.targets += Math.max(0, mainStart - frameStart - shadowFrame);
            watch.main += Math.max(0, mainEnd - mainStart);
            watch.after += Math.max(0, total - mainEnd);
            watch.frames++;
        });
    };

    /**
     * For every active mesh: the lights Babylon actually binds (mesh.lightSources, capped by the material's
     * maxSimultaneousLights) and how many of those cannot reach the mesh at all (point / spot beyond their range).
     * Babylon's Light.canAffectMesh has no range test, so tighter mesh bounds never lower the bindings. The reach test
     * clamps each light into the mesh's world box, so a mesh with scene-sized bounds (a skinned mesh, a track-wide
     * mesh) always counts as in range: a low share on such a scene understates the waste.
     */
    state.lightAudit = () => {
        const scene = state.scene();
        let meshes = 0, bound = 0, outOfRange = 0, shadowed = 0;
        const names = {};
        for (const mesh of scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length)) {
            const material = mesh.material;
            if (!material) continue;
            const cap = material.maxSimultaneousLights || 4;
            const lights = (mesh.lightSources || []).slice(0, cap);
            meshes++;
            const box = mesh.getBoundingInfo().boundingBox;
            for (const light of lights) {
                bound++;
                if (light.getShadowGenerator && light.getShadowGenerator()) shadowed++;
                names[light.name] = (names[light.name] || 0) + 1;
                if (light.getClassName() === "PointLight" || light.getClassName() === "SpotLight") {
                    const p = light.getAbsolutePosition();
                    const c = BABYLON.Vector3.Clamp(p, box.minimumWorld, box.maximumWorld);
                    if (BABYLON.Vector3.Distance(p, c) > light.range) outOfRange++;
                }
            }
        }
        return { activeMeshes: meshes, lightsBoundPerMesh: +(bound / Math.max(1, meshes)).toFixed(2), boundButOutOfRangePct: +((outOfRange / Math.max(1, bound)) * 100).toFixed(1),
            shadowedBoundPerMesh: +(shadowed / Math.max(1, meshes)).toFixed(2), mostBound: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 6) };
    };

    /**
     * Accounts for every main-pass draw: the active meshes grouped by the scene object that owns them (the child of the
     * scene root they sit under), and every shape drawn more than once with what stops its copies from sharing one
     * instanced draw. Also counts each owner's meshes in the shadow maps' caster lists. Per-pass totals say where the
     * frame goes; this says which objects to fix, so no group of draws is skipped unexamined.
     * @returns {{owners: object[], repeats: object[], mainDraws: number}} the draw accounting at the current view
     */
    state.drawOwners = () => {
        const scene = state.scene();
        const activeMeshes = scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length);
        const ownerOf = (node) => {
            let current = node;
            while (current.parent && current.parent.parent) current = current.parent;
            return current.parent ? current.name : node.name;
        };
        const subMeshDraws = (mesh) => (mesh.subMeshes ? mesh.subMeshes.length : 1);
        const owners = new Map();
        const repeats = new Map();
        const drawnSources = new Set();
        let mainDraws = 0;
        for (const mesh of activeMeshes) {
            const source = mesh.isAnInstance ? mesh.sourceMesh : mesh;
            // Instances draw in their source's single instanced call: count that call once.
            const draws = mesh.isAnInstance ? (drawnSources.has(source) ? 0 : subMeshDraws(source)) : subMeshDraws(mesh);
            drawnSources.add(source);
            mainDraws += draws;
            const ownerName = ownerOf(mesh);
            if (!owners.has(ownerName)) owners.set(ownerName, { owner: ownerName, meshes: 0, draws: 0, skinned: 0, instances: 0, lightmapped: 0, geometries: new Set(), examples: [] });
            const owner = owners.get(ownerName);
            owner.meshes++;
            owner.draws += draws;
            if (source.skeleton) owner.skinned++;
            if (mesh.isAnInstance) owner.instances++;
            if (mesh.material && mesh.material.lightmapTexture) owner.lightmapped++;
            if (source.geometry) owner.geometries.add(source.geometry.uniqueId);
            if (owner.examples.length < 3) owner.examples.push(mesh.name);
            if (!source.geometry) continue;
            const repeatKey = source.geometry.uniqueId + "|" + (mesh.material ? mesh.material.uniqueId : "none");
            if (!repeats.has(repeatKey)) repeats.set(repeatKey, { shape: source.name, owner: ownerName, copies: 0, draws: 0, skinned: 0, instances: 0, lightmapped: 0 });
            const repeat = repeats.get(repeatKey);
            repeat.copies++;
            repeat.draws += draws;
            if (source.skeleton) repeat.skinned++;
            if (mesh.isAnInstance) repeat.instances++;
            if (mesh.material && mesh.material.lightmapTexture) repeat.lightmapped++;
        }
        const shadowCasters = new Map();
        for (const light of scene.lights) {
            const generator = light.getShadowGenerator && light.getShadowGenerator();
            const renderList = generator && generator.getShadowMap() ? generator.getShadowMap().renderList || [] : [];
            for (const caster of renderList) shadowCasters.set(ownerOf(caster), (shadowCasters.get(ownerOf(caster)) || 0) + 1);
        }
        const blockerOf = (repeat) => {
            if (repeat.skinned > 0) return "skinned: every copy is its own draw (Babylon cannot instance separately animated skinned meshes)";
            if (repeat.lightmapped > 0) return "lightmapped: the exporter gives every lightmapped copy its own mesh";
            if (repeat.instances < repeat.copies - 1) return "separate meshes of one shape: not exported as instances (material split by reflection probe or lightmap index?)";
            return null;
        };
        return {
            mainDraws,
            owners: [...owners.values()].sort((first, second) => second.draws - first.draws).map((owner) => ({
                owner: owner.owner, meshes: owner.meshes, draws: owner.draws, skinned: owner.skinned, instances: owner.instances, lightmapped: owner.lightmapped,
                uniqueShapes: owner.geometries.size, shadowCasters: shadowCasters.get(owner.owner) || 0, examples: owner.examples,
            })),
            repeats: [...repeats.values()].filter((repeat) => repeat.copies > 1).sort((first, second) => second.draws - first.draws).slice(0, 25)
                .map((repeat) => ({ ...repeat, blocker: blockerOf(repeat) })),
        };
    };

    /**
     * Switches one runtime cost off (on = false) or back on (on = true).
     * Keys: dpr, taa, motionblur, bloom, post (every camera post-process), shadows, lights (every point / spot light).
     * @returns {string} what changed
     */
    state.toggle = (key, on) => {
        const scene = state.scene();
        const engine = scene.getEngine();
        const camera = scene.activeCamera;
        const patterns = { taa: /^taa/i, motionblur: /motionblur/i, bloom: /bloom/i, post: /./ };
        if (key === "dpr") {
            if (state.savedScaling === undefined) state.savedScaling = engine.getHardwareScalingLevel();
            engine.setHardwareScalingLevel(on ? state.savedScaling : 1);
            engine.resize();
            return "hardware scaling " + engine.getHardwareScalingLevel();
        }
        if (patterns[key]) {
            if (!state.savedPost) state.savedPost = camera._postProcesses.filter(Boolean).slice();
            for (const p of state.savedPost) camera.detachPostProcess(p);
            const keep = on ? state.savedPost : state.savedPost.filter((p) => !patterns[key].test(p.name));
            for (const p of keep) camera.attachPostProcess(p);
            return (on ? "restored " : "removed ") + (state.savedPost.length - keep.length || state.savedPost.length) + " post-process passes (" + key + ")";
        }
        if (key === "shadows") { scene.shadowsEnabled = on; return "scene.shadowsEnabled = " + on; }
        if (key === "lights") {
            let count = 0;
            for (const light of scene.lights) if (light.getClassName() !== "HemisphericLight" && light.getClassName() !== "DirectionalLight") { light.setEnabled(on); count++; }
            return (on ? "enabled " : "disabled ") + count + " point/spot lights";
        }
        return "unknown";
    };
}

/**
 * Waits until the toolkit scene exists, is ready and has rendered for a moment.
 * @param {import("puppeteer-core").Page} page - the player page
 * @returns {Promise<number>} milliseconds from navigation to ready
 */
async function waitForScene(page, startedAt) {
    await page.waitForFunction(() => {
        const scene = window.__btProfile && window.__btProfile.scene();
        return scene && scene.meshes.length > 0 && scene.isReady() && scene.activeCamera && window.loaded === true;
    }, { timeout: READY_TIMEOUT_MS, polling: 500 });
    return Date.now() - startedAt;
}

/** Pauses for the given number of seconds. */
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Opens the scene in a fresh page and waits until it is ready.
 * @returns {Promise<{page: import("puppeteer-core").Page, readyMs: number}>}
 */
async function openScene(browser, baseUrl, scene, deviceScaleFactor, consoleErrors) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    await page.evaluateOnNewDocument(installProbe);
    const startedAt = Date.now();
    await page.goto(`${baseUrl}/engine.html?scene=${encodeURIComponent(scene)}`, { waitUntil: "load", timeout: READY_TIMEOUT_MS });
    const readyMs = await waitForScene(page, startedAt);
    await page.evaluate(() => window.__btProfile.watchTargets());
    return { page, readyMs };
}

/**
 * Waits until every material has finished compiling again (a scene-wide toggle recompiles all of them, which can
 * take many seconds on a big scene), then a further quiet period so the frame rate has recovered.
 */
async function settle(page, quietSeconds) {
    await page.evaluate(() => window.__btProfile.scene().whenReadyAsync());
    await sleep(quietSeconds);
    await page.evaluate(() => window.__btProfile.scene().whenReadyAsync());
}

/**
 * Records a CPU profile of the page for the given seconds and returns the top functions by self time.
 * @returns {Promise<{totalMs: number, top: {fn: string, selfMs: number, pct: number}[]}>}
 */
async function cpuProfile(page, seconds) {
    const session = await page.createCDPSession();
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 500 });
    await session.send("Profiler.start");
    await sleep(seconds);
    const { profile } = await session.send("Profiler.stop");
    await session.detach();
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    const deltas = profile.timeDeltas || [];
    for (let i = 0; i < profile.samples.length; i++) {
        const node = byId.get(profile.samples[i]);
        const frame = node.callFrame;
        const file = (frame.url || "").split("/").pop();
        const key = (frame.functionName || "(anonymous)") + " " + file + ":" + frame.lineNumber;
        self.set(key, (self.get(key) || 0) + (deltas[i] || 0) / 1000);
    }
    const totalMs = [...self.values()].reduce((sum, value) => sum + value, 0);
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([fn, ms]) => ({ fn, selfMs: +ms.toFixed(1), pct: +((ms / totalMs) * 100).toFixed(1) }));
    return { totalMs: Math.round(totalMs), top };
}

/** Records one measurement window on the page. */
async function measure(page, windowSeconds) {
    await page.evaluate(() => window.__btProfile.start());
    await sleep(windowSeconds);
    return page.evaluate(() => window.__btProfile.stop());
}

/**
 * Entry point. Two modes:
 * - timeline (default): samples at --times seconds after ready, as the scene plays.
 * - --pin s1,s2: for each moment, a fresh load pins the camera there and measures every --toggles cost switched off on
 *   its own (then back on), each against the same pinned baseline.
 */
async function main() {
    const flags = parseArguments(process.argv.slice(2));
    const baseUrl = (flags.base || "http://localhost:8888").replace(/\/$/, "");
    const scene = flags.scene;
    if (!scene) throw new Error("Pass --scene <exported scene file>, e.g. --scene level.gltf");
    const times = (flags.times || DEFAULT_TIMES).split(",").map(Number).sort((first, second) => first - second);
    const poses = flags.poses ? JSON.parse(fs.readFileSync(path.resolve(flags.poses), "utf8")).pins.map((pin) => ({ atSeconds: pin.atSeconds, pose: pin.pinned })) : null;
    const pins = poses ? poses.map((entry) => entry.atSeconds) : (flags.pin || "").split(",").filter(Boolean).map(Number);
    const toggles = (flags.toggles || "dpr,taa,motionblur,bloom,post,shadows,lights").split(",").filter((key) => key && key !== "none");
    const windowSeconds = Number(flags.window || DEFAULT_WINDOW_SECONDS);
    const settleSeconds = Number(flags.settle || 4);
    const deviceScaleFactor = Number(flags.dpr || 2);
    const headed = flags.headed === "true";
    const shots = flags.shots ? path.resolve(flags.shots) : null;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const tag = path.basename(scene, path.extname(scene));

    const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: headed ? false : "new",
        defaultViewport: null,
        args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-frame-rate-limit",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1600,900"],
    });
    const consoleErrors = [];
    const report = { scene, deviceScaleFactor, headed };
    try {
        if (pins.length === 0) {
            const { page, readyMs } = await openScene(browser, baseUrl, scene, deviceScaleFactor, consoleErrors);
            report.readyMs = readyMs;
            report.census = await page.evaluate(() => window.__btProfile.census());
            report.samples = [];
            let elapsed = 0;
            for (const seconds of times) {
                await sleep(Math.max(0, seconds - elapsed));
                const sample = await measure(page, windowSeconds);
                elapsed = seconds + windowSeconds;
                report.samples.push({ atSeconds: seconds, ...sample });
                if (shots) await page.screenshot({ path: path.join(shots, `${tag}_${seconds}s.png`) });
            }
            await page.close();
        } else {
            report.pins = [];
            for (const [index, seconds] of pins.entries()) {
                const { page, readyMs } = await openScene(browser, baseUrl, scene, deviceScaleFactor, consoleErrors);
                if (!report.census) report.census = await page.evaluate(() => window.__btProfile.census());
                await sleep(seconds);
                // With --poses, the camera goes to the exact pose an earlier run pinned, so two exports are measured from one view.
                const pinned = poses ? await page.evaluate((pose) => window.__btProfile.pose(pose), poses[index].pose) : await page.evaluate(() => window.__btProfile.pin());
                await settle(page, settleSeconds);
                if (shots) await page.screenshot({ path: path.join(shots, `${tag}_pin${seconds}s.png`) });
                const poseBefore = await page.evaluate(() => window.__btProfile.actualPose());
                const baseline = await measure(page, windowSeconds);
                const poseAfter = await page.evaluate(() => window.__btProfile.actualPose());
                const target = pinned.position || pinned;
                const drift = Math.max(...[poseBefore, poseAfter].map((actual) => Math.hypot(actual.position[0] - target[0], actual.position[1] - target[1], actual.position[2] - target[2])));
                if (drift > 0.05 || (pinned.fov != null && Math.abs(poseAfter.fov - pinned.fov) > 1e-3) || poseBefore.camera !== poseAfter.camera)
                    process.stderr.write(`WARNING pin ${seconds}s drifted: target ${JSON.stringify(pinned)} actual ${JSON.stringify(poseBefore)} -> ${JSON.stringify(poseAfter)}\n`);
                const cpu = flags.cpuprofile === "true" ? await cpuProfile(page, windowSeconds) : null;
                const lightAudit = await page.evaluate(() => window.__btProfile.lightAudit());
                const drawOwners = await page.evaluate(() => window.__btProfile.drawOwners());
                const steps = [];
                for (const key of toggles) {
                    const change = await page.evaluate((k) => window.__btProfile.toggle(k, false), key);
                    await settle(page, settleSeconds);
                    const off = await measure(page, windowSeconds);
                    await page.evaluate((k) => window.__btProfile.toggle(k, true), key);
                    await settle(page, settleSeconds);
                    steps.push({ off: key, change, fps: off.fps, p50Ms: off.p50Ms, drawCalls: off.drawCalls, passes: off.passes, cpuRenderMs: off.cpuRenderMs, cpuFrameMs: off.cpuFrameMs });
                }
                const after = await measure(page, windowSeconds);
                report.pins.push({ atSeconds: seconds, readyMs, pinned, actual: { before: poseBefore, after: poseAfter }, baseline, lightAudit, drawOwners, cpu, steps, baselineAgain: { fps: after.fps, p50Ms: after.p50Ms } });
                await page.close();
            }
        }
        report.consoleErrors = consoleErrors.slice(0, 20);
        const text = JSON.stringify(report, null, 2);
        if (flags.out) fs.writeFileSync(path.resolve(flags.out), text);
        process.stdout.write(text + "\n");
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
