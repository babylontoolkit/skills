'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/**
 * The local Agent Reference.
 *
 * Agents used to fetch the Agent Reference and its sub-documents from GitHub on every session. A local
 * copy is read faster, never fails a fetch, can be searched instead of read whole (the toolkit's API
 * declarations alone are 2.7 MB), and stays in step with the installed skills. The copy is downloaded
 * from GitHub at install time — not bundled in the npm package — so a Reference edit reaches agents
 * with `bt-agent update`, without an npm release.
 *
 * Every link into the Reference repo is rewritten to the local file, in the copy and in the installed
 * skills, so an agent simply reads the path it is given. The source repo is never changed, and the
 * persona keeps the GitHub address as the fallback.
 */

const REFERENCE_REPO = 'babylontoolkit/agent';
const REFERENCE_BRANCH = 'main';
const REFERENCE_URL_PREFIX = `https://raw.githubusercontent.com/${REFERENCE_REPO}/${REFERENCE_BRANCH}/`;
const TARBALL_URL = `https://codeload.github.com/${REFERENCE_REPO}/tar.gz/refs/heads/${REFERENCE_BRANCH}`;
const LATEST_COMMIT_URL = `https://api.github.com/repos/${REFERENCE_REPO}/commits/${REFERENCE_BRANCH}`;

/** Written into the copy: where it came from, and what the rewrite found. */
const METADATA_FILE = '.bt-reference.json';
const DOWNLOAD_TIMEOUT_MS = 120000;
const LATEST_COMMIT_TIMEOUT_MS = 5000;

/** Only these files are rewritten and link-checked; everything else is copied as is. */
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.json', '.sh', '.ps1', '.cs', '.py', '.html', '.css']);
/** Repo housekeeping that has no place in an agent's copy. */
const SKIPPED_TOP_LEVEL = new Set(['.git', '.github', '.gitignore', '.gitattributes', 'node_modules', '.DS_Store']);

// The characters that end a URL or path inside markdown, code spans, quotes and prose.
const PATH_CHARACTERS = "[^\\s)`\"'<>\\]]+";
const REFERENCE_URL_PATTERN = escapeRegExp(REFERENCE_URL_PREFIX);

/**
 * `~/.claude/toolkit/reference/` — beside the Unity helper scripts the Reference already keeps in
 * `~/.claude/toolkit/` — or `.claude/toolkit/reference/` in a project install. Only this subfolder is
 * ever replaced or removed; the helper scripts next to it are left alone.
 */
function referenceDir(mode, projectRoot) {
  const base = mode === 'project' ? path.resolve(projectRoot) : os.homedir();
  return path.join(base, '.claude', 'toolkit', 'reference');
}

/** The Claude Code allow rule that lets sessions read the global copy without asking. */
const CLAUDE_READ_RULE = 'Read(~/.claude/toolkit/reference/**)';

/** The folder as agents see it in rewritten links: absolute, with forward slashes on every platform. */
function linkRoot(dir) {
  return path.resolve(dir).split(path.sep).join('/');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trailing sentence punctuation belongs to the prose, not to the path. */
function splitTrailingPunctuation(target) {
  const match = /[.,;:!?]+$/.exec(target);
  return match ? [target.slice(0, match.index), match[0]] : [target, ''];
}

/**
 * Point every link into the Reference repo at the local copy.
 *
 * `curl -fsSL <url> -o <dest>` download commands become `cp "<local file>" <dest>`; every other
 * occurrence — markdown links, bare URLs, code spans — becomes the absolute local path. A markdown
 * link whose path contains a space is wrapped in `<…>` so it still parses.
 */
function rewriteText(text, dir) {
  const root = linkRoot(dir);
  let downloads = 0;
  let links = 0;

  const downloadPattern = new RegExp(`curl((?:\\s+-[A-Za-z-]+)*)\\s+${REFERENCE_URL_PATTERN}(${PATH_CHARACTERS})\\s+-o\\s+(\\S+)`, 'g');
  let result = text.replace(downloadPattern, (whole, flags, target, destination) => {
    downloads += 1;
    return `cp "${root}/${target}" ${destination}`;
  });

  const linkPattern = new RegExp(`(\\]\\()?${REFERENCE_URL_PATTERN}(${PATH_CHARACTERS})`, 'g');
  result = result.replace(linkPattern, (whole, markdownOpen, target) => {
    links += 1;
    const [cleanTarget, punctuation] = splitTrailingPunctuation(target);
    const local = `${root}/${cleanTarget}`;
    if (markdownOpen) return local.includes(' ') ? `](<${local}>${punctuation}` : `](${local}${punctuation}`;
    return `${local}${punctuation}`;
  });

  return { text: result, downloads, links };
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function walkFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Rewrite every text file under `folder` that links into the Reference repo; returns the counts. */
function rewriteFolder(folder, dir) {
  const totals = { files: 0, downloads: 0, links: 0 };
  for (const relative of walkFiles(folder)) {
    if (!isTextFile(relative)) continue;
    const file = path.join(folder, relative);
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(REFERENCE_URL_PREFIX)) continue;
    const rewritten = rewriteText(text, dir);
    fs.writeFileSync(file, rewritten.text, 'utf8');
    totals.files += 1;
    totals.downloads += rewritten.downloads;
    totals.links += rewritten.links;
  }
  return totals;
}

/**
 * Check every local link under the given folders resolves to a file in the copy.
 * A renamed or deleted sub-document shows up here, at install time, instead of mid-run.
 */
function checkLinks(dir, folders) {
  const root = linkRoot(dir);
  const pattern = new RegExp(`${escapeRegExp(root)}/(${PATH_CHARACTERS})`, 'g');
  const broken = new Set();
  let checked = 0;
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const relative of walkFiles(folder)) {
      if (!isTextFile(relative)) continue;
      const text = fs.readFileSync(path.join(folder, relative), 'utf8');
      if (!text.includes(root)) continue;
      for (const match of text.matchAll(pattern)) {
        const target = splitTrailingPunctuation(match[1])[0].split('#')[0];
        checked += 1;
        if (!fs.existsSync(path.join(dir, ...target.split('/')))) broken.add(`${relative} → ${target}`);
      }
    }
  }
  return { checked, broken: [...broken] };
}

