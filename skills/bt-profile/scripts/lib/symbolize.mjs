/**
 * Turns raw V8 call frames (script id, URL, 0-based line / column) into readable, owned locations:
 * the original file and line (through the script's source map when it has one), the enclosing class
 * (`StandardKartController.update` instead of `update`), and the owner — your project, a project-owned bundle,
 * the toolkit, Babylon, physics, shader translation, React, other vendors, or the browser itself.
 */
import fs from "node:fs";
import path from "node:path";
import sourceMap from "source-map-js";

/** Owners whose code the user writes and can change. Config owners may add to this (`yours: true`). */
export const YOUR_OWNERS = new Set(["project"]);

/** Built-in owner labels for the report. */
export const OWNER_LABELS = {
    project: "Your game code",
    toolkit: "Babylon Toolkit runtime",
    babylon: "BabylonJS engine",
    physics: "Havok physics",
    shader: "Shader translation (GLSL → WGSL)",
    react: "React / router",
    vendor: "Other libraries",
    gc: "Garbage collection",
    program: "Browser (parse, compile, layout, GPU IPC)",
    idle: "Idle",
    native: "Browser API",
};

/** Synthetic V8 frames that are never code. */
const SPECIAL_FRAMES = { "(garbage collector)": "gc", "(program)": "program", "(idle)": "idle", "(root)": "root" };

/**
 * Builds a symbolizer for one capture.
 * @param {object} options
 * @param {string} options.scriptsDir - the capture's scripts/ folder (index.json, <id>.js, <id>.map.json)
 * @param {string} options.projectRoot - absolute project root, to resolve dev-server paths to files
 * @param {{match: string, owner: string, label?: string, yours?: boolean, sourceRoots?: string[]}[]} options.owners - config owner rules
 * @returns {{frame: Function, line: Function, ownerOf: Function, labels: object, yours: Set<string>, scripts: Map}} the symbolizer
 */
