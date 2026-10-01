'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where disk space usually goes, per platform.
 *
 * Everything is a plain table so the report stays a lookup over one walk, and so
 * the paths can be checked in tests for every platform from any platform.
 * `ctx` = { platform, home, env } — injected, never read from the process here.
 */

function dirs(ctx) {
  const { home, env } = ctx;
  const p = ctx.platform === 'win32' ? path.win32 : path.posix;
  const join = (...a) => p.join(...a);
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const systemDrive = (env.SystemDrive || 'C:') + '\\';
  const programFiles = env.ProgramFiles || join(systemDrive, 'Program Files');
  const programFilesX86 = env['ProgramFiles(x86)'] || join(systemDrive, 'Program Files (x86)');
  const programData = env.ProgramData || join(systemDrive, 'ProgramData');
  const lib = join(home, 'Library');
  return { join, localAppData, appData, systemDrive, programFiles, programFilesX86, programData, lib };
}

/** Folders outside the home folder worth walking. */
function systemRoots(ctx) {
  const d = dirs(ctx);
  switch (ctx.platform) {
    case 'darwin':
      return ['/Applications', '/Library', '/private/var', '/opt/homebrew', '/usr/local', '/Users/Shared'];
    case 'win32':
      return [d.programFiles, d.programFilesX86, d.programData];
    default:
      return ['/usr', '/var', '/opt', '/snap'];
  }
}

/** Big home sub-folders to break down further (top N children each). */
function breakdowns(ctx) {
  const d = dirs(ctx);
  switch (ctx.platform) {
    case 'darwin':
      return [
        d.lib,
        d.join(d.lib, 'Application Support'),
        d.join(d.lib, 'Caches'),
        d.join(d.lib, 'Containers'),
        d.join(d.lib, 'Group Containers'),
      ];
    case 'win32':
      return [d.localAppData, d.appData, d.join(ctx.home, 'AppData', 'LocalLow'), d.join(d.localAppData, 'Packages')];
    default:
      return [d.join(ctx.home, '.cache'), d.join(ctx.home, '.local', 'share')];
  }
}

/** Expand a trailing `*` (one level) into the folders that exist. */
function glob(pattern) {
  if (!pattern.endsWith('*')) return [pattern];
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern).slice(0, -1);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Known space hogs: { id, group, label, paths[], each? }.
 * `each: true` lists every match separately (one row per Unity editor version).
 */
