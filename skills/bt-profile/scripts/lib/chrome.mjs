/**
 * Finds the Chrome (or Chromium) executable that bt-profile drives: the capture (profile.mjs) and the report's PDF
 * (report.mjs). CHROME_PATH wins; otherwise the usual install locations on macOS, Linux and Windows.
 */
import fs from "node:fs";

/** @returns {string} the path of a Chrome or Chromium executable */
export function findChrome() {
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
    throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium executable.");
}
