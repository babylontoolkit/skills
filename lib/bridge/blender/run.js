'use strict';

/**
 * Runs one Blender script job (T25 step 2, D40):
 *   "$BLENDER" --background --factory-startup --python-exit-code 1 --python <script> -- <jobDir>/io.json
 *
 * Every input and output is resolved under the Unity project; existing outputs inside `Assets/` are
 * copied to `<file>~` first; every declared output must be written by THIS run, or the job fails
 * naming the missing files.
 */

const fs = require('fs');
const path = require('path');

const defaultLog = require('../log');
const { capText, isSafeJobId } = require('../protocol');
const { helperTier, resolveProjectPath, pruneEmptyScratchDirs } = require('../unity/guard');
const { runProcess: defaultRunProcess } = require('../unity/run');

const PREAMBLE =
  "import json, sys\n_io = json.load(open(sys.argv[sys.argv.index('--') + 1]))\nBRIDGE_INPUTS = _io['inputs']\nBRIDGE_OUTPUTS = _io['outputs']\n";
const NO_BLENDER = 'Blender was not found on this computer. Run bt-agent bridge with --blender <path>.';
const CANCELLED = 'Cancel requested — the Blender run was stopped.';
const PROGRESS_EVERY_MS = 500;

/**
 * @param {import('../protocol').BridgeDispatch} dispatch
 * @param {{
 *   project: { key: string, name: string, root: string, toolkitVersion?: string },
 *   blender?: { path: string, version: string },
 *   emit: (event: import('../protocol').BridgeJobEvent) => Promise<void>,
 *   signal?: AbortSignal,
 *   noScripts?: boolean,
 *   runProcess?: import('../unity/run').RunProcess,
 *   log?: { op: (tier: string, label: string) => void },
 *   now?: () => number,
 * }} deps
 * @returns {Promise<void>}
 */
async function executeBlender(dispatch, deps) {
  const { project, blender, emit, signal, noScripts = false, runProcess = defaultRunProcess, log = defaultLog, now = Date.now } = deps;
  const jobId = dispatch.jobId;
  // The id names the job folder that is removed afterwards — never run one that is not a plain token (D3).
  if (!isSafeJobId(jobId)) return;
  const op = /** @type {any} */ (dispatch.op);
  const P = project.root;
  /** @param {string} reason */
  const refuse = (reason) => emit({ jobId, type: 'refused', reason });

  // 1. guard: tiers, then every input and output under the project
  const tier = helperTier(dispatch, project, { noScripts });
  if (!tier.ok) return refuse(tier.reason);
  if (op.kind !== 'blender.script') return refuse(`This runner only runs Blender scripts, not "${op.kind}".`);
  /** @type {string[]} */
  const inputs = [];
  /** @type {string[]} */
  const outputs = [];
  for (const [list, into] of /** @type {[string[], string[]][]} */ ([
    [op.inputs, inputs],
    [op.outputs, outputs],
  ])) {
    for (const rel of list) {
      const abs = resolveProjectPath(P, rel);
      if (!abs) return refuse(`The path "${rel}" is outside the Unity project.`);
      into.push(abs);
    }
  }
  if (!blender) return refuse(NO_BLENDER);

  // 2–4. job dir, io.json, script.py, backups
  const jobDir = path.join(P, '.bridge', 'blender', jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const ioPath = path.join(jobDir, 'io.json');
  const scriptPath = path.join(jobDir, 'script.py');
  fs.writeFileSync(ioPath, JSON.stringify({ inputs, outputs }));
  fs.writeFileSync(scriptPath, PREAMBLE + '\n' + op.source);
  const assets = path.join(P, 'Assets') + path.sep;
  // Decide every backup BEFORE writing any: a model that also declares `Knight.fbx~` would otherwise get the
  // fresh backup of Knight.fbx backed up again as `Knight.fbx~~`. A `~` file is itself a backup — never re-backed-up.
  const toBackUp = outputs.filter((out) => out.startsWith(assets) && !out.endsWith('~') && fs.existsSync(out));
  for (const out of toBackUp) fs.copyFileSync(out, `${out}~`);
  for (const out of outputs) fs.mkdirSync(path.dirname(out), { recursive: true });

  // 5. started
  await emit({ jobId, type: 'started' });
  log.op(tier.tier, `blender ${path.basename(blender.path)} (${outputs.length} output(s))`);

  let lastProgress = 0;
  /** @param {string} line */
  const onLine = (line) => {
    const t = now();
    if (t - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = t;
    emit({ jobId, type: 'progress', line: capText(line, 500) }).catch(() => {});
  };

  // 6. run
  const startMs = now();
  let result;
  try {
    const res = await runProcess(
      blender.path,
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', scriptPath, '--', ioPath],
      { cwd: P, timeoutMs: op.timeoutSeconds * 1000, signal, onLine }
    );
    const text = [res.stdout, res.stderr].filter(Boolean).join('\n');
    if (res.aborted || (signal && signal.aborted)) {
      result = { ok: false, text: CANCELLED };
    } else if (res.timedOut) {
      result = { ok: false, text: capText(`Blender timed out after ${op.timeoutSeconds} s.\n${text}`) };
    } else {
      // 7. every declared output must be written by this run
      const missing = outputs.filter((out) => {
        try {
          return fs.statSync(out).mtimeMs < startMs;
        } catch {
          return true;
        }
      });
      if (missing.length) {
        const names = missing.map((m) => path.relative(P, m).split(path.sep).join('/'));
        result = { ok: false, text: capText(`Blender finished but did not write: ${names.join(', ')}\n${text}`), exitCode: res.code ?? undefined };
      } else {
        // 8.
        result = { ok: res.code === 0, text: capText(text || `Blender exited with code ${res.code}`), exitCode: res.code ?? undefined };
      }
    }
  } catch (err) {
    result = { ok: false, text: `The Desktop Agent failed: ${err && err.message ? err.message : err}` };
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // scratch clean-up is best effort
    }
    pruneEmptyScratchDirs(P);
  }
  await emit({ jobId, type: 'final', result });
}

module.exports = { executeBlender, PREAMBLE, NO_BLENDER };
