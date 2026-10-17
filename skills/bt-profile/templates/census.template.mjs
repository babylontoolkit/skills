/**
 * bt-profile census template — when the profile says a cheap function runs far too often, count who calls it.
 * Copy to the scratchpad (not the project), adapt `reachTheMoment`, and run it through profile.mjs with --heap false:
 *
 *   CENSUS_OUT=/abs/census.json node "$TOOLS/profile.mjs" --url "$URL" --scenario /abs/census.mjs --out /abs/census-run --heap false \
 *     --args method=TransformNode.prototype.computeWorldMatrix,seconds=1
 *
 * It wraps the method for `seconds` of play and records, per object (`this.name`, plus "[arg0]" when the first
 * argument is truthy — e.g. a forced recompute), calls per frame and one sample call stack.
 */

/** Shown in the report. */
export const meta = { name: "census", description: "Calls per frame of one prototype method, per object, with a sample stack." };

/**
 * Installs the counting wrapper in the page.
 * @param {string} methodPath - "Class.prototype.method" under window.BABYLON (or a full "TOOLKIT.Class.prototype.method")
 */
function startCensus(methodPath) {
    const parts = methodPath.split(".");
    const root = parts[0] === "TOOLKIT" || parts[0] === "PROJECT" ? window[parts.shift()] : window.BABYLON;
    const methodName = parts.pop();
    const owner = parts.reduce((object, key) => object[key], root);
    const original = owner[methodName];
    const scene = window.BABYLON.EngineStore.LastCreatedScene;
    const census = window.__btCensus = { calls: new Map(), stacks: new Map(), frames: 0 };
    const frameObserver = scene.onAfterRenderObservable.add(() => { census.frames++; });
    owner[methodName] = function (...args) {
        const key = `${this && this.name !== undefined ? this.name : "(no name)"}${args[0] ? " [arg0]" : ""}`;
        census.calls.set(key, (census.calls.get(key) || 0) + 1);
        if (!census.stacks.has(key) && census.stacks.size < 500) census.stacks.set(key, new Error().stack.split("\n").slice(2, 10).map((line) => line.trim()).join(" | "));
        return original.apply(this, args);
    };
    census.stop = () => { owner[methodName] = original; scene.onAfterRenderObservable.remove(frameObserver); };
}

/** Removes the wrapper and returns the per-object counts, busiest first. */
function stopCensus() {
    const census = window.__btCensus;
    census.stop();
    const frames = Math.max(1, census.frames);
    const total = [...census.calls.values()].reduce((sum, count) => sum + count, 0);
    return {
        frames: census.frames,
        callsPerFrame: +(total / frames).toFixed(1),
        top: [...census.calls].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([key, count]) => ({ key, perFrame: +(count / frames).toFixed(2), stack: census.stacks.get(key) })),
    };
}

/**
 * Gets the game to the moment worth counting. Adapt: wait on the game's own state, hold keys like a player.
 * @param {object} context - the bt-profile scenario context
 */
async function reachTheMoment(context) {
    await context.open();
    await context.waitFor(() => {
        const scene = window.BABYLON && window.BABYLON.EngineStore ? window.BABYLON.EngineStore.LastCreatedScene : null;
        return scene != null && scene.isReady() && scene.activeCamera != null;
    });
    await context.waitForFrames(120);
}

/**
 * Runs the census.
 * @param {object} context - the bt-profile scenario context
 */
export async function run(context) {
    const methodPath = context.options.method || "TransformNode.prototype.computeWorldMatrix";
    await reachTheMoment(context);
    await context.evaluate(startCensus, methodPath);
    await context.sleep(Number(context.options.seconds || 1));
    const result = await context.evaluate(stopCensus);
    const fs = await import("node:fs");
    if (process.env.CENSUS_OUT) fs.writeFileSync(process.env.CENSUS_OUT, JSON.stringify(result, null, 1));
    context.log(`census ${methodPath}: ${result.callsPerFrame} calls per frame over ${result.frames} frames; top: ${result.top.slice(0, 5).map((entry) => `${entry.key} ${entry.perFrame}/f`).join(", ")}`);
}
