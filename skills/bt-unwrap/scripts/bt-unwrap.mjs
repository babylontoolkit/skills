#!/usr/bin/env node
/**
 * bt-unwrap launcher: finds Blender on macOS, Windows or Linux and runs the bt-unwrap pipeline headless.
 *
 *   node bt-unwrap.mjs <model> [options]          run (see --help for every option)
 *   node bt-unwrap.mjs --help                     list every option
 *   node bt-unwrap.mjs --which-blender            print the Blender it would use
 *
 * Launcher-only options (everything else goes to the pipeline):
 *   --blender <path>   use this Blender executable (else $BLENDER, then PATH, then the usual install folders)
 *   --verbose          show Blender's full log instead of only bt-unwrap lines and errors
 *
 * Exit code: the pipeline's — 0 done, 1 failed, 2 bad options.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder holding this launcher; the Blender pipeline lives in its `blender/` subfolder. */
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** The Python entry point Blender runs. */
const PIPELINE_SCRIPT = path.join(SCRIPT_DIRECTORY, 'blender', 'bt_unwrap.py');

/** Lines from Blender worth showing when not --verbose: our own progress plus anything that looks like a failure. */
const IMPORTANT_LINE = /^bt-unwrap:|Traceback|Error|error:|^\s+File "/;

/**
 * Lists the places Blender is usually installed on this platform, newest version first.
 * @returns {string[]} Candidate executable paths (may not exist).
 */
function installedBlenderCandidates() {
    if (process.platform === 'darwin') {
        return ['/Applications/Blender.app/Contents/MacOS/Blender',
            path.join(homedir(), 'Applications/Blender.app/Contents/MacOS/Blender')];
    }
    if (process.platform === 'win32') {
        const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
            .map((root) => path.join(root, 'Blender Foundation'));
        const candidates = [];
        for (const root of roots) {
            if (!existsSync(root)) continue;
            const versions = readdirSync(root).filter((name) => name.toLowerCase().startsWith('blender'))
                .sort((first, second) => second.localeCompare(first, undefined, { numeric: true }));
            candidates.push(...versions.map((name) => path.join(root, name, 'blender.exe')));
        }
        return candidates;
    }
    const optFolders = existsSync('/opt') ? readdirSync('/opt').filter((name) => name.startsWith('blender'))
        .map((name) => path.join('/opt', name, 'blender')) : [];
    return ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', ...optFolders];
}

/**
 * Checks whether a command resolves on PATH.
 * @param {string} command - Command name.
 * @returns {boolean} True when it runs.
 */
function isOnPath(command) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return probe.status === 0;
}

/**
 * Picks the Blender executable to use.
 * @param {string | undefined} explicitPath - Path from --blender.
 * @returns {string} The executable.
 * @throws {Error} When no Blender can be found.
 */
function findBlender(explicitPath) {
    const configured = explicitPath || process.env.BLENDER;
    if (configured) {
        if (!existsSync(configured)) throw new Error(`Blender not found at ${configured}`);
        return configured;
    }
    if (isOnPath('blender')) return 'blender';
    const installed = installedBlenderCandidates().find((candidate) => existsSync(candidate));
    if (installed) return installed;
    throw new Error('Blender not found. Install Blender 4.2+ (5.x recommended), or pass --blender <path> / set BLENDER.');
}

/**
 * Splits launcher-only options from the options meant for the pipeline.
 * @param {string[]} argv - Command-line arguments after the script name.
 * @returns {{ blenderPath: string | undefined, verbose: boolean, whichBlender: boolean, pipelineArguments: string[] }}
 */
function parseLauncherArguments(argv) {
    const pipelineArguments = [];
    let blenderPath;
    let verbose = false;
    let whichBlender = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--blender') {
            blenderPath = argv[index + 1];
            index += 1;
        } else if (argument === '--verbose') {
            verbose = true;
        } else if (argument === '--which-blender') {
            whichBlender = true;
        } else {
            pipelineArguments.push(argument);
        }
    }
    return { blenderPath, verbose, whichBlender, pipelineArguments };
}

/**
 * Prints a child stream line by line, keeping only important lines unless verbose.
 * @param {import('node:stream').Readable} stream - Blender's stdout or stderr.
 * @param {NodeJS.WriteStream} destination - Where to print.
 * @param {boolean} showEverything - Print every line.
 */
function relayLines(stream, destination, showEverything) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
            if (showEverything || IMPORTANT_LINE.test(line)) destination.write(`${line}\n`);
        }
    });
    stream.on('end', () => {
        if (pending && (showEverything || IMPORTANT_LINE.test(pending))) destination.write(`${pending}\n`);
    });
}

/**
 * Runs the pipeline and resolves with Blender's exit code.
 * @returns {Promise<number>} Exit code.
 */
async function main() {
    const { blenderPath, verbose, whichBlender, pipelineArguments } = parseLauncherArguments(process.argv.slice(2));
    let blender;
    try {
        blender = findBlender(blenderPath);
    } catch (error) {
        process.stderr.write(`bt-unwrap: ${error.message}\n`);
        return 1;
    }
    if (whichBlender) {
        process.stdout.write(`${blender}\n`);
        return 0;
    }
    const wantsHelp = pipelineArguments.length === 0 || pipelineArguments.includes('--help') || pipelineArguments.includes('-h');
    const blenderArguments = ['--background', '--factory-startup', '--python-exit-code', '1',
        '--python', PIPELINE_SCRIPT, '--', ...(pipelineArguments.length ? pipelineArguments : ['--help'])];
    const environment = verbose ? { ...process.env, BT_UNWRAP_TRACEBACK: '1' } : process.env;
    const child = spawn(blender, blenderArguments, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    relayLines(child.stdout, process.stdout, verbose || wantsHelp);
    relayLines(child.stderr, process.stderr, verbose || wantsHelp);
    return new Promise((resolve) => {
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', (error) => {
            process.stderr.write(`bt-unwrap: could not start Blender: ${error.message}\n`);
            resolve(1);
        });
    });
}

process.exitCode = await main();