/* ===================== Download ===================== */

/**
 * Download one URL to a file. Node's https first, in a helper process so the installer stays
 * synchronous; then the system curl, which honours proxy settings Node ignores.
 */
function downloadFile(url, destination) {
  const script = `
    const https = require('https');
    const fs = require('fs');
    const [url, destination] = process.argv.slice(1);
    function get(address, redirects) {
      const request = https.get(address, { headers: { 'user-agent': 'bt-agent' } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
          response.resume();
          return get(new URL(response.headers.location, address).toString(), redirects + 1);
        }
        if (response.statusCode !== 200) { console.error('HTTP ' + response.statusCode); process.exit(2); }
        const file = fs.createWriteStream(destination);
        response.pipe(file);
        file.on('finish', () => file.close(() => process.exit(0)));
      });
      request.setTimeout(${DOWNLOAD_TIMEOUT_MS}, () => request.destroy(new Error('timed out')));
      request.on('error', (error) => { console.error(error.message); process.exit(3); });
    }
    get(url, 0);
  `;
  const errors = [];
  try {
    execFileSync(process.execPath, ['-e', script, url, destination], { stdio: ['ignore', 'ignore', 'pipe'], timeout: DOWNLOAD_TIMEOUT_MS + 5000 });
    return;
  } catch (error) {
    errors.push(String((error.stderr && error.stderr.toString()) || error.message).trim());
  }
  try {
    execFileSync('curl', ['-fsSL', '--max-time', String(DOWNLOAD_TIMEOUT_MS / 1000), '-o', destination, url], { stdio: ['ignore', 'ignore', 'pipe'] });
    return;
  } catch (error) {
    errors.push(String((error.stderr && error.stderr.toString()) || error.message).trim());
  }
  throw new Error(errors.filter(Boolean).pop() || `could not download ${url}`);
}

