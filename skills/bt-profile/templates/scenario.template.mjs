/**
 * bt-profile scenario template — copy to `<project>/.agents/profile/<slug>/data/scenario.mjs` and make it play the
 * moment the user says is slow (a cold load, a level start, a boss fight, a menu → game transition, a page that janks
 * on scroll, a slow route change). It works on any web page; on a Babylon page it also waits for the scene.
 *
 * The capture script calls `run(context)` with:
 *   context.open(urlOrPath?)       navigate (default: the --url given to profile.mjs)
 *   context.expectNavigation()     call before a click that loads a new page (so it is not reported as a reload)
 *   context.mark(name)             start a named phase (the report splits every number by phase)
 *   context.waitFor(fn, { timeout, polling, args })   wait until a page function returns truthy
 *   context.waitForFrames(count)   wait until the page has rendered `count` frames (Babylon frames, else browser frames)
 *   context.evaluate(fn, ...args)  run a function in the page (window.BABYLON, window.TOOLKIT, window.PROJECT)
 *   context.keyDown(key) / keyUp(key) / press(key)   keyboard input ("ArrowUp", "w", "Space", …)
 *   context.sleep(seconds)
 *   context.shot(name)             screenshot — only with --snapshots true, otherwise a no-op
 *   context.options                --args key=value,… parsed into strings (settle = seconds to record after the moment)
 *   context.log(message)
 *
 * Rules that keep captures comparable run to run:
 * - Enter the app the way a player does: open the page they open (usually the home page) and click through what they
 *   click (a menu, a level button — context.expectNavigation() first when the click loads a new page). A deep link you
 *   build yourself can take a path players never take (another route, a server quirk), and then you measure the wrong thing.
 * - Drive the game the way a player would (keys, the game's own components), never by skipping work.
 * - Wait on game state (a phase, a component flag), not on fixed sleeps, for anything that loads.
 * - Mark every phase the user cares about; keep the names stable between runs (before / after compares by name).
 */

/** Shown in the report. */
export const meta = {
    name: "my-scenario",
    description: "Cold load of the page (and its Babylon scene, if any), then N seconds of use.",
};

/** Seconds recorded after the scene is running, unless --args settle=<seconds> overrides it (SKILL.md passes it). */
const DEFAULT_SETTLE_SECONDS = 60;

/**
 * Plays the scenario.
 * @param {object} context - the bt-profile scenario context
 */
export async function run(context) {
    const settleSeconds = Number(context.options.settle || context.options.play || DEFAULT_SETTLE_SECONDS);
    await context.open();
    await context.mark("load");
    // Any web app: wait for the page to load and paint. A Babylon page also waits for its scene below.
    await context.waitFor(() => document.readyState === "complete");
    await context.waitForFrames(30);
    const babylonPage = await context.evaluate(() => window.BABYLON != null);
    if (babylonPage) {
        await context.waitFor(() => {
            const scene = window.BABYLON.EngineStore ? window.BABYLON.EngineStore.LastCreatedScene : null;
            return scene != null && scene.isReady() && scene.activeCamera != null;
        });
        // An empty scene is "ready" too (a game that loads its level later): wait until something is drawn.
        try {
            await context.waitFor(() => {
                const scene = window.BABYLON.EngineStore.LastCreatedScene;
                return scene != null && scene.getActiveMeshes().length > 0;
            }, { timeout: 120000 });
        } catch {
            context.log("nothing was drawn within 120 s — check the smoke run's screenshots (a content server down? a menu to click through?)");
        }
    }
    // Hitches behind the loading screen are load time, not stutter the player sees: mark the moment it goes away.
    // (A toolkit splash fades through opacity 0; adapt the check to the game's own loading screen.)
    try {
        await context.waitFor(() => {
            const splash = document.getElementById("xbabylonjsSplashScreen");
            return splash == null || splash.style.opacity === "0" || getComputedStyle(splash).display === "none";
        }, { timeout: 60000 });
    } catch {
        context.log("the loading screen did not go away within 60 s — adapt the reveal check to this game");
    }
    await context.mark("running");
    await context.shot("running");
    await context.sleep(settleSeconds);
    await context.shot("end-of-play");
}