function hogs(ctx) {
  const d = dirs(ctx);
  const h = (...a) => d.join(ctx.home, ...a);
  const L = (...a) => d.join(d.lib, ...a);
  const local = (...a) => d.join(d.localAppData, ...a);
  const roam = (...a) => d.join(d.appData, ...a);

  if (ctx.platform === 'win32') {
    return [
      { id: 'unity-editors', group: 'Unity', label: 'Unity Editor', paths: [d.join(d.programFiles, 'Unity', 'Hub', 'Editor', '*')], each: true },
      { id: 'unity-assetstore', group: 'Unity', label: 'Unity Asset Store downloads', paths: [roam('Unity', 'Asset Store-5.x')] },
      { id: 'unity-cache', group: 'Unity', label: 'Unity package & GI caches', paths: [local('Unity', 'cache'), h('AppData', 'LocalLow', 'Unity', 'Caches')] },
      { id: 'unity-hub', group: 'Unity', label: 'Unity Hub data', paths: [roam('UnityHub')] },
      { id: 'android', group: 'Android', label: 'Android SDK & emulators', paths: [local('Android', 'Sdk'), h('.android')] },
      { id: 'gradle', group: 'Android', label: 'Gradle (~/.gradle)', paths: [h('.gradle')] },
      { id: 'docker', group: 'Docker / VMs', label: 'Docker Desktop disk', paths: [local('Docker')] },
      { id: 'wsl', group: 'Docker / VMs', label: 'WSL Linux distros', paths: [local('Packages', 'CanonicalGroupLimited*')] },
      { id: 'npm', group: 'Package caches', label: 'npm cache', paths: [local('npm-cache')] },
      { id: 'yarn', group: 'Package caches', label: 'Yarn cache', paths: [local('Yarn', 'Cache'), h('.yarn', 'berry', 'cache')] },
      { id: 'pnpm', group: 'Package caches', label: 'pnpm store', paths: [local('pnpm')] },
      { id: 'pip', group: 'Package caches', label: 'pip cache', paths: [local('pip', 'Cache')] },
      { id: 'nuget', group: 'Package caches', label: 'NuGet (~/.nuget)', paths: [h('.nuget')] },
      { id: 'nvm', group: 'Package caches', label: 'nvm Node versions', paths: [roam('nvm')] },
      { id: 'cargo', group: 'Package caches', label: 'Rust (~/.cargo, ~/.rustup)', paths: [h('.cargo'), h('.rustup')] },
      { id: 'dotcache', group: 'Package caches', label: '~/.cache', paths: [h('.cache')] },
      { id: 'ollama', group: 'Package caches', label: 'Ollama models', paths: [h('.ollama')] },
      { id: 'cpptools', group: 'Editors', label: 'VS Code C++ IntelliSense cache', paths: [local('Microsoft', 'vscode-cpptools')] },
      { id: 'vscode', group: 'Editors', label: 'VS Code data', paths: [roam('Code')] },
      { id: 'chrome', group: 'Apps & media', label: 'Chrome profiles', paths: [local('Google', 'Chrome'), local('Google', 'Chrome Beta')] },
      { id: 'steam', group: 'Apps & media', label: 'Steam games', paths: [d.join(d.programFilesX86, 'Steam', 'steamapps')] },
      { id: 'epic', group: 'Apps & media', label: 'Epic Games', paths: [d.join(d.programFiles, 'Epic Games')] },
      { id: 'ios-backups', group: 'Apps & media', label: 'iPhone/iPad backups', paths: [roam('Apple Computer', 'MobileSync', 'Backup'), h('Apple', 'MobileSync', 'Backup')] },
      { id: 'onedrive', group: 'Apps & media', label: 'OneDrive (local copies)', paths: [h('OneDrive')] },
      { id: 'icloud', group: 'Apps & media', label: 'iCloud Drive (local copies)', paths: [h('iCloudDrive')] },
      { id: 'temp', group: 'Leftovers', label: 'Temp files', paths: [local('Temp')] },
      { id: 'trash', group: 'Leftovers', label: 'Recycle Bin', paths: [d.join(d.systemDrive, '$Recycle.Bin')] },
      { id: 'downloads', group: 'Leftovers', label: 'Downloads', paths: [h('Downloads')] },
      { id: 'swap', group: 'Leftovers', label: 'Page file / hibernation file', paths: ['pagefile.sys', 'hiberfil.sys', 'swapfile.sys'].map((f) => d.join(d.systemDrive, f)) },
    ];
  }

  if (ctx.platform === 'darwin') {
    return [
      { id: 'unity-editors', group: 'Unity', label: 'Unity Editor', paths: ['/Applications/Unity/Hub/Editor/*'], each: true },
      { id: 'unity-assetstore', group: 'Unity', label: 'Unity Asset Store downloads', paths: [L('Unity', 'Asset Store-5.x')] },
      { id: 'unity-cache', group: 'Unity', label: 'Unity package & GI caches', paths: [L('Unity', 'cache'), L('Caches', 'com.unity3d.UnityEditor'), L('Caches', 'Unity')] },
      { id: 'unity-hub', group: 'Unity', label: 'Unity Hub data', paths: [L('Application Support', 'UnityHub')] },
      { id: 'xcode-deriveddata', group: 'Xcode', label: 'Xcode DerivedData', paths: [L('Developer', 'Xcode', 'DerivedData')] },
      { id: 'xcode-archives', group: 'Xcode', label: 'Xcode Archives', paths: [L('Developer', 'Xcode', 'Archives')] },
      { id: 'xcode-devicesupport', group: 'Xcode', label: 'Xcode device support files', paths: [L('Developer', 'Xcode', 'iOS DeviceSupport'), L('Developer', 'Xcode', 'watchOS DeviceSupport'), L('Developer', 'Xcode', 'tvOS DeviceSupport')] },
      { id: 'simulators', group: 'Xcode', label: 'Simulator devices & runtimes', paths: [L('Developer', 'CoreSimulator'), '/Library/Developer/CoreSimulator'] },
      { id: 'android', group: 'Android', label: 'Android SDK & emulators', paths: [L('Android', 'sdk'), h('.android')] },
      { id: 'gradle', group: 'Android', label: 'Gradle (~/.gradle)', paths: [h('.gradle')] },
      { id: 'docker', group: 'Docker / VMs', label: 'Docker Desktop disk', paths: [L('Containers', 'com.docker.docker')] },
      { id: 'vms', group: 'Docker / VMs', label: 'Parallels / UTM VMs', paths: [h('Parallels'), L('Containers', 'com.utmapp.UTM')] },
      { id: 'npm', group: 'Package caches', label: 'npm cache', paths: [h('.npm')] },
      { id: 'yarn', group: 'Package caches', label: 'Yarn cache', paths: [L('Caches', 'Yarn'), h('.yarn', 'berry', 'cache')] },
      { id: 'pnpm', group: 'Package caches', label: 'pnpm store', paths: [L('pnpm'), h('.pnpm-store')] },
      { id: 'pip', group: 'Package caches', label: 'pip cache', paths: [L('Caches', 'pip')] },
      { id: 'homebrew', group: 'Package caches', label: 'Homebrew download cache', paths: [L('Caches', 'Homebrew')] },
      { id: 'nuget', group: 'Package caches', label: 'NuGet (~/.nuget)', paths: [h('.nuget')] },
      { id: 'nvm', group: 'Package caches', label: 'nvm Node versions', paths: [h('.nvm')] },
      { id: 'cargo', group: 'Package caches', label: 'Rust (~/.cargo, ~/.rustup)', paths: [h('.cargo'), h('.rustup')] },
      { id: 'dotcache', group: 'Package caches', label: '~/.cache', paths: [h('.cache')] },
      { id: 'ollama', group: 'Package caches', label: 'Ollama models', paths: [h('.ollama')] },
      { id: 'cpptools', group: 'Editors', label: 'VS Code C++ IntelliSense cache', paths: [L('Caches', 'vscode-cpptools')] },
      { id: 'vscode', group: 'Editors', label: 'VS Code data', paths: [L('Application Support', 'Code')] },
      { id: 'chrome', group: 'Apps & media', label: 'Chrome profiles', paths: [L('Application Support', 'Google')] },
      { id: 'steam', group: 'Apps & media', label: 'Steam games', paths: [L('Application Support', 'Steam')] },
      { id: 'epic', group: 'Apps & media', label: 'Epic Games', paths: [L('Application Support', 'Epic'), '/Users/Shared/Epic Games'] },
      { id: 'ios-backups', group: 'Apps & media', label: 'iPhone/iPad backups', paths: [L('Application Support', 'MobileSync', 'Backup')] },
      { id: 'mail', group: 'Apps & media', label: 'Mail', paths: [L('Mail')] },
      { id: 'messages', group: 'Apps & media', label: 'Messages attachments', paths: [L('Messages')] },
      { id: 'photos', group: 'Apps & media', label: 'Photos libraries', paths: [h('Pictures', '*')].flatMap(glob).filter((p) => p.endsWith('.photoslibrary')) },
      { id: 'icloud', group: 'Apps & media', label: 'iCloud Drive (local copies)', paths: [L('Mobile Documents')] },
      { id: 'trash', group: 'Leftovers', label: 'Trash', paths: [h('.Trash')] },
      { id: 'downloads', group: 'Leftovers', label: 'Downloads', paths: [h('Downloads')] },
      { id: 'swap', group: 'Leftovers', label: 'Swap / sleep image', paths: ['/private/var/vm'] },
    ];
  }

  return [
    { id: 'unity-editors', group: 'Unity', label: 'Unity Editor', paths: [h('Unity', 'Hub', 'Editor', '*')], each: true },
    { id: 'unity-cache', group: 'Unity', label: 'Unity caches', paths: [h('.cache', 'unity3d'), h('.local', 'share', 'unity3d')] },
    { id: 'docker', group: 'Docker / VMs', label: 'Docker', paths: ['/var/lib/docker'] },
    { id: 'npm', group: 'Package caches', label: 'npm cache', paths: [h('.npm')] },
    { id: 'yarn', group: 'Package caches', label: 'Yarn cache', paths: [h('.cache', 'yarn'), h('.yarn', 'berry', 'cache')] },
    { id: 'pnpm', group: 'Package caches', label: 'pnpm store', paths: [h('.local', 'share', 'pnpm')] },
    { id: 'nvm', group: 'Package caches', label: 'nvm Node versions', paths: [h('.nvm')] },
    { id: 'dotcache', group: 'Package caches', label: '~/.cache', paths: [h('.cache')] },
    { id: 'gradle', group: 'Android', label: 'Gradle (~/.gradle)', paths: [h('.gradle')] },
    { id: 'trash', group: 'Leftovers', label: 'Trash', paths: [h('.local', 'share', 'Trash')] },
    { id: 'downloads', group: 'Leftovers', label: 'Downloads', paths: [h('Downloads')] },
  ];
}

