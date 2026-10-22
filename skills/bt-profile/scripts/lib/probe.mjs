/**
 * The in-page half of the bt-profile capture. `installProbe` is serialised into every document the profiled page
 * opens (puppeteer `evaluateOnNewDocument`), so it must stay self-contained: no imports, no outer variables.
 *
 * It records, on `window.__btProfile`:
 * - one entry per rendered Babylon frame: begin time, CPU work (begin → end of the engine frame), draw calls, active
 *   meshes and particles, and the SceneInstrumentation timers the engine exposes — or, on a page with no Babylon engine,
 *   one entry per browser frame (requestAnimationFrame: time only, `frameSource: "raf"`);
 * - counters sampled every half second: meshes, materials, textures, particle systems, compiled effects (shader
 *   programs / pipelines), JS heap;
 * - long animation frames (LoAF) with their script attribution, when the browser supports them;
 * - every shader module / pipeline (WebGPU) and program (WebGL) the page creates, with its time (`gpuCompiles`);
 * - phase marks set by the scenario (`__btProfile.mark("countdown")`);
 * - the late-stutter sources: the Babylon Toolkit's reveal and every late compile it names with its cause (`reveals`,
 *   `lateCompiles`), downloads (`resources`), GPU textures created (`textures`) and audio decodes (`audioDecodes`).
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
    /** Most shader / pipeline creations kept (a run creates tens to a few thousand). */
    const MAX_GPU_COMPILES = 20000;

    const epochNow = () => performance.timeOrigin + performance.now();
    const state = {
        frames: [],
        counters: [],
        marks: [],
        longFrames: [],
        loafs: [],
        engineAttachedAt: null,
        scenesSeen: 0,
        rafFrames: [],
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

    // Any web app: until a Babylon engine is found, the browser's own frames (requestAnimationFrame) are timed, so a page
    // with no Babylon at all still gets FPS, frame gaps and the timeline. They are used only when no engine ever attaches.
    let rafPrevious = null;
    const onAnimationFrame = (now) => {
        if (hookedEngine != null) return;
        if (rafPrevious != null) state.rafFrames.push({ at: performance.timeOrigin + now, cpuMs: null });
        rafPrevious = now;
        requestAnimationFrame(onAnimationFrame);
    };
    requestAnimationFrame(onAnimationFrame);

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

    // GPU work the main thread does not see: every shader module, render / compute pipeline (WebGPU) and linked program
    // (WebGL) the page creates, with its time. A frame gap with little script in it right after a burst of these is the GPU
    // process compiling pipelines — the classic first-visit stutter (the browser's shader caches hide it on later visits).
    state.gpuCompiles = [];
    const recordCompile = (kind) => { if (state.gpuCompiles.length < MAX_GPU_COMPILES) state.gpuCompiles.push({ at: epochNow(), kind }); };
    const wrapCompile = (prototype, method, kind) => {
        if (!prototype || typeof prototype[method] !== "function") return;
        const original = prototype[method];
        prototype[method] = function (...args) { recordCompile(kind); return original.apply(this, args); };
    };
    if (typeof GPUDevice !== "undefined") {
        wrapCompile(GPUDevice.prototype, "createShaderModule", "shaderModule");
        wrapCompile(GPUDevice.prototype, "createRenderPipeline", "renderPipeline");
        wrapCompile(GPUDevice.prototype, "createRenderPipelineAsync", "renderPipeline");
        wrapCompile(GPUDevice.prototype, "createComputePipeline", "computePipeline");
        wrapCompile(GPUDevice.prototype, "createComputePipelineAsync", "computePipeline");
    }
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
        if (typeof window[name] !== "undefined") wrapCompile(window[name].prototype, "linkProgram", "program");
    }

    // First-use work that lands after the game is revealed — the late-stutter sources. The Babylon Toolkit announces its
    // reveal (SceneManager.OnSceneRevealedObservable) and names every shader / pipeline built after it with its cause
    // (SceneShaderWarmup.OnLateCompileObservable). The probe turns that detector on even in a production build, so a
    // profiled deployed game reports its late compiles too.
    state.reveals = [];
    state.lateCompiles = [];
    state.toolkit = null;
    const MAX_LATE_RECORDS = 5000;
    const hookToolkit = () => {
        const toolkit = window.TOOLKIT;
        if (state.toolkit || !toolkit || !toolkit.SceneShaderWarmup || !toolkit.SceneManager) return;
        const warmup = toolkit.SceneShaderWarmup;
        state.toolkit = { warmup: true, lateCompileDetector: !!warmup.OnLateCompileObservable, forcedReporting: false };
        try {
            if (warmup.OnLateCompileObservable && typeof warmup.IsLateCompileReportingEnabled === "function" && !warmup.IsLateCompileReportingEnabled()) {
                warmup.LateCompileReporting = true;
                state.toolkit.forcedReporting = true;
            }
        } catch { /* an older toolkit without the switch */ }
        try {
            if (toolkit.SceneManager.OnSceneRevealedObservable) {
                toolkit.SceneManager.OnSceneRevealedObservable.add((scene) => {
                    state.reveals.push({ at: epochNow(), sceneUniqueId: scene ? scene.uniqueId : null });
                    try { state.toolkit.safetyNet = typeof warmup.IsSafetyNetEnabled === "function" && scene ? warmup.IsSafetyNetEnabled(scene.getEngine()) : null; } catch { /* not on WebGL */ }
                });
            }
        } catch { /* an older toolkit without the reveal observable */ }
        try {
            if (warmup.OnLateCompileObservable) {
                warmup.OnLateCompileObservable.add((record) => {
                    if (state.lateCompiles.length >= MAX_LATE_RECORDS) return;
                    state.lateCompiles.push({
                        at: epochNow(), kind: record.kind, causeKind: record.causeKind, cause: record.cause, meshName: record.meshName,
                        materialName: record.materialName, particleSystemName: record.particleSystemName, postProcessName: record.postProcessName,
                        renderPassName: record.renderPassName, effectName: record.effectName, effectKey: String(record.effectKey || "").slice(0, 400),
                        msSinceReveal: record.msSinceReveal, sceneUniqueId: record.sceneUniqueId,
                    });
                });
            }
        } catch { /* an older toolkit without the detector */ }
    };
    setInterval(hookToolkit, ATTACH_POLL_MS);

    // Downloads: what the page fetched and when it finished — a texture, model or sound fetched during play is decoded and
    // uploaded right after it arrives, often in one long frame.
    state.resources = [];
    try {
        const resourceObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (state.resources.length >= MAX_LATE_RECORDS) return;
                state.resources.push({
                    startAt: performance.timeOrigin + entry.startTime, at: performance.timeOrigin + entry.responseEnd,
                    name: String(entry.name || "").slice(0, 300), type: entry.initiatorType,
                    kb: +(((entry.encodedBodySize || entry.transferSize || 0)) / 1024).toFixed(1), ms: +entry.duration.toFixed(1),
                });
            }
        });
        resourceObserver.observe({ type: "resource", buffered: true });
    } catch { /* resource timing unavailable */ }

    // GPU textures created (WebGPU createTexture, WebGL texture storage / compressed uploads): a first-time texture during
    // play costs its decode and upload on that frame.
    state.textures = [];
    const recordTexture = (width, height) => { if (state.textures.length < MAX_GPU_COMPILES) state.textures.push({ at: epochNow(), width: width || null, height: height || null }); };
    const wrapTexture = (prototype, method, size) => {
        if (!prototype || typeof prototype[method] !== "function") return;
        const original = prototype[method];
        prototype[method] = function (...args) { try { const [width, height] = size(args); recordTexture(width, height); } catch { recordTexture(null, null); } return original.apply(this, args); };
    };
    if (typeof GPUDevice !== "undefined") {
        wrapTexture(GPUDevice.prototype, "createTexture", (args) => {
            const size = args[0] && args[0].size;
            return Array.isArray(size) ? [size[0], size[1]] : size ? [size.width, size.height] : [null, null];
        });
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
        wrapTexture(WebGL2RenderingContext.prototype, "texStorage2D", (args) => [args[3], args[4]]);
        wrapTexture(WebGL2RenderingContext.prototype, "compressedTexImage2D", (args) => (args[1] === 0 ? [args[3], args[4]] : [null, null]));
    }

    // Audio decoding: a sound decoded the first time it plays stalls that moment (decodeAudioData runs off the main thread,
    // but its arrival and the buffer it creates land on a frame).
    state.audioDecodes = [];
    try {
        const audioPrototype = typeof BaseAudioContext !== "undefined" ? BaseAudioContext.prototype : null;
        if (audioPrototype && typeof audioPrototype.decodeAudioData === "function") {
            const decode = audioPrototype.decodeAudioData;
            audioPrototype.decodeAudioData = function (data, ...rest) {
                const startAt = epochNow();
                const kb = data && data.byteLength ? +(data.byteLength / 1024).toFixed(1) : null;
                const result = decode.call(this, data, ...rest);
                const done = () => { if (state.audioDecodes.length < MAX_LATE_RECORDS) state.audioDecodes.push({ startAt, at: epochNow(), kb }); };
                if (result && typeof result.then === "function") result.then(done, done);
                return result;
            };
        }
    } catch { /* no Web Audio */ }

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
    state.dump = () => {
        // A toolkit found only after its reveal: take the late compiles it kept (their own reveal-relative times).
        try {
            const toolkit = window.TOOLKIT;
            const scene = currentScene();
            if (toolkit && toolkit.SceneShaderWarmup && scene && state.lateCompiles.length === 0 && typeof toolkit.SceneShaderWarmup.GetLateCompiles === "function") {
                for (const record of toolkit.SceneShaderWarmup.GetLateCompiles(scene) || []) state.lateCompiles.push({ ...record, at: null });
            }
        } catch { /* nothing to recover */ }
        return state.snapshot();
    };
    state.snapshot = () => ({
        reveals: state.reveals,
        lateCompiles: state.lateCompiles,
        toolkit: state.toolkit,
        resources: state.resources,
        textures: state.textures,
        audioDecodes: state.audioDecodes,
        engine: state.engine || null,
        engineAttachedAt: state.engineAttachedAt,
        scenesSeen: state.scenesSeen,
        frameSource: state.engine ? "babylon" : "raf",
        frames: state.engine ? state.frames : state.rafFrames,
        counters: state.counters,
        marks: state.marks,
        loafs: state.loafs,
        gpuCompiles: state.gpuCompiles,
        gpuCold: window.__btGpuCold || null,
        location: location.href,
    });
}