/** The commit GitHub's branch now points at, or null when it cannot be reached quickly. */
function latestCommit() {
  const script = `
    const https = require('https');
    const request = https.get(${JSON.stringify(LATEST_COMMIT_URL)}, { headers: { 'user-agent': 'bt-agent', accept: 'application/vnd.github.sha' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => process.stdout.write(response.statusCode === 200 ? body.trim() : ''));
    });
    request.setTimeout(${LATEST_COMMIT_TIMEOUT_MS}, () => request.destroy());
    request.on('error', () => process.stdout.write(''));
  `;
  try {
    const sha = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: LATEST_COMMIT_TIMEOUT_MS + 2000 }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/* ===================== Tarball ===================== */

function nulTerminated(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** `<length> <key>=<value>\n` records of a pax header. */
function paxRecords(body) {
  const records = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(body.subarray(offset, space).toString('utf8'), 10);
    if (!length) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Read a gzipped tarball as GitHub serves it: regular files only, the top folder (`agent-main/`)
 * stripped, and the commit taken from the pax global header GitHub writes.
 */
function readTarball(gzipped) {
  const buffer = zlib.gunzipSync(gzipped);
  const files = [];
  let commit = null;
  let longPath = null;
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(nulTerminated(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'g') {
      const records = paxRecords(body);
      if (/^[0-9a-f]{40}$/.test(records.comment || '')) commit = records.comment;
      continue;
    }
    if (type === 'x') { longPath = paxRecords(body).path || null; continue; }
    if (type === 'L') { longPath = nulTerminated(body, 0, body.length); continue; }

    const prefix = nulTerminated(header, 345, 155);
    const name = longPath || (prefix ? `${prefix}/${nulTerminated(header, 0, 100)}` : nulTerminated(header, 0, 100));
    longPath = null;
    if (type !== '0') continue;
    const relative = name.split('/').slice(1).join('/');
    if (relative) files.push({ path: relative, data: Buffer.from(body) });
  }
  return { commit, files };
}

/** A path from an archive or a folder that stays inside the copy and is not repo housekeeping. */
function keepPath(relative) {
  const parts = relative.split('/');
  if (parts.some((part) => part === '..' || part === '') || path.isAbsolute(relative)) return false;
  return !SKIPPED_TOP_LEVEL.has(parts[0]) && parts[parts.length - 1] !== '.DS_Store';
}

/** A local checkout as the source (`--reference-from`), for offline installs and unreleased Reference edits. */
function readFolder(folder) {
  if (!fs.existsSync(path.join(folder, 'reference.md'))) throw new Error(`${folder} has no reference.md`);
  const files = walkFiles(folder)
    .filter(keepPath)
    .map((relative) => ({ path: relative, data: fs.readFileSync(path.join(folder, ...relative.split('/'))) }));
  let commit = null;
  try {
    commit = execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not a git checkout */
  }
  return { commit, files };
}

/* ===================== Install ===================== */

function readMetadata(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, METADATA_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** A copy agents can use: the metadata and the Reference itself are both there. */
function isUsable(dir) {
  return Boolean(readMetadata(dir)) && fs.existsSync(path.join(dir, 'reference.md'));
}

/**
 * Download (or copy) the Reference into its folder, rewrite its links and check them.
 * The new copy is built beside the old one and swapped in only when complete; when the download
 * fails, an existing copy is kept and agents keep reading it.
 */
function installReference({ mode = 'global', projectRoot = process.cwd(), from = null, dryRun = false } = {}) {
  const dir = referenceDir(mode, projectRoot);
  const source = from ? path.resolve(from) : `${REFERENCE_REPO}@${REFERENCE_BRANCH}`;
  if (dryRun) return { dir, status: 'would-install', source };

  let archive;
  try {
    if (from) archive = readFolder(path.resolve(from));
    else {
      const temporary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-reference-')), 'reference.tar.gz');
      try {
        downloadFile(TARBALL_URL, temporary);
        archive = readTarball(fs.readFileSync(temporary));
      } finally {
        fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
      }
    }
    if (!archive.files.some((file) => file.path === 'reference.md')) throw new Error('the download has no reference.md');
  } catch (error) {
    const reason = error.message.split('\n').filter(Boolean).pop();
    if (isUsable(dir)) return { dir, status: 'kept', source, reason, ...readMetadata(dir) };
    return { dir, status: 'unavailable', source, reason };
  }

  const staging = `${dir}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  const files = archive.files.filter((file) => keepPath(file.path));
  for (const file of files) {
    const target = path.join(staging, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  // Links are rewritten to the final folder, not the staging one, so they are right once swapped in.
  const rewrite = rewriteFolder(staging, dir);
  // A project install keeps the copy out of the project's git without touching its .gitignore.
  fs.writeFileSync(path.join(staging, '.gitignore'), '*\n');

  const metadata = {
    repo: REFERENCE_REPO,
    branch: REFERENCE_BRANCH,
    source,
    commit: archive.commit,
    installedAt: new Date().toISOString(),
    files: files.length,
    rewrittenFiles: rewrite.files,
    rewrittenLinks: rewrite.links,
    rewrittenDownloads: rewrite.downloads,
  };
  fs.writeFileSync(path.join(staging, METADATA_FILE), JSON.stringify(metadata, null, 2) + '\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(staging, dir);
  return { dir, status: 'installed', ...metadata };
}

function removeReference(dir, { dryRun = false } = {}) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  REFERENCE_URL_PREFIX,
  METADATA_FILE,
  CLAUDE_READ_RULE,
  referenceDir,
  linkRoot,
  rewriteText,
  rewriteFolder,
  checkLinks,
  readTarball,
  readMetadata,
  isUsable,
  latestCommit,
  installReference,
  removeReference,
};