const GB = 1024 ** 3;

/**
 * Cleanup suggestions, shown only when the matching hog is at least `min` bytes.
 * Text only — diskinfo never runs any of them.
 */
function suggestions(ctx) {
  const win = ctx.platform === 'win32';
  const mac = ctx.platform === 'darwin';
  return [
    { id: 'xcode-deriveddata', min: GB, text: 'Xcode DerivedData is a build cache: rm -rf ~/Library/Developer/Xcode/DerivedData/*' },
    { id: 'xcode-devicesupport', min: GB, text: 'Old device support folders in ~/Library/Developer/Xcode/*DeviceSupport are safe to delete.' },
    { id: 'simulators', min: GB, text: 'xcrun simctl delete unavailable — and remove old runtimes in Xcode > Settings > Components.' },
    { id: 'unity-projects', min: GB, text: "Unity project Library/ folders rebuild when the project opens; delete them for projects you're not working on." },
    { id: 'unreal-projects', min: GB, text: 'Unreal Intermediate/, DerivedDataCache/ and Binaries/ rebuild; delete them for idle projects.' },
    { id: 'unity-editors', min: GB, text: 'Remove Unity Editor versions you no longer use in Unity Hub > Installs.' },
    { id: 'unity-assetstore', min: GB, text: 'Unity Asset Store downloads (.unitypackage) can be re-downloaded from My Assets.' },
    { id: 'cpptools', min: GB, text: 'Delete the VS Code C++ IntelliSense cache, and cap it with "C_Cpp.intelliSenseCacheSize": 5 in VS Code settings.' },
    { id: 'npm', min: GB, text: 'npm cache clean --force' },
    { id: 'yarn', min: GB, text: 'yarn cache clean' },
    { id: 'pnpm', min: GB, text: 'pnpm store prune' },
    { id: 'pip', min: GB, text: 'pip cache purge' },
    { id: 'nuget', min: GB, text: 'dotnet nuget locals all --clear' },
    { id: 'homebrew', min: GB / 2, text: 'brew cleanup --prune=all' },
    { id: 'gradle', min: GB, text: 'Delete ~/.gradle/caches (Gradle downloads what it needs again).' },
    { id: 'docker', min: GB, text: 'docker system prune -a — removes unused images, containers and build cache.' },
    { id: 'wsl', min: GB, text: 'Remove WSL distros you no longer use: wsl --list, then wsl --unregister <name>.' },
    { id: 'node-modules', min: GB, text: 'node_modules in old projects can be deleted; npm install brings them back.' },
    { id: 'ios-backups', min: GB, text: win ? 'Old device backups: iTunes / Apple Devices > Preferences > Devices.' : 'Old device backups: Finder > your iPhone > Manage Backups.' },
    { id: 'steam', min: GB, text: "Uninstall Steam games you don't play from the Steam library." },
    { id: 'temp', min: GB, text: 'Clear temp files: Settings > System > Storage > Temporary files.' },
    { id: 'trash', min: GB / 10, text: win ? 'Empty the Recycle Bin.' : 'Empty the Trash.' },
    { id: 'downloads', min: GB, text: 'Review Downloads, sorted by size.' },
    { id: 'snapshots', min: 1, text: 'Local Time Machine snapshots hold space no folder shows: tmutil listlocalsnapshots /, then sudo tmutil deletelocalsnapshots <date>.' },
    { id: 'always', min: 0, text: mac ? 'System Settings > General > Storage has its own recommendations.' : win ? 'Settings > System > Storage > Cleanup recommendations, and Disk Cleanup > Clean up system files.' : 'Your distro package cache (apt clean / dnf clean all) and journalctl --vacuum-size=200M.' },
  ];
}

module.exports = { systemRoots, breakdowns, hogs, suggestions, glob };