/**
 * `--gpu-cold true`: makes every fragment shader unique to this page load, so the GPU process cannot reuse a pipeline
 * compiled on an earlier visit. A fresh Chrome profile only makes the browser cold — on macOS the compiled Metal pipelines
 * live in a system cache outside it, so without this only the first capture after a shader change is a true first visit.
 * Each fragment shader gets a branch that is never taken but cannot be folded away (it compares the pixel position with a
 * random bound), so it renders exactly the same. Nothing on disk is touched. Serialised into every document like
 * `installProbe`, so it must stay self-contained.
 */
export function installGpuCold() {
    const bound = (1000000 + Math.floor(Math.random() * 1000000)) + 0.123;
    const stats = { bound, tagged: 0, untagged: 0 };
    window.__btGpuCold = stats;

    /** WGSL: finds the @fragment entry point and the name of its pixel position, and opens its body with the branch. */
    const tagWgsl = (code) => {
        const head = /@fragment\s+fn\s+\w+\s*\(/.exec(code);
        if (!head) return null;
        // The parameter list holds attributes with their own parentheses (@location(0)): find its matching ")".
        const open = head.index + head[0].length;
        let depth = 1;
        let close = open;
        for (; close < code.length && depth > 0; close++) {
            if (code[close] === "(") depth++;
            else if (code[close] === ")") depth--;
        }
        close--; // the matching ")"
        const body = code.indexOf("{", close);
        if (depth !== 0 || body < 0) return null;
        const parameters = code.slice(open, close);
        const at = body + 1;
        let position = null;
        const direct = /@builtin\s*\(\s*position\s*\)\s*(\w+)\s*:/.exec(parameters);
        if (direct) position = direct[1];
        else {
            for (const typed of parameters.matchAll(/(?:^|,)\s*(\w+)\s*:\s*(\w+)\s*(?=,|$)/g)) {
                const struct = new RegExp(`struct\\s+${typed[2]}\\s*\\{([^}]*)\\}`).exec(code);
                const field = struct && /@builtin\s*\(\s*position\s*\)\s*(\w+)\s*:/.exec(struct[1]);
                if (field) { position = `${typed[1]}.${field[1]}`; break; }
            }
        }
        if (position) return `${code.slice(0, at)}\n  if (${position}.x < -${bound}) { discard; }${code.slice(at)}`;
        // No pixel position among the inputs (a blit, a mip-map pass): add one — a builtin input never shifts the vertex
        // stage's @location interface.
        const kept = parameters.replace(/,\s*$/, "");
        const signature = `${kept}${kept.trim() ? ", " : ""}@builtin(position) btGpuColdPosition : vec4<f32>`;
        return `${code.slice(0, open)}${signature}${code.slice(close, at)}\n  if (btGpuColdPosition.x < -${bound}) { discard; }${code.slice(at)}`;
    };
    if (typeof GPUDevice !== "undefined") {
        const createShaderModule = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function (descriptor) {
            const code = descriptor && typeof descriptor.code === "string" ? descriptor.code : null;
            if (code == null || !code.includes("@fragment")) return createShaderModule.call(this, descriptor);
            const tagged = tagWgsl(code);
            if (tagged == null) { stats.untagged++; return createShaderModule.call(this, descriptor); }
            stats.tagged++;
            return createShaderModule.call(this, { ...descriptor, code: tagged });
        };
    }
    // GLSL (WebGL): a fragment shader's main() opens with the same never-taken branch on gl_FragCoord.
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
        if (typeof window[name] === "undefined") continue;
        const shaderSource = window[name].prototype.shaderSource;
        window[name].prototype.shaderSource = function (shader, source) {
            let fragment = false;
            try { fragment = this.getShaderParameter(shader, this.SHADER_TYPE) === this.FRAGMENT_SHADER; } catch { /* not a shader */ }
            const main = fragment && typeof source === "string" ? /void\s+main\s*\(\s*(void)?\s*\)\s*\{/.exec(source) : null;
            if (!fragment) return shaderSource.call(this, shader, source);
            if (!main) { stats.untagged++; return shaderSource.call(this, shader, source); }
            stats.tagged++;
            const at = main.index + main[0].length;
            return shaderSource.call(this, shader, `${source.slice(0, at)}\n  if (gl_FragCoord.x < -${bound}) discard;${source.slice(at)}`);
        };
    }
}
