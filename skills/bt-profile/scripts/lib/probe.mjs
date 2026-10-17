/**
 * The in-page half of the bt-profile capture. `installProbe` is serialised into every document the profiled page
 * opens (puppeteer `evaluateOnNewDocument`), so it must stay self-contained: no imports, no outer variables.
 *
 * It records, on `window.__btProfile`:
 * - one entry per rendered Babylon frame: begin time, CPU work (begin → end of the engine frame), draw calls, active
 *   meshes and particles, and the SceneInstrumentation timers the engine exposes;
 * - counters sampled every half second: meshes, materials, textures, particle systems, compiled effects (shader
 *   programs / pipelines), JS heap;
 * - long animation frames (LoAF) with their script attribution, when the browser supports them;
 * - phase marks set by the scenario (`__btProfile.mark("countdown")`).
 *
 * Every time is an epoch time in milliseconds (`performance.timeOrigin + performance.now()`), so frames, marks and
 * the CPU profile line up across page navigations.
 */
export function installProbe() {
    /** How often the scene counters are sampled, in milliseconds. */
    const COUNTER_INTERVAL_MS = 500;
    /** How often the probe looks for a new engine or scene, in milliseconds. */
    const ATTACH_POLL_MS = 50;
    /** Frames longer than this (ms) keep their full instrumentation breakdown in the spike list. */
    const LONG_FRAME_MS = 50;

    const epochNow = () => performance.timeOrigin + performance.now();
    const state = {
        frames: [],
        counters: [],
        marks: [],
        longFrames: [],
        loafs: [],
        engineAttachedAt: null,
        scenesSeen: 0,
    };
    window.__btProfile = state;

    /** Records a named phase boundary (the scenario calls it: "intro", "countdown", "takeoff" …). */
    state.mark = (name) => {
        state.marks.push({ name, at: epochNow() });
        return name;
    };

    const babylon = () => window.BABYLON || null;
    const currentEngine = () => {
        const library = babylon();
        if (!library || !library.EngineStore) return null;
        return library.EngineStore.LastCreatedEngine || null;
    };
    const currentScene = () => {
        const library = babylon();
        if (!library || !library.EngineStore) return null;
        return library.EngineStore.LastCreatedScene || null;
    };

    let hookedEngine = null;
    let hookedScene = null;
    let instrumentation = null;
    let frameBegin = 0;

    /** Turns on every SceneInstrumentation timer this Babylon version has, for the scene now rendering. */
    const instrumentScene = (scene) => {
        const library = babylon();
        if (!library.SceneInstrumentation) return;
        if (instrumentation) {
            try { instrumentation.dispose(); } catch { /* the old scene is already gone */ }
        }
        instrumentation = new library.SceneInstrumentation(scene);
        for (const flag of ["captureFrameTime", "captureRenderTime", "captureRenderTargetsRenderTime", "captureActiveMeshesEvaluationTime",
            "captureAnimationsTime", "capturePhysicsTime", "captureParticlesRenderTime", "captureCameraRenderTime", "captureInterFrameTime"]) {
            try { instrumentation[flag] = true; } catch { /* timer not supported by this engine */ }
        }
        hookedScene = scene;
        state.scenesSeen++;
    };

    const timer = (name) => {
        const counter = instrumentation && instrumentation[name];
        return counter && typeof counter.current === "number" ? counter.current : null;
    };

    const activeParticles = (scene) => {
        let total = 0;
        for (const system of scene.particleSystems || []) {
            try { total += system.getActiveCount ? system.getActiveCount() : 0; } catch { /* a GPU system mid-dispose */ }
        }
        return total;
    };

    const onBeginFrame = () => { frameBegin = performance.now(); };
    const onEndFrame = () => {
        const end = performance.now();
        const scene = hookedScene;
        const engine = hookedEngine;
        const drawCounter = engine && engine._drawCalls;
        const frame = {
            at: performance.timeOrigin + frameBegin,
            cpuMs: +(end - frameBegin).toFixed(3),
            draws: drawCounter && typeof drawCounter.current === "number" ? drawCounter.current : null,
            activeMeshes: scene && scene.getActiveMeshes ? scene.getActiveMeshes().length : null,
            particles: scene ? activeParticles(scene) : null,
            renderMs: timer("renderTimeCounter"),
            targetsMs: timer("renderTargetsRenderTimeCounter"),
            evaluateMs: timer("activeMeshesEvaluationTimeCounter"),
            animationsMs: timer("animationsTimeCounter"),
            physicsMs: timer("physicsTimeCounter"),
            particlesMs: timer("particlesRenderTimeCounter"),
        };
        state.frames.push(frame);
        if (frame.cpuMs >= LONG_FRAME_MS) state.longFrames.push(frame);
    };

    /** Hooks the engine's frame observables once, and re-instruments whenever a new scene starts rendering. */
    const attach = () => {
        const engine = currentEngine();
        if (engine && engine !== hookedEngine && engine.onBeginFrameObservable && engine.onEndFrameObservable) {
            hookedEngine = engine;
            engine.onBeginFrameObservable.add(onBeginFrame);
            engine.onEndFrameObservable.add(onEndFrame);
            state.engineAttachedAt = epochNow();
            state.engine = engine.isWebGPU ? "WebGPU" : "WebGL" + (engine.webGLVersion || "");
        }
        const scene = currentScene();
        if (scene && scene !== hookedScene && !scene.isDisposed) instrumentScene(scene);
    };
    setInterval(attach, ATTACH_POLL_MS);

    /** Counts what the scene holds and how many shader programs / pipelines the engine has compiled so far. */
    const sampleCounters = () => {
        const engine = hookedEngine;
        const scene = hookedScene;
        const memory = performance.memory;
        const entry = { at: epochNow(), heapMb: memory ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null };
        if (engine) {
            const compiled = engine._compiledEffects;
            entry.compiledEffects = compiled ? Object.keys(compiled).length : null;
            entry.textureCache = engine.getLoadedTexturesCache ? engine.getLoadedTexturesCache().length : null;
        }
        if (scene && !scene.isDisposed) {
            entry.meshes = scene.meshes.length;
            entry.materials = scene.materials.length;
            entry.textures = scene.textures.length;
            entry.particleSystems = (scene.particleSystems || []).length;
            entry.animationGroups = (scene.animationGroups || []).length;
            entry.skeletons = (scene.skeletons || []).length;
        }
        state.counters.push(entry);
    };
    setInterval(sampleCounters, COUNTER_INTERVAL_MS);

    // Long Animation Frames name the script, function and invoker behind every frame over 50 ms.
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                state.loafs.push({
                    at: performance.timeOrigin + entry.startTime,
                    durationMs: +entry.duration.toFixed(1),
                    blockingMs: +(entry.blockingDuration || 0).toFixed(1),
                    renderMs: entry.renderStart ? +(entry.startTime + entry.duration - entry.renderStart).toFixed(1) : null,
                    scripts: (entry.scripts || []).slice(0, 6).map((script) => ({
                        invoker: script.invoker,
                        invokerType: script.invokerType,
                        sourceUrl: script.sourceURL,
                        sourceFunction: script.sourceFunctionName,
                        sourceChar: script.sourceCharPosition,
                        durationMs: +script.duration.toFixed(1),
                        forcedLayoutMs: +(script.forcedStyleAndLayoutDuration || 0).toFixed(1),
                    })),
                });
            }
        });
        observer.observe({ type: "long-animation-frame", buffered: true });
    } catch {
        // Long Animation Frames are Chrome 123+; the CPU profile still attributes the time without them.
    }

    /**
     * Static census of the scene now rendering: what the GPU is asked to do each frame and what may be expensive.
     * @returns {object|null} null before a scene exists
     */
    state.census = () => {
        const scene = currentScene();
        const engine = currentEngine();
        if (!scene || !engine) return null;
        const particleSystems = (scene.particleSystems || []).map((system) => ({
            name: system.name,
            className: system.getClassName ? system.getClassName() : "",
            capacity: system.getCapacity ? system.getCapacity() : null,
            emitRate: system.emitRate,
            active: system.isStarted ? system.isStarted() : null,
            activeCount: system.getActiveCount ? system.getActiveCount() : null,
            emitter: system.emitter && system.emitter.name ? system.emitter.name : null,
        }));
        let adapter = "";
        try { adapter = engine.getGlInfo ? JSON.stringify(engine.getGlInfo()) : ""; } catch { adapter = ""; }
        return {
            engine: engine.isWebGPU ? "WebGPU" : "WebGL" + (engine.webGLVersion || ""),
            adapter,
            hardwareScaling: engine.getHardwareScalingLevel(),
            renderSize: [engine.getRenderWidth(), engine.getRenderHeight()],
            devicePixelRatio: window.devicePixelRatio,
            meshes: scene.meshes.length,
            materials: scene.materials.length,
            textures: scene.textures.length,
            lights: scene.lights.length,
            shadowGenerators: scene.lights.filter((light) => light.getShadowGenerator && light.getShadowGenerator()).length,
            skeletons: (scene.skeletons || []).length,
            animationGroups: (scene.animationGroups || []).length,
            compiledEffects: engine._compiledEffects ? Object.keys(engine._compiledEffects).length : null,
            particleSystems,
            postProcesses: scene.activeCamera && scene.activeCamera._postProcesses ? scene.activeCamera._postProcesses.filter(Boolean).map((post) => post.name) : [],
            physics: !!(scene.getPhysicsEngine && scene.getPhysicsEngine()),
        };
    };

    /** Everything the probe recorded, for the capture script to save. */
    state.dump = () => ({
        engine: state.engine || null,
        engineAttachedAt: state.engineAttachedAt,
        scenesSeen: state.scenesSeen,
        frames: state.frames,
        counters: state.counters,
        marks: state.marks,
        loafs: state.loafs,
        location: location.href,
    });
}