export function createSymbolizer({ scriptsDir, projectRoot, owners = [] }) {
    const index = fs.existsSync(path.join(scriptsDir, "index.json")) ? JSON.parse(fs.readFileSync(path.join(scriptsDir, "index.json"), "utf8")) : [];
    const scripts = new Map(index.map((entry) => [entry.scriptId, entry]));
    const ownerRules = owners.map((rule) => ({ ...rule, pattern: new RegExp(rule.match) }));
    const labels = { ...OWNER_LABELS };
    const yours = new Set(YOUR_OWNERS);
    for (const rule of ownerRules) {
        if (rule.label) labels[rule.owner] = rule.label;
        if (rule.yours !== false) yours.add(rule.owner);
    }
    const textCache = new Map();
    const consumerCache = new Map();
    const classSpanCache = new Map();
    const frameCache = new Map();
    const classFileCache = new Map();

    /** Returns the generated text of a script, or null. */
    const scriptText = (scriptId) => {
        const key = `script:${scriptId}`;
        if (textCache.has(key)) return textCache.get(key);
        const file = path.join(scriptsDir, `${scriptId}.js`);
        const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        textCache.set(key, text);
        return text;
    };

    /** Returns a source-map consumer for a script, or null. */
    const consumerFor = (scriptId) => {
        if (consumerCache.has(scriptId)) return consumerCache.get(scriptId);
        let consumer = null;
        const file = path.join(scriptsDir, `${scriptId}.map.json`);
        if (fs.existsSync(file)) {
            try { consumer = new sourceMap.SourceMapConsumer(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { consumer = null; }
        }
        consumerCache.set(scriptId, consumer);
        return consumer;
    };

    /**
     * Maps a dev-server or file URL to a local file path when one exists.
     * @returns {string|null} absolute file path
     */
    const urlToFile = (url) => {
        if (!url) return null;
        let pathname;
        try { pathname = decodeURIComponent(new URL(url).pathname); } catch { pathname = url; }
        if (url.startsWith("file://")) return fs.existsSync(pathname) ? pathname : null;
        if (pathname.startsWith("/@fs/")) {
            const absolute = pathname.slice(4);
            return fs.existsSync(absolute) ? absolute : null;
        }
        if (path.isAbsolute(pathname) && fs.existsSync(pathname) && !pathname.startsWith("/src/") && !pathname.startsWith("/node_modules/")) return pathname;
        const candidates = [path.join(projectRoot, pathname), path.join(projectRoot, "public", pathname)];
        return candidates.find((candidate) => fs.existsSync(candidate)) || null;
    };

    /** Owner of a script URL by the config rules, then the built-in rules. */
    const ownerOfUrl = (url) => {
        for (const rule of ownerRules) if (rule.pattern.test(url)) return rule.owner;
        if (/glslang|twgsl/i.test(url)) return "shader";
        if (/havok|Physics\/v2\//i.test(url)) return "physics";
        if (/@babylonjs-toolkit|Runtime\/ESM\//.test(url)) return "toolkit";
        if (/node_modules\/@babylonjs\//.test(url)) return "babylon";
        if (/node_modules\/(\.vite\/deps\/)?(react|react-dom|scheduler|react-router|react-router-dom)([/._]|$)/.test(url)) return "react";
        // A pre-bundled dependency served from any optimizer cache folder (`.vite/deps/`, a custom cacheDir's `deps/`).
        if (/\/deps\/(react|react-dom|scheduler|react-router|react-router-dom)[_.]/.test(url)) return "react";
        if (/\/deps\/@babylonjs_/.test(url)) return "babylon";
        if (/node_modules\//.test(url)) return "vendor";
        let pathname = "";
        try { pathname = new URL(url).pathname; } catch { pathname = url; }
        if (pathname.startsWith("/src/") || pathname.startsWith("/@fs/") && pathname.includes(projectRoot)) return "project";
        if (/\.wasm$/.test(pathname)) return "vendor";
        return "vendor";
    };

    /**
     * Owner of an original source file (a source-mapped frame): the file a bundle was built from names its library even when
     * the bundle's URL does not (a dependency chunk, a custom optimizer cache). Null when the path says nothing.
     */
    const ownerOfSourcePath = (file) => {
        const normalized = file.split(path.sep).join("/");
        if (/glslang|twgsl/i.test(normalized)) return "shader";
        if (/havok|\/Physics\/v2\//i.test(normalized)) return "physics";
        if (/@babylonjs-toolkit\/|\/Runtime\/ESM\//.test(normalized)) return "toolkit";
        if (/node_modules\/@babylonjs\//.test(normalized)) return "babylon";
        if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(normalized)) return "react";
        if (/node_modules\//.test(normalized)) return "vendor";
        if (normalized.startsWith(projectRoot.split(path.sep).join("/") + "/")) return "project";
        return null;
    };

    /** Splits text into line-start offsets (cached with the text). */
    const lineStarts = (text) => {
        const starts = [0];
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
        return starts;
    };

    /** Finds every `class Name { … }` span in a text (strings, comments and template literals skipped). */
    const classSpans = (cacheKey, text) => {
        if (classSpanCache.has(cacheKey)) return classSpanCache.get(cacheKey);
        const spans = [];
        const stack = [];
        const templateDepths = [];
        let depth = 0;
        let pendingClass = null;
        let i = 0;
        const length = text.length;
        while (i < length) {
            const character = text[i];
            const next = text[i + 1];
            if (character === "/" && next === "/") { const end = text.indexOf("\n", i); i = end < 0 ? length : end; continue; }
            if (character === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? length : end + 2; continue; }
            if (character === "'" || character === "\"") {
                i++;
                while (i < length && text[i] !== character) { if (text[i] === "\\") i++; if (text[i] === "\n") break; i++; }
                i++;
                continue;
            }
            if (character === "`") {
                i++;
                while (i < length && text[i] !== "`") {
                    if (text[i] === "\\") { i += 2; continue; }
                    if (text[i] === "$" && text[i + 1] === "{") { templateDepths.push(depth); depth++; i += 2; break; }
                    i++;
                }
                if (text[i] === "`") i++;
                continue;
            }
            if (character === "}" && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth - 1) {
                // End of a ${…} expression: resume the template literal.
                depth--;
                templateDepths.pop();
                i++;
                while (i < length && text[i] !== "`") {
                    if (text[i] === "\\") { i += 2; continue; }
                    if (text[i] === "$" && text[i + 1] === "{") { templateDepths.push(depth); depth++; i += 2; break; }
                    i++;
                }
                if (text[i] === "`") i++;
                continue;
            }
            if (character === "c" && text.startsWith("class", i) && !/[\w$]/.test(text[i - 1] || " ") && /\s/.test(text[i + 5] || "")) {
                const match = /^class\s+([A-Za-z_$][\w$]*)/.exec(text.slice(i, i + 200));
                if (match) pendingClass = { name: match[1], start: i };
                i += 5;
                continue;
            }
            if (character === "{") {
                if (pendingClass) { stack.push({ ...pendingClass, depth }); pendingClass = null; }
                depth++;
            } else if (character === "}") {
                depth--;
                const top = stack[stack.length - 1];
                if (top && top.depth === depth) { spans.push({ name: top.name, start: top.start, end: i }); stack.pop(); }
            }
            i++;
        }
        classSpanCache.set(cacheKey, spans);
        return spans;
    };

    /** Innermost class whose span contains a 0-based line / column of a text. */
    const enclosingClass = (cacheKey, text, line, column) => {
        if (!text) return null;
        const startsKey = `${cacheKey}:starts`;
        if (!textCache.has(startsKey)) textCache.set(startsKey, lineStarts(text));
        const starts = textCache.get(startsKey);
        const offset = (starts[line] ?? 0) + column;
        let best = null;
        for (const span of classSpans(cacheKey, text)) {
            if (span.start <= offset && offset <= span.end && (!best || span.start > best.start)) best = span;
        }
        return best ? best.name : null;
    };

    /**
     * Finds the TypeScript / JavaScript file that declares a class under the rule's source roots, and the line of a
     * method in it — for bundles that ship without source maps but keep their class and method names.
     * @returns {{file: string, line: number}|null} 1-based line
     */
    const locateInSourceRoots = (roots, className, methodName) => {
        if (!roots || roots.length === 0 || !className) return null;
        const cacheKey = `${roots.join("|")}:${className}`;
        if (!classFileCache.has(cacheKey)) {
            let found = null;
            const pattern = new RegExp(`\\bclass\\s+${className}\\b`);
            const walk = (directory) => {
                if (found) return;
                let entries = [];
                try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (found) return;
                    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
                    const full = path.join(directory, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                        const text = fs.readFileSync(full, "utf8");
                        if (pattern.test(text)) found = { file: full, text };
                    }
                }
            };
            for (const root of roots) walk(root);
            classFileCache.set(cacheKey, found);
        }
        const found = classFileCache.get(cacheKey);
        if (!found) return null;
        const lines = found.text.split("\n");
        const classLine = lines.findIndex((text) => new RegExp(`\\bclass\\s+${className}\\b`).test(text));
        let line = classLine;
        if (methodName) {
            const bare = methodName.replace(/^(get|set|async|static)\s+/, "");
            const methodPattern = new RegExp(`^\\s*(public |protected |private |static |async |readonly |override |get |set )*${bare.replace(/[$]/g, "\\$")}\\s*[(<]`);
            const methodLine = lines.findIndex((text, lineIndex) => lineIndex > classLine && methodPattern.test(text));
            if (methodLine >= 0) line = methodLine;
        }
        return { file: found.file, line: line + 1 };
    };

    /**
     * Symbolizes one V8 call frame.
     * @param {{functionName: string, scriptId: string, url: string, lineNumber: number, columnNumber: number}} callFrame
     * @returns {{key: string, name: string, owner: string, file: string|null, line: number|null, url: string, native: boolean, special: string|null}}
     */
    const frame = (callFrame) => {
        const cacheKey = `${callFrame.scriptId}:${callFrame.lineNumber}:${callFrame.columnNumber}:${callFrame.functionName}`;
        if (frameCache.has(cacheKey)) return frameCache.get(cacheKey);
        const special = SPECIAL_FRAMES[callFrame.functionName];
        let result;
        if (special && !callFrame.url) {
            result = { key: special, name: callFrame.functionName, owner: special, file: null, line: null, url: "", native: false, special };
        } else if (!callFrame.url) {
            const name = callFrame.functionName || "(native)";
            result = { key: `native|${name}`, name, owner: "native", file: null, line: null, url: "", native: true, special: null };
        } else {
            result = symbolizeScriptFrame(callFrame);
        }
        frameCache.set(cacheKey, result);
        return result;
    };

    /** Symbolizes a frame that belongs to a script (has a URL). */
    const symbolizeScriptFrame = (callFrame) => {
        const url = callFrame.url;
        let owner = ownerOfUrl(url);
        const rule = ownerRules.find((candidate) => candidate.pattern.test(url));
        const functionName = callFrame.functionName || "";
        let file = urlToFile(url.replace(/\?.*$/, ""));
        let line = callFrame.lineNumber + 1;
        let className = null;
        const consumer = consumerFor(callFrame.scriptId);
        let mapped = false;
        if (consumer && callFrame.lineNumber >= 0) {
            const original = consumer.originalPositionFor({ line: callFrame.lineNumber + 1, column: Math.max(0, callFrame.columnNumber) });
            if (original && original.source) {
                const sourcePath = resolveMappedSource(url, original.source);
                const content = consumer.sourceContentFor(original.source, true);
                if (sourcePath || content) {
                    if (sourcePath) file = sourcePath;
                    line = original.line;
                    mapped = true;
                    const text = content || (sourcePath ? safeRead(sourcePath) : null);
                    className = enclosingClass(`src:${sourcePath || original.source}`, text, original.line - 1, original.column || 0);
                }
            }
        }
        // Config rules are authoritative; otherwise the mapped original file decides (its URL can be a generic bundle).
        if (mapped && file && !rule) owner = ownerOfSourcePath(file) || owner;
        if (!mapped && callFrame.lineNumber >= 0) {
            className = enclosingClass(`script:${callFrame.scriptId}`, scriptText(callFrame.scriptId), callFrame.lineNumber, Math.max(0, callFrame.columnNumber));
        }
        if (!mapped && rule && rule.sourceRoots) {
            const located = locateInSourceRoots(rule.sourceRoots, className, functionName);
            if (located) { file = located.file; line = located.line; }
        }
        const bareName = functionName || "(anonymous)";
        const name = className && functionName && functionName !== className ? `${className}.${functionName}` : (className && !functionName ? `${className} (anonymous fn)` : bareName);
        const shortUrl = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
        const where = file || shortUrl;
        return { key: `${owner}|${where}|${line}|${name}`, name, owner, file, line, url: shortUrl, native: false, special: null, wasm: /\.wasm$/.test(shortUrl) };
    };

    /** Resolves a source-map `sources` entry to a local file. */
    const resolveMappedSource = (scriptUrl, source) => {
        if (path.isAbsolute(source) && fs.existsSync(source)) return source;
        try {
            const resolved = new URL(source, scriptUrl).href;
            return urlToFile(resolved);
        } catch {
            return null;
        }
    };

    const safeRead = (file) => {
        const key = `file:${file}`;
        if (textCache.has(key)) return textCache.get(key);
        let text = null;
        try { text = fs.readFileSync(file, "utf8"); } catch { text = null; }
        textCache.set(key, text);
        return text;
    };

    /**
     * Maps a generated 1-based line of a script (a CPU profile `positionTicks` line) to the original file and line.
     * @returns {{file: string|null, line: number}} the location
     */
    const line = (scriptId, url, generatedLine) => {
        const consumer = consumerFor(scriptId);
        if (consumer) {
            const original = consumer.originalPositionFor({ line: generatedLine, column: 0, bias: sourceMap.SourceMapConsumer.LEAST_UPPER_BOUND });
            if (original && original.source && original.line) return { file: resolveMappedSource(url, original.source), line: original.line };
        }
        return { file: urlToFile(url.replace(/\?.*$/, "")), line: generatedLine };
    };

    return { frame, line, ownerOf: ownerOfUrl, labels, yours, scripts, readFile: safeRead };
}
