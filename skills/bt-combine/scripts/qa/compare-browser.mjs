/**
 * bt-combine browser check: loads each exported scene in the toolkit's player page (headless Chrome), captures the
 * same moments after load, and records console errors and load time. Comparing captures of the source scene and the
 * combined scene at the same moment shows whether a merge changed what the player sees (time-driven flythroughs land
 * on the same frame within a second or so; capture a burst to line them up).
 *
 * Usage:
 *   node compare-browser.mjs --base http://localhost:8888 --scenes original.gltf,combined.gltf --times 10,15,20,30 --out ./captures
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

/** Default capture moments, in seconds after the page's load event. */
const DEFAULT_TIMES = "10,15,20,30";

/** Viewport used for every capture, in CSS pixels. */
const VIEWPORT = { width: 1600, height: 900 };

/** How long to wait for the player page's load event, in milliseconds. */
const NAVIGATION_TIMEOUT_MS = 120000;

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
                path.join(cacheRoot, version, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
                path.join(cacheRoot, version, "chrome-linux64", "chrome"),
                path.join(cacheRoot, version, "chrome-win64", "chrome.exe"),
            ].find((candidate) => fs.existsSync(candidate));
            if (cached) return cached;
        }
    }
    throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium executable.");
}

/**
 * Loads one scene, captures every requested moment, and reports what happened.
 * @param {import("puppeteer-core").Browser} browser - the running browser
 * @param {string} baseUrl - dev server root, e.g. http://localhost:8888
 * @param {string} sceneFile - exported scene file name under scenes/, e.g. Level01.gltf
 * @param {number[]} captureSeconds - moments to capture, in seconds after load, ascending
 * @param {string} outputFolder - where the PNGs are written
 * @returns {Promise<{scene: string, loadMilliseconds: number, captures: string[], consoleErrors: string[]}>}
 */
async function captureScene(browser, baseUrl, sceneFile, captureSeconds, outputFolder) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const consoleErrors = [];
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    const loadStart = Date.now();
    await page.goto(`${baseUrl}/index.html?scene=${encodeURIComponent(sceneFile)}`, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    const loadMilliseconds = Date.now() - loadStart;

    const captures = [];
    const sceneName = path.basename(sceneFile, path.extname(sceneFile));
    let elapsedSeconds = 0;
    for (const seconds of captureSeconds) {
        await new Promise((resolve) => setTimeout(resolve, (seconds - elapsedSeconds) * 1000));
        elapsedSeconds = seconds;
        const capturePath = path.join(outputFolder, `${sceneName}_${seconds}s.png`);
        await page.screenshot({ path: capturePath });
        captures.push(capturePath);
    }
    await page.close();
    return { scene: sceneFile, loadMilliseconds, captures, consoleErrors };
}

/**
 * Writes sheet.html and sheet.png into the output folder: one row per capture moment, one column per scene, so
 * matching views (and a load-time offset between runs) are easy to spot at a glance.
 * @param {import("puppeteer-core").Browser} browser - the running browser
 * @param {{scene: string, captures: string[]}[]} results - captureScene results, in column order
 * @param {number[]} captureSeconds - the capture moments, in row order
 * @param {string} outputFolder - where the sheet is written
 * @returns {Promise<string>} path of sheet.png
 */
async function writeContactSheet(browser, results, captureSeconds, outputFolder) {
    const header = results.map((result) => `<th>${result.scene}</th>`).join("");
    const rows = captureSeconds.map((seconds, row) => {
        const cells = results.map((result) => `<td><img src="file://${result.captures[row]}"></td>`).join("");
        return `<tr><td>${seconds}s</td>${cells}</tr>`;
    }).join("");
    const html = `<html><body style="margin:0;background:#222;color:#fff;font:14px sans-serif"><table><tr><th></th>${header}</tr>${rows}</table>`
        + "<style>img{width:480px;display:block}</style></body></html>";
    const htmlPath = path.join(outputFolder, "sheet.html");
    const sheetPath = path.join(outputFolder, "sheet.png");
    fs.writeFileSync(htmlPath, html);
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 400 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
    await page.screenshot({ path: sheetPath, fullPage: true });
    await page.close();
    return sheetPath;
}

/** Entry point: captures every scene, writes the contact sheet, and prints a JSON summary. */
async function main() {
    const flags = parseArguments(process.argv.slice(2));
    const baseUrl = (flags.base || "http://localhost:8888").replace(/\/$/, "");
    const scenes = (flags.scenes || "").split(",").filter(Boolean);
    const captureSeconds = (flags.times || DEFAULT_TIMES).split(",").map(Number).sort((first, second) => first - second);
    const outputFolder = path.resolve(flags.out || "./captures");
    if (scenes.length === 0) throw new Error("Pass --scenes original.gltf,combined.gltf");
    fs.mkdirSync(outputFolder, { recursive: true });

    const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: "new",
        args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--allow-file-access-from-files"],
    });
    try {
        const results = [];
        for (const sceneFile of scenes) {
            results.push(await captureScene(browser, baseUrl, sceneFile, captureSeconds, outputFolder));
        }
        const sheet = await writeContactSheet(browser, results, captureSeconds, outputFolder);
        process.stdout.write(JSON.stringify({ sheet, results }, null, 2) + "\n");
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
