#!/usr/bin/env node
/**
 * chuanban-antigravity-theme-patch · 一键安装、自检、CDP 接力重启、安全模式验证、打包与回滚 CLI (install.mjs)
 *
 * 支持子命令：
 *   node install.mjs install        [--channel auto|stable|insiders] [--preset native|morandi|absolutely|claude-desktop-purewhite|vintage-deep] [--dark-preset onyx|claude-warm] [--sync-user] [--with-launcher] [--target-dir <dir>]
 *   node install.mjs upgrade        [--check] [--dry-run] [--version <vX.Y.Z>] [--mirror cloudflare-r2|github-release] [--force] [--target-dir <dir>] [--manifest-url <url>]
 *   node install.mjs relaunch       [--channel auto|stable|insiders] [--force] [--target-dir <dir>]
 *   node install.mjs download-fonts [--dir <download-dir>] [--all] [--force] [--super-ttc]
 *   node install.mjs install-fonts  --auto-download [--dir <download-dir>] [--force] [--super-ttc] [--retire-super-ttc]
 *   node install.mjs install-fonts  --from <font-folder-or-zip-path> [--retire-super-ttc]
 *   node install.mjs doctor         [--channel auto|stable|insiders] [--target-dir <dir>]
 *   node install.mjs verify         [--safe-mode] [--channel auto|stable|insiders] [--target-dir <dir>]
 *   node install.mjs rollback       [--target-dir <dir>]
 *   node install.mjs uninstall      [--target-dir <dir>]
 *   node install.mjs build-manifest [--set-version <X.Y.Z>]
 *   node install.mjs pack           [--update-bundle] [--set-version <X.Y.Z>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 屏蔽 Node 22.x 动态探测 node:sqlite 时的 ExperimentalWarning 噪声，保持 doctor/verify JSON 输出纯净
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  if (type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) return;
  return _origEmitWarning.call(this, warning, ...rest);
};

const GOOGLE_DRIVE_URL = 'https://drive.google.com/drive/folders/1NX92SgVUqtSjWg6bt6sIJXy-cn7J_boC';
const WINDOWS_SARASA_SPLIT_VIEW_URL = 'https://drive.google.com/file/d/1iVVvZXtwUcDiHy42tJ25X6N-JlOf3l7A/view?usp=sharing';
const SARASA_GITHUB_RELEASES_URL = 'https://github.com/be5invis/Sarasa-Gothic/releases';
const NOTION_GUIDE_URL = 'https://chuanban.notion.site/chuanban-antigravity-theme-patch-db7c5846f37546be9481cd791aed0554';
const FEISHU_LANDING_URL = 'https://www.feishu.cn/wiki/EQyqwJEqmi1LH3k11tzcmkMHnYd';
const FEISHU_FONT_MIRROR_URL = 'https://www.feishu.cn/wiki/V2lbwB8ykiLLXrkzY41cXjQ1nXc';
const GITHUB_REPO_URL = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch';
const GITHUB_RELEASES_LATEST_URL = `${GITHUB_REPO_URL}/releases/latest`;
const R2_UPDATE_BASE_URL = 'https://img.chuanban.cc/themes/chuanban-antigravity';
const UPDATE_MANIFEST_MIRRORS = [
  { id: 'cloudflare-r2', url: `${R2_UPDATE_BASE_URL}/latest.json` },
  { id: 'github-release', url: `${GITHUB_REPO_URL}/releases/latest/download/latest.json` }
];
const R2_FONT_MIRROR_BASE_URL = 'https://img.chuanban.cc/fonts/chuanban-suite';
const GITHUB_FONT_MIRROR_TAG = 'fonts-sarasa-v1.0.43';
const GITHUB_FONT_MIRROR_BASE_URL = `${GITHUB_REPO_URL}/releases/download/${GITHUB_FONT_MIRROR_TAG}`;
const R2_SARASA_SPLIT_URL = `${R2_FONT_MIRROR_BASE_URL}/Windows-Sarasa-Split-SC-TTF-v1.0.43.zip`;
const GITHUB_SARASA_SPLIT_URL = `${GITHUB_FONT_MIRROR_BASE_URL}/Windows-Sarasa-Split-SC-TTF-v1.0.43.zip`;

function isLoopbackHttpUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || '').trim());
    return (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function isAllowedUpdateUrl(urlStr, { allowLoopbackOrigin = null } = {}) {
  try {
    const u = new URL(String(urlStr || '').trim());
    if (allowLoopbackOrigin && u.origin === allowLoopbackOrigin && isLoopbackHttpUrl(u.href)) {
      return true;
    }
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'img.chuanban.cc' && u.pathname.startsWith('/themes/chuanban-antigravity/')) {
      return true;
    }
    if (
      u.hostname === 'github.com' &&
      (u.pathname === '/Anarcadia/chuanban-antigravity-theme-patch/releases' ||
        u.pathname.startsWith('/Anarcadia/chuanban-antigravity-theme-patch/releases/'))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function buildGoogleDriveDirectUrl(fileId) {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
}

const FONT_DOWNLOAD_CATALOG = {
  anthropicSerifRegular: {
    id: 'anthropicSerifRegular',
    label: 'Anthropic Serif Regular',
    filename: 'AnthropicSerif-Regular.ttf',
    driveFileId: '1RZ1rMYYFlr5B-slSSZV-DCJtv5AfTMUV',
    sha256: '5806e7fbfebfe6683fdb2c16d8eb91b98ccd6b4ba0d477e8f5167782e0d7b009',
    mirrors: [
      { id: 'cloudflare-r2', url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicSerif-Regular.ttf` },
      { id: 'google-drive', url: buildGoogleDriveDirectUrl('1RZ1rMYYFlr5B-slSSZV-DCJtv5AfTMUV') }
    ],
    url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicSerif-Regular.ttf`,
    kind: 'font',
    minBytes: 100 * 1024,
    timeoutSec: 120
  },
  anthropicSerifBold: {
    id: 'anthropicSerifBold',
    label: 'Anthropic Serif Bold',
    filename: 'AnthropicSerif-Bold.ttf',
    driveFileId: '1-LJfTa1wasIqkoCCHI4mfVyh8tzreiAO',
    sha256: '3e0d9660390f1800f229e2724cf0b09030ec53188cd3d361ca210077ce564426',
    mirrors: [
      { id: 'cloudflare-r2', url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicSerif-Bold.ttf` },
      { id: 'google-drive', url: buildGoogleDriveDirectUrl('1-LJfTa1wasIqkoCCHI4mfVyh8tzreiAO') }
    ],
    url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicSerif-Bold.ttf`,
    kind: 'font',
    minBytes: 100 * 1024,
    timeoutSec: 120
  },
  anthropicMonoRegular: {
    id: 'anthropicMonoRegular',
    label: 'Anthropic Mono Regular',
    filename: 'AnthropicMono-Regular.ttf',
    driveFileId: '1NK_1Q2MBl5yHw94pC_kbzybDgqEFCZVk',
    sha256: '0e686e9d651bf3b7448bbc7ec5c5ffd48e3ae9b07710d26ed332170487f60295',
    mirrors: [
      { id: 'cloudflare-r2', url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicMono-Regular.ttf` },
      { id: 'google-drive', url: buildGoogleDriveDirectUrl('1NK_1Q2MBl5yHw94pC_kbzybDgqEFCZVk') }
    ],
    url: `${R2_FONT_MIRROR_BASE_URL}/AnthropicMono-Regular.ttf`,
    kind: 'font',
    minBytes: 50 * 1024,
    timeoutSec: 120
  },
  sarasaSplitScZip: {
    id: 'sarasaSplitScZip',
    label: 'Sarasa Gothic SC Split TTF (14 weights, 170 MB ZIP)',
    filename: 'Windows-Sarasa-Split-SC-TTF-v1.0.43.zip',
    driveFileId: '1iVVvZXtwUcDiHy42tJ25X6N-JlOf3l7A',
    sha256: '5add515b1bdc35a246e2507f34b3fce45e517e156842e81a948ca91e51dafde3',
    mirrors: [
      { id: 'cloudflare-r2', url: R2_SARASA_SPLIT_URL },
      { id: 'github-release', url: GITHUB_SARASA_SPLIT_URL },
      { id: 'google-drive', url: buildGoogleDriveDirectUrl('1iVVvZXtwUcDiHy42tJ25X6N-JlOf3l7A') }
    ],
    url: R2_SARASA_SPLIT_URL,
    viewUrl: R2_SARASA_SPLIT_URL,
    kind: 'zip',
    minBytes: 50 * 1024 * 1024,
    timeoutSec: 600
  },
  sarasaSuperTtc: {
    id: 'sarasaSuperTtc',
    label: 'Sarasa Gothic SuperTTC (791 MB TTC, macOS/Linux optional)',
    filename: 'Sarasa-SuperTTC.ttc',
    driveFileId: '1i7mqpF2UpjCSR9oBPvPAD3CB6TJn9mwu',
    sha256: 'c66ea03101e8615e3205dc383323f7a3c3100ef783f228b3d877d38ce84ff314',
    mirrors: [
      { id: 'github-release', url: `${GITHUB_FONT_MIRROR_BASE_URL}/Sarasa-SuperTTC.ttc` },
      { id: 'google-drive', url: buildGoogleDriveDirectUrl('1i7mqpF2UpjCSR9oBPvPAD3CB6TJn9mwu') }
    ],
    url: `${GITHUB_FONT_MIRROR_BASE_URL}/Sarasa-SuperTTC.ttc`,
    kind: 'font',
    minBytes: 200 * 1024 * 1024,
    timeoutSec: 1200
  }
};

const ALLOWED_ORIGINS = [
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://localhost',
  'https://localhost',
  'vscode-file://'
];

const args = process.argv.slice(2);
const subcommand = args.find((a) => !a.startsWith('-')) || 'help';
const hasFlag = (f) => args.some((a) => a === f || a.startsWith(f + '='));
function getArg(flag, fallback = null) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1);
  }
  return fallback;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent && parent !== resolved) {
      try {
        const realParent = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
        return path.join(realParent, path.basename(resolved));
      } catch {}
    }
    return resolved;
  }
}

function isSameTargetPath(a, b) {
  const pa = canonicalPath(a);
  const pb = canonicalPath(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? pa.toLowerCase() === pb.toLowerCase()
    : pa === pb;
}

function resolveGlobalInstallDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'theme-patch');
}

function resolveDefaultTargetDir() {
  const installed = resolveGlobalInstallDir();
  if (fs.existsSync(path.join(installed, 'core', 'daemon.mjs'))) {
    return installed;
  }
  return __dirname;
}

// ============================================================================
// 1. 生成与校验 core/manifest.json 及 dist/ 发行包
// ============================================================================
function buildManifest(baseDir = __dirname, opts = {}) {
  const BASELINE_VERSION = '6.0.6';
  const BASELINE_MIN_NODE = '22.0.0';
  const BASELINE_MIN_ANTIGRAVITY = '2.34.0';
  const coreDir = path.join(baseDir, 'core');
  const files = ['daemon.mjs', 'runtime.js', 'theme.css', 'i18n.json'];
  const entries = {};
  for (const name of files) {
    const p = path.join(coreDir, name);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing core file: ${p}`);
    }
    const stat = fs.statSync(p);
    entries[name] = {
      sha256: sha256File(p),
      bytes: stat.size
    };
  }

  const cliSetVersion = hasFlag('--set-version') ? getArg('--set-version', '') : null;
  const rawSetVersion =
    opts?.setVersion !== undefined && opts?.setVersion !== null ? opts.setVersion : cliSetVersion;
  let explicitVersion = null;
  if (rawSetVersion !== null) {
    const trimmed = String(rawSetVersion).trim();
    const m = trimmed.match(/^v?(\d+\.\d+\.\d+)$/);
    if (!m) {
      throw new Error(`Invalid --set-version "${rawSetVersion}". Expected format X.Y.Z or vX.Y.Z.`);
    }
    explicitVersion = m[1];
  }

  const manifestPath = path.join(coreDir, 'manifest.json');
  let existingManifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {}
  }

  let version = BASELINE_VERSION;
  if (explicitVersion) {
    version = explicitVersion;
  } else if (existingManifest && typeof existingManifest.version === 'string') {
    const verMatch = existingManifest.version.trim().match(/^v?(\d+\.\d+\.\d+)$/);
    if (verMatch) {
      const existingTuple = extractBaseSemverTuple(verMatch[1]);
      if (existingTuple && compareSemverTuples(existingTuple, extractBaseSemverTuple(BASELINE_VERSION)) >= 0) {
        version = verMatch[1];
      }
    }
  }

  let minNodeVersion = BASELINE_MIN_NODE;
  if (existingManifest && typeof existingManifest.minNodeVersion === 'string') {
    const trimmedNode = existingManifest.minNodeVersion.trim();
    if (/^\d+\.\d+\.\d+$/.test(trimmedNode)) {
      const nodeTuple = extractBaseSemverTuple(trimmedNode);
      if (nodeTuple && compareSemverTuples(nodeTuple, extractBaseSemverTuple(BASELINE_MIN_NODE)) > 0) {
        minNodeVersion = trimmedNode;
      }
    }
  }

  let minAntigravityVersion = BASELINE_MIN_ANTIGRAVITY;
  if (existingManifest && typeof existingManifest.minAntigravityVersion === 'string') {
    const trimmedAg = existingManifest.minAntigravityVersion.trim();
    if (/^\d+\.\d+\.\d+$/.test(trimmedAg)) {
      const agTuple = extractBaseSemverTuple(trimmedAg);
      if (agTuple && compareSemverTuples(agTuple, extractBaseSemverTuple(BASELINE_MIN_ANTIGRAVITY)) > 0) {
        minAntigravityVersion = trimmedAg;
      }
    }
  }

  const manifest = {
    name: 'chuanban-antigravity-theme-patch',
    version,
    minNodeVersion,
    minAntigravityVersion,
    fullMetricsNodeVersion: '22.13.0',
    distribution: {
      notionGuide: NOTION_GUIDE_URL,
      googleDriveFullBundle: GOOGLE_DRIVE_URL,
      githubRepo: GITHUB_REPO_URL
    },
    files: entries
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

function collectPackEntries(baseDir, includeItems) {
  const allowedUserFiles = new Set(['config.json', 'custom.css', 'custom.js', 'i18n.override.json']);
  const skipNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const entriesToPack = [];
  const collectEntries = (relPosix) => {
    const fullPath = path.join(baseDir, ...relPosix.split('/'));
    if (!fs.existsSync(fullPath)) return;
    const st = fs.statSync(fullPath);
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(fullPath).sort()) {
        if (skipNames.has(child)) continue;
        if (relPosix === 'user' && !allowedUserFiles.has(child)) continue;
        collectEntries(`${relPosix}/${child}`);
      }
    } else if (st.isFile()) {
      entriesToPack.push({ abs: fullPath, entry: relPosix });
    }
  };
  for (const item of includeItems) {
    collectEntries(item.replace(/\\/g, '/'));
  }
  return entriesToPack;
}

function packAndVerifyZip(baseDir, zipPath, entriesToPack, manifest) {
  const zipName = path.basename(zipPath);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  if (process.platform === 'win32') {
    const listTmpPath = path.join(os.tmpdir(), `ag-pack-entries-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(listTmpPath, JSON.stringify(entriesToPack), 'utf8');
    try {
      const psScript = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.IO.Compression',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zipPath = '${zipPath.replace(/'/g, "''")}'`,
        `$listPath = '${listTmpPath.replace(/'/g, "''")}'`,
        '$parsed = Get-Content -LiteralPath $listPath -Raw -Encoding UTF8 | ConvertFrom-Json',
        '$items = @(foreach ($x in $parsed) { if ($null -ne $x) { $x } })',
        '$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)',
        'try {',
        '  foreach ($it in $items) {',
        '    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, [string]$it.abs, [string]$it.entry, [System.IO.Compression.CompressionLevel]::Optimal)',
        '  }',
        '} finally {',
        '  $zip.Dispose()',
        '}',
        '$zr = [System.IO.Compression.ZipFile]::OpenRead($zipPath)',
        '$sha = [System.Security.Cryptography.SHA256]::Create()',
        '$out = @{ hasBackslash = $false; core = @{} }',
        'try {',
        '  foreach ($e in $zr.Entries) {',
        '    if ($e.FullName.Contains("\\")) { $out.hasBackslash = $true }',
        '    if ($e.FullName.StartsWith("core/") -and $e.Name -ne "") {',
        '      $s = $e.Open()',
        '      $ms = New-Object System.IO.MemoryStream',
        '      try { $s.CopyTo($ms) } finally { $s.Dispose() }',
        '      $bytes = $ms.ToArray()',
        '      $ms.Dispose()',
        '      $hash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()',
        '      $out.core[$e.Name] = @{ sha256 = $hash; bytes = $bytes.Length }',
        '    }',
        '  }',
        '} finally {',
        '  $sha.Dispose()',
        '  $zr.Dispose()',
        '}',
        '$out | ConvertTo-Json -Compress -Depth 4'
      ].join('; ');

      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        cwd: baseDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      if (r.status !== 0) {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        throw new Error(`ZipArchive pack failed: ${(r.stderr || r.stdout || '').trim()}`);
      }
      const verifyData = JSON.parse(String(r.stdout || '').trim());
      if (verifyData.hasBackslash) {
        fs.unlinkSync(zipPath);
        throw new Error(`Verification failed: backslash path detected in ${zipName}`);
      }
      for (const [name, meta] of Object.entries(manifest.files)) {
        const actual = verifyData.core?.[name];
        if (!actual) {
          fs.unlinkSync(zipPath);
          throw new Error(`Verification failed: missing core/${name} in ${zipName}`);
        }
        if (actual.sha256 !== meta.sha256 || actual.bytes !== meta.bytes) {
          fs.unlinkSync(zipPath);
          throw new Error(
            `Verification failed for core/${name} in ${zipName}: expected ${meta.sha256} (${meta.bytes}B), got ${actual.sha256} (${actual.bytes}B)`
          );
        }
      }
    } finally {
      try {
        if (fs.existsSync(listTmpPath)) fs.unlinkSync(listTmpPath);
      } catch {}
    }
  } else {
    const r = spawnSync('zip', ['-q', zipPath, ...entriesToPack.map((e) => e.entry)], {
      cwd: baseDir,
      stdio: 'inherit'
    });
    if (r.status !== 0) throw new Error('zip command failed');
    // 逐文件校验 zip 内 core/* 的 SHA-256 与字节数与 manifest 完全一致，杜绝脏包发布
    for (const [name, meta] of Object.entries(manifest.files)) {
      const uz = spawnSync('unzip', ['-p', zipPath, `core/${name}`], { maxBuffer: 20 * 1024 * 1024 });
      if (uz.status !== 0) {
        fs.unlinkSync(zipPath);
        throw new Error(`Verification failed: missing core/${name} in ${zipName}`);
      }
      const actualSha = crypto.createHash('sha256').update(uz.stdout).digest('hex');
      if (actualSha !== meta.sha256 || uz.stdout.length !== meta.bytes) {
        fs.unlinkSync(zipPath);
        throw new Error(
          `Verification failed for core/${name} in ${zipName}: expected ${meta.sha256} (${meta.bytes}B), got ${actualSha} (${uz.stdout.length}B)`
        );
      }
    }
  }
  const st = fs.statSync(zipPath);
  return { zipPath, filename: zipName, bytes: st.size, sha256: sha256File(zipPath) };
}

function extractChangelogHighlights(baseDir, version) {
  const clPath = path.join(baseDir, 'CHANGELOG.md');
  if (!fs.existsSync(clPath)) return [];
  try {
    const lines = fs.readFileSync(clPath, 'utf8').split(/\r?\n/);
    const cleanVer = String(version || '').replace(/^v/i, '');
    let inSection = false;
    const bullets = [];
    for (const line of lines) {
      if (/^##\s+\[/.test(line)) {
        if (inSection) break;
        if (line.includes(`[v${cleanVer}]`) || line.includes(`[${cleanVer}]`)) {
          inSection = true;
        }
        continue;
      }
      if (!inSection) continue;
      if (line.startsWith('- ')) {
        const clean = line
          .slice(2)
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/[：:]\s*$/, '')
          .trim();
        if (clean) bullets.push(clean.length > 140 ? clean.slice(0, 137) + '...' : clean);
        if (bullets.length >= 4) break;
      }
    }
    return bullets;
  } catch {
    return [];
  }
}

function buildDistZip(baseDir = __dirname, { updateBundleOnly = false, setVersion = null } = {}) {
  const manifest = buildManifest(baseDir, setVersion !== null ? { setVersion } : {});
  const distDir = path.join(baseDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const fullInclude = ['LICENSE', 'SKILL.md', 'README.md', 'CHANGELOG.md', 'install.mjs', '.gitattributes', '.gitignore', 'core', 'user', 'assets'].filter((item) =>
    fs.existsSync(path.join(baseDir, item))
  );
  const slimInclude = ['LICENSE', 'SKILL.md', 'README.md', 'CHANGELOG.md', 'install.mjs', 'core', 'user'].filter((item) =>
    fs.existsSync(path.join(baseDir, item))
  );

  let fullInfo = null;
  if (!updateBundleOnly) {
    const fullZipPath = path.join(distDir, `${manifest.name}-v${manifest.version}.zip`);
    fullInfo = packAndVerifyZip(baseDir, fullZipPath, collectPackEntries(baseDir, fullInclude), manifest);
  }

  const updateZipName = `core-update-v${manifest.version}.zip`;
  const updateZipPath = path.join(distDir, updateZipName);
  const updateInfo = packAndVerifyZip(baseDir, updateZipPath, collectPackEntries(baseDir, slimInclude), manifest);

  const tag = `v${manifest.version}`;
  const latestPayload = {
    schemaVersion: 1,
    name: manifest.name,
    channel: 'stable',
    version: manifest.version,
    releasedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    minNodeVersion: manifest.minNodeVersion || '22.0.0',
    minAntigravityVersion: manifest.minAntigravityVersion || '2.34.0',
    changelog: extractChangelogHighlights(baseDir, manifest.version),
    coreUpdateBundle: {
      filename: updateInfo.filename,
      bytes: updateInfo.bytes,
      sha256: updateInfo.sha256,
      mirrors: [
        { id: 'cloudflare-r2', url: `${R2_UPDATE_BASE_URL}/${updateInfo.filename}` },
        { id: 'github-release', url: `${GITHUB_REPO_URL}/releases/download/${tag}/${updateInfo.filename}` }
      ]
    },
    ...(fullInfo
      ? {
          fullBundle: {
            filename: fullInfo.filename,
            bytes: fullInfo.bytes,
            sha256: fullInfo.sha256,
            mirrors: [
              { id: 'github-release', url: `${GITHUB_REPO_URL}/releases/download/${tag}/${fullInfo.filename}` }
            ]
          }
        }
      : {}),
    fullReleaseUrl: `${GITHUB_REPO_URL}/releases/tag/${tag}`
  };
  const latestJsonPath = path.join(distDir, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestPayload, null, 2) + '\n', 'utf8');

  return {
    zipPath: fullInfo ? fullInfo.zipPath : updateInfo.zipPath,
    ...(fullInfo ? { fullZipPath: fullInfo.zipPath, fullBytes: fullInfo.bytes } : {}),
    updateZipPath: updateInfo.zipPath,
    updateBytes: updateInfo.bytes,
    latestJsonPath,
    version: manifest.version,
    filesVerified: Object.keys(manifest.files).length
  };
}

function verifyCoreIntegrity(baseDir = __dirname, { coreDir = path.join(baseDir, 'core') } = {}) {
  const manifestPath = path.join(coreDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing manifest.json', modified: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'invalid manifest.json', modified: [] };
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object' || Object.keys(manifest.files).length === 0) {
    return { ok: false, reason: 'invalid manifest.json', modified: [] };
  }
  const resolvedCoreRoot = path.resolve(coreDir);
  const resolvedCorePrefix = resolvedCoreRoot.endsWith(path.sep) ? resolvedCoreRoot : resolvedCoreRoot + path.sep;
  const modified = [];
  for (const [name, meta] of Object.entries(manifest.files)) {
    if (
      !name ||
      typeof name !== 'string' ||
      name.includes('\0') ||
      name.includes('..') ||
      path.basename(name) !== name
    ) {
      modified.push({ file: String(name), status: 'invalid_manifest_entry' });
      continue;
    }
    const p = path.resolve(resolvedCoreRoot, name);
    if (!p.startsWith(resolvedCorePrefix)) {
      modified.push({ file: name, status: 'invalid_manifest_entry' });
      continue;
    }
    if (!meta || typeof meta !== 'object' || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.sha256)) {
      modified.push({ file: name, status: 'invalid_manifest_entry' });
      continue;
    }
    if (!fs.existsSync(p)) {
      modified.push({ file: name, status: 'missing' });
      continue;
    }
    const expectedSha = meta.sha256.toLowerCase();
    let actualHash = sha256File(p);
    if (actualHash !== expectedSha) {
      // 自动自愈 Windows Git core.autocrlf=true 导致的 CRLF 换行符哈希差异
      try {
        const rawText = fs.readFileSync(p, 'utf8');
        if (rawText.includes('\r\n')) {
          const lfText = rawText.replace(/\r\n/g, '\n');
          const lfHash = crypto.createHash('sha256').update(Buffer.from(lfText, 'utf8')).digest('hex');
          if (lfHash === expectedSha) {
            fs.writeFileSync(p, lfText, 'utf8');
            actualHash = lfHash;
          }
        }
      } catch {}
    }
    if (actualHash !== expectedSha) {
      modified.push({ file: name, status: 'modified', expected: expectedSha, actual: actualHash });
    }
  }
  return { ok: modified.length === 0, manifest, modified };
}

// ============================================================================
// 2. 环境、字体、2.33.0+ CDP Opt-in 状态、M1 启动器与实时 CDP 窗口检查
// ============================================================================
function buildWin32LnkSpecsPs() {
  return [
    `$lnkSpecs = if ($env:AG_WIN32_LNK_DIRS) {`,
    `  @($env:AG_WIN32_LNK_DIRS -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object { @{ dir = $_; recurse = $true; depth = 2 } })`,
    `} else {`,
    `  @(`,
    `    @{ dir = [Environment]::GetFolderPath('Desktop'); recurse = $false; depth = 0 },`,
    `    @{ dir = [Environment]::GetFolderPath('CommonDesktopDirectory'); recurse = $false; depth = 0 },`,
    `    @{ dir = (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'); recurse = $true; depth = 2 },`,
    `    @{ dir = (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'); recurse = $true; depth = 2 },`,
    `    @{ dir = (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'); recurse = $false; depth = 0 }`,
    `  ) | Where-Object { $_.dir -and (Test-Path -LiteralPath $_.dir) }`,
    `}`,
    `$seenLnkDirs = @{}`
  ];
}

function pickMinDetectedHostVersion(versions) {
  const clean = [];
  for (const raw of versions) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v) clean.push(v);
  }
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const parseTuple = (s) => {
    const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  let best = clean[0];
  let bestTuple = parseTuple(best);
  for (let i = 1; i < clean.length; i++) {
    const cur = clean[i];
    const curTuple = parseTuple(cur);
    if (curTuple && bestTuple) {
      const diff =
        curTuple[0] !== bestTuple[0]
          ? curTuple[0] - bestTuple[0]
          : curTuple[1] !== bestTuple[1]
          ? curTuple[1] - bestTuple[1]
          : curTuple[2] - bestTuple[2];
      if (diff < 0) {
        best = cur;
        bestTuple = curTuple;
      }
    } else if (curTuple && !bestTuple) {
      best = cur;
      bestTuple = curTuple;
    }
  }
  return best;
}

function extractLinuxDesktopExecBinary(rawDesktop) {
  const lines = String(rawDesktop || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^Exec\s*=\s*(.+)$/);
    if (!m) continue;
    const rhs = m[1].trim();
    const tokens = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < rhs.length; i++) {
      const ch = rhs[i];
      if (quote) {
        if (ch === '\\' && i + 1 < rhs.length) {
          cur += rhs[++i];
        } else if (ch === quote) {
          quote = '';
        } else {
          cur += ch;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '\\' && i + 1 < rhs.length) {
        cur += rhs[++i];
      } else if (/\s/.test(ch)) {
        if (cur.length > 0) {
          tokens.push(cur);
          cur = '';
        }
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) tokens.push(cur);

    let idx = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (/^(?:\/usr\/bin\/|\/bin\/)?env$/.test(tok)) {
        idx++;
        while (idx < tokens.length) {
          const envArg = tokens[idx];
          if (envArg === '-u' || envArg === '--unset') {
            idx += 2;
          } else if (envArg === '--') {
            idx++;
            break;
          } else if (envArg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(envArg)) {
            idx++;
          } else {
            break;
          }
        }
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        idx++;
        continue;
      }
      if (/^%[fFuUdDnNickvm%]$/.test(tok)) {
        idx++;
        continue;
      }
      return tok;
    }
  }
  return '';
}

function readHostVersionAndProcesses(channel = 'auto') {
  const home = os.homedir();
  const allowStable = channel !== 'insiders';
  const allowInsiders = channel !== 'stable';
  let appVersion = null;
  let runningProcesses = [];
  let launcherInstalled = false;

  if (process.platform === 'darwin') {
    const readDarwinBundleVersion = (appBundle) => {
      const infoPlist = path.join(appBundle, 'Contents', 'Info.plist');
      if (!fs.existsSync(infoPlist)) return null;
      try {
        const xml = fs.readFileSync(infoPlist, 'utf8');
        const m = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
        if (m && m[1]) return m[1].trim();
      } catch {}
      return null;
    };
    const appCandidates = [
      ...(allowStable
        ? ['/Applications/Antigravity.app', path.join(home, 'Applications/Antigravity.app')]
        : []),
      ...(allowInsiders
        ? ['/Applications/Antigravity - Insiders.app', path.join(home, 'Applications/Antigravity - Insiders.app')]
        : [])
    ];
    const launcherApp =
      channel === 'insiders'
        ? path.join(home, 'Applications', 'Antigravity - Insiders (Theme).app')
        : path.join(home, 'Applications', 'Antigravity (Theme).app');
    launcherInstalled = fs.existsSync(path.join(launcherApp, 'Contents', 'MacOS', 'launcher'));

    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 2500 });
    if (ps.status === 0 && ps.stdout) {
      for (const line of String(ps.stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const cmd = m[2];
        if (
          !pid ||
          /--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk|--ms-enable-electron-run-as-node/i.test(cmd) ||
          /Helper(?:\s|\.|\/)/i.test(cmd)
        ) {
          continue;
        }
        const appMatch = cmd.match(
          /^"?(\/[^\r\n"]*?\/Antigravity(?:\s-\sInsiders)?\.app)\/Contents\/MacOS\/(Antigravity(?:\s-\sInsiders)?)"?(?:\s|$)/
        );
        if (!appMatch) continue;
        const ch = /Insiders/i.test(appMatch[2]) ? 'insiders' : 'stable';
        if ((ch === 'stable' && !allowStable) || (ch === 'insiders' && !allowInsiders)) continue;
        runningProcesses.push({
          pid,
          channel: ch,
          appPath: appMatch[1],
          exePath: `${appMatch[1]}/Contents/MacOS/${appMatch[2]}`,
          cmd,
          hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/.test(cmd)
        });
      }
    }
    if (runningProcesses.length > 0) {
      appVersion = pickMinDetectedHostVersion(
        runningProcesses.map((proc) => (proc.appPath ? readDarwinBundleVersion(proc.appPath) : null))
      );
    }
    if (!appVersion) {
      appVersion = pickMinDetectedHostVersion(appCandidates.map((appBundle) => readDarwinBundleVersion(appBundle)));
    }
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const stableExeCandidates = allowStable
      ? [
          path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
          path.join(progFiles, 'Antigravity', 'Antigravity.exe')
        ]
      : [];
    const insidersExeCandidates = allowInsiders
      ? [
          path.join(localAppData, 'Programs', 'Antigravity - Insiders', 'Antigravity - Insiders.exe'),
          path.join(progFiles, 'Antigravity - Insiders', 'Antigravity - Insiders.exe')
        ]
      : [];
    const existingStableExe = stableExeCandidates.find((p) => fs.existsSync(p)) || '';
    const existingInsidersExe = insidersExeCandidates.find((p) => fs.existsSync(p)) || '';
    const existingExes = [...stableExeCandidates, ...insidersExeCandidates].filter((p) => fs.existsSync(p));
    const psExeList = existingExes.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
    const psProbe = [
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$allowStable = $${allowStable ? 'true' : 'false'}`,
      `$allowInsiders = $${allowInsiders ? 'true' : 'false'}`,
      `$staticVers = @()`,
      existingExes.length > 0
        ? `$staticVers = @(foreach ($ep in @(${psExeList})) { try { $sv = [string](Get-Item -LiteralPath $ep -ErrorAction Stop).VersionInfo.ProductVersion; if ($sv) { $sv } } catch {} })`
        : '',
      `$procs = @()`,
      `try { $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe' OR Name = 'Antigravity - Insiders.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -notmatch '--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk|--ms-enable-electron-run-as-node' } | ForEach-Object { $ep = [string]$_.ExecutablePath; $pv = ''; if ($ep) { try { $pv = [string](Get-Item -LiteralPath $ep -ErrorAction Stop).VersionInfo.ProductVersion } catch {} }; @{ pid = [int]$_.ProcessId; name = [string]$_.Name; exe = $ep; ver = $pv; cmd = [string]$_.CommandLine } }) } catch {}`,
      `if ($procs.Count -eq 0) { $byName = Get-Process -Name 'Antigravity','Antigravity - Insiders' -ErrorAction SilentlyContinue | Group-Object ProcessName; $procs = @(foreach ($g in $byName) { $p = ($g.Group | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1); if ($null -eq $p) { $p = $g.Group | Select-Object -First 1 }; if ($null -ne $p) { $exePath = ''; $pv = ''; try { $exePath = [string]$p.Path; if ($exePath) { $pv = [string](Get-Item -LiteralPath $exePath -ErrorAction Stop).VersionInfo.ProductVersion } } catch {}; @{ pid = [int]$p.Id; name = ([string]$p.ProcessName + '.exe'); exe = $exePath; ver = $pv; cmd = '' } } }) }`,
      `$lnkOk = $false`,
      `$wsh = New-Object -ComObject WScript.Shell`,
      ...buildWin32LnkSpecsPs(),
      `foreach ($spec in $lnkSpecs) { $dk = ([string]$spec.dir).ToLowerInvariant(); if ($seenLnkDirs.ContainsKey($dk)) { continue }; $seenLnkDirs[$dk] = $true; $items = if ($spec.recurse) { Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -Recurse -Depth $spec.depth -ErrorAction SilentlyContinue } else { Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue }; foreach ($item in $items) { try { $s = $wsh.CreateShortcut($item.FullName); $leaf = [IO.Path]::GetFileName([string]$s.TargetPath); $matchTarget = (($leaf -ieq 'Antigravity.exe' -and $allowStable) -or ($leaf -ieq 'Antigravity - Insiders.exe' -and $allowInsiders)); if ($matchTarget -and ($s.Arguments -match '--remote-debugging-port')) { $lnkOk = $true } } catch {} } }`,
      `@{ staticVers = $staticVers; launcherInstalled = $lnkOk; procs = $procs } | ConvertTo-Json -Compress -Depth 4`
    ]
      .filter(Boolean)
      .join('\n');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psProbe], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 6000
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      try {
        const info = JSON.parse(r.stdout.trim());
        launcherInstalled = Boolean(info.launcherInstalled);
        const rawProcs = Array.isArray(info.procs) ? info.procs : info.procs ? [info.procs] : [];
        const procVersions = [];
        runningProcesses = rawProcs
          .map((p) => {
            const ch = /insiders/i.test(p.name || p.exe || '') ? 'insiders' : 'stable';
            const cmd = String(p.cmd || '');
            const exeVer = typeof p.ver === 'string' ? p.ver.trim() : '';
            const fallbackExe = (ch === 'insiders' ? existingInsidersExe : existingStableExe) || existingExes[0] || '';
            return {
              pid: Number(p.pid) || 0,
              channel: ch,
              appPath: '',
              exePath: String(p.exe || fallbackExe),
              _exeVer: exeVer,
              cmd,
              hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/i.test(cmd)
            };
          })
          .filter(
            (p) =>
              p.pid > 0 && ((p.channel === 'stable' && allowStable) || (p.channel === 'insiders' && allowInsiders))
          )
          .map(({ _exeVer, ...rest }) => {
            if (_exeVer) procVersions.push(_exeVer);
            return rest;
          });
        appVersion = pickMinDetectedHostVersion(procVersions);
        if (!appVersion) {
          const rawStaticVers = Array.isArray(info.staticVers)
            ? info.staticVers
            : info.staticVers
            ? [info.staticVers]
            : [];
          appVersion = pickMinDetectedHostVersion(rawStaticVers);
        }
      } catch {}
    }
  } else {
    const readLinuxPkgVersion = (pkgPath) => {
      if (!pkgPath || !fs.existsSync(pkgPath)) return null;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
          return pkg.version.trim();
        }
      } catch {}
      return null;
    };
    const resolveLinuxExecutablePath = (rawExe) => {
      const token = String(rawExe || '').trim().replace(/\s+\(deleted\)$/, '');
      if (!token) return '';
      if (token.startsWith('/')) return token;
      if (token.includes('/')) return '';
      const pathDirs = [
        ...String(process.env.PATH || '').split(':'),
        path.join(home, '.local', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/snap/bin'
      ];
      for (const dir of pathDirs) {
        if (!dir) continue;
        const cand = path.join(dir, token);
        if (fs.existsSync(cand)) return cand;
      }
      return '';
    };
    const probeLinuxAppVersionFromExecutable = (rawExe) => {
      const exe = resolveLinuxExecutablePath(rawExe);
      if (!exe || !exe.startsWith('/')) return null;
      let realExe = exe;
      try {
        if (fs.existsSync(exe)) realExe = fs.realpathSync(exe);
      } catch {}
      const isIns = /insiders/i.test(exe) || /insiders/i.test(realExe);
      const appFolder = isIns ? 'antigravity-insiders' : 'antigravity';
      const dirsToCheck = Array.from(new Set([path.dirname(realExe), path.dirname(exe)]));
      for (const baseDir of dirsToCheck) {
        const relCandidates = [
          path.join(baseDir, 'resources', 'app', 'package.json'),
          path.join(baseDir, '..', 'resources', 'app', 'package.json'),
          path.join(baseDir, '..', 'share', appFolder, 'resources', 'app', 'package.json'),
          path.join(baseDir, '..', 'lib', appFolder, 'resources', 'app', 'package.json')
        ];
        for (const cand of relCandidates) {
          const ver = readLinuxPkgVersion(cand);
          if (ver) return ver;
        }
      }
      return null;
    };
    const userAppsDir = path.join(home, '.local', 'share', 'applications');
    const desktopNames = [
      allowStable ? 'antigravity.desktop' : null,
      allowInsiders ? 'antigravity-insiders.desktop' : null
    ].filter(Boolean);
    launcherInstalled = desktopNames.some((name) => {
      const p = path.join(userAppsDir, name);
      try {
        return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('--remote-debugging-port');
      } catch {
        return false;
      }
    });
    const probeLinuxChannelStaticVersions = (ch) => {
      const isIns = ch === 'insiders';
      const pkgPaths = isIns
        ? [
            '/usr/share/antigravity-insiders/resources/app/package.json',
            '/opt/Antigravity - Insiders/resources/app/package.json',
            '/opt/Antigravity-Insiders/resources/app/package.json',
            '/opt/antigravity-insiders/resources/app/package.json'
          ]
        : [
            '/usr/share/antigravity/resources/app/package.json',
            '/opt/Antigravity/resources/app/package.json',
            '/opt/antigravity/resources/app/package.json'
          ];
      const found = [];
      for (const pkgPath of pkgPaths) {
        const ver = readLinuxPkgVersion(pkgPath);
        if (ver) found.push(ver);
      }
      if (found.length > 0) return found;
      const desktopName = isIns ? 'antigravity-insiders.desktop' : 'antigravity.desktop';
      for (const dir of [userAppsDir, '/usr/share/applications']) {
        const dp = path.join(dir, desktopName);
        if (!fs.existsSync(dp)) continue;
        try {
          const raw = fs.readFileSync(dp, 'utf8');
          const execBin = extractLinuxDesktopExecBinary(raw);
          const ver = probeLinuxAppVersionFromExecutable(execBin);
          if (ver) {
            found.push(ver);
            break;
          }
        } catch {}
      }
      return found;
    };
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 2500 });
    const procVersions = [];
    if (ps.status === 0 && ps.stdout) {
      for (const line of String(ps.stdout).split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const cmd = m[2];
        if (
          !pid ||
          /--type=|--crashpad|--utility-sub-type=|--import=|sidecar_sdk|--ms-enable-electron-run-as-node|daemon\.mjs|install\.mjs/i.test(
            cmd
          )
        ) {
          continue;
        }
        const binMatch = cmd.match(
          /^(?:"((?:[^"\r\n]*\/)?antigravity(?:-insiders)?)"|'((?:[^'\r\n]*\/)?antigravity(?:-insiders)?)'|(\/(?:[^\s"']|\s-\sinsiders)*\/antigravity(?:-insiders)?)|(antigravity(?:-insiders)?))(?=\s+(?!-\s*insiders(?:\/|\s|$))|$)/i
        );
        let matchedExe = binMatch ? binMatch[1] || binMatch[2] || binMatch[3] || binMatch[4] || '' : '';
        let procLinkExe = '';
        if (typeof fs.readlinkSync === 'function') {
          try {
            const linkTarget = String(fs.readlinkSync(`/proc/${pid}/exe`) || '').replace(/\s+\(deleted\)$/, '');
            if (/\/antigravity(?:-insiders)?$/i.test(linkTarget)) {
              procLinkExe = linkTarget;
              if (!matchedExe) matchedExe = linkTarget;
            }
          } catch {}
        }
        if (!matchedExe) continue;
        const resolvedExe = resolveLinuxExecutablePath(procLinkExe || matchedExe) || procLinkExe || matchedExe;
        const ch = /insiders/i.test(procLinkExe || resolvedExe || matchedExe) ? 'insiders' : 'stable';
        if ((ch === 'stable' && !allowStable) || (ch === 'insiders' && !allowInsiders)) continue;
        runningProcesses.push({
          pid,
          channel: ch,
          appPath: '',
          exePath: resolvedExe,
          cmd,
          hasCdpFlag: /--remote-debugging-port(?:=|\s|$)/.test(cmd)
        });
        const procVer =
          probeLinuxAppVersionFromExecutable(procLinkExe || resolvedExe || matchedExe) ||
          pickMinDetectedHostVersion(probeLinuxChannelStaticVersions(ch));
        if (procVer) procVersions.push(procVer);
      }
    }
    if (procVersions.length > 0) {
      appVersion = pickMinDetectedHostVersion(procVersions);
    }
    if (!appVersion) {
      const staticVers = [
        ...(allowStable ? probeLinuxChannelStaticVersions('stable') : []),
        ...(allowInsiders ? probeLinuxChannelStaticVersions('insiders') : [])
      ];
      appVersion = pickMinDetectedHostVersion(staticVers);
    }
  }

  return { appVersion, runningProcesses, launcherInstalled };
}

async function detectEnvironment(channel = 'auto') {
  const nodeVer = process.versions.node;
  const [major, minor] = nodeVer.split('.').map((n) => parseInt(n, 10));
  const nodeBasicOk = major >= 22;

  let sqliteAvailable = false;
  try {
    const mod = await import('node:sqlite').catch(() => null);
    sqliteAvailable = !!(mod && typeof mod.DatabaseSync === 'function');
  } catch {
    sqliteAvailable = false;
  }

  const home = os.homedir();
  const winUserFontsDir =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
      : null;
  const winSystemFontsDir =
    process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts') : null;
  const fontDirs =
    process.platform === 'darwin'
      ? [path.join(home, 'Library/Fonts'), '/Library/Fonts']
      : process.platform === 'win32'
      ? [winUserFontsDir, winSystemFontsDir]
      : [path.join(home, '.local/share/fonts'), '/usr/local/share/fonts', '/usr/share/fonts'];

  let allFontFiles = [];
  let userFontFiles = [];
  let systemFontFiles = [];
  for (const d of fontDirs) {
    try {
      if (d && fs.existsSync(d)) {
        const list = fs.readdirSync(d);
        allFontFiles.push(...list);
        if (process.platform === 'win32') {
          if (winUserFontsDir && isSameTargetPath(d, winUserFontsDir)) {
            userFontFiles = list;
          } else if (winSystemFontsDir && isSameTargetPath(d, winSystemFontsDir)) {
            systemFontFiles = list;
          }
        }
      }
    } catch {}
  }

  let winHkcuFontEntries = null;
  if (process.platform === 'win32') {
    winHkcuFontEntries = readWinHkcuFontRegistryEntries();
  }

  const registeredWinUserBasenames = new Set();
  if (Array.isArray(winHkcuFontEntries)) {
    for (const e of winHkcuFontEntries) {
      const rawData = String(e?.data || '').trim();
      if (!rawData) continue;
      const base = path.win32.basename(rawData).toLowerCase();
      if (base) registeredWinUserBasenames.add(base);
    }
  }

  // Windows 下 Chromium local() 只能识别已写入注册表（HKCU\...\Fonts）或系统目录（C:\Windows\Fonts）的字体；
  // 仅手动复制到 AppData\Local\Microsoft\Windows\Fonts 但未写注册表的文件不算“有效已装”
  const effectiveFontFiles =
    process.platform === 'win32' && Array.isArray(winHkcuFontEntries)
      ? [
          ...systemFontFiles,
          ...userFontFiles.filter((f) => registeredWinUserBasenames.has(f.toLowerCase()))
        ]
      : allFontFiles;

  // v5.5.0+ UI 西文直连官方 Google Sans Flex 引擎，本地仅需 Anthropic Serif（对话正文）+ Anthropic Mono（代码）+ Sarasa（中文）
  const hasAnthropicSerifFont = effectiveFontFiles.some((f) => /AnthropicSerif|Anthropic[ _-]Serif/i.test(f));
  const hasAnthropicSerifRegular = effectiveFontFiles.some((f) =>
    /AnthropicSerif.*(Regular|Text)|Anthropic[ _-]Serif.*(Regular|Text)/i.test(f)
  );
  const hasAnthropicSerifBold = effectiveFontFiles.some((f) =>
    /AnthropicSerif.*(Bold|SemiBold)|Anthropic[ _-]Serif.*(Bold|SemiBold)/i.test(f)
  );
  const hasAnthropicMonoFont = effectiveFontFiles.some((f) => /AnthropicMono|Anthropic[ _-]Mono/i.test(f));
  const hasAnthropicFont = hasAnthropicSerifFont && hasAnthropicMonoFont;
  const hasSarasaUiScSplit = effectiveFontFiles.some((f) => /^Sarasa[-_ ]?Ui[-_ ]?SC[-_ ].*\.ttf$/i.test(f));
  const hasSarasaMonoSlabScSplit = effectiveFontFiles.some((f) => /^Sarasa[-_ ]?Mono[-_ ]?Slab[-_ ]?SC[-_ ].*\.ttf$/i.test(f));
  const hasSarasaSplitScTtf = hasSarasaUiScSplit && hasSarasaMonoSlabScSplit;

  const systemWinFontBasenames = new Set(systemFontFiles.map((f) => f.toLowerCase()));
  const targetFontFilePattern = /AnthropicSerif|Anthropic[ _-]Serif|AnthropicMono|Anthropic[ _-]Mono|Sarasa|更纱|更紗/i;
  const unregisteredWinFonts =
    process.platform === 'win32' && Array.isArray(winHkcuFontEntries)
      ? userFontFiles.filter(
          (f) =>
            /\.(ttf|otf|ttc)$/i.test(f) &&
            targetFontFilePattern.test(f) &&
            !(hasSarasaSplitScTtf && /Sarasa.*\.ttc$/i.test(f)) &&
            !registeredWinUserBasenames.has(f.toLowerCase()) &&
            !systemWinFontBasenames.has(f.toLowerCase())
        )
      : [];
  const diskHasSuperTtc = allFontFiles.some((f) => /Sarasa[ _-]?SuperTTC[^\\\/]*\.ttc$/i.test(f));
  const sysHasSuperTtc = systemFontFiles.some((f) => /Sarasa[ _-]?SuperTTC[^\\\/]*\.ttc$/i.test(f));
  const hkcuHasSuperTtc =
    winHkcuFontEntries !== null
      ? winHkcuFontEntries.some(
          (e) => /Sarasa[ _-]?SuperTTC/i.test(e.name) || /Sarasa[ _-]?SuperTTC[^\\\/]*\.ttc$/i.test(e.data)
        )
      : diskHasSuperTtc;
  const hasSarasaSuperTtc =
    process.platform === 'win32' ? Boolean(sysHasSuperTtc || hkcuHasSuperTtc) : diskHasSuperTtc;
  const orphanSuperTtcPendingReboot = Boolean(process.platform === 'win32' && diskHasSuperTtc && !hasSarasaSuperTtc);
  const hasSarasaFont =
    process.platform === 'win32'
      ? Boolean(
          hasSarasaSplitScTtf ||
            hasSarasaSuperTtc ||
            systemFontFiles.some((f) => /Sarasa|更纱|更紗/i.test(f)) ||
            (winHkcuFontEntries !== null &&
              winHkcuFontEntries.some((e) => /Sarasa|更纱|更紗/i.test(e.name) || /Sarasa|更纱|更紗/i.test(e.data)))
        )
      : effectiveFontFiles.some((f) => /Sarasa|更纱|更紗/i.test(f));

  const checkSingleChannel = (ch) => {
    const isInsiders = ch === 'insiders';
    const appDirName = isInsiders ? 'Antigravity - Insiders' : 'Antigravity';
    const dotDir = path.join(home, isInsiders ? '.antigravity-insiders' : '.antigravity');
    let portFile;
    let appPaths = [];
    let winExePaths = [];
    if (process.platform === 'darwin') {
      portFile = path.join(home, 'Library/Application Support', appDirName, 'DevToolsActivePort');
      const bundleName = isInsiders ? 'Antigravity - Insiders.app' : 'Antigravity.app';
      appPaths = [path.join('/Applications', bundleName), path.join(home, 'Applications', bundleName)];
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
      portFile = path.join(appData, appDirName, 'DevToolsActivePort');
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const exeName = isInsiders ? 'Antigravity - Insiders.exe' : 'Antigravity.exe';
      winExePaths = [
        path.join(localAppData, 'Programs', appDirName, exeName),
        path.join(progFiles, appDirName, exeName)
      ];
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      portFile = path.join(xdg, appDirName, 'DevToolsActivePort');
    }
    const linuxInstallDirs =
      process.platform !== 'darwin' && process.platform !== 'win32'
        ? isInsiders
          ? [
              '/usr/share/antigravity-insiders',
              '/opt/Antigravity - Insiders',
              '/opt/Antigravity-Insiders',
              '/opt/antigravity-insiders'
            ]
          : ['/usr/share/antigravity', '/opt/Antigravity', '/opt/antigravity']
        : [];
    const portFileExists = fs.existsSync(portFile);
    const appExists =
      appPaths.length > 0
        ? appPaths.some((p) => fs.existsSync(p)) || portFileExists
        : portFileExists ||
          fs.existsSync(path.dirname(portFile)) ||
          fs.existsSync(dotDir) ||
          winExePaths.some((p) => fs.existsSync(p)) ||
          linuxInstallDirs.some((d) => fs.existsSync(d));
    return {
      channel: ch,
      appExists,
      portFile,
      portFileExists
    };
  };

  const primaryChannel = channel === 'insiders' ? 'insiders' : 'stable';
  const stableInfo = checkSingleChannel('stable');
  const insidersInfo = checkSingleChannel('insiders');
  const chInfo = primaryChannel === 'insiders' ? insidersInfo : stableInfo;
  const channelsMap = {
    stable: stableInfo,
    insiders: insidersInfo
  };
  const hostRuntime = readHostVersionAndProcesses(channel);
  const portFileExists =
    channel === 'stable'
      ? stableInfo.portFileExists
      : channel === 'insiders'
      ? insidersInfo.portFileExists
      : hostRuntime.runningProcesses.length > 0
      ? hostRuntime.runningProcesses.some((p) => channelsMap[p.channel]?.portFileExists)
      : stableInfo.portFileExists || insidersInfo.portFileExists;

  let cdpStatus = 'app_not_running';
  if (hostRuntime.runningProcesses.length > 0) {
    const anyReadyRunning = hostRuntime.runningProcesses.some(
      (p) => p.hasCdpFlag || channelsMap[p.channel]?.portFileExists
    );
    cdpStatus = anyReadyRunning ? 'ready' : 'missing_opt_in_flag';
  } else if (portFileExists) {
    cdpStatus = 'stale_port_file';
  }

  const activeRunningChannel = hostRuntime.runningProcesses[0]?.channel || primaryChannel;
  const preferredPortFile =
    channelsMap[activeRunningChannel]?.portFile ||
    (chInfo.portFileExists
      ? chInfo.portFile
      : channel !== 'stable' && insidersInfo.portFileExists
      ? insidersInfo.portFile
      : chInfo.portFile);
  const channelAppExists =
    channel === 'stable'
      ? stableInfo.appExists
      : channel === 'insiders'
      ? insidersInfo.appExists
      : stableInfo.appExists || insidersInfo.appExists;

  return {
    nodeVer,
    major,
    minor,
    nodeBasicOk,
    sqliteAvailable,
    tier: sqliteAvailable
      ? 'FULL (>= 22.13, Theme + Google Sans Flex/Sarasa/Serif + i18n + SQLite Live Metrics)'
      : nodeBasicOk
      ? 'STANDARD (22.0~22.12, Theme + Fonts + i18n; SQLite Metrics gracefully disabled)'
      : 'UNSUPPORTED (< 22.0, requires Node 22+)',
    hasAnthropicFont,
    hasAnthropicSerifFont,
    hasAnthropicSerifRegular,
    hasAnthropicSerifBold,
    hasAnthropicMonoFont,
    hasSarasaFont,
    hasSarasaSplitScTtf,
    hasSarasaSuperTtc,
    orphanSuperTtcPendingReboot,
    unregisteredWinFonts,
    winUserFontsDir,
    channel,
    appExists: channelAppExists || hostRuntime.runningProcesses.length > 0,
    appVersion: hostRuntime.appVersion,
    cdpStatus,
    launcherInstalled: hostRuntime.launcherInstalled,
    runningProcesses: hostRuntime.runningProcesses,
    portFile: preferredPortFile,
    portFileExists,
    channels: channelsMap
  };
}

function inspectJsoncRootObject(raw) {
  let i = 0;
  const len = raw.length;
  let depth = 0;
  let openBraceIdx = -1;
  let closeBraceIdx = -1;
  let hasTopProps = false;
  let hasRemoteDebuggingPort = false;

  while (i < len) {
    const ch = raw[i];
    const next = i + 1 < len ? raw[i + 1] : '';

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < len && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"') {
      i++;
      let val = '';
      while (i < len) {
        if (raw[i] === '\\') {
          val += raw.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
        val += raw[i++];
      }
      if (depth === 1 && openBraceIdx !== -1 && closeBraceIdx === -1) {
        hasTopProps = true;
        if (val === 'remote-debugging-port') {
          let k = i;
          while (k < len) {
            if (/\s/.test(raw[k])) {
              k++;
            } else if (raw[k] === '/' && raw[k + 1] === '/') {
              k += 2;
              while (k < len && raw[k] !== '\n') k++;
            } else if (raw[k] === '/' && raw[k + 1] === '*') {
              k += 2;
              while (k + 1 < len && !(raw[k] === '*' && raw[k + 1] === '/')) k++;
              k += 2;
            } else {
              break;
            }
          }
          if (raw[k] === ':') {
            hasRemoteDebuggingPort = true;
          }
        }
      }
      continue;
    }

    if (ch === '{') {
      if (depth === 0 && openBraceIdx === -1) {
        openBraceIdx = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && openBraceIdx !== -1 && closeBraceIdx === -1) {
        closeBraceIdx = i;
      }
    } else if (depth === 1 && openBraceIdx !== -1 && closeBraceIdx === -1 && !/\s/.test(ch)) {
      hasTopProps = true;
    }
    i++;
  }

  return { openBraceIdx, closeBraceIdx, hasTopProps, hasRemoteDebuggingPort };
}

function ensureArgvRemoteDebugging(channel = 'auto') {
  const home = os.homedir();
  const dirs =
    channel === 'insiders'
      ? ['.antigravity-insiders']
      : channel === 'stable'
      ? ['.antigravity']
      : ['.antigravity', '.antigravity-insiders'];

  const results = [];
  for (const d of dirs) {
    const defaultPort = d === '.antigravity-insiders' ? 9223 : 9222;
    const argvDir = path.join(home, d);
    const argvPath = path.join(argvDir, 'argv.json');
    if (!fs.existsSync(argvDir)) continue;
    try {
      if (!fs.existsSync(argvPath)) {
        fs.writeFileSync(argvPath, JSON.stringify({ 'remote-debugging-port': defaultPort }, null, 2) + '\n', 'utf8');
        results.push({ path: argvPath, port: defaultPort, action: 'created' });
        continue;
      }
      const raw = fs.readFileSync(argvPath, 'utf8');
      const parsedInfo = inspectJsoncRootObject(raw);
      if (parsedInfo.hasRemoteDebuggingPort) {
        results.push({ path: argvPath, action: 'already-present' });
        continue;
      }
      if (parsedInfo.openBraceIdx !== -1 && parsedInfo.closeBraceIdx > parsedInfo.openBraceIdx) {
        const afterOpen = raw.slice(parsedInfo.openBraceIdx + 1);
        const comma = parsedInfo.hasTopProps ? ',' : '';
        const trailingNl = afterOpen.startsWith('\n') || afterOpen.startsWith('\r') ? '' : '\n';
        const patched =
          raw.slice(0, parsedInfo.openBraceIdx + 1) +
          `\n\t"remote-debugging-port": ${defaultPort}${comma}${trailingNl}` +
          afterOpen;
        fs.writeFileSync(argvPath, patched, 'utf8');
        results.push({ path: argvPath, port: defaultPort, action: 'patched' });
      } else {
        results.push({ path: argvPath, action: 'skipped', error: 'root JSON object not found' });
      }
    } catch (e) {
      results.push({ path: argvPath, action: 'skipped', error: e.message });
    }
  }
  return results;
}

function isAllowedOrigin(urlStr, extraOrigins = null) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  if (ALLOWED_ORIGINS.some((prefix) => urlStr.startsWith(prefix))) return true;
  if (Array.isArray(extraOrigins)) {
    return extraOrigins.some((prefix) => typeof prefix === 'string' && prefix && urlStr.startsWith(prefix));
  }
  return false;
}

function isExternalNonHostBrowserProduct(browserStr, userAgentStr = '') {
  const b = String(browserStr || '').trim();
  const ua = String(userAgentStr || '').trim();
  if (!b && !ua) return false;
  if (/electron|antigravity/i.test(b) || /electron\/|antigravity\//i.test(ua)) return false;
  return /^(?:Headless)?Chrome\/|^Chromium\/|^Edg(?:e|A|iOS)?\/|^Brave\/|^Firefox\/|^OPR\/|^Vivaldi\//i.test(b);
}

function fetchBrowserVersionFromPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 450 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done({ externalBrowser: false });
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          done({
            externalBrowser: isExternalNonHostBrowserProduct(parsed?.Browser, parsed?.['User-Agent'])
          });
        } catch {
          done({ externalBrowser: false });
        }
      });
      res.on('error', () => done({ externalBrowser: false }));
    });
    req.on('error', () => done({ externalBrowser: false }));
    req.on('timeout', () => {
      req.destroy();
      done({ externalBrowser: false });
    });
  });
}

function fetchTargetsFromPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 450 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done({ reachable: false, targets: [] });
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          done(Array.isArray(parsed) ? { reachable: true, targets: parsed } : { reachable: false, targets: [] });
        } catch {
          done({ reachable: false, targets: [] });
        }
      });
      res.on('error', () => done({ reachable: false, targets: [] }));
    });
    req.on('error', () => done({ reachable: false, targets: [] }));
    req.on('timeout', () => {
      req.destroy();
      done({ reachable: false, targets: [] });
    });
  });
}

async function inspectLiveWindow(portFileOrEnv, fallbackPort = 9222, extraAllowedOrigins = null) {
  const channelSpecs = [];

  if (portFileOrEnv && typeof portFileOrEnv === 'object' && portFileOrEnv.channels) {
    const reqCh = portFileOrEnv.channel || 'auto';
    const allowStable = reqCh !== 'insiders';
    const allowInsiders = reqCh !== 'stable';
    const stableSpec = allowStable
      ? {
          portFile: portFileOrEnv.channels.stable?.portFile || '',
          fallbackPort: portFileOrEnv.channels.stable?.appExists !== false ? 9222 : 0
        }
      : null;
    const insidersSpec = allowInsiders
      ? {
          portFile: portFileOrEnv.channels.insiders?.portFile || '',
          fallbackPort: reqCh === 'insiders' || portFileOrEnv.channels.insiders?.appExists ? 9223 : 0
        }
      : null;
    const preferInsidersFirst =
      allowInsiders &&
      Boolean(
        portFileOrEnv.portFile &&
          insidersSpec?.portFile &&
          portFileOrEnv.portFile === insidersSpec.portFile
      );
    if (preferInsidersFirst) {
      if (insidersSpec) channelSpecs.push(insidersSpec);
      if (stableSpec) channelSpecs.push(stableSpec);
    } else {
      if (stableSpec) channelSpecs.push(stableSpec);
      if (insidersSpec) channelSpecs.push(insidersSpec);
    }
    if (
      portFileOrEnv.portFile &&
      portFileOrEnv.portFile !== stableSpec?.portFile &&
      portFileOrEnv.portFile !== insidersSpec?.portFile &&
      allowStable &&
      allowInsiders
    ) {
      channelSpecs.unshift({ portFile: portFileOrEnv.portFile, fallbackPort: 0 });
    }
  } else if (typeof portFileOrEnv === 'string' && portFileOrEnv) {
    channelSpecs.push({ portFile: portFileOrEnv, fallbackPort: fallbackPort > 0 ? fallbackPort : 0 });
  } else if (fallbackPort > 0) {
    channelSpecs.push({ portFile: '', fallbackPort });
  }

  let firstRespondedPort = null;
  const targets = [];
  const seenTargetIds = new Set();
  const triedPorts = new Set();

  const appendPortTargets = (portNum, list) => {
    if (!firstRespondedPort) firstRespondedPort = portNum;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const tid = String(item.id || '');
      const dedupeKey = tid ? `${portNum}:${tid}` : `${portNum}:${targets.length}`;
      if (seenTargetIds.has(dedupeKey)) continue;
      seenTargetIds.add(dedupeKey);
      targets.push({ ...item, _cdpPort: portNum });
    }
  };

  for (const spec of channelSpecs) {
    let channelPortFound = false;
    if (spec.portFile && fs.existsSync(spec.portFile)) {
      let raw = '';
      try {
        raw = fs.readFileSync(spec.portFile, 'utf8').trim();
      } catch {}
      const parsed = parseInt(raw.split(/\r?\n/)[0], 10);
      if (parsed > 0 && !triedPorts.has(parsed)) {
        triedPorts.add(parsed);
        const res = await fetchTargetsFromPort(parsed);
        if (res.reachable) {
          const verInfo = await fetchBrowserVersionFromPort(parsed);
          if (!verInfo.externalBrowser) {
            appendPortTargets(parsed, res.targets);
            channelPortFound = true;
          }
        }
      }
    }
    if (!channelPortFound && spec.fallbackPort > 0 && !triedPorts.has(spec.fallbackPort)) {
      triedPorts.add(spec.fallbackPort);
      const fbRes = await fetchTargetsFromPort(spec.fallbackPort);
      if (fbRes.reachable) {
        const verInfo = await fetchBrowserVersionFromPort(spec.fallbackPort);
        if (!verInfo.externalBrowser) {
          appendPortTargets(spec.fallbackPort, fbRes.targets);
        }
      }
    }
  }
  if (!firstRespondedPort) {
    return { reachable: false, reason: 'No active CDP port responded (checked DevToolsActivePort & fallback port 9222)' };
  }

  const pages = targets.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      !String(t.url || '').startsWith('devtools://') &&
      isAllowedOrigin(t.url, extraAllowedOrigins) &&
      !String(t.title || '').includes('Launchpad')
  );

  if (pages.length === 0) {
    return { reachable: true, port: firstRespondedPort, pages: 0, reason: 'No active workbench page target' };
  }

  const evaluatePageState = (candidate) =>
    new Promise((resolve) => {
      const ws = new WebSocket(candidate.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve(null);
      }, 2000);
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => {
                const pills = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
                  ? Array.from(document.querySelectorAll('[data-ag-metrics-pill="1"], #ag-live-metrics-pill'))
                  : [];
                const primaryPill = (typeof document !== 'undefined' && document.getElementById('ag-live-metrics-pill')) || pills[0] || null;
                return {
                  __isHost: !!(
                    (window.location && window.location.protocol === 'vscode-file:') ||
                    (window.__APP_CONFIG__ && window.__APP_CONFIG__.productName === 'antigravity') ||
                    (window.electronNative && (
                      (typeof window.electronNative.setTitleBarOverlay === 'function' && window.nativeStorage && typeof window.nativeStorage.getItems === 'function') ||
                      (typeof window.electronNative.getZoomLevel === 'function' && window.electronNative.wcvBrowser && typeof window.electronNative.wcvBrowser.setThemeColor === 'function')
                    )) ||
                    (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('link[href*="/jetbox.css"], body[data-agy-theme], body[data-newux-theme], [id="antigravity.agentSidePanelInputBox"]'))
                  ),
                  version: window.__ag_patch_version || null,
                  bodyReady: window.__ag_body_ready === true,
                  hasStyle: !!document.getElementById('ag-custom-fonts'),
                  hasUserStyle: !!document.getElementById('antigravity-user-custom-style'),
                  preset: document.documentElement ? document.documentElement.getAttribute('data-ag-preset') : null,
                  darkPreset: document.documentElement ? document.documentElement.getAttribute('data-ag-dark-preset') : null,
                  uiLang: document.documentElement ? document.documentElement.getAttribute('data-ag-lang') : null,
                  themeMode: document.documentElement ? document.documentElement.getAttribute('data-ag-theme-mode') : null,
                  pageType: document.documentElement ? document.documentElement.getAttribute('data-ag-page-type') : null,
                  waxSeal: document.documentElement ? document.documentElement.getAttribute('data-ag-wax-seal') : null,
                  dictCount: window.__ag_i18n_dict ? Object.keys(window.__ag_i18n_dict).length : 0,
                  protoSafe: window.__ag_i18n_dict ? Object.getPrototypeOf(window.__ag_i18n_dict) === null : false,
                  pillMounted: pills.length > 0,
                  pillCount: pills.length,
                  pillText: primaryPill ? (primaryPill.textContent || null) : null
                };
              })()`,
              returnByValue: true
            }
          })
        );
      });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(msg.result?.result?.value || null);
          }
        } catch {}
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

  let selected = null;
  let firstHostCandidate = null;
  let firstHostNullCandidate = null;
  const hostTargets = [];

  const isLikelyHostWhenTimedOut = (cand) => {
    const u = String(cand?.url || '');
    const t = String(cand?.title || '');
    return u.startsWith('vscode-file://') || u.startsWith('plugin://swarm--') || /\bAntigravity\b/i.test(t);
  };

  for (const candidate of pages) {
    const rawState = await evaluatePageState(candidate);
    if (rawState === null) {
      if (isLikelyHostWhenTimedOut(candidate)) {
        hostTargets.push({ targetId: candidate.id, port: candidate._cdpPort || firstRespondedPort, title: candidate.title, state: null });
        if (!firstHostNullCandidate) {
          firstHostNullCandidate = { page: candidate, state: null };
        }
      }
      continue;
    }
    const isHost = rawState.__isHost === true;
    const cleanState = { ...rawState };
    delete cleanState.__isHost;
    if (isHost) {
      hostTargets.push({ targetId: candidate.id, port: candidate._cdpPort || firstRespondedPort, title: candidate.title, state: cleanState });
      if (!selected && cleanState.hasStyle === true) {
        selected = { page: candidate, state: cleanState };
      }
      if (!firstHostCandidate) {
        firstHostCandidate = { page: candidate, state: cleanState };
      }
    }
  }

  if (!selected) {
    selected = firstHostCandidate || firstHostNullCandidate;
  }
  if (!selected) {
    return { reachable: true, port: firstRespondedPort, pages: 0, reason: 'No active workbench page target' };
  }

  return {
    reachable: true,
    port: selected.page._cdpPort || firstRespondedPort,
    targetId: selected.page.id,
    title: selected.page.title,
    state: selected.state,
    ...(hostTargets.length > 1 ? { hostTargets } : {})
  };
}

// ============================================================================
// 3. M1 跨平台 CDP Opt-in 启动器部署与清理 + 子命令实现
// ============================================================================
function ensureCdpLaunchers(channel = 'auto', options = {}) {
  const home = os.homedir();
  const allowStable = channel !== 'insiders';
  const allowInsiders = channel !== 'stable';
  const withDarwinLauncher = Boolean(options && options.withLauncher);

  if (process.platform === 'darwin') {
    // 默认采用「单图标纯净模式」：不额外生成第二个 .app 图标，全靠 M2 守护进程冷启动自动接力 + relaunch 子命令；
    // 若历史安装曾生成过 (Theme).app，默认自动注销 LaunchServices 索引并移入废纸篓，确保启动台/Spotlight 仅保留唯一官方图标。
    if (!withDarwinLauncher) {
      const cleaned = removeCdpLaunchers();
      return {
        platform: 'darwin',
        mode: 'single-icon-m2-relay',
        launchers: [],
        cleanedLegacyLaunchers: cleaned
      };
    }

    const appsDir = path.join(home, 'Applications');
    const specs = [
      allowStable
        ? {
            channel: 'stable',
            srcApp: ['/Applications/Antigravity.app', path.join(appsDir, 'Antigravity.app')].find((p) => fs.existsSync(p)),
            launcherName: 'Antigravity (Theme).app',
            bundleId: 'com.chuanban.antigravity.theme-launcher',
            displayName: 'Antigravity (Theme)'
          }
        : null,
      allowInsiders
        ? {
            channel: 'insiders',
            srcApp: ['/Applications/Antigravity - Insiders.app', path.join(appsDir, 'Antigravity - Insiders.app')].find(
              (p) => fs.existsSync(p)
            ),
            launcherName: 'Antigravity - Insiders (Theme).app',
            bundleId: 'com.chuanban.antigravity.theme-launcher.insiders',
            displayName: 'Antigravity - Insiders (Theme)'
          }
        : null
    ].filter((s) => s && s.srcApp);

    const created = [];
    for (const spec of specs) {
      try {
        const destApp = path.join(appsDir, spec.launcherName);
        const contentsDir = path.join(destApp, 'Contents');
        const macosDir = path.join(contentsDir, 'MacOS');
        const resDir = path.join(contentsDir, 'Resources');
        fs.mkdirSync(macosDir, { recursive: true });
        fs.mkdirSync(resDir, { recursive: true });

        const srcResDir = path.join(spec.srcApp, 'Contents', 'Resources');
        let iconBase = '';
        if (fs.existsSync(srcResDir)) {
          const icnsCandidate =
            ['icon.icns', 'electron.icns'].find((n) => fs.existsSync(path.join(srcResDir, n))) ||
            fs.readdirSync(srcResDir).find((n) => n.endsWith('.icns')) ||
            '';
          if (icnsCandidate) {
            fs.copyFileSync(path.join(srcResDir, icnsCandidate), path.join(resDir, 'icon.icns'));
            iconBase = 'icon';
          }
        }

        const plistXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          '<dict>',
          '  <key>CFBundleExecutable</key>',
          '  <string>launcher</string>',
          '  <key>CFBundleIdentifier</key>',
          `  <string>${spec.bundleId}</string>`,
          '  <key>CFBundleName</key>',
          `  <string>${spec.displayName}</string>`,
          '  <key>CFBundleDisplayName</key>',
          `  <string>${spec.displayName}</string>`,
          '  <key>CFBundlePackageType</key>',
          '  <string>APPL</string>',
          '  <key>CFBundleShortVersionString</key>',
          '  <string>6.0.6</string>',
          '  <key>CFBundleVersion</key>',
          '  <string>606</string>',
          ...(iconBase ? ['  <key>CFBundleIconFile</key>', `  <string>${iconBase}</string>`] : []),
          '  <key>LSMinimumSystemVersion</key>',
          '  <string>12.0</string>',
          '  <key>LSUIElement</key>',
          '  <true/>',
          '  <key>NSHighResolutionCapable</key>',
          '  <true/>',
          '</dict>',
          '</plist>',
          ''
        ].join('\n');
        fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plistXml, 'utf8');

        const escapedAppPath = spec.srcApp.replace(/(["\\$`])/g, '\\$1');
        const launcherScript = [
          '#!/bin/sh',
          '# Managed by chuanban-antigravity-theme-patch (Optional M1 CDP Opt-in Launcher)',
          `exec /usr/bin/open -a "${escapedAppPath}" --args --remote-debugging-port=0 "$@"`,
          ''
        ].join('\n');
        const binPath = path.join(macosDir, 'launcher');
        fs.writeFileSync(binPath, launcherScript, { encoding: 'utf8', mode: 0o755 });
        fs.chmodSync(binPath, 0o755);

        const lsreg =
          '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
        if (fs.existsSync(lsreg)) {
          spawnSync(lsreg, ['-f', destApp], { stdio: 'ignore', timeout: 4000 });
        }
        created.push(destApp);
      } catch {}
    }
    return { platform: 'darwin', mode: 'optional-m1-launcher', launchers: created };
  }

  if (process.platform === 'win32') {
    const psPatch = [
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$allowStable = $${allowStable ? 'true' : 'false'}`,
      `$allowInsiders = $${allowInsiders ? 'true' : 'false'}`,
      `$wsh = New-Object -ComObject WScript.Shell`,
      ...buildWin32LnkSpecsPs(),
      `$patched = @(); $already = @(); $skipped = @()`,
      `foreach ($spec in $lnkSpecs) {`,
      `  $dk = ([string]$spec.dir).ToLowerInvariant()`,
      `  if ($seenLnkDirs.ContainsKey($dk)) { continue }`,
      `  $seenLnkDirs[$dk] = $true`,
      `  $items = if ($spec.recurse) {`,
      `    Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -Recurse -Depth $spec.depth -ErrorAction SilentlyContinue`,
      `  } else {`,
      `    Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue`,
      `  }`,
      `  foreach ($item in $items) {`,
      `    $lnkPath = $item.FullName`,
      `    try {`,
      `      $sc = $wsh.CreateShortcut($lnkPath)`,
      `      $leaf = [IO.Path]::GetFileName([string]$sc.TargetPath)`,
      `      $isStable = ($leaf -ieq 'Antigravity.exe')`,
      `      $isIns = ($leaf -ieq 'Antigravity - Insiders.exe')`,
      `      if ((-not $isStable -or -not $allowStable) -and (-not $isIns -or -not $allowInsiders)) { continue }`,
      `      $argsStr = [string]$sc.Arguments`,
      `      if ($argsStr -match '--remote-debugging-port') { $already += $lnkPath; continue }`,
      `      $sc.Arguments = if ($argsStr.Trim()) { "$($argsStr.Trim()) --remote-debugging-port=0" } else { '--remote-debugging-port=0' }`,
      `      $sc.Save()`,
      `      $patched += $lnkPath`,
      `    } catch { $skipped += $lnkPath }`,
      `  }`,
      `}`,
      `@{ patched = $patched; already = $already; skipped = $skipped } | ConvertTo-Json -Compress -Depth 3`
    ].join('\n');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psPatch], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000
    });
    try {
      const parsed = JSON.parse(String(r.stdout || '').trim() || '{}');
      const normArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
      return {
        platform: 'win32',
        patched: normArr(parsed.patched),
        already: normArr(parsed.already),
        skipped: normArr(parsed.skipped)
      };
    } catch {
      return { platform: 'win32', patched: [], already: [], skipped: [] };
    }
  }

  if (process.platform === 'linux') {
    const updated = [];
    const sysApps = '/usr/share/applications';
    const userApps = path.join(home, '.local', 'share', 'applications');
    const names = [
      allowStable ? 'antigravity.desktop' : null,
      allowInsiders ? 'antigravity-insiders.desktop' : null
    ].filter(Boolean);
    for (const name of names) {
      try {
        const srcPath = fs.existsSync(path.join(userApps, name))
          ? path.join(userApps, name)
          : path.join(sysApps, name);
        if (!fs.existsSync(srcPath)) continue;
        const raw = fs.readFileSync(srcPath, 'utf8');
        let next = raw.replace(/^(Exec=.*)$/gm, (line) =>
          /--remote-debugging-port/.test(line) ? line : `${line} --remote-debugging-port=0`
        );
        if (!next.includes('# X-Chuanban-Theme-Patch=1')) {
          next = `# X-Chuanban-Theme-Patch=1\n${next}`;
        }
        fs.mkdirSync(userApps, { recursive: true });
        const destPath = path.join(userApps, name);
        fs.writeFileSync(destPath, next, 'utf8');
        updated.push(destPath);
      } catch {}
    }
    return { platform: 'linux', desktopFiles: updated };
  }

  return { platform: process.platform };
}

function removeCdpLaunchers() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const appsDir = path.join(home, 'Applications');
    const lsreg =
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    const removed = [];
    for (const name of ['Antigravity (Theme).app', 'Antigravity - Insiders (Theme).app']) {
      const appPath = path.join(appsDir, name);
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      if (!fs.existsSync(plistPath)) continue;
      try {
        const xml = fs.readFileSync(plistPath, 'utf8');
        if (!xml.includes('com.chuanban.antigravity.theme-launcher')) continue;
        if (fs.existsSync(lsreg)) {
          spawnSync(lsreg, ['-u', appPath], { stdio: 'ignore', timeout: 4000 });
        }
        if (fs.existsSync('/usr/bin/trash')) {
          spawnSync('/usr/bin/trash', [appPath], { stdio: 'ignore', timeout: 4000 });
        } else {
          fs.rmSync(appPath, { recursive: true, force: true });
        }
        removed.push(appPath);
      } catch {}
    }
    return removed;
  }

  if (process.platform === 'win32') {
    const psClean = [
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$wsh = New-Object -ComObject WScript.Shell`,
      ...buildWin32LnkSpecsPs(),
      `foreach ($spec in $lnkSpecs) {`,
      `  $dk = ([string]$spec.dir).ToLowerInvariant()`,
      `  if ($seenLnkDirs.ContainsKey($dk)) { continue }`,
      `  $seenLnkDirs[$dk] = $true`,
      `  $items = if ($spec.recurse) {`,
      `    Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -Recurse -Depth $spec.depth -ErrorAction SilentlyContinue`,
      `  } else {`,
      `    Get-ChildItem -LiteralPath $spec.dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue`,
      `  }`,
      `  foreach ($item in $items) {`,
      `    try {`,
      `      $sc = $wsh.CreateShortcut($item.FullName)`,
      `      $leaf = [IO.Path]::GetFileName([string]$sc.TargetPath)`,
      `      if (($leaf -ieq 'Antigravity.exe') -or ($leaf -ieq 'Antigravity - Insiders.exe')) {`,
      `        $orig = [string]$sc.Arguments`,
      `        $clean = ($orig -replace '(^|\\s)--remote-debugging-port(=\\d+)?(\\s|$)', ' ').Trim()`,
      `        if ($clean -ne $orig.Trim()) { $sc.Arguments = $clean; $sc.Save() }`,
      `      }`,
      `    } catch {}`,
      `  }`,
      `}`
    ].join('\n');
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psClean], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 8000
    });
    return;
  }

  if (process.platform === 'linux') {
    const userApps = path.join(home, '.local', 'share', 'applications');
    for (const name of ['antigravity.desktop', 'antigravity-insiders.desktop']) {
      const p = path.join(userApps, name);
      if (!fs.existsSync(p)) continue;
      try {
        const raw = fs.readFileSync(p, 'utf8');
        if (raw.includes('# X-Chuanban-Theme-Patch=1')) {
          fs.unlinkSync(p);
        }
      } catch {}
    }
  }
}

function inspectWindowsTaskXmlTriggers(rawXml) {
  const xml = String(rawXml || '').replace(/\0/g, '');
  const settingsBlock = xml.match(/<Settings\b[^>]*>[\s\S]*?<\/Settings>/i)?.[0] || '';
  const taskEnabled = !/<Enabled>\s*false\s*<\/Enabled>/i.test(settingsBlock);
  const isTriggerEnabled = (block) => !/<Enabled>\s*false\s*<\/Enabled>/i.test(block);
  const hasIntervalRepetition = (block) =>
    /<Repetition\b[^>]*>[\s\S]*?<Interval>\s*[^<\s]+\s*<\/Interval>[\s\S]*?<\/Repetition>/i.test(block);
  const timedBlocks = xml.match(/<(?:TimeTrigger|CalendarTrigger)\b[^>]*>[\s\S]*?<\/(?:TimeTrigger|CalendarTrigger)>/gi) || [];
  const hasTimedRepetition = timedBlocks.some((block) => isTriggerEnabled(block) && hasIntervalRepetition(block));
  const logonBlocks = xml.match(/<LogonTrigger\b[^>]*>[\s\S]*?<\/LogonTrigger>/gi) || [];
  const logonHasRepetition = logonBlocks.some((block) => isTriggerEnabled(block) && hasIntervalRepetition(block));
  const legacyLogonOnlyRepetition = logonHasRepetition && !hasTimedRepetition;
  return { taskEnabled, hasTimedRepetition, legacyLogonOnlyRepetition };
}

function inspectWindowsKeepAliveTask(targetDir) {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      "try {",
      "  $i = Get-ScheduledTaskInfo -TaskName 'AntigravityThemeDaemon' -ErrorAction Stop;",
      "  [pscustomobject]@{",
      "    registered=$true;",
      "    nextRunTime=$(if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{$null});",
      "    lastRunTime=$(if($i.LastRunTime -and $i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToString('o')}else{$null});",
      "    lastTaskResult=$i.LastTaskResult",
      "  } | ConvertTo-Json -Compress",
      "} catch { '{\"registered\":false}' }"
    ].join(' ');
    const infoRes = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    });
    if (infoRes.status !== 0) {
      return {
        registered: null,
        error: String(infoRes.stderr || infoRes.stdout || `powershell exit ${infoRes.status}`).trim()
      };
    }
    const info = JSON.parse(String(infoRes.stdout || '').trim());
    if (!info.registered) {
      return {
        registered: false,
        taskEnabled: false,
        nextRunTime: null,
        lastRunTime: null,
        lastTaskResult: null,
        hasTimedRepetition: false,
        legacyLogonOnlyRepetition: false,
        warning: '未找到 AntigravityThemeDaemon 计划任务，daemon 意外退出后不会被自动拉起'
      };
    }

    const queryRes = spawnSync('schtasks', ['/Query', '/TN', 'AntigravityThemeDaemon', '/XML'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    });
    if (queryRes.status !== 0) {
      return {
        registered: true,
        taskEnabled: null,
        nextRunTime: info.nextRunTime ?? null,
        lastRunTime: info.lastRunTime ?? null,
        lastTaskResult: info.lastTaskResult ?? null,
        hasTimedRepetition: null,
        legacyLogonOnlyRepetition: null,
        warning: `无法读取 AntigravityThemeDaemon 计划任务 XML（exit ${queryRes.status}）`
      };
    }

    const { taskEnabled, hasTimedRepetition, legacyLogonOnlyRepetition } = inspectWindowsTaskXmlTriggers(queryRes.stdout);

    const installScriptPath = path.join(targetDir || resolveDefaultTargetDir(), 'install.mjs');
    const warning = !taskEnabled
      ? `计划任务 AntigravityThemeDaemon 当前处于禁用状态，保活不会触发；请启用该任务或执行 node "${installScriptPath}" install 重新注册`
      : !hasTimedRepetition
      ? `5 分钟保活只挂在登录触发器上，安装后到下次登录前不会重复；请执行 node "${installScriptPath}" install 重新注册`
      : null;

    return {
      registered: true,
      taskEnabled,
      nextRunTime: info.nextRunTime ?? null,
      lastRunTime: info.lastRunTime ?? null,
      lastTaskResult: info.lastTaskResult ?? null,
      hasTimedRepetition,
      legacyLogonOnlyRepetition,
      warning
    };
  } catch (err) {
    return {
      registered: null,
      error: String(err?.message || err)
    };
  }
}

function buildFontReport(env) {
  const missingFonts = [];
  if (!env.hasAnthropicSerifFont) {
    missingFonts.push('Anthropic Serif (AnthropicSerif-Regular.ttf, AnthropicSerif-Bold.ttf)');
  }
  if (!env.hasAnthropicMonoFont) {
    missingFonts.push('Anthropic Mono (AnthropicMono-Regular.ttf)');
  }
  if (!env.hasSarasaFont) {
    missingFonts.push(
      process.platform === 'win32'
        ? 'Sarasa Gothic (Windows 推荐拆分版 Windows-Sarasa-Split-SC-TTF-v1.0.43.zip，避免 791MB SuperTTC 卡顿)'
        : 'Sarasa Gothic (Sarasa SC Split TTF ZIP 或 Sarasa-SuperTTC.ttc)'
    );
  }
  const allRequiredFontsInstalled = missingFonts.length === 0;
  const superTtcWarning =
    process.platform === 'win32' && env.hasSarasaSuperTtc
      ? `Detected monolithic 791MB Sarasa-SuperTTC.ttc active on Windows; DirectWrite/Chromium may stall 1.5–10.5s on initial weight instantiation and consume >2GB renderer virtual memory. Recommended: run \`node install.mjs install-fonts --auto-download --retire-super-ttc\` (or manually download Windows-Sarasa-Split-SC-TTF-v1.0.43.zip from ${WINDOWS_SARASA_SPLIT_VIEW_URL}).`
      : null;
  const unregisteredFiles = Array.isArray(env.unregisteredWinFonts) ? env.unregisteredWinFonts : [];
  const unregisteredWarning =
    process.platform === 'win32' && unregisteredFiles.length > 0
      ? `Found ${unregisteredFiles.length} font file(s) copied into ${env.winUserFontsDir} without HKCU\\...\\Fonts registry entries (${unregisteredFiles.slice(0, 5).join(', ')}${unregisteredFiles.length > 5 ? ', ...' : ''}). Chromium local() cannot load unregistered Windows user fonts. Fix immediately with: node install.mjs install-fonts --from "${env.winUserFontsDir}"`
      : null;

  const autoDownloadCommand = !allRequiredFontsInstalled
    ? process.platform === 'win32' && env.hasSarasaSuperTtc
      ? 'node install.mjs install-fonts --auto-download --retire-super-ttc'
      : 'node install.mjs install-fonts --auto-download'
    : null;

  return {
    uiLatinEngine: 'Google Sans Flex (native variable font)',
    allRequiredInstalled: allRequiredFontsInstalled,
    anthropicInstalled: env.hasAnthropicFont,
    anthropicSerifInstalled: env.hasAnthropicSerifFont,
    anthropicMonoInstalled: env.hasAnthropicMonoFont,
    sarasaInstalled: env.hasSarasaFont,
    sarasaSplitScInstalled: env.hasSarasaSplitScTtf,
    superTtcActive: env.hasSarasaSuperTtc,
    orphanSuperTtcPendingReboot: env.orphanSuperTtcPendingReboot,
    superTtcWarning,
    unregisteredFiles,
    unregisteredWarning,
    missing: missingFonts,
    autoDownloadCommand,
    downloadUrl: !allRequiredFontsInstalled ? FEISHU_FONT_MIRROR_URL : null,
    directDownloadUrls: !allRequiredFontsInstalled
      ? {
          feishuCnMirrorPage: FEISHU_FONT_MIRROR_URL,
          feishuCnLandingPage: FEISHU_LANDING_URL,
          anthropicSerifRegular: FONT_DOWNLOAD_CATALOG.anthropicSerifRegular.url,
          anthropicSerifBold: FONT_DOWNLOAD_CATALOG.anthropicSerifBold.url,
          anthropicMonoRegular: FONT_DOWNLOAD_CATALOG.anthropicMonoRegular.url,
          sarasaSplitScZip: FONT_DOWNLOAD_CATALOG.sarasaSplitScZip.url,
          sarasaSplitScView: WINDOWS_SARASA_SPLIT_VIEW_URL,
          sarasaGithubReleases: SARASA_GITHUB_RELEASES_URL,
          googleDriveFolder: GOOGLE_DRIVE_URL
        }
      : null
  };
}

function extractBaseSemverTuple(verStr) {
  const m = String(verStr || '').match(/v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemverTuples(a, b) {
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function inspectSourceSync(sourceDir, targetDir) {
  if (isSameTargetPath(sourceDir, targetDir)) {
    return { sameDirectory: true, inSync: true, sourceOlder: false, outdatedFiles: [] };
  }
  const srcManifestPath = path.join(sourceDir, 'core', 'manifest.json');
  const dstManifestPath = path.join(targetDir, 'core', 'manifest.json');
  if (!fs.existsSync(srcManifestPath)) return null;
  if (!fs.existsSync(dstManifestPath)) {
    return {
      sourceDir,
      targetDir,
      inSync: false,
      sourceOlder: false,
      reason: 'target_manifest_missing',
      outdatedFiles: ['core/manifest.json']
    };
  }
  try {
    const srcManifest = JSON.parse(fs.readFileSync(srcManifestPath, 'utf8'));
    const dstManifest = JSON.parse(fs.readFileSync(dstManifestPath, 'utf8'));
    const fileNames = new Set([
      ...Object.keys(srcManifest.files || {}),
      ...Object.keys(dstManifest.files || {})
    ]);
    const outdatedFiles = [];
    for (const name of fileNames) {
      const srcFile = path.join(sourceDir, 'core', name);
      const dstFile = path.join(targetDir, 'core', name);
      const srcSha = fs.existsSync(srcFile) ? sha256File(srcFile) : null;
      const dstSha = fs.existsSync(dstFile) ? sha256File(dstFile) : null;
      if (srcSha !== dstSha) {
        outdatedFiles.push(`core/${name}`);
      }
    }
    if (sha256File(srcManifestPath) !== sha256File(dstManifestPath)) {
      outdatedFiles.push('core/manifest.json');
    }
    const srcInstaller = path.join(sourceDir, 'install.mjs');
    const dstInstaller = path.join(targetDir, 'install.mjs');
    if (fs.existsSync(srcInstaller) && fs.existsSync(dstInstaller) && sha256File(srcInstaller) !== sha256File(dstInstaller)) {
      outdatedFiles.push('install.mjs');
    }
    const verCmp = compareSemverTuples(
      extractBaseSemverTuple(srcManifest.version),
      extractBaseSemverTuple(dstManifest.version)
    );
    const sourceOlder = verCmp < 0;
    return {
      sourceDir,
      targetDir,
      sourceVersion: srcManifest.version || null,
      targetVersion: dstManifest.version || null,
      sourceOlder,
      inSync: outdatedFiles.length === 0,
      outdatedFiles,
      syncHint:
        outdatedFiles.length > 0 && !sourceOlder
          ? `node ${JSON.stringify(path.join(sourceDir, 'install.mjs'))} install`
          : null
    };
  } catch {
    return null;
  }
}

async function runDoctor() {
  const defaultTarget = resolveGlobalInstallDir();
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const channel = readTargetConfiguredChannel(targetDir);
  const isCustomSandboxTarget =
    hasFlag('--target-dir') && !isSameTargetPath(targetDir, defaultTarget) && !hasFlag('--register-service');

  const env = await detectEnvironment(channel);
  const integrity = verifyCoreIntegrity(targetDir);
  const sourceSync = inspectSourceSync(__dirname, targetDir);
  const live = await inspectLiveWindow(env, 9222, readTargetAllowedOrigins(targetDir));

  const cdpMissingFlag = !isCustomSandboxTarget && !live.reachable && env.cdpStatus === 'missing_opt_in_flag';
  const remediation = cdpMissingFlag ? `node ${JSON.stringify(path.join(targetDir, 'install.mjs'))} relaunch` : null;

  const fontsReport = buildFontReport(env);
  const launcherMode =
    process.platform === 'darwin'
      ? env.launcherInstalled
        ? 'optional-launcher-app'
        : 'single-icon-m2-relay'
      : process.platform === 'win32'
      ? 'in-place-lnk'
      : 'desktop-entry';

  const report = {
    ok: Boolean(env.nodeBasicOk && integrity.ok && !cdpMissingFlag),
    node: {
      version: env.nodeVer,
      execPath: process.execPath,
      serviceExecPath: resolveStableNodeExecPath(),
      tier: env.tier
    },
    fonts: fontsReport,
    antigravity: {
      channel: env.channel,
      appExists: env.appExists,
      appVersion: env.appVersion,
      cdpStatus: live.reachable ? 'ready' : env.cdpStatus,
      launcherMode,
      launcherInstalled: env.launcherInstalled,
      runningProcesses: env.runningProcesses.map(({ cmd: _cmd, ...rest }) => rest),
      remediation,
      portFile: env.portFile,
      portFileExists: env.portFileExists,
      channels: env.channels
    },
    coreIntegrity: {
      targetDir,
      clean: integrity.ok,
      modifiedFiles: integrity.modified,
      ...(sourceSync && !sourceSync.sameDirectory ? { sourceSync } : {})
    },
    keepAliveTask: inspectWindowsKeepAliveTask(targetDir),
    update: buildDoctorUpdateSection(targetDir, env),
    liveWindow: live
  };

  console.log(JSON.stringify(report, null, 2));
  if (!env.nodeBasicOk) {
    console.error('\n[ERROR] Node.js >= 22.0.0 is required. Current:', env.nodeVer);
    process.exit(1);
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dest, item);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function parsePidFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { pid: 0, startMs: 0, stopRequested: false };
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { pid: 0, startMs: 0, stopRequested: false };
    const lines = raw.split(/\r?\n/);
    const pid = parseInt(lines[0], 10) || 0;
    const second = (lines[1] || '').trim();
    if (second === 'STOP') return { pid, startMs: 0, stopRequested: true };
    let startMs = parseInt(second, 10) || 0;
    if (!startMs && pid > 0) {
      try {
        startMs = Math.round(fs.statSync(filePath).mtimeMs);
      } catch {}
    }
    return { pid, startMs, stopRequested: false };
  } catch {
    return { pid: 0, startMs: 0, stopRequested: false };
  }
}

function checkDaemonPidState(pid, recordedStartMs = 0) {
  if (!pid || pid <= 0 || pid === process.pid) return 'not_daemon';
  let kill0Eperm = false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === 'EPERM') {
      kill0Eperm = true;
    } else {
      return 'not_daemon';
    }
  }
  if (process.platform === 'win32') {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = spawnSync('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 4000
        });
        if (res.status === 0) {
          const out = String(res.stdout || '').toLowerCase();
          if (!out.includes('node.exe')) return 'not_daemon';
        }
        const psCmd = [
          `$gp = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
          `if (-not $gp) { [Console]::Out.WriteLine('STATE=GONE'); exit 0 }`,
          `if ($gp.ProcessName -ne 'node') { [Console]::Out.WriteLine('STATE=NOT_NODE'); exit 0 }`,
          `$ms = try { ([DateTimeOffset]$gp.StartTime).ToUnixTimeMilliseconds() } catch { 0 }`,
          `[Console]::Out.WriteLine("STARTMS=$ms"); [Console]::Out.Flush()`,
          `$cmd = try { (Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue).CommandLine } catch { '' }`,
          `[Console]::Out.WriteLine("CMD=$cmd")`
        ].join('; ');
        const cimRes = spawnSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
          {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 6000
          }
        );
        const rawOut = String(cimRes.stdout || '');
        if (rawOut.includes('STATE=GONE') || rawOut.includes('STATE=NOT_NODE')) {
          return 'not_daemon';
        }
        const msMatch = rawOut.match(/STARTMS=(\d+)/);
        const procStartMs = msMatch ? parseInt(msMatch[1], 10) || 0 : 0;
        const cmdMatch = rawOut.match(/CMD=([^\r\n]*)/);
        if (cmdMatch) {
          const cmdLine = cmdMatch[1].trim().toLowerCase();
          if (cmdLine) {
            if (cmdLine.includes('daemon.mjs') || cmdLine.includes('antigravity-font-daemon')) {
              return 'confirmed';
            }
            return 'not_daemon';
          }
        }
        if (procStartMs > 0 && recordedStartMs > 0) {
          return Math.abs(procStartMs - recordedStartMs) <= 5000 ? 'confirmed' : 'not_daemon';
        }
        if (cimRes.status === 0) {
          try {
            process.kill(pid, 0);
            return 'uncertain';
          } catch (e) {
            return e && e.code === 'EPERM' ? 'uncertain' : 'not_daemon';
          }
        }
      } catch {}
    }
    return 'uncertain';
  }
  if (kill0Eperm) return 'not_daemon';
  return 'confirmed';
}

function sendCooperativeStop(pidPath, pid, waitMs = 1200) {
  try {
    fs.writeFileSync(pidPath, `${pid}\nSTOP`, 'utf8');
    const steps = Math.max(1, Math.ceil(waitMs / 50));
    for (let i = 0; i < steps; i++) {
      sleepSync(50);
      if (!fs.existsSync(pidPath)) return true;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (err) {
          if (!err || err.code !== 'EPERM') return true;
        }
      }
    }
  } catch {}
  return false;
}

function stopRunningDaemonProcesses() {
  const tmpDir = os.tmpdir();
  const stopped = [];
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('ag-theme-daemon-') && f.endsWith('.pid')) {
        const pidPath = path.join(tmpDir, f);
        const { pid, startMs, stopRequested } = parsePidFile(pidPath);
        if (!stopRequested && pid > 0) {
          const pidState = checkDaemonPidState(pid, startMs);
          if (pidState === 'confirmed') {
            let killed = false;
            try {
              process.kill(pid, 'SIGTERM');
              for (let i = 0; i < 8; i++) {
                sleepSync(50);
                try {
                  process.kill(pid, 0);
                } catch (e) {
                  if (!e || e.code !== 'EPERM') {
                    killed = true;
                    break;
                  }
                }
              }
            } catch {}
            if (!killed) {
              killed = sendCooperativeStop(pidPath, pid, 1500);
            }
            if (killed) stopped.push(pid);
          } else if (pidState === 'uncertain') {
            // 不对无法确认的进程发送 SIGTERM，但发出协作 STOP 信号等待片刻后无条件移除陈旧 .pid，防止重装自锁
            sendCooperativeStop(pidPath, pid, 350);
          }
        }
        try {
          if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
        } catch {}
      }
    }
  } catch {}
  return stopped;
}

function resolveStableNodeExecPath(execPath = process.execPath, platform = process.platform, home = os.homedir()) {
  if (platform !== 'darwin' && platform !== 'linux') return execPath;
  let realExec = '';
  try {
    realExec = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }

  const dynamicCellarCandidates = [];
  for (const probePath of [execPath, realExec]) {
    const m = String(probePath || '').match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node)$/i);
    if (m) {
      const brewPrefix = m[1];
      const formula = m[2];
      const binName = m[3];
      dynamicCellarCandidates.push(path.join(brewPrefix, 'bin', binName));
      dynamicCellarCandidates.push(path.join(brewPrefix, 'opt', formula, 'bin', binName));
    }
  }

  const envExtra = process.env.AG_STABLE_NODE_CANDIDATES
    ? String(process.env.AG_STABLE_NODE_CANDIDATES)
        .split(path.delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const staticCandidates =
    platform === 'darwin'
      ? [
          '/opt/homebrew/bin/node',
          '/usr/local/bin/node',
          '/opt/homebrew/opt/node/bin/node',
          '/usr/local/opt/node/bin/node',
          '/opt/homebrew/opt/node@22/bin/node',
          '/opt/homebrew/opt/node@24/bin/node',
          path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'),
          path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
        ]
      : [
          '/home/linuxbrew/.linuxbrew/bin/node',
          '/home/linuxbrew/.linuxbrew/opt/node/bin/node',
          '/usr/local/bin/node',
          '/usr/bin/node',
          path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
        ];

  const seen = new Set();
  for (const cand of [...envExtra, ...dynamicCellarCandidates, ...staticCandidates]) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    try {
      if (fs.existsSync(cand) && fs.realpathSync(cand) === realExec) {
        return cand;
      }
    } catch {}
  }
  return execPath;
}

function registerSystemService(targetDir, wrapperDaemon) {
  const home = os.homedir();
  const serviceNodeExec = resolveStableNodeExecPath();
  if (process.platform === 'darwin') {
    const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    const existingCustomFontPlist = path.join(launchAgentsDir, 'com.antigravity.customfont.plist');
    const themePlist = path.join(launchAgentsDir, 'com.antigravity.theme.plist');
    const activePlist = fs.existsSync(existingCustomFontPlist) ? existingCustomFontPlist : themePlist;
    const label = path.basename(activePlist, '.plist');

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${serviceNodeExec}</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>${wrapperDaemon}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/antigravity-font-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/antigravity-font-daemon.err</string>
</dict>
</plist>
`;
    const prevPlist = fs.existsSync(activePlist) ? fs.readFileSync(activePlist, 'utf8') : '';
    const plistChanged = prevPlist !== plistContent;
    if (plistChanged) {
      fs.writeFileSync(activePlist, plistContent, 'utf8');
    }

    const uid = process.getuid ? process.getuid() : 501;
    const domainTarget = `gui/${uid}/${label}`;
    const sleepSync = (ms) => {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      } catch {}
    };
    const queryServiceState = () => {
      const r = spawnSync('launchctl', ['print', domainTarget], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const out = String(r.stdout || '');
      return { loaded: r.status === 0, running: r.status === 0 && /\bpid\s*=\s*\d+/i.test(out) };
    };

    let runningNow = false;
    try {
      const initial = queryServiceState();
      if (initial.loaded && !plistChanged) {
        spawnSync('launchctl', ['kickstart', '-k', domainTarget], { stdio: 'ignore' });
      } else {
        if (initial.loaded) {
          spawnSync('launchctl', ['bootout', domainTarget], { stdio: 'ignore' });
          for (let i = 0; i < 20 && queryServiceState().loaded; i++) {
            sleepSync(100);
          }
        }
        for (let i = 0; i < 6; i++) {
          if (!queryServiceState().loaded) {
            const bootRes = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, activePlist], { stdio: 'ignore' });
            if (bootRes.status !== 0 && !queryServiceState().loaded) {
              spawnSync('launchctl', ['load', '-w', activePlist], { stdio: 'ignore' });
            }
          }
          if (queryServiceState().loaded) break;
          sleepSync(120);
        }
        spawnSync('launchctl', ['kickstart', '-k', domainTarget], { stdio: 'ignore' });
      }
      for (let i = 0; i < 5; i++) {
        const st = queryServiceState();
        if (st.running) {
          runningNow = true;
          break;
        }
        sleepSync(60);
      }
      if (!runningNow) runningNow = queryServiceState().loaded;
    } catch {}
    return { platform: 'darwin', serviceFile: activePlist, label, nodeExec: serviceNodeExec, runningNow };
  }

  if (process.platform === 'linux') {
    const systemdDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(systemdDir, { recursive: true });
    const serviceFile = path.join(systemdDir, 'antigravity-theme.service');
    const unitContent = `[Unit]
Description=Chuanban Antigravity Theme & Live Metrics Daemon
After=default.target

[Service]
ExecStart="${serviceNodeExec}" --disable-warning=ExperimentalWarning "${wrapperDaemon}"
Restart=always
RestartSec=3
KillMode=process

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(serviceFile, unitContent, 'utf8');
    try {
      execSync(
        'systemctl --user daemon-reload 2>/dev/null && (systemctl --user enable antigravity-theme.service 2>/dev/null || true) && (systemctl --user reset-failed antigravity-theme.service 2>/dev/null || true) && systemctl --user restart antigravity-theme.service 2>/dev/null || true',
        { stdio: 'ignore' }
      );
    } catch {}
    return { platform: 'linux', serviceFile, runningNow: true };
  }

  if (process.platform === 'win32') {
    stopRunningDaemonProcesses();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbsFile = path.join(startupDir, 'AntigravityThemeDaemon.vbs');
    const localVbsFile = path.join(targetDir, 'AntigravityThemeDaemon.vbs');
    // 传入 --keep-alive：PT5M 周期保活探测到健康守护仍在运行时直接静默退出（不强杀清缓存），仅在进程意外退出/被误杀后自动复活
    const cmd = `""${process.execPath}"" --disable-warning=ExperimentalWarning ""${wrapperDaemon}"" --keep-alive`;
    const vbsContent = `\uFEFFSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "${cmd}", 0, False\r\n`;
    try {
      // 使用 UTF-16LE (带 BOM) 写入本地启动跳板 VBS，彻底兼容 Windows 中文用户名路径 (wscript.exe 原生支持 UTF-16LE)
      fs.writeFileSync(localVbsFile, vbsContent, 'utf16le');
    } catch {}

    // 单一权威自启策略：优先使用带当前用户 <UserId> 与 ME 完整性 SDDL 的 XML 注册 Windows 计划任务，
    // 兼顾非提权（Medium Integrity）终端零报错创建、跨完整性覆盖与脱离沙盒 Job Object；成功后清理旧版残留避免多路争抢！
    let autostartMethod = 'none';
    let scheduledTaskStarted = false;
    let taskSettingsUpdated = false;
    let taskEnabled = null;
    let taskHasTimedRepetition = null;
    let taskUpdateError = null;
    let taskUpdateWarning = null;
    const xmlEsc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    let userAuthor = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : '') + (process.env.USERNAME || os.userInfo().username);
    let userSid = '';
    try {
      const whoRes = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (whoRes.status === 0) {
        const m = String(whoRes.stdout || '').trim().match(/^"([^"]+)","(S-1-[^"]+)"/);
        if (m) {
          userAuthor = m[1];
          userSid = m[2];
        }
      }
    } catch {}
    const principalId = userSid || userAuthor;
    const sddl = `D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;IU)${userSid ? `(A;;FA;;;${userSid})` : ''}S:(ML;;NW;;;ME)`;
    // LogonTrigger 上的 Repetition 要等登录事件发生后才开始，install/升级在登录之后执行，所以下次登录前不会重复；
    // 改由 TimeTrigger 承载每 5 分钟的重复，不写 Duration 即无限期；
    // 首次周期触发在 StartBoundary+5min，install 末尾的 /Run 会立即补跑一次。
    const pad2 = (n) => String(n).padStart(2, '0');
    const nowLocal = new Date();
    const startBoundary = `${nowLocal.getFullYear()}-${pad2(nowLocal.getMonth() + 1)}-${pad2(nowLocal.getDate())}T${pad2(nowLocal.getHours())}:${pad2(nowLocal.getMinutes())}:00`;
    const taskXml = [
      '\uFEFF<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      `    <Author>${xmlEsc(userAuthor)}</Author>`,
      '    <URI>\\AntigravityThemeDaemon</URI>',
      `    <SecurityDescriptor>${xmlEsc(sddl)}</SecurityDescriptor>`,
      '  </RegistrationInfo>',
      '  <Principals>',
      '    <Principal id="Author">',
      `      <UserId>${xmlEsc(principalId)}</UserId>`,
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>',
      '  </Settings>',
      '  <Triggers>',
      '    <LogonTrigger>',
      '      <Enabled>true</Enabled>',
      `      <UserId>${xmlEsc(principalId)}</UserId>`,
      '    </LogonTrigger>',
      '    <TimeTrigger>',
      '      <Repetition>',
      '        <Interval>PT5M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      `      <StartBoundary>${startBoundary}</StartBoundary>`,
      '      <Enabled>true</Enabled>',
      '    </TimeTrigger>',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>SessionUnlock</StateChange>',
      `      <UserId>${xmlEsc(principalId)}</UserId>`,
      '    </SessionStateChangeTrigger>',
      '  </Triggers>',
      '  <Actions Context="Author">',
      '    <Exec>',
      '      <Command>wscript.exe</Command>',
      `      <Arguments>//B //NoLogo &quot;${xmlEsc(localVbsFile)}&quot;</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      ''
    ].join('\r\n');

    const tmpXmlPath = path.join(os.tmpdir(), `ag-theme-task-${process.pid}.xml`);
    try {
      fs.writeFileSync(tmpXmlPath, taskXml, 'utf16le');
      const createRes = spawnSync('schtasks', ['/Create', '/TN', 'AntigravityThemeDaemon', '/XML', tmpXmlPath, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 6000
      });
      if (createRes.status === 0) {
        autostartMethod = 'schtasks';
        taskSettingsUpdated = true;
        taskEnabled = true;
        taskHasTimedRepetition = true;
      } else {
        taskUpdateError =
          String(createRes.stderr || createRes.stdout || '').trim() || `schtasks /Create exited with code ${createRes.status}`;
        // 兼容旧版高完整性创建的无 SDDL 计划任务：若同名任务已存在且指向当前 VBS，直接复用而不降级写 HKCU\Run 制造双路并发
        const queryRes = spawnSync('schtasks', ['/Query', '/TN', 'AntigravityThemeDaemon', '/XML'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 4000
        });
        if (
          queryRes.status === 0 &&
          String(queryRes.stdout || '')
            .replace(/\0/g, '')
            .toLowerCase()
            .includes('antigravitythemedaemon.vbs')
        ) {
          autostartMethod = 'schtasks';
          const triggerCheck = inspectWindowsTaskXmlTriggers(queryRes.stdout);
          taskEnabled = triggerCheck.taskEnabled;
          taskHasTimedRepetition = triggerCheck.hasTimedRepetition;
          if (!triggerCheck.taskEnabled || !triggerCheck.hasTimedRepetition) {
            const installScriptPath = path.join(targetDir, 'install.mjs');
            const reason = !triggerCheck.taskEnabled
              ? '现有任务当前处于禁用状态（<Settings><Enabled>false</Enabled>）'
              : '现有任务缺少定时重复触发器（安装后至下次登录前 5 分钟保活不会生效）';
            taskUpdateWarning = `未能覆盖更新计划任务 AntigravityThemeDaemon（可能因旧任务由管理员权限创建），且${reason}。请以管理员身份运行 node "${installScriptPath}" install，或先管理员执行 schtasks /Delete /TN AntigravityThemeDaemon /F 后重装。`;
          }
        }
      }
    } catch (err) {
      taskUpdateError = taskUpdateError || String(err?.message || err);
    } finally {
      try {
        if (fs.existsSync(tmpXmlPath)) fs.unlinkSync(tmpXmlPath);
      } catch {}
    }

    if (autostartMethod === 'schtasks') {
      // 清理旧版多重自启残留
      try {
        if (fs.existsSync(vbsFile)) fs.unlinkSync(vbsFile);
      } catch {}
      try {
        spawnSync(
          'reg',
          ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AntigravityThemeDaemon', '/f'],
          { stdio: 'ignore', windowsHide: true }
        );
      } catch {}

      try {
        const runRes = spawnSync('schtasks', ['/Run', '/TN', 'AntigravityThemeDaemon'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000
        });
        if (runRes.status === 0) {
          const tmpDir = os.tmpdir();
          for (let i = 0; i < 15; i++) {
            sleepSync(100);
            const hasLivePid = fs.readdirSync(tmpDir).some((f) => {
              if (!f.startsWith('ag-theme-daemon-') || !f.endsWith('.pid')) return false;
              const parsed = parsePidFile(path.join(tmpDir, f));
              return !parsed.stopRequested && parsed.pid > 0;
            });
            if (hasLivePid) {
              scheduledTaskStarted = true;
              break;
            }
          }
        }
      } catch {}
    }

    // 仅当组策略等禁用了 schtasks 时，按 HKCU\Run -> Startup 目录顺序单路降级自启
    if (autostartMethod === 'none') {
      try {
        const regRes = spawnSync(
          'reg',
          [
            'add',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            'AntigravityThemeDaemon',
            '/t',
            'REG_SZ',
            '/d',
            `wscript.exe //B //NoLogo "${localVbsFile}"`,
            '/f'
          ],
          { stdio: 'ignore', windowsHide: true }
        );
        if (regRes.status === 0) {
          autostartMethod = 'registry-run';
          try {
            if (fs.existsSync(vbsFile)) fs.unlinkSync(vbsFile);
          } catch {}
        }
      } catch {}
    }
    if (autostartMethod === 'none') {
      try {
        fs.mkdirSync(startupDir, { recursive: true });
        fs.writeFileSync(vbsFile, vbsContent, 'utf16le');
        autostartMethod = 'startup-vbs';
      } catch {}
    }

    // 若计划任务未能即时拉起后台进程，回退到 detached spawn 直接拉起
    let spawnedPid = null;
    if (!scheduledTaskStarted) {
      try {
        // 固定工作目录为用户主目录，避免后台进程继承调用方终端的 CWD 导致该目录被占用无法删除
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', wrapperDaemon], {
          cwd: os.homedir(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.unref();
        spawnedPid = child.pid || null;
      } catch {}
    }
    return {
      platform: 'win32',
      autostartMethod,
      serviceFile: autostartMethod === 'startup-vbs' ? vbsFile : localVbsFile,
      localVbsFile,
      scheduledTask: autostartMethod === 'schtasks' ? 'AntigravityThemeDaemon' : null,
      taskSettingsUpdated,
      taskEnabled,
      hasTimedRepetition: taskHasTimedRepetition,
      taskUpdateError,
      taskUpdateWarning,
      scheduledTaskStarted,
      spawnedPid,
      runningNow: Boolean(scheduledTaskStarted || spawnedPid)
    };
  }

  return { platform: process.platform, serviceFile: null };
}

async function runInstall() {
  const cliChannel = getArg('--channel', null);
  const preserveUserChannel = hasFlag('--preserve-user-channel');
  const channel = cliChannel || 'auto';
  const preset = getArg('--preset', null);
  const darkPreset = getArg('--dark-preset', null);
  const syncUser = hasFlag('--sync-user');
  const defaultTarget = resolveGlobalInstallDir();
  const targetDir = path.resolve(getArg('--target-dir', defaultTarget));
  const isCustomSandboxTarget =
    hasFlag('--target-dir') && !isSameTargetPath(targetDir, defaultTarget) && !hasFlag('--register-service');

  const VALID_LIGHT_PRESETS = new Set([
    'native',
    'morandi',
    'absolutely',
    'high-contrast',
    'claude-desktop-purewhite',
    'vintage-deep'
  ]);
  const VALID_DARK_PRESETS = new Set(['onyx', 'claude-warm']);
  if (preset && !VALID_LIGHT_PRESETS.has(preset)) {
    console.error(
      `[ERROR] Invalid --preset "${preset}". Expected one of: native, morandi, absolutely, claude-desktop-purewhite, vintage-deep.`
    );
    process.exit(1);
  }
  if (darkPreset && !VALID_DARK_PRESETS.has(darkPreset)) {
    console.error(`[ERROR] Invalid --dark-preset "${darkPreset}". Expected one of: onyx, claude-warm.`);
    process.exit(1);
  }

  const env = await detectEnvironment(channel);
  if (!env.nodeBasicOk) {
    console.error(`[ERROR] Node.js >= 22.0.0 is required (current: ${env.nodeVer}).`);
    process.exit(1);
  }

  if (!verifyCoreIntegrity(__dirname).ok) {
    buildManifest(__dirname);
  }

  const srcCore = path.join(__dirname, 'core');
  const srcUser = path.join(__dirname, 'user');
  const targetCore = path.join(targetDir, 'core');
  const targetPrev = path.join(targetDir, 'core.prev');
  const backupsDir = path.join(targetDir, 'backups');
  const targetUser = path.join(targetDir, 'user');

  let backupCreated = null;
  let userBackupCreated = null;
  if (!isSameTargetPath(__dirname, targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });

    // 仅当已安装的 core/ 与当前待安装 core/ 的 manifest SHA-256 不同时才备份，防止重复 install 冲掉上一版快照
    const srcManifestPath = path.join(srcCore, 'manifest.json');
    const targetManifestPath = path.join(targetCore, 'manifest.json');
    const shouldBackup =
      fs.existsSync(targetCore) &&
      (!fs.existsSync(targetManifestPath) || sha256File(srcManifestPath) !== sha256File(targetManifestPath));

    if (shouldBackup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stampedBackupDir = path.join(backupsDir, stamp);
      fs.mkdirSync(backupsDir, { recursive: true });
      copyDirRecursive(targetCore, stampedBackupDir);
      fs.rmSync(targetPrev, { recursive: true, force: true });
      copyDirRecursive(targetCore, targetPrev);
      backupCreated = stampedBackupDir;
      try {
        const coreBackupStamps = fs
          .readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name) && !entry.name.endsWith('-user'))
          .map((entry) => entry.name)
          .sort()
          .reverse();
        for (const oldStamp of coreBackupStamps.slice(8)) {
          try {
            fs.rmSync(path.join(backupsDir, oldStamp), { recursive: true, force: true });
          } catch {}
        }
      } catch {}
    } else if (fs.existsSync(targetCore) && !fs.existsSync(targetPrev)) {
      copyDirRecursive(targetCore, targetPrev);
      backupCreated = targetPrev;
    }

    fs.rmSync(targetCore, { recursive: true, force: true });
    copyDirRecursive(srcCore, targetCore);

    // user/ 层默认永不覆盖已有文件；仅在显式传入 --sync-user 时先备份旧 user/ 再按标准 4 模板白名单同步
    const USER_TEMPLATE_FILES = ['config.json', 'custom.css', 'i18n.override.json', 'custom.js'];
    if (syncUser && fs.existsSync(targetUser)) {
      const userStamp = new Date().toISOString().replace(/[:.]/g, '-') + '-user';
      const stampedUserBackupDir = path.join(backupsDir, userStamp);
      fs.mkdirSync(backupsDir, { recursive: true });
      copyDirRecursive(targetUser, stampedUserBackupDir);
      userBackupCreated = stampedUserBackupDir;
    }
    fs.mkdirSync(targetUser, { recursive: true });
    for (const item of USER_TEMPLATE_FILES) {
      const s = path.join(srcUser, item);
      const d = path.join(targetUser, item);
      if (fs.existsSync(s) && (!fs.existsSync(d) || syncUser)) {
        fs.copyFileSync(s, d);
      }
    }

    for (const docFile of ['install.mjs', 'SKILL.md', 'README.md', 'CHANGELOG.md']) {
      const s = path.join(__dirname, docFile);
      const d = path.join(targetDir, docFile);
      if (fs.existsSync(s)) fs.copyFileSync(s, d);
    }
  }

  // 更新 user/config.json（仅在显式传入 CLI 参数或首次初始化时更新对应字段，保留用户自定义；兼容 Windows 记事本 UTF-8 BOM）
  const userConfigPath = path.join(targetUser, 'config.json');
  let currentCfg = {};
  let canWriteUserCfg = true;
  const prevCfgRaw = fs.existsSync(userConfigPath) ? fs.readFileSync(userConfigPath, 'utf8') : null;
  let preMutateCfgJson = null;
  if (prevCfgRaw !== null) {
    try {
      const parsed = JSON.parse(prevCfgRaw.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        currentCfg = parsed;
        preMutateCfgJson = JSON.stringify(currentCfg);
      } else {
        canWriteUserCfg = false;
      }
    } catch {
      canWriteUserCfg = false;
      console.warn('[Install] Warning: existing user/config.json is invalid JSON; leaving it untouched to prevent data loss.');
    }
  }
  if (typeof currentCfg.enabled !== 'boolean') currentCfg.enabled = true;
  if (cliChannel && !preserveUserChannel) {
    currentCfg.channel = cliChannel;
  } else if (!currentCfg.channel) {
    currentCfg.channel = 'auto';
  }
  if (preset) {
    currentCfg.preset = preset === 'high-contrast' ? 'morandi' : preset;
  } else if (!currentCfg.preset || currentCfg.preset === 'high-contrast') {
    currentCfg.preset = 'morandi';
  }
  if (darkPreset) {
    currentCfg.darkPreset = darkPreset;
  } else if (!currentCfg.darkPreset) {
    currentCfg.darkPreset = 'onyx';
  }
  if (syncUser || currentCfg.installedLocale !== 'none') {
    currentCfg.installedLocale = 'zh-CN';
  }
  if ('fontMode' in currentCfg) {
    delete currentCfg.fontMode;
  }
  if (!currentCfg.modules || typeof currentCfg.modules !== 'object' || Array.isArray(currentCfg.modules)) {
    currentCfg.modules = {};
  }
  for (const modKey of [
    'i18n',
    'metrics',
    'composerWaxSeal',
    'contextMenu',
    'updateCheck',
    'deadlockHealer',
    'coldBootHealer',
    'zoomShortcuts',
    'cdpAutoRelaunch',
    'customCss',
    'customJs'
  ]) {
    if (typeof currentCfg.modules[modKey] !== 'boolean') {
      currentCfg.modules[modKey] = true;
    }
  }
  // 自动清理早期版本遗留在 user/config.json 中的出厂默认 selectors，确保后续升级由 core/runtime.js 统一托管
  if (currentCfg.selectors && typeof currentCfg.selectors === 'object') {
    if (currentCfg.selectors.inputBoxId === 'antigravity.agentSidePanelInputBox') {
      delete currentCfg.selectors;
    } else if (
      typeof currentCfg.selectors.excludeI18n === 'string' &&
      (!currentCfg.selectors.excludeI18n.includes('.monaco-editor') ||
        (currentCfg.selectors.excludeI18n.startsWith('code, pre, kbd, samp') &&
          !currentCfg.selectors.excludeI18n.includes('[data-markdown-root]')))
    ) {
      delete currentCfg.selectors.excludeI18n;
      if (Object.keys(currentCfg.selectors).length === 0) {
        delete currentCfg.selectors;
      }
    }
  }
  if (canWriteUserCfg) {
    const postMutateCfgJson = JSON.stringify(currentCfg);
    const nextCfgJson = JSON.stringify(currentCfg, null, 2) + '\n';
    const semanticallyUnchanged = !syncUser && preMutateCfgJson !== null && postMutateCfgJson === preMutateCfgJson;
    if (!semanticallyUnchanged && (prevCfgRaw === null || prevCfgRaw.replace(/^\uFEFF/, '') !== nextCfgJson)) {
      fs.writeFileSync(userConfigPath, nextCfgJson, 'utf8');
    }
  }

  const realDaemon = path.join(targetCore, 'daemon.mjs');
  let argvStatus = { skipped: true, reason: 'custom-target-dir' };
  let launcherStatus = { skipped: true, reason: 'custom-target-dir' };
  let serviceInfo = { skipped: true, reason: 'custom-target-dir' };

  if (!isCustomSandboxTarget) {
    // 自动检查并修补 ~/.antigravity/argv.json (兼容 1.x) 与 M1 跨平台单图标参数/可选启动器 (2.33.0+)
    argvStatus = ensureArgvRemoteDebugging(currentCfg.channel);
    launcherStatus = ensureCdpLaunchers(currentCfg.channel, { withLauncher: hasFlag('--with-launcher') });

    // 创建兼容包装脚本 ~/.gemini/antigravity/scripts/antigravity-font-daemon.mjs（使用 pathToFileURL 兼容 Windows C:\ 路径）
    const scriptsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const wrapperDaemon = path.join(scriptsDir, 'antigravity-font-daemon.mjs');
    const realDaemonUrl = pathToFileURL(realDaemon).href;
    fs.writeFileSync(
      wrapperDaemon,
      `#!/usr/bin/env node\n// Auto-generated wrapper -> ${realDaemon}\nawait import(${JSON.stringify(realDaemonUrl)});\n`,
      { encoding: 'utf8', mode: 0o755 }
    );

    // 注册/更新跨平台自启服务
    serviceInfo = registerSystemService(targetDir, wrapperDaemon);

    // 立即执行一次 --once 同步注入
    const onceArgs = ['--disable-warning=ExperimentalWarning', realDaemon, '--once'];
    if (cliChannel === 'stable' || cliChannel === 'insiders' || cliChannel === 'auto') {
      onceArgs.push('--channel', cliChannel);
    }
    spawnSync(process.execPath, onceArgs, {
      stdio: 'inherit'
    });
  }

  const effectivePostChannel =
    cliChannel === 'stable' || cliChannel === 'insiders' || cliChannel === 'auto'
      ? cliChannel
      : currentCfg.channel;
  const postEnv = isCustomSandboxTarget ? env : await detectEnvironment(effectivePostChannel);
  const live = isCustomSandboxTarget
    ? { skipped: true, reason: 'custom-target-dir' }
    : await inspectLiveWindow(postEnv, 9222, Array.isArray(currentCfg.allowedOrigins) ? currentCfg.allowedOrigins : null);
  const fontsReport = buildFontReport(postEnv);
  const needsCdpRelaunch =
    !isCustomSandboxTarget && !live.reachable && postEnv.cdpStatus === 'missing_opt_in_flag';
  const keepAliveUpgradeWarning =
    !isCustomSandboxTarget && serviceInfo && typeof serviceInfo === 'object' ? serviceInfo.taskUpdateWarning || null : null;
  const warnings = keepAliveUpgradeWarning ? [keepAliveUpgradeWarning] : [];
  if (!fontsReport.allRequiredInstalled) {
    warnings.push(
      `Missing required fonts (${fontsReport.missing.join('; ')}). Run: node ${JSON.stringify(path.join(targetDir, 'install.mjs'))} install-fonts --auto-download`
    );
  }
  if (fontsReport.unregisteredWarning) {
    warnings.push(fontsReport.unregisteredWarning);
  }
  const installOk = !keepAliveUpgradeWarning;
  console.log(
    '\n[Install Complete]',
    JSON.stringify(
      {
        ok: installOk,
        targetDir,
        backupCreated,
        userSynced: syncUser,
        userBackupCreated,
        argvStatus,
        launcherStatus,
        serviceInfo,
        fonts: fontsReport,
        warnings,
        config: currentCfg,
        cdpStatus: isCustomSandboxTarget ? 'sandbox' : live.reachable ? 'ready' : postEnv.cdpStatus,
        relaunchHint: needsCdpRelaunch
          ? `Antigravity (${postEnv.appVersion || '2.33.0+'}) is currently running without --remote-debugging-port. When idle, run: node ${JSON.stringify(path.join(targetDir, 'install.mjs'))} relaunch`
          : null,
        liveWindow: live
      },
      null,
      2
    )
  );
  if (keepAliveUpgradeWarning) {
    console.warn(`\n[WARN] ${keepAliveUpgradeWarning}`);
    process.exitCode = 1;
  }
  if (!fontsReport.allRequiredInstalled) {
    console.warn(
      `\n[WARN] Missing fonts detected: ${fontsReport.missing.join(' | ')}\n       Auto-download & install: node ${JSON.stringify(path.join(targetDir, 'install.mjs'))} install-fonts --auto-download`
    );
  }
}

function hasRecentActiveConversationWal(channel = 'auto', windowSec = 15) {
  const home = os.homedir();
  const dirs = [];
  if (channel !== 'insiders') dirs.push(path.join(home, '.gemini', 'antigravity', 'conversations'));
  if (channel !== 'stable') dirs.push(path.join(home, '.gemini', 'antigravity-insiders', 'conversations'));
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const activeFiles = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.db-wal')) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full, { throwIfNoEntry: false });
        if (st && st.size > 4096 && now - st.mtimeMs < windowMs) {
          activeFiles.push({ file: name, ageMs: Math.round(now - st.mtimeMs), bytes: st.size });
        }
      }
    } catch {}
  }
  return activeFiles;
}

function isPidRunning(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function tokenizeRelaunchCmdLine(cmdLine, platform = process.platform) {
  const src = String(cmdLine || '');
  const tokens = [];
  if (platform === 'win32') {
    // 遵循 Windows CommandLineToArgvW 的 2n / 2n+1 反斜杠 + 双引号规则
    let cur = '';
    let inQuotes = false;
    let hasToken = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\\') {
        let bsCount = 1;
        while (i + bsCount < src.length && src[i + bsCount] === '\\') bsCount++;
        if (i + bsCount < src.length && src[i + bsCount] === '"') {
          cur += '\\'.repeat(Math.floor(bsCount / 2));
          hasToken = true;
          if (bsCount % 2 === 1) {
            cur += '"';
          } else {
            inQuotes = !inQuotes;
          }
          i += bsCount;
          continue;
        }
        cur += '\\'.repeat(bsCount);
        hasToken = true;
        i += bsCount - 1;
        continue;
      }
      if (ch === '"') {
        hasToken = true;
        if (inQuotes && i + 1 < src.length && src[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) {
        if (hasToken || cur.length > 0) {
          tokens.push(cur);
          cur = '';
          hasToken = false;
        }
        continue;
      }
      cur += ch;
      hasToken = true;
    }
    if (hasToken || cur.length > 0) tokens.push(cur);
    return tokens;
  }

  // POSIX ps -axo command= 输出无外层 shell 引号，禁用单引号配对以免路径中的撇号（如 John's Repo）吞没后续参数
  let cur = '';
  let inDoubleQuote = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inDoubleQuote) {
      if (ch === '\\' && i + 1 < src.length && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inDoubleQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inDoubleQuote = true;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function stripLeadingExecutableFromCmdLine(cmdLine, exePath = '', platform = process.platform) {
  const src = String(cmdLine || '').trimStart();
  if (!src) return '';
  const exe = String(exePath || '').trim();
  if (exe) {
    const cmpSrc = platform === 'win32' ? src.toLowerCase() : src;
    const cmpExe = platform === 'win32' ? exe.toLowerCase() : exe;
    const quotedExe = `"${cmpExe}"`;
    if (cmpSrc.startsWith(quotedExe)) {
      const rest = src.slice(quotedExe.length);
      if (!rest || /^\s/.test(rest)) return rest.trimStart();
    }
    if (cmpSrc.startsWith(cmpExe)) {
      const rest = src.slice(cmpExe.length);
      if (!rest || /^\s/.test(rest)) return rest.trimStart();
    }
  }
  if (platform === 'darwin') {
    const macAppMatch = src.match(
      /^(?:"[^"]+"|\S.*?\/Antigravity(?:\s-\sInsiders)?\.app\/Contents\/MacOS\/Antigravity(?:\s-\sInsiders)?)(?=\s|$)/
    );
    if (macAppMatch) return src.slice(macAppMatch[0].length).trimStart();
  } else if (platform === 'win32') {
    const winExeMatch = src.match(/^(?:"[^"]+"|[a-zA-Z]:\\[^\r\n]*?\.exe)(?=\s|$)/i);
    if (winExeMatch) return src.slice(winExeMatch[0].length).trimStart();
  }
  if (src.startsWith('"')) {
    const endQuote = src.indexOf('"', 1);
    if (endQuote > 0) return src.slice(endQuote + 1).trimStart();
  }
  const firstWs = src.search(/\s/);
  return firstWs < 0 ? '' : src.slice(firstWs + 1).trimStart();
}

function readLinuxProcCmdlineArgs(pid, platform = process.platform) {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (!raw || raw.length === 0) return null;
    const parts = raw.toString('utf8').split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts.length > 1 ? parts.slice(1) : [];
  } catch {
    return null;
  }
}

function normalizeProxyUrl(address, defaultScheme = 'http') {
  const raw = String(address || '').trim();
  if (!raw) return '';
  // Chromium --proxy-server 允许逗号分隔回退链（如 http://127.0.0.1:7890,direct://），提取首个真实代理节点
  const firstHop = raw
    .split(',')
    .map((s) => s.trim())
    .find((s) => s && !/^direct:\/\//i.test(s));
  if (!firstHop) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(firstHop)) return firstHop;
  return `${defaultScheme}://${firstHop}`;
}

function parseProxyServerSpec(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!text.includes('=')) {
    const url = normalizeProxyUrl(text, 'http');
    return url ? { httpProxy: url, httpsProxy: url } : null;
  }
  const map = Object.create(null);
  for (const entry of text.split(';')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const scheme = entry.slice(0, eq).trim().toLowerCase();
    const val = entry.slice(eq + 1).trim();
    if (scheme && val) map[scheme] = val;
  }
  let httpProxy = map.http ? normalizeProxyUrl(map.http, 'http') : '';
  let httpsProxy = map.https ? normalizeProxyUrl(map.https, 'http') : '';
  if (map.socks) {
    // WinINet 注册表中的 socks= 协议名无版本后缀，现代本地代理客户端普遍提供 SOCKS5 混合监听，Go net/http 亦仅支持 socks5://
    const socks = normalizeProxyUrl(map.socks, 'socks5');
    if (!httpProxy) httpProxy = socks;
    if (!httpsProxy) httpsProxy = socks;
  }
  if (!httpProxy && httpsProxy) httpProxy = httpsProxy;
  if (!httpsProxy && httpProxy) httpsProxy = httpProxy;
  if (!httpProxy && !httpsProxy) {
    const firstVal = Object.values(map)[0];
    if (firstVal) {
      const url = normalizeProxyUrl(firstVal, 'http');
      httpProxy = url;
      httpsProxy = url;
    }
  }
  return httpProxy || httpsProxy ? { httpProxy, httpsProxy } : null;
}

function normalizeBypassTokenForNoProxy(rawEntry) {
  const trimmed = String(rawEntry || '').trim();
  if (!trimmed) return '';
  const low = trimmed.toLowerCase();
  if (low === '<local>' || low === '<-loopback>') return '';
  if (low === '[::1]') return '::1';
  if (trimmed === '*.*.*.*') return '*';

  // 分离非 IPv6 末尾端口（如 192.168.1.*:8080 或 *corp.com:8443）
  let hostPart = trimmed;
  let portSuffix = '';
  const firstColon = trimmed.indexOf(':');
  const lastColon = trimmed.lastIndexOf(':');
  if (firstColon > 0 && firstColon === lastColon && /^\d{1,5}$/.test(trimmed.slice(firstColon + 1))) {
    hostPart = trimmed.slice(0, firstColon);
    portSuffix = trimmed.slice(firstColon);
  }

  if (/^\d{1,3}(?:\.(?:\d{1,3}|\*)){1,3}$/.test(hostPart) && hostPart.includes('*')) {
    const parts = hostPart.split('.');
    const starIdx = parts.indexOf('*');
    if (starIdx >= 1 && starIdx <= 3 && parts.slice(starIdx).every((p) => p === '*')) {
      const nums = parts.slice(0, starIdx).map((n) => Number(n));
      if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        const octets = [...nums, 0, 0, 0].slice(0, 4);
        // Go httpproxy 对 CIDR 条目不支持附带端口后缀，统一输出标准网段 CIDR
        return `${octets.join('.')}/${starIdx * 8}`;
      }
    }
    return '';
  }

  // WinINet 允许 *corp.com（无点号），近似转换为 Go/Node 支持的子域后缀 .corp.com
  if (/^\*[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(hostPart)) {
    return `.${hostPart.slice(1)}${portSuffix}`;
  }

  return `${hostPart}${portSuffix}`;
}

function parseBypassListEntries(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[;,\s]+/)) {
    const norm = normalizeBypassTokenForNoProxy(part);
    if (norm) out.push(norm);
  }
  return out;
}

function mergeNoProxyValue(existingRaw, extraEntries = []) {
  const LOOPBACK_ENTRIES = ['localhost', '127.0.0.1', '::1'];
  const merged = [];
  const seen = new Set();
  const pushItem = (rawItem) => {
    const norm = normalizeBypassTokenForNoProxy(rawItem);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(norm);
  };
  for (const part of String(existingRaw || '').split(/[,;]+/)) {
    pushItem(part);
  }
  for (const extra of extraEntries) {
    pushItem(extra);
  }
  for (const lb of LOOPBACK_ENTRIES) {
    pushItem(lb);
  }
  return merged.join(',');
}

function extractRelaunchArgsFromCmdLine(cmdLine, meta = {}) {
  const platform = meta?.platform || process.platform;
  const procTokens = Array.isArray(meta?.procArgs)
    ? meta.procArgs
    : readLinuxProcCmdlineArgs(meta?.pid, platform);
  const tokens =
    procTokens !== null
      ? procTokens
      : (() => {
          const rest = stripLeadingExecutableFromCmdLine(cmdLine, meta?.exePath || '', platform);
          return rest ? tokenizeRelaunchCmdLine(rest, platform) : [];
        })();
  if (tokens.length === 0) return { allArgs: [], preservedProxyArgs: [] };

  const VALUE_FLAGS = new Set(['--proxy-server', '--proxy-bypass-list', '--proxy-pac-url']);
  const BOOL_FLAGS = new Set(['--no-proxy-server', '--proxy-auto-detect']);
  const DROP_EXACT_FLAGS = new Set(['--updated', '--remote-debugging-pipe', '--inspect', '--inspect-brk']);
  const DROP_VALUE_FLAGS = new Set(['--remote-debugging-port', '--type']);
  const DROP_PREFIXES = ['--squirrel-', '-psn_', '--inspect=', '--inspect-brk='];
  const allArgs = [];
  const preservedProxyArgs = [];
  const seenProxy = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.startsWith('-')) {
      const lowTok = tok.toLowerCase();
      if (DROP_PREFIXES.some((pfx) => lowTok.startsWith(pfx))) {
        continue;
      }
      const eqIdx = tok.indexOf('=');
      const flag = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
      if (DROP_EXACT_FLAGS.has(flag)) continue;
      if (DROP_VALUE_FLAGS.has(flag)) {
        if (eqIdx < 0 && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          i++;
        }
        continue;
      }
      if (BOOL_FLAGS.has(flag)) {
        if (!seenProxy.has(flag)) {
          seenProxy.add(flag);
          preservedProxyArgs.push(flag);
          allArgs.push(flag);
        }
        continue;
      }
      if (VALUE_FLAGS.has(flag)) {
        let val = '';
        if (eqIdx >= 0) {
          val = tok.slice(eqIdx + 1).trim();
        } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
          val = tokens[++i].trim();
        }
        if (val && !seenProxy.has(flag)) {
          seenProxy.add(flag);
          const normalized = `${flag}=${val}`;
          preservedProxyArgs.push(normalized);
          allArgs.push(normalized);
        }
        continue;
      }
      if (platform === 'darwin') {
        if (tok.startsWith('--')) {
          allArgs.push(tok);
        }
        continue;
      }
    } else if (platform === 'darwin') {
      // macOS ps -axo command= 不带引号，丢弃无引号位置路径碎片，交由 Electron 原生会话记忆恢复打开的工作区
      continue;
    }
    allArgs.push(tok);
  }
  return { allArgs, preservedProxyArgs };
}

function readWindowsSystemProxyFresh() {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    if (r.status !== 0 || !r.stdout) return null;
    const out = String(r.stdout);
    const enabledMatch = out.match(/ProxyEnable[ \t]+REG_DWORD[ \t]+0x([0-9a-f]+)/i);
    if (!enabledMatch || parseInt(enabledMatch[1], 16) !== 1) return null;
    const serverMatch = out.match(/ProxyServer[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
    if (!serverMatch || !serverMatch[1].trim()) return null;
    const parsed = parseProxyServerSpec(serverMatch[1]);
    if (!parsed) return null;
    const overrideMatch = out.match(/ProxyOverride[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
    const rawBypassList = overrideMatch ? overrideMatch[1].trim() : '';
    return {
      ...parsed,
      rawBypassList,
      noProxyEntries: parseBypassListEntries(rawBypassList)
    };
  } catch {
    return null;
  }
}

function redactProxyCredentials(text) {
  return String(text || '').replace(/(:\/\/)([^@\s/]+)@/g, '$1<redacted>@');
}

function readEnvCaseInsensitive(envObj, keyName, joinAll = false) {
  const target = keyName.toLowerCase();
  const vals = [];
  for (const [k, v] of Object.entries(envObj)) {
    if (k.toLowerCase() === target && v !== undefined && v !== null && String(v).trim() !== '') {
      if (!joinAll) return String(v);
      vals.push(String(v));
    }
  }
  return joinAll ? vals.join(',') : '';
}

function writeProxyEnvPair(envObj, upperKey, val, platform = process.platform) {
  const lowerKey = upperKey.toLowerCase();
  if (platform === 'win32') {
    for (const k of Object.keys(envObj)) {
      if (k.toLowerCase() === lowerKey && k !== upperKey) {
        delete envObj[k];
      }
    }
    envObj[upperKey] = val;
  } else {
    envObj[upperKey] = val;
    envObj[lowerKey] = val;
  }
}

function buildRelaunchPlan(cmdLine, targetMeta = {}) {
  const platform = targetMeta?.platform || process.platform;
  const { allArgs, preservedProxyArgs } = extractRelaunchArgsFromCmdLine(cmdLine, targetMeta);
  const args = ['--remote-debugging-port=0', ...allArgs];
  const env = { ...(targetMeta?.baseEnv || process.env) };
  const hasExplicitNoProxyFlag = preservedProxyArgs.includes('--no-proxy-server');
  const proxyBypassArg = preservedProxyArgs.find((a) => a.startsWith('--proxy-bypass-list='));
  const cliBypassEntries = proxyBypassArg
    ? parseBypassListEntries(proxyBypassArg.slice('--proxy-bypass-list='.length))
    : [];
  const hasAnyProxyEnv = () =>
    Boolean(
      readEnvCaseInsensitive(env, 'HTTP_PROXY') ||
        readEnvCaseInsensitive(env, 'HTTPS_PROXY') ||
        readEnvCaseInsensitive(env, 'ALL_PROXY')
    );

  let proxySource = 'none';
  let extraBypassEntries = [...cliBypassEntries];
  if (hasExplicitNoProxyFlag) {
    proxySource = 'cli-no-proxy';
  } else if (hasAnyProxyEnv()) {
    proxySource = 'inherited-env';
  } else {
    const proxyServerArg = preservedProxyArgs.find((a) => a.startsWith('--proxy-server='));
    let resolved = proxyServerArg ? parseProxyServerSpec(proxyServerArg.slice('--proxy-server='.length)) : null;
    if (resolved) {
      proxySource = 'cli-proxy-flag';
    } else if (platform === 'win32') {
      resolved = readWindowsSystemProxyFresh();
      if (resolved) proxySource = 'win32-system-proxy';
    }
    if (resolved) {
      if (resolved.httpProxy) {
        writeProxyEnvPair(env, 'HTTP_PROXY', resolved.httpProxy, platform);
      }
      if (resolved.httpsProxy) {
        writeProxyEnvPair(env, 'HTTPS_PROXY', resolved.httpsProxy, platform);
      }
      if (Array.isArray(resolved.noProxyEntries)) {
        extraBypassEntries = [...extraBypassEntries, ...resolved.noProxyEntries];
      }
    }
  }

  // 只要最终环境携带任意 *_PROXY（包括 --no-proxy-server 下仍从父进程继承 HTTP_PROXY 的场景），一律合并环回与绕行列表以防 Node 侧代理库劫持环回请求
  if (hasAnyProxyEnv()) {
    const existingNoProxy = readEnvCaseInsensitive(env, 'NO_PROXY', true);
    const mergedNoProxy = mergeNoProxyValue(existingNoProxy, extraBypassEntries);
    writeProxyEnvPair(env, 'NO_PROXY', mergedNoProxy, platform);
  }

  return { args, env, preservedProxyArgs, proxySource };
}

async function runRelaunch() {
  const channel = getArg('--channel', 'auto');
  const force = hasFlag('--force');
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const daemonPath = path.join(targetDir, 'core', 'daemon.mjs');

  if (!force) {
    const activeWals = hasRecentActiveConversationWal(channel, 15);
    if (activeWals.length > 0) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            reason: 'active_conversation_detected',
            activeWals,
            hint: 'An Agent conversation updated its WAL within the last 15s. Wait until the turn finishes, or pass --force to relaunch anyway.'
          },
          null,
          2
        )
      );
      process.exit(2);
    }
  }

  const hostBefore = readHostVersionAndProcesses(channel);
  const procsToStop = hostBefore.runningProcesses;
  const home = os.homedir();

  // 写入防重入冷却锁，告知后台守护进程 M2 本次为主动接力重启
  const guardFile = path.join(os.tmpdir(), 'ag-cdp-relaunch-guard.json');
  try {
    const prevGuard = fs.existsSync(guardFile) ? JSON.parse(fs.readFileSync(guardFile, 'utf8')) : {};
    const prevHandled = Array.isArray(prevGuard.handledPids) ? prevGuard.handledPids : [];
    fs.writeFileSync(
      guardFile,
      JSON.stringify(
        {
          lastRelaunchAtMs: Date.now(),
          lastChannel: channel,
          reason: 'manual-cli-relaunch',
          handledPids: Array.from(new Set([...prevHandled.slice(-15), ...procsToStop.map((p) => p.pid)]))
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  } catch {}

  let launchTarget = procsToStop[0] || null;
  if (!launchTarget) {
    if (process.platform === 'darwin') {
      const appPath =
        channel === 'insiders'
          ? ['/Applications/Antigravity - Insiders.app', path.join(home, 'Applications/Antigravity - Insiders.app')].find(
              (p) => fs.existsSync(p)
            ) || '/Applications/Antigravity - Insiders.app'
          : ['/Applications/Antigravity.app', path.join(home, 'Applications/Antigravity.app')].find((p) =>
              fs.existsSync(p)
            ) || '/Applications/Antigravity.app';
      launchTarget = { channel: channel === 'insiders' ? 'insiders' : 'stable', appPath, exePath: '' };
    } else if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const cands =
        channel === 'insiders'
          ? [
              path.join(localAppData, 'Programs', 'Antigravity - Insiders', 'Antigravity - Insiders.exe'),
              path.join(progFiles, 'Antigravity - Insiders', 'Antigravity - Insiders.exe')
            ]
          : [
              path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
              path.join(progFiles, 'Antigravity', 'Antigravity.exe')
            ];
      const exePath = cands.find((p) => fs.existsSync(p)) || '';
      launchTarget = { channel: channel === 'insiders' ? 'insiders' : 'stable', appPath: '', exePath };
    } else {
      const exePath = ['/usr/bin/antigravity', '/usr/local/bin/antigravity', '/opt/Antigravity/antigravity'].find((p) =>
        fs.existsSync(p)
      );
      launchTarget = { channel: 'stable', appPath: '', exePath: exePath || 'antigravity' };
    }
  }

  // 在终止旧主进程之前提前构建重启计划（确保 Linux 下 /proc/<pid>/cmdline 存活可读）
  const relaunchPlan = buildRelaunchPlan(launchTarget.cmd, launchTarget);

  for (const p of procsToStop) {
    if (process.platform === 'darwin' && p.appPath) {
      spawnSync('osascript', ['-e', `tell application "${p.appPath}" to quit`], { stdio: 'ignore', timeout: 3000 });
      for (let i = 0; i < 25 && isPidRunning(p.pid); i++) sleepSync(100);
    } else if (process.platform === 'win32') {
      const stopPs = `$gp = Get-Process -Id ${p.pid} -ErrorAction SilentlyContinue; if ($gp) { [void]$gp.CloseMainWindow(); if (-not $gp.WaitForExit(1800)) { Stop-Process -Id ${p.pid} -Force -ErrorAction SilentlyContinue } }`;
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', stopPs], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000
      });
    }
    if (isPidRunning(p.pid)) {
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 35 && isPidRunning(p.pid); i++) sleepSync(100);
    }
    if (isPidRunning(p.pid) && process.platform !== 'win32') {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {}
      for (let i = 0; i < 15 && isPidRunning(p.pid); i++) sleepSync(80);
    }
  }

  // 确保 Electron SingletonLock 完全释放后再启动带 --remote-debugging-port=0 的新宿主实例
  sleepSync(250);

  if (process.platform === 'darwin' && launchTarget.appPath) {
    spawnSync('/usr/bin/open', ['-a', launchTarget.appPath, '--args', ...relaunchPlan.args], {
      env: relaunchPlan.env,
      stdio: 'ignore',
      timeout: 5000
    });
  } else if (launchTarget.exePath) {
    const child = spawn(launchTarget.exePath, relaunchPlan.args, {
      cwd: os.homedir(),
      env: relaunchPlan.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
  } else {
    console.error(JSON.stringify({ ok: false, reason: 'executable_not_found' }, null, 2));
    process.exit(1);
  }

  let live = { reachable: false };
  for (let i = 0; i < 30; i++) {
    sleepSync(500);
    const curEnv = await detectEnvironment(launchTarget.channel || channel);
    const targetChInfo = curEnv.channels?.[launchTarget.channel || 'stable'];
    if (targetChInfo && !targetChInfo.portFileExists) continue;
    if (fs.existsSync(daemonPath)) {
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath, '--once'], {
        stdio: 'ignore',
        windowsHide: true
      });
    }
    live = await inspectLiveWindow(curEnv);
    if (live.reachable && live.state?.hasStyle) break;
  }

  const ok = Boolean(live.reachable && live.state?.hasStyle);
  console.log(
    JSON.stringify(
      {
        ok,
        stoppedPids: procsToStop.map((p) => p.pid),
        proxySource: relaunchPlan.proxySource,
        preservedProxyArgs: relaunchPlan.preservedProxyArgs.map(redactProxyCredentials),
        version: live.state?.version || null,
        themeStyle: Boolean(live.state?.hasStyle),
        dictCount: live.state?.dictCount || 0,
        pillMounted: Boolean(live.state?.pillMounted),
        live
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);
}

async function runVerify() {
  const safeMode = hasFlag('--safe-mode');
  const cliChannel = getArg('--channel', null);
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const channel = safeMode
    ? cliChannel === 'stable' || cliChannel === 'insiders' || cliChannel === 'auto'
      ? cliChannel
      : 'auto'
    : readTargetConfiguredChannel(targetDir);
  const expectedEnabled = safeMode ? true : readTargetPatchEnabled(targetDir);
  const daemonPath = path.join(targetDir, 'core', 'daemon.mjs');

  const daemonArgs = ['--disable-warning=ExperimentalWarning', daemonPath, '--once'];
  if (safeMode) daemonArgs.push('--safe-mode');
  if (cliChannel === 'stable' || cliChannel === 'insiders' || cliChannel === 'auto') {
    daemonArgs.push('--channel', cliChannel);
  }

  const daemonRes = spawnSync(process.execPath, daemonArgs, { encoding: 'utf8', windowsHide: true });
  if (daemonRes.stdout) process.stderr.write(daemonRes.stdout);
  if (daemonRes.stderr) process.stderr.write(daemonRes.stderr);
  const installedManifest = readInstalledCoreManifest(targetDir);
  const installedSemver =
    installedManifest && typeof installedManifest.version === 'string' && installedManifest.version.trim()
      ? installedManifest.version.trim().replace(/^v/i, '')
      : '';
  const escapedInstalledSemver = installedSemver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installedSemverRe = escapedInstalledSemver
    ? new RegExp(`(?:^|[^0-9.])v?${escapedInstalledSemver}(?:$|[^0-9.])`, 'i')
    : null;

  const env = await detectEnvironment(channel);
  const live = await inspectLiveWindow(env, 9222, safeMode ? null : readTargetAllowedOrigins(targetDir));
  const fontsReport = buildFontReport(env);
  const candidateStates =
    Array.isArray(live.hostTargets) && live.hostTargets.length > 0
      ? live.hostTargets.map((h) => h.state)
      : [live.state];
  const isStateConsistent = (st) => {
    if (!st || typeof st !== 'object') return false;
    const ver = typeof st.version === 'string' ? st.version.trim() : '';
    if (!ver) return false;
    if (installedSemverRe && !installedSemverRe.test(ver)) return false;
    return expectedEnabled
      ? Boolean(st.hasStyle && !ver.endsWith('-disabled'))
      : Boolean(!st.hasStyle && ver.endsWith('-disabled'));
  };
  const ok = Boolean(
    daemonRes.status === 0 &&
      live.reachable &&
      (live.pages === 0 || (candidateStates.length > 0 && candidateStates.every(isStateConsistent)))
  );
  console.log(
    JSON.stringify(
      {
        ok,
        enabled: expectedEnabled,
        version: live.state?.version || null,
        themeStyle: Boolean(live.state?.hasStyle),
        safeMode,
        channel,
        fonts: {
          allRequiredInstalled: fontsReport.allRequiredInstalled,
          missing: fontsReport.missing,
          unregisteredFiles: fontsReport.unregisteredFiles,
          autoDownloadCommand: fontsReport.autoDownloadCommand
        },
        live
      },
      null,
      2
    )
  );
}

async function runRollback() {
  const defaultTarget = resolveGlobalInstallDir();
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const isCustomSandboxTarget =
    hasFlag('--target-dir') && !isSameTargetPath(targetDir, defaultTarget) && !hasFlag('--register-service');
  const targetCore = path.join(targetDir, 'core');
  const targetPrev = path.join(targetDir, 'core.prev');
  const backupsDir = path.join(targetDir, 'backups');

  const isValidCoreBackup = (dir) =>
    fs.existsSync(path.join(dir, 'daemon.mjs')) && fs.existsSync(path.join(dir, 'runtime.js'));
  const isVerifiedCoreBackup = (dir) =>
    isValidCoreBackup(dir) && verifyCoreIntegrity(dir, { coreDir: dir }).ok;

  const isIsoStampDir = (name) => /^\d{4}-\d{2}-\d{2}T/.test(name);
  const backupStampsNewestFirst = fs.existsSync(backupsDir)
    ? fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.endsWith('-user'))
        .map((entry) => entry.name)
        .sort((a, b) => {
          const aIso = isIsoStampDir(a);
          const bIso = isIsoStampDir(b);
          if (aIso !== bIso) return aIso ? -1 : 1;
          return b.localeCompare(a);
        })
    : [];

  let restoreSource = null;
  if (isVerifiedCoreBackup(targetPrev)) {
    restoreSource = targetPrev;
  } else {
    for (const name of backupStampsNewestFirst) {
      const candidate = path.join(backupsDir, name);
      if (isVerifiedCoreBackup(candidate)) {
        restoreSource = candidate;
        break;
      }
    }
  }

  if (!restoreSource) {
    if (isValidCoreBackup(targetPrev)) {
      restoreSource = targetPrev;
    } else {
      for (const name of backupStampsNewestFirst) {
        const candidate = path.join(backupsDir, name);
        if (isValidCoreBackup(candidate)) {
          restoreSource = candidate;
          break;
        }
      }
    }
  }

  if (!restoreSource) {
    console.error(`[ERROR] No valid core backup found at ${targetPrev} or ${backupsDir}`);
    process.exit(1);
  }

  if (!isCustomSandboxTarget && process.platform === 'win32') {
    stopRunningDaemonProcesses();
  }

  fs.rmSync(targetCore, { recursive: true, force: true });
  copyDirRecursive(restoreSource, targetCore);

  // 重启守护进程并立即执行一次 --once 重新注入（沙箱 --target-dir 隔离模式下跳过全局服务干预）
  const cliChannel = getArg('--channel', null);
  const realDaemon = path.join(targetCore, 'daemon.mjs');
  const wrapperDaemon = path.join(os.homedir(), '.gemini', 'antigravity', 'scripts', 'antigravity-font-daemon.mjs');
  if (!isCustomSandboxTarget) {
    if (process.platform === 'darwin') {
      const uid = process.getuid ? process.getuid() : 501;
      try {
        execSync(
          `launchctl kickstart -k gui/${uid}/com.antigravity.customfont 2>/dev/null || launchctl kickstart -k gui/${uid}/com.antigravity.theme 2>/dev/null || true`,
          { stdio: 'ignore' }
        );
      } catch {}
    } else if (process.platform === 'linux') {
      try {
        execSync(
          '(systemctl --user reset-failed antigravity-theme.service 2>/dev/null || true) && systemctl --user restart antigravity-theme.service 2>/dev/null || true',
          { stdio: 'ignore' }
        );
      } catch {}
    } else if (process.platform === 'win32') {
      let restartedViaTask = false;
      try {
        const r = spawnSync('schtasks', ['/Run', '/TN', 'AntigravityThemeDaemon'], {
          stdio: 'ignore',
          windowsHide: true
        });
        restartedViaTask = r.status === 0;
      } catch {}
      if (!restartedViaTask) {
        try {
          const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fs.existsSync(wrapperDaemon) ? wrapperDaemon : realDaemon], {
            cwd: os.homedir(),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.unref();
        } catch {}
      }
    }
    const onceArgs = ['--disable-warning=ExperimentalWarning', realDaemon, '--once'];
    if (cliChannel === 'stable' || cliChannel === 'insiders' || cliChannel === 'auto') {
      onceArgs.push('--channel', cliChannel);
    }
    const onceRes = spawnSync(process.execPath, onceArgs, {
      encoding: 'utf8',
      windowsHide: true
    });
    if (onceRes.stdout) process.stderr.write(onceRes.stdout);
    if (onceRes.stderr) process.stderr.write(onceRes.stderr);
  }

  const env = await detectEnvironment(readTargetConfiguredChannel(targetDir));
  const live = isCustomSandboxTarget
    ? { skipped: true, reason: 'custom-target-dir' }
    : await inspectLiveWindow(env, 9222, readTargetAllowedOrigins(targetDir));
  console.log(
    JSON.stringify(
      {
        ok: true,
        restoredFrom: restoreSource,
        restoredTo: targetCore,
        live
      },
      null,
      2
    )
  );
}

// ============================================================================
// 2.6 更新缓存诊断、双源清单探测与事务性自举升级 (upgrade)
// ============================================================================
function getUpdateCheckCachePath(targetDir) {
  return path.join(targetDir, '.cache', 'update-check.json');
}

function readUpdateCheckCache(targetDir) {
  const p = getUpdateCheckCachePath(targetDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeUpdateCheckCache(targetDir, data) {
  const cachePath = getUpdateCheckCachePath(targetDir);
  const cacheDir = path.dirname(cachePath);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, cachePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function readInstalledCoreManifest(targetDir) {
  const mp = path.join(targetDir, 'core', 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  try {
    return JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function isUpdateAvailableVersion(currentVer, candidateVer) {
  const curTuple = extractBaseSemverTuple(currentVer);
  const candTuple = extractBaseSemverTuple(candidateVer);
  if (!curTuple || !candTuple) {
    return Boolean(candidateVer && currentVer && String(candidateVer).replace(/^v/i, '') !== String(currentVer).replace(/^v/i, ''));
  }
  return compareSemverTuples(candTuple, curTuple) > 0;
}

function buildDoctorUpdateSection(targetDir, env = null) {
  const manifest = readInstalledCoreManifest(targetDir);
  const current = manifest?.version ? String(manifest.version) : null;
  let updateCheckEnabled = true;
  const userCfgPath = path.join(targetDir, 'user', 'config.json');
  if (fs.existsSync(userCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(userCfgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (cfg?.modules && typeof cfg.modules.updateCheck === 'boolean') {
        updateCheckEnabled = cfg.modules.updateCheck;
      }
    } catch {}
  }
  const cache = readUpdateCheckCache(targetDir);
  const latest = cache?.latestVersion ? String(cache.latestVersion) : null;
  const dismissedVersion = cache?.dismissedVersion ? String(cache.dismissedVersion) : null;
  const minAntigravityVersion =
    typeof cache?.minAntigravityVersion === 'string' && cache.minAntigravityVersion.trim()
      ? cache.minAntigravityVersion.trim()
      : null;
  const minNodeVersion =
    typeof cache?.minNodeVersion === 'string' && cache.minNodeVersion.trim() ? cache.minNodeVersion.trim() : null;
  const hostAppVersion = env?.appVersion || cache?.hostAppVersion || null;
  const newer = Boolean(latest && current && isUpdateAvailableVersion(current, latest));
  const hostCompatible = !minAntigravityVersion || !hostAppVersion || semverSatisfiesMin(hostAppVersion, minAntigravityVersion);
  const nodeCompatible = !minNodeVersion || semverSatisfiesMin(process.versions.node, minNodeVersion);
  const available = Boolean(newer && hostCompatible && nodeCompatible);
  const dismissed = Boolean(available && dismissedVersion && dismissedVersion === latest);
  const rawUpgradeErr =
    typeof cache?.upgradeError === 'string' && cache.upgradeError.trim() ? cache.upgradeError.trim() : null;
  const rawUpgradeFailedVer =
    typeof cache?.upgradeFailedVersion === 'string' && cache.upgradeFailedVersion.trim()
      ? cache.upgradeFailedVersion.trim().replace(/^v/i, '')
      : null;
  const upgradeError =
    available && rawUpgradeErr && (!rawUpgradeFailedVer || rawUpgradeFailedVer === latest) ? rawUpgradeErr : null;
  return {
    enabled: updateCheckEnabled,
    current,
    latest,
    available,
    incompatibleHost: Boolean(newer && !hostCompatible),
    incompatibleNode: Boolean(newer && !nodeCompatible),
    minAntigravityVersion,
    minNodeVersion,
    hostAppVersion,
    dismissed,
    upgradeError,
    checkedAt: cache?.checkedAt || null,
    source: cache?.source || null,
    releaseUrl: cache?.releaseUrl || GITHUB_RELEASES_LATEST_URL,
    upgradeCommand: `node ${JSON.stringify(path.join(targetDir, 'install.mjs'))} upgrade`
  };
}

function hasProcessProxyEnv() {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
  );
}

function parseWindowsProxyFromRegStdout(out) {
  const text = String(out || '');
  if (!text) return null;
  const enabledMatch = text.match(/ProxyEnable[ \t]+REG_DWORD[ \t]+0x([0-9a-f]+)/i);
  if (!enabledMatch || parseInt(enabledMatch[1], 16) !== 1) return null;
  const serverMatch = text.match(/ProxyServer[ \t]+REG_SZ[ \t]*([^\r\n]*)/i);
  if (!serverMatch) return null;
  const parsed = parseProxyServerSpec(serverMatch[1]);
  return parsed ? parsed.httpsProxy || parsed.httpProxy || null : null;
}

function execFileAsync(bin, cmdArgs, { timeoutMs = 8000, maxBuffer = 512 * 1024, signal = null } = {}) {
  return new Promise((resolve) => {
    const opts = { encoding: 'utf8', windowsHide: true, maxBuffer, timeout: timeoutMs };
    if (signal) opts.signal = signal;
    execFile(bin, cmdArgs, opts, (err, stdout) => {
      const aborted = Boolean(
        signal?.aborted || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))
      );
      const code = err ? (typeof err.code === 'number' ? err.code : String(err.code || 'ERR')) : 0;
      if (err) resolve({ ok: false, aborted, code, error: err.message || String(err), stdout: String(stdout || '') });
      else resolve({ ok: true, aborted: false, code: 0, error: '', stdout: String(stdout || '') });
    });
  });
}

async function detectWindowsSystemProxyAsync() {
  if (process.platform !== 'win32') return null;
  if (_cachedWinSystemProxy !== undefined) return _cachedWinSystemProxy;
  if (hasProcessProxyEnv()) return null;
  _cachedWinSystemProxy = null;
  try {
    const r = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { timeoutMs: 3000 }
    );
    if (r.ok && r.stdout) {
      _cachedWinSystemProxy = parseWindowsProxyFromRegStdout(r.stdout);
    }
  } catch {
    _cachedWinSystemProxy = null;
  }
  return _cachedWinSystemProxy;
}

async function resolveUpdateCurlProxyAsync() {
  const hasEnvProxy = hasProcessProxyEnv();
  const winProxy = hasEnvProxy ? null : await detectWindowsSystemProxyAsync();
  return {
    proxyUrl: winProxy || '',
    hasEnvProxy,
    hasEffectiveProxy: Boolean(hasEnvProxy || winProxy)
  };
}

function combineAbortSignals(timeoutMs, externalSignal = null) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

function firstTruthyAsync(promises) {
  if (!Array.isArray(promises) || promises.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remaining = promises.length;
    let settled = false;
    for (const p of promises) {
      Promise.resolve(p).then(
        (val) => {
          if (settled) return;
          if (val) {
            settled = true;
            resolve(val);
            return;
          }
          remaining -= 1;
          if (remaining <= 0) {
            settled = true;
            resolve(null);
          }
        },
        () => {
          if (settled) return;
          remaining -= 1;
          if (remaining <= 0) {
            settled = true;
            resolve(null);
          }
        }
      );
    }
  });
}

async function fetchTextWithProxyFallback(
  urlStr,
  { timeoutSec = 8, maxBytes = 256 * 1024, signal = null, proxyInfo = null } = {}
) {
  if (signal?.aborted) return { ok: false, aborted: true, error: 'aborted' };
  const isLoopback = isLoopbackHttpUrl(urlStr);
  const resolvedProxy = isLoopback ? { proxyUrl: '', hasEnvProxy: false, hasEffectiveProxy: false } : proxyInfo || (await resolveUpdateCurlProxyAsync());
  if (signal?.aborted) return { ok: false, aborted: true, error: 'aborted' };

  let curlCode = null;
  let curlErrorMsg = '';
  try {
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const curlArgs = ['-fsSL', '--connect-timeout', '5', '--max-time', String(timeoutSec), '--max-filesize', String(maxBytes)];
    if (isLoopback) curlArgs.push('--noproxy', '*');
    else if (resolvedProxy.proxyUrl) curlArgs.push('--proxy', resolvedProxy.proxyUrl);
    curlArgs.push(urlStr);
    const cr = await execFileAsync(curlBin, curlArgs, {
      timeoutMs: (timeoutSec + 3) * 1000,
      maxBuffer: maxBytes + 64 * 1024,
      signal
    });
    if (cr.ok && typeof cr.stdout === 'string' && cr.stdout.trim()) {
      return { ok: true, text: cr.stdout, method: resolvedProxy.proxyUrl ? 'curl(win-system-proxy)' : 'curl' };
    }
    if (cr.aborted || signal?.aborted) {
      return { ok: false, aborted: true, error: 'aborted' };
    }
    if (cr.code === 22) {
      return { ok: false, curlExitCode: 22, error: 'HTTP error (curl status 22)' };
    }
    curlCode = cr.code;
    curlErrorMsg = cr.error || (typeof cr.code === 'number' ? `curl failed with exit code ${cr.code}` : String(cr.code));
  } catch (e) {
    curlCode = e?.code || 'ERR';
    curlErrorMsg = String(e?.message || e);
  }

  if (!isLoopback && resolvedProxy.hasEffectiveProxy && curlCode !== 'ENOENT') {
    return { ok: false, error: curlErrorMsg || `curl failed with exit code ${curlCode}` };
  }

  try {
    const res = await fetch(urlStr, {
      redirect: 'follow',
      signal: combineAbortSignals(timeoutSec * 1000, signal),
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    });
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, error: 'response_too_large' };
    }
    return { ok: true, text, method: 'node-fetch' };
  } catch (err) {
    const aborted = Boolean(signal?.aborted || err?.name === 'AbortError');
    return { ok: false, ...(aborted ? { aborted: true } : {}), error: String(err?.message || err) };
  }
}

async function resolveGithubLatestTagFallback({ timeoutSec = 8, signal = null, proxyInfo = null } = {}) {
  if (signal?.aborted) return { ok: false, aborted: true, error: 'aborted' };
  const resolvedProxy = proxyInfo || (await resolveUpdateCurlProxyAsync());
  if (signal?.aborted) return { ok: false, aborted: true, error: 'aborted' };

  let headerTarget = '';
  let curlCode = null;
  try {
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const curlArgs = ['-sSI', '--connect-timeout', '5', '--max-time', String(timeoutSec)];
    if (resolvedProxy.proxyUrl) curlArgs.push('--proxy', resolvedProxy.proxyUrl);
    curlArgs.push(GITHUB_RELEASES_LATEST_URL);
    const cr = await execFileAsync(curlBin, curlArgs, {
      timeoutMs: (timeoutSec + 3) * 1000,
      signal
    });
    if (cr.aborted || signal?.aborted) {
      return { ok: false, aborted: true, error: 'aborted' };
    }
    if (cr.ok && cr.stdout) {
      headerTarget = String(cr.stdout);
    }
    curlCode = cr.code;
  } catch (e) {
    curlCode = e?.code || 'ERR';
  }

  let match = String(headerTarget).match(/\/releases\/tag\/(v?\d+\.\d+\.\d+)/i);
  if (!match && (!resolvedProxy.hasEffectiveProxy || curlCode === 'ENOENT')) {
    try {
      const res = await fetch(GITHUB_RELEASES_LATEST_URL, {
        method: 'GET',
        redirect: 'manual',
        signal: combineAbortSignals(timeoutSec * 1000, signal)
      });
      headerTarget = res.headers?.get?.('location') || res.url || '';
      match = String(headerTarget).match(/\/releases\/tag\/(v?\d+\.\d+\.\d+)/i);
    } catch {}
  }

  if (!match) {
    return { ok: false, error: `Unable to resolve GitHub latest tag from ${GITHUB_RELEASES_LATEST_URL}` };
  }
  const tag = match[1].startsWith('v') ? match[1] : `v${match[1]}`;
  const cleanVer = tag.replace(/^v/i, '');
  return {
    ok: true,
    source: 'github-releases-redirect',
    manifest: {
      schemaVersion: 1,
      name: 'chuanban-antigravity-theme-patch',
      channel: 'stable',
      version: cleanVer,
      releasedAt: null,
      minNodeVersion: '22.0.0',
      changelog: [],
      coreUpdateBundle: {
        filename: `core-update-v${cleanVer}.zip`,
        sha256: null,
        mirrors: [
          { id: 'github-release', url: `${GITHUB_REPO_URL}/releases/download/${tag}/core-update-v${cleanVer}.zip` },
          { id: 'github-release-full', url: `${GITHUB_REPO_URL}/releases/download/${tag}/chuanban-antigravity-theme-patch-v${cleanVer}.zip` },
          { id: 'cloudflare-r2', url: `${R2_UPDATE_BASE_URL}/core-update-v${cleanVer}.zip` }
        ]
      },
      fullReleaseUrl: `${GITHUB_REPO_URL}/releases/tag/${tag}`
    }
  };
}

async function fetchRemoteUpdateMetadata({ manifestUrlOverride = null, requestedVersion = null, preferredMirror = null } = {}) {
  const allowLoopbackOrigin = manifestUrlOverride && isLoopbackHttpUrl(manifestUrlOverride) ? new URL(manifestUrlOverride).origin : null;

  let cleanRequestedVersion = null;
  if (requestedVersion) {
    const m = String(requestedVersion).trim().match(/^v?(\d+\.\d+\.\d+)$/);
    if (!m) {
      return { ok: false, error: `Invalid --version "${requestedVersion}". Expected format like 6.0.7 or v6.0.7.` };
    }
    const cleanVer = m[1];
    cleanRequestedVersion = cleanVer;
    const tag = `v${cleanVer}`;
    if (!manifestUrlOverride) {
      return {
        ok: true,
        allowLoopbackOrigin: null,
        source: 'explicit-version-tag',
        manifest: {
          schemaVersion: 1,
          name: 'chuanban-antigravity-theme-patch',
          channel: 'stable',
          version: cleanVer,
          minNodeVersion: '22.0.0',
          changelog: [],
          coreUpdateBundle: {
            filename: `core-update-v${cleanVer}.zip`,
            sha256: null,
            mirrors: [
              { id: 'cloudflare-r2', url: `${R2_UPDATE_BASE_URL}/core-update-v${cleanVer}.zip` },
              { id: 'github-release', url: `${GITHUB_REPO_URL}/releases/download/${tag}/core-update-v${cleanVer}.zip` },
              { id: 'github-release-full', url: `${GITHUB_REPO_URL}/releases/download/${tag}/chuanban-antigravity-theme-patch-v${cleanVer}.zip` }
            ]
          },
          fullReleaseUrl: `${GITHUB_REPO_URL}/releases/tag/${tag}`
        }
      };
    }
  }

  const candidateMirrors = manifestUrlOverride
    ? [{ id: 'custom-manifest', url: manifestUrlOverride }]
    : resolveAssetMirrors({ mirrors: UPDATE_MANIFEST_MIRRORS, url: UPDATE_MANIFEST_MIRRORS[0].url }, { preferredMirror });

  const errors = [];
  if (manifestUrlOverride) {
    const m = candidateMirrors[0];
    if (!isAllowedUpdateUrl(m.url, { allowLoopbackOrigin })) {
      errors.push({ mirror: m.id, url: m.url, error: 'blocked_untrusted_manifest_url' });
      return { ok: false, errors, error: 'Failed to fetch update manifest from custom URL' };
    }
    const res = await fetchTextWithProxyFallback(m.url, { timeoutSec: 6, maxBytes: 256 * 1024 });
    if (!res.ok) {
      errors.push({ mirror: m.id, url: m.url, error: res.error || `HTTP ${res.httpStatus || 0}` });
      return { ok: false, errors, error: 'Failed to fetch update manifest from custom URL' };
    }
    try {
      const parsed = JSON.parse(String(res.text).replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.coreUpdateBundle) {
        if (cleanRequestedVersion) {
          const remoteVer = String(parsed.version).trim().replace(/^v/i, '');
          if (remoteVer !== cleanRequestedVersion) {
            const mismatchErr = `Requested version ${cleanRequestedVersion} does not match manifest version ${remoteVer}`;
            errors.push({ mirror: m.id, url: m.url, error: mismatchErr });
            return { ok: false, errors, error: mismatchErr };
          }
        }
        return { ok: true, allowLoopbackOrigin, source: m.id, manifest: parsed, errors };
      }
      errors.push({ mirror: m.id, url: m.url, error: 'invalid_manifest_schema' });
    } catch (parseErr) {
      errors.push({ mirror: m.id, url: m.url, error: `invalid_json: ${parseErr?.message || parseErr}` });
    }
    return { ok: false, errors, error: 'Failed to parse custom update manifest' };
  }

  const proxyInfo = await resolveUpdateCurlProxyAsync();
  const ac = new AbortController();
  const probeManifestMirror = async (m) => {
    if (!isAllowedUpdateUrl(m.url, { allowLoopbackOrigin })) {
      errors.push({ mirror: m.id, url: m.url, error: 'blocked_untrusted_manifest_url' });
      return null;
    }
    const res = await fetchTextWithProxyFallback(m.url, {
      timeoutSec: 6,
      maxBytes: 256 * 1024,
      signal: ac.signal,
      proxyInfo
    });
    if (!res.ok) {
      if (!res.aborted) {
        errors.push({ mirror: m.id, url: m.url, error: res.error || `HTTP ${res.httpStatus || 0}` });
      }
      return null;
    }
    try {
      const parsed = JSON.parse(String(res.text).replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.coreUpdateBundle) {
        return { ok: true, allowLoopbackOrigin, source: m.id, manifest: parsed };
      }
      errors.push({ mirror: m.id, url: m.url, error: 'invalid_manifest_schema' });
    } catch (parseErr) {
      errors.push({ mirror: m.id, url: m.url, error: `invalid_json: ${parseErr?.message || parseErr}` });
    }
    return null;
  };

  try {
    const manifestPromises = candidateMirrors.map((m) => probeManifestMirror(m));
    const ghRedirectPromise = resolveGithubLatestTagFallback({
      timeoutSec: 6,
      signal: ac.signal,
      proxyInfo
    }).catch(() => null);

    const winner = await firstTruthyAsync(manifestPromises);
    if (winner) {
      ac.abort();
      return { ...winner, errors };
    }

    const ghFallback = await ghRedirectPromise;
    if (ghFallback && ghFallback.ok) {
      return {
        ok: true,
        allowLoopbackOrigin: null,
        source: ghFallback.source,
        manifest: ghFallback.manifest,
        errors
      };
    }
    if (ghFallback && ghFallback.error && !ghFallback.aborted) {
      errors.push({ mirror: 'github-releases-redirect', error: ghFallback.error });
    }
    return { ok: false, errors, error: 'Failed to fetch update manifest from all official sources' };
  } finally {
    ac.abort();
  }
}

function inspectZipEntriesSafe(zipPath) {
  if (process.platform === 'win32') {
    const cfgTmp = path.join(os.tmpdir(), `ag-ziplist-cfg-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(cfgTmp, JSON.stringify({ zip: path.resolve(zipPath) }), 'utf8');
      const psScript = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$cfg = Get-Content -LiteralPath '${cfgTmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
        '$zr = [System.IO.Compression.ZipFile]::OpenRead([string]$cfg.zip)',
        '$names = New-Object System.Collections.Generic.List[string]',
        'try { foreach ($e in $zr.Entries) { $names.Add([string]$e.FullName) } } finally { $zr.Dispose() }',
        '$names | ConvertTo-Json -Compress'
      ].join('\n');
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 5 * 1024 * 1024
      });
      if (r.status !== 0) return { ok: false, reason: 'zip_open_failed', error: (r.stderr || r.stdout || '').trim().slice(0, 240) };
      const parsed = JSON.parse(String(r.stdout || '[]').trim() || '[]');
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const norm = String(entry || '');
        if (!norm || norm.includes('\0') || norm.startsWith('/') || norm.startsWith('\\') || /^[a-zA-Z]:/.test(norm)) {
          return { ok: false, reason: 'unsafe_zip_entry_path', entry: norm };
        }
        const parts = norm.split(/[\\/]+/);
        if (parts.some((p) => p === '..')) {
          return { ok: false, reason: 'zip_slip_traversal_detected', entry: norm };
        }
      }
      return { ok: true, count: entries.length };
    } catch (err) {
      return { ok: false, reason: 'zip_inspect_error', error: String(err?.message || err) };
    } finally {
      try {
        if (fs.existsSync(cfgTmp)) fs.unlinkSync(cfgTmp);
      } catch {}
    }
  }

  const r = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, reason: 'zip_list_failed', error: (r.stderr || '').trim().slice(0, 240) };
  const entries = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('\0') || entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
      return { ok: false, reason: 'unsafe_zip_entry_path', entry };
    }
    const parts = entry.split(/[\\/]+/);
    if (parts.some((p) => p === '..')) {
      return { ok: false, reason: 'zip_slip_traversal_detected', entry };
    }
  }
  const zList = spawnSync('unzip', ['-Z', zipPath], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (zList.status === 0 && typeof zList.stdout === 'string') {
    if (/^l[rwxstST-]{9}\s/m.test(zList.stdout)) {
      return { ok: false, reason: 'symlink_entry_in_zip' };
    }
  }
  return { ok: true, count: entries.length };
}

function inspectExtractedTreeSafe(rootDir) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        return { ok: false, reason: 'symlink_detected_in_archive', entry: path.relative(rootDir, full) };
      }
      if (st.isDirectory()) {
        const sub = walk(full);
        if (!sub.ok) return sub;
      }
    }
    return { ok: true };
  };
  try {
    if (!fs.existsSync(rootDir)) return { ok: false, reason: 'extracted_dir_missing' };
    return walk(rootDir);
  } catch (err) {
    return { ok: false, reason: 'extracted_tree_scan_error', error: String(err?.message || err) };
  }
}

function locateStagedBundleRoot(unpackedDir) {
  const isRoot = (dir) =>
    fs.existsSync(path.join(dir, 'install.mjs')) &&
    fs.existsSync(path.join(dir, 'core', 'manifest.json')) &&
    fs.existsSync(path.join(dir, 'core', 'daemon.mjs'));
  if (isRoot(unpackedDir)) return unpackedDir;
  for (const child of fs.readdirSync(unpackedDir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(unpackedDir, child.name);
    if (isRoot(candidate)) return candidate;
  }
  return null;
}

function semverSatisfiesMin(currentVer, minVer) {
  const cur = extractBaseSemverTuple(currentVer);
  const min = extractBaseSemverTuple(minVer);
  if (!cur || !min) return true;
  return compareSemverTuples(cur, min) >= 0;
}

function isUpgradeLockPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  let exists = false;
  try {
    process.kill(pid, 0);
    exists = true;
  } catch (err) {
    if (err && err.code === 'EPERM') exists = true;
  }
  if (!exists) return false;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000
      });
      if (r.status === 0) {
        return String(r.stdout || '').toLowerCase().includes('node.exe');
      }
    } catch {}
  }
  return true;
}

function acquireUpgradeLock(targetDir) {
  const cacheDir = path.join(targetDir, '.cache');
  const lockPath = path.join(cacheDir, 'upgrade.lock');
  fs.mkdirSync(cacheDir, { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, payload, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (!fs.existsSync(lockPath)) return;
          const raw = fs.readFileSync(lockPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Number(parsed?.pid) === process.pid) {
            fs.unlinkSync(lockPath);
          }
        } catch {}
      };
      return { ok: true, lockPath, release };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        return { ok: false, error: `Failed to acquire upgrade lock: ${err?.message || err}` };
      }
      let holderPid = 0;
      let holderStartedAt = null;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        try {
          const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          holderPid = Number(parsed?.pid) || 0;
          holderStartedAt = typeof parsed?.startedAt === 'string' ? parsed.startedAt : null;
        } catch {
          holderPid = 0;
        }
        if (holderPid > 0) {
          const alive = isUpgradeLockPidAlive(holderPid);
          stale = !alive || ageMs > 15 * 60 * 1000;
        } else {
          stale = ageMs > 10000;
        }
      } catch {
        stale = true;
      }
      if (!stale || attempt > 0) {
        return {
          ok: false,
          pid: holderPid || null,
          startedAt: holderStartedAt,
          error: holderPid
            ? `Another upgrade process is already running (PID ${holderPid})`
            : 'Another upgrade process is already running'
        };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
  return { ok: false, error: 'Another upgrade process is already running' };
}

function isActiveUpgradeLockHeld(targetDir) {
  try {
    const lockPath = path.join(targetDir, '.cache', 'upgrade.lock');
    if (!fs.existsSync(lockPath)) return false;
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > 15 * 60 * 1000) return false;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const holderPid = Number(parsed?.pid) || 0;
    return holderPid > 0 && isUpgradeLockPidAlive(holderPid);
  } catch {
    return false;
  }
}

function readTargetConfiguredChannel(targetDir) {
  const cliCh = getArg('--channel', null);
  if (cliCh === 'stable' || cliCh === 'insiders' || cliCh === 'auto') return cliCh;
  const cfgPath = path.join(targetDir, 'user', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed?.channel === 'stable' || parsed?.channel === 'insiders') {
        return parsed.channel;
      }
    } catch {}
  }
  return 'auto';
}

function readTargetPatchEnabled(targetDir) {
  const cfgPath = path.join(targetDir, 'user', 'config.json');
  if (!fs.existsSync(cfgPath)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed.enabled !== false;
    }
  } catch {}
  return true;
}

function readTargetAllowedOrigins(targetDir) {
  const cfgPath = path.join(targetDir, 'user', 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && Array.isArray(parsed.allowedOrigins)) {
      return parsed.allowedOrigins.filter((s) => typeof s === 'string' && s);
    }
  } catch {}
  return null;
}

function hasCoreRuntimeBundleChanged(prevManifest, nextManifest) {
  if (!prevManifest || !nextManifest) return true;
  const prevVer = String(prevManifest.version || '').replace(/^v/i, '');
  const nextVer = String(nextManifest.version || '').replace(/^v/i, '');
  if (prevVer !== nextVer) return true;
  for (const name of ['runtime.js', 'theme.css', 'i18n.json']) {
    const prevSha = prevManifest.files?.[name]?.sha256 || '';
    const nextSha = nextManifest.files?.[name]?.sha256 || '';
    if (!prevSha || !nextSha || prevSha !== nextSha) return true;
  }
  return false;
}

function extractHandoffDaemonPatchVersion(handoffStdout) {
  const text = String(handoffStdout || '');
  const injectedMatches = Array.from(text.matchAll(/\[Daemon\] Injected \(([^)\r\n]+)\) into target/g));
  if (injectedMatches.length > 0) {
    const lastVer = injectedMatches[injectedMatches.length - 1][1]?.trim();
    if (lastVer) return lastVer;
  }
  const startedMatches = Array.from(text.matchAll(/\[Antigravity Daemon\] Started \(([^)\r\n]+)\)/g));
  if (startedMatches.length > 0) {
    const lastStarted = startedMatches[startedMatches.length - 1][1]?.trim();
    if (lastStarted) return lastStarted;
  }
  return null;
}

function isSamePatchBuildVersion(actualVer, expectedVer) {
  const a = String(actualVer || '').trim();
  const b = String(expectedVer || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const normalizeChannelTag = (s) => s.replace(/-(?:stable|insiders)-([0-9a-f]{8})(-disabled)?$/i, '-$1$2');
  return normalizeChannelTag(a) === normalizeChannelTag(b);
}

function verifySingleLivePageState(state, { expectedEnabled, expectedVersion, toVersion, preUpgradePatchVersion, stagedRuntimeChanged }) {
  if (!state || typeof state !== 'object') {
    return { ok: false, actualVersion: null, reason: 'missing_page_state' };
  }
  const actualVersion = typeof state.version === 'string' ? state.version.trim() : '';
  if (!actualVersion) {
    return { ok: false, actualVersion: null, reason: 'missing_runtime_version_marker' };
  }

  if (expectedVersion) {
    if (!isSamePatchBuildVersion(actualVersion, expectedVersion)) {
      return { ok: false, actualVersion, reason: 'runtime_version_mismatch' };
    }
  } else {
    const escapedVer = String(toVersion || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasTargetSemver = escapedVer
      ? new RegExp(`(?:^|[^0-9.])v?${escapedVer}(?:$|[^0-9.])`, 'i').test(actualVersion)
      : false;
    if (!hasTargetSemver) {
      return { ok: false, actualVersion, reason: 'runtime_semver_mismatch' };
    }
    if (stagedRuntimeChanged && preUpgradePatchVersion && actualVersion === preUpgradePatchVersion) {
      return { ok: false, actualVersion, reason: 'runtime_version_unchanged' };
    }
    if (expectedEnabled && actualVersion.endsWith('-disabled')) {
      return { ok: false, actualVersion, reason: 'unexpected_disabled_marker' };
    }
    if (!expectedEnabled && !actualVersion.endsWith('-disabled')) {
      return { ok: false, actualVersion, reason: 'missing_disabled_marker' };
    }
  }

  if (expectedEnabled && !state.hasStyle) {
    return { ok: false, actualVersion, reason: 'missing_theme_style_element' };
  }
  if (!expectedEnabled && state.hasStyle) {
    return { ok: false, actualVersion, reason: 'unexpected_style_when_disabled' };
  }
  return { ok: true, actualVersion, reason: null };
}

function verifyPostUpgradeLiveWindow({
  postLiveReport,
  postEnv = null,
  targetDir,
  toVersion,
  handoffStdout = '',
  preUpgradePatchVersion = null,
  stagedRuntimeChanged = false
}) {
  const expectedEnabled = readTargetPatchEnabled(targetDir);
  const handoffPatchVer = extractHandoffDaemonPatchVersion(handoffStdout);
  const expectedVersion = handoffPatchVer
    ? expectedEnabled
      ? handoffPatchVer
      : `${handoffPatchVer}-disabled`
    : null;

  if (!postLiveReport || !postLiveReport.reachable) {
    if (postEnv && Array.isArray(postEnv.runningProcesses) && postEnv.runningProcesses.length === 0) {
      return { ok: true, expectedEnabled, expectedVersion, actualVersion: null, reason: 'host_closed_during_upgrade' };
    }
    return { ok: false, expectedEnabled, expectedVersion, actualVersion: null, reason: 'live_window_unreachable' };
  }
  if (postLiveReport.pages === 0) {
    return { ok: true, expectedEnabled, expectedVersion, actualVersion: null, reason: 'no_workbench_pages' };
  }

  const candidateStates =
    Array.isArray(postLiveReport.hostTargets) && postLiveReport.hostTargets.length > 0
      ? postLiveReport.hostTargets.map((h) => h.state)
      : [postLiveReport.state];

  let lastActualVersion = null;
  for (const st of candidateStates) {
    const check = verifySingleLivePageState(st, {
      expectedEnabled,
      expectedVersion,
      toVersion,
      preUpgradePatchVersion,
      stagedRuntimeChanged
    });
    lastActualVersion = check.actualVersion;
    if (!check.ok) {
      return {
        ok: false,
        expectedEnabled,
        expectedVersion,
        actualVersion: check.actualVersion,
        reason: check.reason
      };
    }
  }
  return {
    ok: true,
    expectedEnabled,
    expectedVersion,
    actualVersion: lastActualVersion,
    reason: null
  };
}

function summarizeHandoffFailure({ handoffRes, postIntegrity, postLiveOk, postLiveCheck }) {
  const rawStderr = String(handoffRes?.stderr || '');
  const errLines = rawStderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[WARN\]/i.test(l));
  const injLine = errLines.find((l) => /\[Daemon\] Injection (?:failed|error)/i.test(l)) || '';
  const strippedInj = injLine
    ? injLine
        .replace(/^\[Daemon\]\s*Injection (?:failed|error)(?:\s+on\s+[^:]+)?:\s*(?:Script Exception:\s*)?/i, '')
        .trim()
    : '';
  const jsErrLine =
    errLines.find(
      (l) =>
        /\b(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|Error):/i.test(l) &&
        !/^\[Daemon\]\s*Injection/i.test(l)
    ) || '';
  const preferredErrLine =
    (strippedInj && !/^(?:evalmachine\.)?<anonymous>:\d+$/.test(strippedInj)
      ? strippedInj
      : jsErrLine || strippedInj) ||
    errLines.find((l) => /^\[ERROR\]/i.test(l)) ||
    jsErrLine ||
    (handoffRes?.status !== 0 && errLines.length > 0 ? errLines[0] : '');
  const cleanDetail = preferredErrLine
    ? preferredErrLine
        .replace(/^\[Daemon\]\s*Injection (?:failed|error)(?:\s+on\s+[^:]+)?:\s*(?:Script Exception:\s*)?/i, '')
        .replace(/^\[ERROR\]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 72)
    : '';

  if (handoffRes?.status !== 0) {
    const exitTag = handoffRes?.signal
      ? `signal ${handoffRes.signal}`
      : typeof handoffRes?.status === 'number'
      ? `exit ${handoffRes.status}`
      : handoffRes?.error?.code
      ? `spawn ${handoffRes.error.code}`
      : 'aborted';
    return `Bootstrap handoff failed (${exitTag})${cleanDetail ? `: ${cleanDetail}` : ''}`.slice(0, 140);
  }
  if (!postIntegrity?.ok) {
    return 'Post-upgrade core SHA-256 verification failed';
  }
  if (!postLiveOk) {
    const reasonTag = postLiveCheck?.reason || 'unverified';
    const prefix = `Post-upgrade live window verification failed (${reasonTag}`;
    if (!cleanDetail) return `${prefix})`.slice(0, 140);
    const budget = Math.max(12, 139 - prefix.length - 2);
    return `${prefix}: ${cleanDetail.slice(0, budget)})`;
  }
  return 'Post-upgrade verification failed';
}

async function runUpgrade() {
  const checkOnly = hasFlag('--check') || hasFlag('--dry-run');
  const force = hasFlag('--force');
  const requestedVersion = getArg('--version', null);
  const preferredMirror = getArg('--mirror', null);
  const manifestUrlOverride = getArg('--manifest-url', null);
  const explicitCliChannel = getArg('--channel', null);
  const defaultTarget = resolveGlobalInstallDir();
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const isCustomSandboxTarget =
    hasFlag('--target-dir') && !isSameTargetPath(targetDir, defaultTarget) && !hasFlag('--register-service');

  const currentManifest = readInstalledCoreManifest(targetDir);
  if (!currentManifest || !currentManifest.version) {
    console.error(`[ERROR] No valid installation found at ${targetDir} (missing core/manifest.json). Run "node install.mjs install" first.`);
    process.exit(1);
  }
  const fromVersion = String(currentManifest.version);
  const preUpgradeManifestPath = path.join(targetDir, 'core', 'manifest.json');
  const preUpgradeManifestSha = fs.existsSync(preUpgradeManifestPath) ? sha256File(preUpgradeManifestPath) : null;
  const existingCache = readUpdateCheckCache(targetDir) || {};

  let lock = null;
  const releaseLockOnce = () => {
    if (lock) lock.release();
  };
  if (!checkOnly) {
    lock = acquireUpgradeLock(targetDir);
    if (!lock.ok) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: 'lock',
            error: lock.error,
            ...(lock.pid ? { holderPid: lock.pid } : {}),
            ...(lock.startedAt ? { holderStartedAt: lock.startedAt } : {})
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    process.once('exit', releaseLockOnce);
  }

  const remote = await fetchRemoteUpdateMetadata({ manifestUrlOverride, requestedVersion, preferredMirror });
  if (!remote.ok || !remote.manifest) {
    releaseLockOnce();
    console.error(JSON.stringify({ ok: false, currentVersion: fromVersion, error: remote.error, errors: remote.errors || [] }, null, 2));
    process.exit(1);
  }

  const remoteManifest = remote.manifest;
  const toVersion = String(remoteManifest.version || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(toVersion)) {
    releaseLockOnce();
    console.error(
      JSON.stringify(
        {
          ok: false,
          step: 'manifest_version',
          currentVersion: fromVersion,
          error: `Invalid remote manifest version "${remoteManifest.version ?? ''}"`
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  const semverNewer = isUpdateAvailableVersion(fromVersion, toVersion);
  const requiredMinAgVersion =
    typeof remoteManifest.minAntigravityVersion === 'string' && remoteManifest.minAntigravityVersion.trim()
      ? remoteManifest.minAntigravityVersion.trim()
      : null;
  const requiredMinNodeVersion =
    typeof remoteManifest.minNodeVersion === 'string' && remoteManifest.minNodeVersion.trim()
      ? remoteManifest.minNodeVersion.trim()
      : '22.0.0';

  const targetChannel = readTargetConfiguredChannel(targetDir);
  const hostEnv = requiredMinAgVersion || !checkOnly ? await detectEnvironment(targetChannel) : null;
  const cachedHostAppVersion =
    typeof existingCache.hostAppVersion === 'string' && existingCache.hostAppVersion.trim()
      ? existingCache.hostAppVersion.trim()
      : null;
  const hostAppVersion = hostEnv?.appVersion || cachedHostAppVersion || null;
  const hostVersionCompatible =
    !requiredMinAgVersion || !hostAppVersion || semverSatisfiesMin(hostAppVersion, requiredMinAgVersion);
  const nodeVersionCompatible = semverSatisfiesMin(process.versions.node, requiredMinNodeVersion);
  const incompatibleHost = Boolean(semverNewer && !hostVersionCompatible);
  const incompatibleNode = Boolean(semverNewer && !nodeVersionCompatible);
  const updateAvailable = Boolean(semverNewer && hostVersionCompatible && nodeVersionCompatible);

  const candidateReleaseUrl = remoteManifest.fullReleaseUrl || `${GITHUB_REPO_URL}/releases/tag/v${toVersion}`;
  const releaseUrl = isAllowedUpdateUrl(candidateReleaseUrl, { allowLoopbackOrigin: remote.allowLoopbackOrigin })
    ? candidateReleaseUrl
    : `${GITHUB_REPO_URL}/releases/tag/v${toVersion}`;

  const preUpgradeCacheSnapshot = {
    checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: remote.source,
    currentVersion: fromVersion,
    latestVersion: toVersion,
    updateAvailable,
    minAntigravityVersion: requiredMinAgVersion,
    minNodeVersion: requiredMinNodeVersion,
    hostAppVersion,
    incompatibleHost,
    incompatibleNode,
    dismissedVersion: checkOnly || !updateAvailable ? null : existingCache.dismissedVersion || null,
    upgradeError: null,
    upgradeFailedVersion: null,
    changelog: Array.isArray(remoteManifest.changelog) ? remoteManifest.changelog : [],
    bundleBytes: Number(remoteManifest.coreUpdateBundle?.bytes || 0) || null,
    releaseUrl
  };

  if (checkOnly) {
    if (!isActiveUpgradeLockHeld(targetDir)) {
      writeUpdateCheckCache(targetDir, preUpgradeCacheSnapshot);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          checkOnly: true,
          targetDir,
          currentVersion: fromVersion,
          latestVersion: toVersion,
          updateAvailable,
          incompatibleHost,
          incompatibleNode,
          hostAppVersion,
          minAntigravityVersion: requiredMinAgVersion,
          minNodeVersion: requiredMinNodeVersion,
          upgraded: false,
          source: remote.source,
          changelog: remoteManifest.changelog || [],
          releaseUrl
        },
        null,
        2
      )
    );
    return;
  }

  if ((semverNewer || requestedVersion || force) && !hostVersionCompatible && !force) {
    writeUpdateCheckCache(targetDir, preUpgradeCacheSnapshot);
    releaseLockOnce();
    console.error(
      JSON.stringify(
        {
          ok: false,
          step: 'antigravity_version',
          currentVersion: fromVersion,
          latestVersion: toVersion,
          hostAppVersion,
          minAntigravityVersion: requiredMinAgVersion,
          error: `Antigravity >= ${requiredMinAgVersion} required for v${toVersion} (current: ${hostAppVersion})`
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  if ((semverNewer || requestedVersion || force) && !nodeVersionCompatible && !force) {
    writeUpdateCheckCache(targetDir, preUpgradeCacheSnapshot);
    releaseLockOnce();
    console.error(
      JSON.stringify(
        {
          ok: false,
          step: 'node_version',
          currentVersion: fromVersion,
          latestVersion: toVersion,
          minNodeVersion: requiredMinNodeVersion,
          error: `Node.js >= ${requiredMinNodeVersion} required for v${toVersion} (current: ${process.versions.node})`
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  if (!updateAvailable && !force && !requestedVersion) {
    writeUpdateCheckCache(targetDir, preUpgradeCacheSnapshot);
    releaseLockOnce();
    console.log(
      JSON.stringify(
        {
          ok: true,
          checkOnly: false,
          targetDir,
          currentVersion: fromVersion,
          latestVersion: toVersion,
          updateAvailable: false,
          hostAppVersion,
          minAntigravityVersion: requiredMinAgVersion,
          upgraded: false,
          source: remote.source,
          changelog: remoteManifest.changelog || [],
          releaseUrl
        },
        null,
        2
      )
    );
    return;
  }

  writeUpdateCheckCache(targetDir, preUpgradeCacheSnapshot);

  const persistUpgradeFailure = (rawReason, overrides = null) => {
    const cleanMsg = String(rawReason || 'Upgrade failed').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Upgrade failed';
    writeUpdateCheckCache(targetDir, {
      ...preUpgradeCacheSnapshot,
      ...(overrides && typeof overrides === 'object' ? overrides : {}),
      upgradeError: cleanMsg,
      upgradeFailedVersion: toVersion
    });
    return cleanMsg;
  };

  const bundleSpec = remoteManifest.coreUpdateBundle || remoteManifest.fullBundle;
  if (!bundleSpec || !Array.isArray(bundleSpec.mirrors) || bundleSpec.mirrors.length === 0) {
    const errMsg = persistUpgradeFailure('Remote manifest has no downloadable update bundle mirrors');
    releaseLockOnce();
    console.error(JSON.stringify({ ok: false, step: 'mirrors', error: errMsg }, null, 2));
    process.exit(1);
  }

  const trustedMirrors = bundleSpec.mirrors.filter((m) =>
    m && m.url && isAllowedUpdateUrl(m.url, { allowLoopbackOrigin: remote.allowLoopbackOrigin })
  );
  if (trustedMirrors.length === 0) {
    const errMsg = persistUpgradeFailure('No trusted update bundle URL matched official domain whitelist');
    releaseLockOnce();
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: errMsg,
          rejectedUrls: bundleSpec.mirrors.map((m) => m?.url).filter(Boolean)
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const rawBundleFilename =
    bundleSpec.filename != null ? String(bundleSpec.filename).trim() : `core-update-v${toVersion}.zip`;
  if (
    !rawBundleFilename ||
    rawBundleFilename.includes('/') ||
    rawBundleFilename.includes('\\') ||
    rawBundleFilename.includes('..') ||
    rawBundleFilename.includes('\0') ||
    path.basename(rawBundleFilename) !== rawBundleFilename ||
    !/^[A-Za-z0-9._-]+$/.test(rawBundleFilename)
  ) {
    const errMsg = persistUpgradeFailure(`Invalid update bundle filename "${rawBundleFilename}"`);
    releaseLockOnce();
    console.error(JSON.stringify({ ok: false, step: 'bundle_filename', error: errMsg }, null, 2));
    process.exit(1);
  }

  const stagingRoot = path.join(targetDir, '.cache', 'staging', `upgrade-v${toVersion}-${process.pid}-${Date.now()}`);
  const unpackedDir = path.join(stagingRoot, 'unpacked');
  const cleanupStaging = () => {
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {}
  };

  const ROOT_DOC_FILES = ['install.mjs', 'SKILL.md', 'README.md', 'CHANGELOG.md'];
  const rootBackupDir = path.join(stagingRoot, 'root-backup');
  let rootBackupRecords = null;
  let handoffStarted = false;
  const snapshotRootFilesBackup = () => {
    fs.mkdirSync(rootBackupDir, { recursive: true });
    rootBackupRecords = ROOT_DOC_FILES.map((name) => {
      const srcPath = path.join(targetDir, name);
      const existed = fs.existsSync(srcPath);
      const backupPath = path.join(rootBackupDir, name);
      if (existed) {
        fs.copyFileSync(srcPath, backupPath);
      }
      return { name, existed, backupPath };
    });
  };
  const restoreRootFilesBackup = () => {
    if (!Array.isArray(rootBackupRecords)) return;
    for (const rec of rootBackupRecords) {
      const destPath = path.join(targetDir, rec.name);
      try {
        if (rec.existed) {
          if (fs.existsSync(rec.backupPath)) {
            fs.copyFileSync(rec.backupPath, destPath);
          }
        } else if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
      } catch {}
    }
  };
  const recoverAfterFailedHandoff = (failReason, { precomputedPostIntegrity = null } = {}) => {
    persistUpgradeFailure(failReason);
    restoreRootFilesBackup();
    let rollbackOk = false;
    const integrityCheck = precomputedPostIntegrity || verifyCoreIntegrity(targetDir);
    const installedAfterFail = readInstalledCoreManifest(targetDir)?.version || null;
    const postFailManifestSha = fs.existsSync(preUpgradeManifestPath) ? sha256File(preUpgradeManifestPath) : null;
    const coreWasModified =
      !integrityCheck.ok ||
      installedAfterFail !== fromVersion ||
      (preUpgradeManifestSha && postFailManifestSha !== preUpgradeManifestSha);
    if (coreWasModified) {
      try {
        const rbTarget = path.join(targetDir, 'install.mjs');
        const rbScript = fs.existsSync(rbTarget) ? rbTarget : __filename;
        const rbArgs = [rbScript, 'rollback', '--target-dir', targetDir];
        if (explicitCliChannel === 'stable' || explicitCliChannel === 'insiders' || explicitCliChannel === 'auto') {
          rbArgs.push('--channel', explicitCliChannel);
        }
        if (!isCustomSandboxTarget) rbArgs.push('--register-service');
        const rbRes = spawnSync(process.execPath, rbArgs, { encoding: 'utf8', windowsHide: true });
        rollbackOk = rbRes.status === 0;
      } catch {}
      persistUpgradeFailure(failReason);
    } else {
      if (!isCustomSandboxTarget && process.platform === 'win32') {
        // Windows 在 handoff 前已停止旧守护进程；若 handoff 在拉起新服务前失败（core 未改动），需确保恢复守护进程运行
        const realDaemon = path.join(targetDir, 'core', 'daemon.mjs');
        const wrapperDaemon = path.join(os.homedir(), '.gemini', 'antigravity', 'scripts', 'antigravity-font-daemon.mjs');
        let started = false;
        try {
          const r = spawnSync('schtasks', ['/Run', '/TN', 'AntigravityThemeDaemon'], {
            stdio: 'ignore',
            windowsHide: true
          });
          started = r.status === 0;
        } catch {}
        if (!started && fs.existsSync(realDaemon)) {
          try {
            const child = spawn(
              process.execPath,
              ['--disable-warning=ExperimentalWarning', fs.existsSync(wrapperDaemon) ? wrapperDaemon : realDaemon],
              { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true }
            );
            child.unref();
          } catch {}
        }
      }
      rollbackOk = true;
    }
    return rollbackOk;
  };

  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    const downloadAssetSpec = {
      id: `core-update-v${toVersion}`,
      filename: rawBundleFilename,
      url: trustedMirrors[0].url,
      mirrors: trustedMirrors,
      kind: 'zip',
      minBytes: 32 * 1024,
      sha256: bundleSpec.sha256 || null,
      timeoutSec: 45
    };

    const dlRes = await downloadFontAsset(downloadAssetSpec, stagingRoot, {
      force: true,
      preferredMirror
    });
    if (!dlRes.ok || !dlRes.filePath) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure('Failed to download verified update package');
      releaseLockOnce();
      console.error(JSON.stringify({ ok: false, step: 'download', error: errMsg, details: dlRes }, null, 2));
      process.exit(1);
    }

    const zipCheck = inspectZipEntriesSafe(dlRes.filePath);
    if (!zipCheck.ok) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(`Archive security check failed: ${zipCheck.reason || 'unsafe_zip'}`);
      releaseLockOnce();
      console.error(JSON.stringify({ ok: false, step: 'zip_security_check', error: errMsg, ...zipCheck }, null, 2));
      process.exit(1);
    }

    const extractRes = extractZipArchive(dlRes.filePath, unpackedDir);
    if (!extractRes.ok) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(`Failed to extract update archive: ${extractRes.error || 'extract_failed'}`);
      releaseLockOnce();
      console.error(JSON.stringify({ ok: false, step: 'extract', error: errMsg, ...extractRes }, null, 2));
      process.exit(1);
    }

    const treeCheck = inspectExtractedTreeSafe(unpackedDir);
    if (!treeCheck.ok) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(`Extracted tree security check failed: ${treeCheck.reason || 'unsafe_tree'}`);
      releaseLockOnce();
      console.error(JSON.stringify({ ok: false, step: 'extracted_tree_security_check', error: errMsg, ...treeCheck }, null, 2));
      process.exit(1);
    }

    const stagedRoot = locateStagedBundleRoot(unpackedDir);
    if (!stagedRoot) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure('Extracted archive does not contain install.mjs + core/');
      releaseLockOnce();
      console.error(JSON.stringify({ ok: false, step: 'locate_bundle', error: errMsg }, null, 2));
      process.exit(1);
    }

    const stagedIntegrity = verifyCoreIntegrity(stagedRoot);
    const stagedManifest = readInstalledCoreManifest(stagedRoot);
    if (!stagedIntegrity.ok || !stagedManifest || stagedManifest.name !== 'chuanban-antigravity-theme-patch') {
      cleanupStaging();
      const errMsg = persistUpgradeFailure('Staged package failed core manifest SHA-256 verification');
      releaseLockOnce();
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: 'staged_integrity',
            error: errMsg,
            stagedIntegrity
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    if (String(stagedManifest.version).replace(/^v/i, '') !== toVersion) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(`Staged version mismatch (expected ${toVersion}, got ${stagedManifest.version})`);
      releaseLockOnce();
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: 'version_mismatch',
            error: errMsg,
            expected: toVersion,
            actual: stagedManifest.version
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    if (!semverSatisfiesMin(process.versions.node, stagedManifest.minNodeVersion || '22.0.0') && !force) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(
        `Node.js >= ${stagedManifest.minNodeVersion} required for v${toVersion} (current: ${process.versions.node})`,
        {
          minNodeVersion: stagedManifest.minNodeVersion,
          incompatibleNode: Boolean(semverNewer),
          updateAvailable: false
        }
      );
      releaseLockOnce();
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: 'node_version',
            error: errMsg
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    const stagedMinAgVersion =
      typeof stagedManifest.minAntigravityVersion === 'string' && stagedManifest.minAntigravityVersion.trim()
        ? stagedManifest.minAntigravityVersion.trim()
        : requiredMinAgVersion;
    if (stagedMinAgVersion && hostAppVersion && !semverSatisfiesMin(hostAppVersion, stagedMinAgVersion) && !force) {
      cleanupStaging();
      const errMsg = persistUpgradeFailure(
        `Antigravity >= ${stagedMinAgVersion} required for v${toVersion} (current: ${hostAppVersion})`,
        {
          minAntigravityVersion: stagedMinAgVersion,
          incompatibleHost: Boolean(semverNewer),
          updateAvailable: false
        }
      );
      releaseLockOnce();
      console.error(
        JSON.stringify(
          {
            ok: false,
            step: 'antigravity_version',
            hostAppVersion,
            minAntigravityVersion: stagedMinAgVersion,
            error: errMsg
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    const stagedRuntimeChanged = hasCoreRuntimeBundleChanged(currentManifest, stagedManifest);
    const targetAllowedOrigins = readTargetAllowedOrigins(targetDir);

    let preUpgradeLiveReachable = false;
    let preUpgradePatchVersion = null;
    if (!isCustomSandboxTarget) {
      const preEnv = hostEnv || (await detectEnvironment(targetChannel));
      const preLive = await inspectLiveWindow(preEnv, 9222, targetAllowedOrigins);
      preUpgradeLiveReachable = Boolean(preLive.reachable);
      preUpgradePatchVersion =
        typeof preLive?.state?.version === 'string' && preLive.state.version.trim()
          ? preLive.state.version.trim()
          : null;
    }

    snapshotRootFilesBackup();
    handoffStarted = true;

    // 仅 Windows 提前停守护进程释放 NTFS 文件锁；macOS(launchd)/Linux(systemd) 由 handoff 落盘后的服务重启原子接管，避免 cgroup/KeepAlive 自杀或并发抢占
    if (!isCustomSandboxTarget && process.platform === 'win32') {
      stopRunningDaemonProcesses();
    }

    // 先写入升级完成态缓存，使 handoff 内的 --once 与新启动守护进程首帧即读到最新状态（失败时自动恢复并附带持久化错误原因）
    const upgradedIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    writeUpdateCheckCache(targetDir, {
      checkedAt: upgradedIso,
      upgradedAt: upgradedIso,
      source: dlRes.mirror || remote.source,
      currentVersion: toVersion,
      latestVersion: toVersion,
      updateAvailable: false,
      minAntigravityVersion: stagedMinAgVersion || null,
      minNodeVersion: stagedManifest.minNodeVersion || requiredMinNodeVersion || null,
      hostAppVersion,
      incompatibleHost: false,
      incompatibleNode: false,
      dismissedVersion: null,
      upgradeError: null,
      upgradeFailedVersion: null,
      changelog: Array.isArray(remoteManifest.changelog) ? remoteManifest.changelog : [],
      bundleBytes: dlRes.bytes,
      releaseUrl
    });

    const targetUserCfgPath = path.join(targetDir, 'user', 'config.json');
    let preHandoffUserCfgRawBuf = null;
    let preHandoffUserCfgJson = null;
    let preHandoffUserCfgHadChannel = false;
    let preHandoffUserCfgChannel = undefined;
    let preHandoffUserCfgInstalledLocale = undefined;
    if (fs.existsSync(targetUserCfgPath)) {
      try {
        preHandoffUserCfgRawBuf = fs.readFileSync(targetUserCfgPath);
        const parsedPreCfg = JSON.parse(preHandoffUserCfgRawBuf.toString('utf8').replace(/^\uFEFF/, ''));
        if (parsedPreCfg && typeof parsedPreCfg === 'object' && !Array.isArray(parsedPreCfg)) {
          preHandoffUserCfgJson = JSON.stringify(parsedPreCfg);
          preHandoffUserCfgHadChannel = Object.prototype.hasOwnProperty.call(parsedPreCfg, 'channel');
          preHandoffUserCfgChannel = parsedPreCfg.channel;
          preHandoffUserCfgInstalledLocale = parsedPreCfg.installedLocale;
        }
      } catch {}
    }

    // Bootstrap Handoff：由暂存区的新版 install.mjs 接管安装事务
    const stagedInstallPath = path.join(stagedRoot, 'install.mjs');
    const hasExplicitChannel =
      explicitCliChannel === 'stable' || explicitCliChannel === 'insiders' || explicitCliChannel === 'auto';
    let stagedSupportsPreserveChannel = false;
    if (hasExplicitChannel) {
      try {
        stagedSupportsPreserveChannel = fs.readFileSync(stagedInstallPath, 'utf8').includes('--preserve-user-channel');
      } catch {}
    }
    const handoffArgs = [stagedInstallPath, 'install', '--target-dir', targetDir];
    if (hasExplicitChannel && stagedSupportsPreserveChannel) {
      handoffArgs.push('--channel', explicitCliChannel, '--preserve-user-channel');
    }
    if (!isCustomSandboxTarget) {
      handoffArgs.push('--register-service');
    }
    const rawHandoffRes = spawnSync(process.execPath, handoffArgs, {
      cwd: stagedRoot,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    let extraOnceStdout = '';
    let extraOnceStderr = '';
    if (
      hasExplicitChannel &&
      !stagedSupportsPreserveChannel &&
      !isCustomSandboxTarget &&
      rawHandoffRes.status === 0
    ) {
      const targetDaemonPath = path.join(targetDir, 'core', 'daemon.mjs');
      if (fs.existsSync(targetDaemonPath)) {
        const extraOnceRes = spawnSync(
          process.execPath,
          ['--disable-warning=ExperimentalWarning', targetDaemonPath, '--once', '--channel', explicitCliChannel],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
        );
        extraOnceStdout = extraOnceRes.stdout || '';
        extraOnceStderr = extraOnceRes.stderr || '';
      }
    }
    const handoffRes = {
      ...rawHandoffRes,
      stdout: `${rawHandoffRes.stdout || ''}${extraOnceStdout ? `\n${extraOnceStdout}` : ''}`,
      stderr: `${rawHandoffRes.stderr || ''}${extraOnceStderr ? `\n${extraOnceStderr}` : ''}`
    };

    if (preHandoffUserCfgJson !== null && fs.existsSync(targetUserCfgPath)) {
      try {
        const postRawBuf = fs.readFileSync(targetUserCfgPath);
        const parsedPostCfg = JSON.parse(postRawBuf.toString('utf8').replace(/^\uFEFF/, ''));
        if (parsedPostCfg && typeof parsedPostCfg === 'object' && !Array.isArray(parsedPostCfg)) {
          let mutatedPost = false;
          if (preHandoffUserCfgInstalledLocale === 'none' && parsedPostCfg.installedLocale !== 'none') {
            parsedPostCfg.installedLocale = 'none';
            mutatedPost = true;
          }
          if (hasExplicitChannel) {
            const desiredChannel = preHandoffUserCfgHadChannel && preHandoffUserCfgChannel ? preHandoffUserCfgChannel : 'auto';
            if (parsedPostCfg.channel !== desiredChannel) {
              if (!preHandoffUserCfgHadChannel) {
                delete parsedPostCfg.channel;
              } else {
                parsedPostCfg.channel = desiredChannel;
              }
              mutatedPost = true;
            }
          }
          if (JSON.stringify(parsedPostCfg) === preHandoffUserCfgJson && preHandoffUserCfgRawBuf) {
            if (!postRawBuf.equals(preHandoffUserCfgRawBuf)) {
              fs.writeFileSync(targetUserCfgPath, preHandoffUserCfgRawBuf);
            }
          } else if (mutatedPost) {
            if (hasExplicitChannel && !preHandoffUserCfgHadChannel) {
              parsedPostCfg.channel = 'auto';
            }
            fs.writeFileSync(targetUserCfgPath, JSON.stringify(parsedPostCfg, null, 2) + '\n', 'utf8');
          }
        }
      } catch {}
    }

    const postIntegrity = verifyCoreIntegrity(targetDir);
    let postLiveOk = true;
    let postLiveReport = null;
    let postLiveCheck = null;
    const handoffCombinedOutput = `${handoffRes.stdout || ''}\n${handoffRes.stderr || ''}`;
    const handoffTouchedLiveTarget =
      /\[Daemon\] (?:Attached (?:target|iframe):|Injected \(|Injection (?:failed|error)\b)/i.test(handoffCombinedOutput);
    if (!isCustomSandboxTarget && (preUpgradeLiveReachable || handoffTouchedLiveTarget)) {
      const hasDeterministicInjectionError = /\[Daemon\] Injection (?:failed|error)/i.test(String(handoffRes.stderr || ''));
      const retryDelaysMs = hasDeterministicInjectionError ? [250] : [250, 350, 500, 700];
      let postEnv = await detectEnvironment(targetChannel);
      postLiveReport = await inspectLiveWindow(postEnv, 9222, targetAllowedOrigins);
      postLiveCheck = verifyPostUpgradeLiveWindow({
        postLiveReport,
        postEnv,
        targetDir,
        toVersion,
        handoffStdout: handoffRes.stdout || '',
        preUpgradePatchVersion,
        stagedRuntimeChanged
      });
      for (const delayMs of retryDelaysMs) {
        if (postLiveCheck.ok) break;
        await new Promise((r) => setTimeout(r, delayMs));
        postEnv = await detectEnvironment(targetChannel);
        postLiveReport = await inspectLiveWindow(postEnv, 9222, targetAllowedOrigins);
        postLiveCheck = verifyPostUpgradeLiveWindow({
          postLiveReport,
          postEnv,
          targetDir,
          toVersion,
          handoffStdout: handoffRes.stdout || '',
          preUpgradePatchVersion,
          stagedRuntimeChanged
        });
      }
      postLiveOk = postLiveCheck.ok;
    }

    if (handoffRes.status !== 0 || !postIntegrity.ok || !postLiveOk) {
      const handoffFailMsg = summarizeHandoffFailure({
        handoffRes,
        postIntegrity,
        postLiveOk,
        postLiveCheck
      });
      // 在触发回滚与服务重启前先将失败摘要落盘，确保接管的守护进程（含 Linux systemctl --user restart）启动即读到错误详情
      const rollbackOk = recoverAfterFailedHandoff(handoffFailMsg, { precomputedPostIntegrity: postIntegrity });
      cleanupStaging();
      releaseLockOnce();
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: handoffFailMsg,
            upgraded: false,
            rolledBack: rollbackOk,
            fromVersion,
            attemptedVersion: toVersion,
            handoffExitCode: handoffRes.status,
            ...(handoffRes.signal ? { handoffSignal: handoffRes.signal } : {}),
            postIntegrity,
            postLiveOk,
            ...(postLiveCheck ? { liveVerification: postLiveCheck } : {}),
            postLiveReport,
            stderr: String(handoffRes.stderr || '').trim().slice(0, 600)
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    cleanupStaging();
    releaseLockOnce();
    console.log(
      JSON.stringify(
        {
          ok: true,
          upgraded: true,
          fromVersion,
          toVersion,
          targetDir,
          mirror: dlRes.mirror || remote.source,
          bundleBytes: dlRes.bytes,
          coreIntegrity: postIntegrity,
          userPreserved: true,
          clientRestarted: false,
          ...(postLiveCheck ? { liveVerification: postLiveCheck } : {}),
          ...(postLiveReport ? { liveWindow: postLiveReport } : {})
        },
        null,
        2
      )
    );
  } catch (err) {
    const rawErrMsg = err?.message || String(err);
    const errMsg = persistUpgradeFailure(rawErrMsg);
    let rolledBack = false;
    if (handoffStarted) {
      rolledBack = recoverAfterFailedHandoff(errMsg);
    } else {
      restoreRootFilesBackup();
    }
    cleanupStaging();
    releaseLockOnce();
    console.error(JSON.stringify({ ok: false, error: errMsg, ...(handoffStarted ? { rolledBack } : {}) }, null, 2));
    process.exit(1);
  }
}

let _cachedWinSystemProxy = undefined;
function detectWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  if (_cachedWinSystemProxy !== undefined) return _cachedWinSystemProxy;
  if (hasProcessProxyEnv()) return null;
  _cachedWinSystemProxy = null;
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    );
    if (r.status !== 0 || !r.stdout) return null;
    _cachedWinSystemProxy = parseWindowsProxyFromRegStdout(r.stdout);
  } catch {
    _cachedWinSystemProxy = null;
  }
  return _cachedWinSystemProxy;
}

function sha256FileChunked(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(256 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function validateDownloadedBinary(filePath, { kind = 'font', minBytes = 1024, sha256 = null } = {}) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'file_missing', bytes: 0 };
    const st = fs.statSync(filePath);
    const bytes = st.size;
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(512, Math.max(0, bytes)));
    try {
      if (head.length > 0) fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const asciiPrefix = head.toString('utf8').trimStart().toLowerCase();
    if (asciiPrefix.startsWith('<!doctype') || asciiPrefix.startsWith('<html') || asciiPrefix.startsWith('<?xml')) {
      const isQuotaExceeded = /quota exceeded|too many users have viewed or downloaded/i.test(asciiPrefix);
      return {
        ok: false,
        reason: isQuotaExceeded ? 'quota_exceeded_html' : 'html_interstitial_or_quota_exceeded',
        bytes,
        circuitBreakMirror: true
      };
    }
    if (bytes < minBytes) {
      return { ok: false, reason: 'file_too_small', bytes, minBytes };
    }
    if (kind === 'zip') {
      const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
      if (!isZip) return { ok: false, reason: 'invalid_zip_magic', bytes };
    } else if (kind === 'font') {
      const tag = head.length >= 4 ? head.subarray(0, 4).toString('ascii') : '';
      const isTtf = head.length >= 4 && head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00;
      const isValidFont = isTtf || tag === 'OTTO' || tag === 'true' || tag === 'ttcf';
      if (!isValidFont) return { ok: false, reason: 'invalid_font_magic', bytes };
    }
    if (sha256) {
      const actualSha = sha256FileChunked(filePath);
      if (actualSha.toLowerCase() !== String(sha256).toLowerCase()) {
        return {
          ok: false,
          reason: 'sha256_mismatch',
          bytes,
          expectedSha256: String(sha256).toLowerCase(),
          actualSha256: actualSha
        };
      }
      return { ok: true, bytes, sha256: actualSha };
    }
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, reason: 'validation_error', error: String(err?.message || err), bytes: 0 };
  }
}

function resolveAssetMirrors(asset, { preferredMirror = null, mirrorOrder = null } = {}) {
  const baseMirrors =
    Array.isArray(asset.mirrors) && asset.mirrors.length > 0
      ? asset.mirrors.map((m) => ({ id: m.id || 'default', url: m.url }))
      : [{ id: 'default', url: asset.url }];

  if (Array.isArray(mirrorOrder) && mirrorOrder.length > 0) {
    const ordered = [];
    const seen = new Set();
    for (const id of mirrorOrder) {
      const found = baseMirrors.find((m) => m.id === id);
      if (found && !seen.has(found.id)) {
        ordered.push(found);
        seen.add(found.id);
      }
    }
    for (const m of baseMirrors) {
      if (!seen.has(m.id)) {
        ordered.push(m);
        seen.add(m.id);
      }
    }
    return ordered;
  }

  if (preferredMirror) {
    const exact = baseMirrors.filter((m) => m.id === preferredMirror);
    if (exact.length > 0) {
      const rest = baseMirrors.filter((m) => m.id !== preferredMirror);
      return [...exact, ...rest];
    }
  }
  return baseMirrors;
}

function shouldCircuitBreakMirror(attempt) {
  if (!attempt) return false;
  if (attempt.circuitBreakMirror) return true;
  if (attempt.reason === 'quota_exceeded_html' || attempt.reason === 'html_interstitial_or_quota_exceeded') return true;
  if (attempt.reason === 'sha256_mismatch') return true;
  const httpStatus = Number(attempt.httpStatus || 0);
  if ([401, 403, 404, 410, 429, 451].includes(httpStatus)) return true;
  const errStr = String(attempt.error || '');
  if (/\b(403|404|410|429)\b/.test(errStr) && /requested URL returned error|status code/i.test(errStr)) return true;
  return false;
}

async function downloadFontAsset(
  asset,
  downloadDir,
  { force = false, preferredMirror = null, mirrorOrder = null } = {}
) {
  const safeFilename = typeof asset?.filename === 'string' ? asset.filename : '';
  if (
    !safeFilename ||
    safeFilename.includes('\0') ||
    safeFilename.includes('..') ||
    safeFilename.includes('/') ||
    safeFilename.includes('\\') ||
    path.basename(safeFilename) !== safeFilename
  ) {
    return {
      ok: false,
      id: asset?.id,
      filename: asset?.filename,
      error: `Unsafe asset filename "${asset?.filename ?? ''}"`,
      attempts: []
    };
  }
  fs.mkdirSync(downloadDir, { recursive: true });
  const finalPath = path.join(downloadDir, safeFilename);
  if (!force && fs.existsSync(finalPath)) {
    const cachedCheck = validateDownloadedBinary(finalPath, asset);
    if (cachedCheck.ok) {
      return {
        ok: true,
        id: asset.id,
        filename: asset.filename,
        filePath: finalPath,
        cached: true,
        bytes: cachedCheck.bytes,
        ...(cachedCheck.sha256 ? { sha256: cachedCheck.sha256 } : {}),
        method: 'cache'
      };
    }
  }

  const partPath = `${finalPath}.part-${process.pid}-${Date.now()}`;
  const cleanupPart = () => {
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {}
  };
  const timeoutSec = asset.timeoutSec || 300;
  const mirrors = resolveAssetMirrors(asset, { preferredMirror, mirrorOrder });
  const attempts = [];

  for (const mirror of mirrors) {
    let mirrorCircuitBroken = false;
    const recordAttemptAndCheckBreak = (entry) => {
      const fullEntry = { mirror: mirror.id, url: mirror.url, ...entry };
      attempts.push(fullEntry);
      if (shouldCircuitBreakMirror(fullEntry)) {
        mirrorCircuitBroken = true;
        process.stderr.write(
          `[Fonts] Mirror "${mirror.id}" rejected ${asset.filename} (${fullEntry.reason || fullEntry.httpStatus || fullEntry.error || 'blocked'}), switching to next mirror...\n`
        );
      }
    };

    const isLoopbackMirror = isLoopbackHttpUrl(mirror.url);
    const hasEnvProxy = isLoopbackMirror ? false : hasProcessProxyEnv();
    const winProxy = isLoopbackMirror || hasEnvProxy ? null : detectWindowsSystemProxy();
    const hasEffectiveProxy = Boolean(!isLoopbackMirror && (hasEnvProxy || winProxy));
    let curlMissing = false;
    let curlFailedOverProxy = false;

    // Strategy 1: curl / curl.exe（跨平台原生支持 HTTP_PROXY/HTTPS_PROXY，Windows 下自动探测系统注册表代理）
    try {
      const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const curlArgs = [
        '-fSL',
        '--retry',
        '1',
        '--retry-delay',
        '2',
        '--connect-timeout',
        '15',
        '--max-time',
        String(timeoutSec)
      ];
      if (isLoopbackMirror) curlArgs.push('--noproxy', '*');
      else if (winProxy) curlArgs.push('--proxy', winProxy);
      curlArgs.push('-o', partPath, mirror.url);
      const r = spawnSync(curlBin, curlArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        windowsHide: true,
        timeout: (timeoutSec + 15) * 1000
      });
      if (r?.error && r.error.code === 'ENOENT') {
        curlMissing = true;
      }
      if (r.status === 0 && !r.error) {
        const chk = validateDownloadedBinary(partPath, asset);
        if (chk.ok) {
          fs.renameSync(partPath, finalPath);
          return {
            ok: true,
            id: asset.id,
            filename: asset.filename,
            filePath: finalPath,
            cached: false,
            bytes: chk.bytes,
            ...(chk.sha256 ? { sha256: chk.sha256 } : {}),
            mirror: mirror.id,
            url: mirror.url,
            method: winProxy ? 'curl(win-system-proxy)' : 'curl',
            ...(attempts.length > 0 ? { failoverAttempts: attempts } : {})
          };
        }
        recordAttemptAndCheckBreak({ method: 'curl', ok: false, ...chk });
      } else {
        if (!curlMissing && r.status !== 0) {
          curlFailedOverProxy = true;
        }
        recordAttemptAndCheckBreak({
          method: 'curl',
          ok: false,
          status: r.status,
          error: String(r.error?.message || r.stderr || '').trim().slice(0, 240)
        });
      }
    } catch (err) {
      if (err?.code === 'ENOENT') curlMissing = true;
      recordAttemptAndCheckBreak({ method: 'curl', ok: false, error: String(err?.message || err).slice(0, 240) });
    }
    cleanupPart();
    if (mirrorCircuitBroken) continue;

    const skipFetchOverProxy = !isLoopbackMirror && hasEffectiveProxy && !curlMissing;
    const skipWinPsOverProxy = skipFetchOverProxy && (hasEnvProxy || curlFailedOverProxy);

    // Strategy 2 (Windows): PowerShell .NET HttpClient（原生继承 WinINET/PAC/系统代理与 TLS 1.2+，流式落盘零高内存）
    if (process.platform === 'win32' && !skipWinPsOverProxy) {
      const cfgTmp = path.join(os.tmpdir(), `ag-dl-cfg-${process.pid}-${Date.now()}.json`);
      try {
        fs.writeFileSync(cfgTmp, JSON.stringify({ url: mirror.url, out: partPath, timeoutSec }), 'utf8');
        const psScript = [
          '$ErrorActionPreference = "Stop"',
          '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
          'Add-Type -AssemblyName System.Net.Http',
          `$cfg = Get-Content -LiteralPath '${cfgTmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
          '$handler = New-Object System.Net.Http.HttpClientHandler',
          '$handler.AllowAutoRedirect = $true',
          '$handler.UseProxy = $true',
          '$client = New-Object System.Net.Http.HttpClient($handler)',
          '$client.Timeout = [TimeSpan]::FromSeconds([int]$cfg.timeoutSec)',
          'try {',
          '  $resp = $client.GetAsync([string]$cfg.url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()',
          '  $resp.EnsureSuccessStatusCode() | Out-Null',
          '  $inStream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()',
          '  $outStream = [System.IO.File]::Create([string]$cfg.out)',
          '  try { $inStream.CopyTo($outStream) } finally { $outStream.Dispose(); $inStream.Dispose() }',
          '} finally { $client.Dispose(); $handler.Dispose() }'
        ].join('\n');
        const r = spawnSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
            encoding: 'utf8',
            windowsHide: true,
            timeout: (timeoutSec + 20) * 1000
          }
        );
        if (r.status === 0 && !r.error) {
          const chk = validateDownloadedBinary(partPath, asset);
          if (chk.ok) {
            fs.renameSync(partPath, finalPath);
            return {
              ok: true,
              id: asset.id,
              filename: asset.filename,
              filePath: finalPath,
              cached: false,
              bytes: chk.bytes,
              ...(chk.sha256 ? { sha256: chk.sha256 } : {}),
              mirror: mirror.id,
              url: mirror.url,
              method: 'powershell-httpclient',
              ...(attempts.length > 0 ? { failoverAttempts: attempts } : {})
            };
          }
          recordAttemptAndCheckBreak({ method: 'powershell-httpclient', ok: false, ...chk });
        } else {
          recordAttemptAndCheckBreak({
            method: 'powershell-httpclient',
            ok: false,
            status: r.status,
            error: String(r.error?.message || r.stderr || '').trim().slice(0, 240)
          });
        }
      } catch (err) {
        recordAttemptAndCheckBreak({
          method: 'powershell-httpclient',
          ok: false,
          error: String(err?.message || err).slice(0, 240)
        });
      } finally {
        try {
          if (fs.existsSync(cfgTmp)) fs.unlinkSync(cfgTmp);
        } catch {}
      }
      cleanupPart();
      if (mirrorCircuitBroken) continue;
    }

    // 显式代理或 Windows 系统代理存在且 curl 可用时，跳过会忽略代理或超时阻塞的 node-fetch，立即切换下一个镜像
    if (skipFetchOverProxy) continue;

    // Strategy 3: Node 22+ 原生 fetch 流式下载兜底
    try {
      const res = await fetch(mirror.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutSec * 1000)
      });
      if (!res.ok || !res.body) {
        recordAttemptAndCheckBreak({ method: 'node-fetch', ok: false, httpStatus: res.status });
      } else {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partPath));
        const chk = validateDownloadedBinary(partPath, asset);
        if (chk.ok) {
          fs.renameSync(partPath, finalPath);
          return {
            ok: true,
            id: asset.id,
            filename: asset.filename,
            filePath: finalPath,
            cached: false,
            bytes: chk.bytes,
            ...(chk.sha256 ? { sha256: chk.sha256 } : {}),
            mirror: mirror.id,
            url: mirror.url,
            method: 'node-fetch',
            ...(attempts.length > 0 ? { failoverAttempts: attempts } : {})
          };
        }
        recordAttemptAndCheckBreak({ method: 'node-fetch', ok: false, ...chk });
      }
    } catch (err) {
      recordAttemptAndCheckBreak({ method: 'node-fetch', ok: false, error: String(err?.message || err).slice(0, 240) });
    }
    cleanupPart();
  }

  return {
    ok: false,
    id: asset.id,
    filename: asset.filename,
    url: mirrors[0]?.url || asset.url,
    mirrors: mirrors.map((m) => ({ id: m.id, url: m.url })),
    manualUrl: asset.viewUrl || mirrors[0]?.url || GOOGLE_DRIVE_URL,
    attempts
  };
}

function extractZipArchive(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const cfgTmp = path.join(os.tmpdir(), `ag-unzip-cfg-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(cfgTmp, JSON.stringify({ zip: path.resolve(zipPath), dest: path.resolve(destDir) }), 'utf8');
      const psUnzip = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$cfg = Get-Content -LiteralPath '${cfgTmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
        '[System.IO.Compression.ZipFile]::ExtractToDirectory([string]$cfg.zip, [string]$cfg.dest)'
      ].join('\n');
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psUnzip],
        { encoding: 'utf8', windowsHide: true, timeout: 120000 }
      );
      if (r.status === 0 && !r.error) return { ok: true, method: 'dotnet-zipfile' };
      return { ok: false, error: String(r.error?.message || r.stderr || 'ZipFile extract failed').trim().slice(0, 240) };
    } finally {
      try {
        if (fs.existsSync(cfgTmp)) fs.unlinkSync(cfgTmp);
      } catch {}
    }
  }

  const uz = spawnSync('unzip', ['-oq', zipPath, '-d', destDir], { encoding: 'utf8', timeout: 120000 });
  if (uz.status === 0 && !uz.error) return { ok: true, method: 'unzip' };
  if (process.platform === 'darwin') {
    const dt = spawnSync('ditto', ['-xk', zipPath, destDir], { encoding: 'utf8', timeout: 120000 });
    if (dt.status === 0 && !dt.error) return { ok: true, method: 'ditto' };
  }
  const py = spawnSync('python3', ['-m', 'zipfile', '-e', zipPath, destDir], { encoding: 'utf8', timeout: 120000 });
  if (py.status === 0 && !py.error) return { ok: true, method: 'python3-zipfile' };
  return {
    ok: false,
    error: String(uz.stderr || py.stderr || uz.error?.message || 'Failed to extract zip archive').trim().slice(0, 240)
  };
}

function selectMissingFontAssets(env, { includeAll = false, useSuperTtc = false, wantSplitSarasa = false } = {}) {
  const assets = [];
  if (includeAll || !env.hasAnthropicSerifFont || !env.hasAnthropicSerifRegular) {
    if (includeAll || !env.hasAnthropicSerifFont || (!env.hasAnthropicSerifRegular && env.hasAnthropicSerifBold)) {
      assets.push(FONT_DOWNLOAD_CATALOG.anthropicSerifRegular);
    }
  }
  if (includeAll || !env.hasAnthropicSerifFont || !env.hasAnthropicSerifBold) {
    if (includeAll || !env.hasAnthropicSerifFont || (env.hasAnthropicSerifRegular && !env.hasAnthropicSerifBold)) {
      assets.push(FONT_DOWNLOAD_CATALOG.anthropicSerifBold);
    }
  }
  if (includeAll || !env.hasAnthropicMonoFont) {
    assets.push(FONT_DOWNLOAD_CATALOG.anthropicMonoRegular);
  }
  const needSarasa = includeAll || !env.hasSarasaFont || (wantSplitSarasa && !env.hasSarasaSplitScTtf);
  if (needSarasa) {
    if (useSuperTtc && process.platform !== 'win32') {
      assets.push(FONT_DOWNLOAD_CATALOG.sarasaSuperTtc);
    } else {
      assets.push(FONT_DOWNLOAD_CATALOG.sarasaSplitScZip);
    }
  }
  return assets;
}

async function downloadFontsBatch({
  downloadDir,
  includeAll = false,
  force = false,
  useSuperTtc = false,
  wantSplitSarasa = false,
  preferredMirror = null,
  mirrorOrder = null
} = {}) {
  const env = await detectEnvironment('auto');
  const assets = selectMissingFontAssets(env, { includeAll, useSuperTtc, wantSplitSarasa });
  const targetDownloadDir = path.resolve(downloadDir || path.join(os.tmpdir(), 'chuanban-ag-fonts-cache'));
  fs.mkdirSync(targetDownloadDir, { recursive: true });
  const results = [];
  for (const asset of assets) {
    process.stderr.write(`[Fonts] Downloading ${asset.filename} ...\n`);
    const r = await downloadFontAsset(asset, targetDownloadDir, { force, preferredMirror, mirrorOrder });
    results.push(r);
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    downloadDir: targetDownloadDir,
    requestedCount: assets.length,
    downloadedCount: results.filter((r) => r.ok && !r.cached).length,
    cachedCount: results.filter((r) => r.ok && r.cached).length,
    failedCount: failed.length,
    results,
    manualFallbackHint:
      failed.length > 0
        ? `Automatic download failed for ${failed.map((f) => f.filename).join(', ')} (likely terminal network/proxy restriction). In Mainland China (no proxy / slow download), open the Feishu domestic mirror page in browser: ${FEISHU_FONT_MIRROR_URL} (landing page: ${FEISHU_LANDING_URL}) and download the font files to one folder; or use Cloudflare R2 (${R2_SARASA_SPLIT_URL}), GitHub Release (${GITHUB_SARASA_SPLIT_URL}), or Google Drive (${GOOGLE_DRIVE_URL}). Then run: node install.mjs install-fonts --from "<downloaded-folder-or-zip>"`
        : null
  };
}

function parseMirrorOrderArg() {
  const raw = getArg('--mirror-order', null);
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

async function runDownloadFontsCmd() {
  const downloadDir = getArg('--dir', path.join(os.tmpdir(), 'chuanban-ag-fonts-cache'));
  const includeAll = hasFlag('--all');
  const force = hasFlag('--force');
  const useSuperTtc = hasFlag('--super-ttc');
  const preferredMirror = getArg('--mirror', null);
  const mirrorOrder = parseMirrorOrderArg();
  const summary = await downloadFontsBatch({
    downloadDir,
    includeAll,
    force,
    useSuperTtc,
    preferredMirror,
    mirrorOrder
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

async function runInstallFonts() {
  const autoDownload = hasFlag('--auto-download');
  const fromArg = getArg('--from', null);
  const shouldRetireSuperTtc = process.platform === 'win32' && hasFlag('--retire-super-ttc');

  if (!autoDownload && !fromArg) {
    console.error(
      'Usage:\n  node install.mjs install-fonts --auto-download [--dir <cache-dir>] [--force] [--retire-super-ttc]\n  node install.mjs install-fonts --from <font-folder-or-zip-path> [--retire-super-ttc]'
    );
    process.exit(1);
  }
  if (fromArg && !fs.existsSync(fromArg)) {
    console.error(`[ERROR] --from path does not exist: ${fromArg}`);
    process.exit(1);
  }

  let downloadSummary = null;
  const sourceInputs = [];
  if (fromArg) sourceInputs.push(path.resolve(fromArg));
  if (autoDownload) {
    const preEnv = await detectEnvironment('auto');
    downloadSummary = await downloadFontsBatch({
      downloadDir: getArg('--dir', null),
      includeAll: hasFlag('--all'),
      force: hasFlag('--force'),
      useSuperTtc: hasFlag('--super-ttc'),
      wantSplitSarasa: shouldRetireSuperTtc,
      preferredMirror: getArg('--mirror', null),
      mirrorOrder: parseMirrorOrderArg()
    });
    if (downloadSummary.requestedCount > 0) {
      for (const r of downloadSummary.results) {
        if (r.ok && r.filePath && fs.existsSync(r.filePath)) {
          sourceInputs.push(r.filePath);
        }
      }
    }
    // Windows 下如果已有手动复制但未写注册表的目标用户字体，仅将其精准加入队列补齐注册表（避免误扫整个目录或重新注册已退订的 SuperTTC）
    if (
      process.platform === 'win32' &&
      Array.isArray(preEnv.unregisteredWinFonts) &&
      preEnv.unregisteredWinFonts.length > 0 &&
      preEnv.winUserFontsDir &&
      fs.existsSync(preEnv.winUserFontsDir)
    ) {
      for (const fname of preEnv.unregisteredWinFonts) {
        const fp = path.join(preEnv.winUserFontsDir, fname);
        if (fs.existsSync(fp)) sourceInputs.push(fp);
      }
    }
    if (downloadSummary.requestedCount === 0 && sourceInputs.length === 0) {
      const superTtcRetirement = shouldRetireSuperTtc
        ? retireWindowsSuperTtc({ force: hasFlag('--force') })
        : null;
      const postEnv = await detectEnvironment('auto');
      console.log(
        JSON.stringify(
          {
            ok: true,
            alreadyInstalled: true,
            platform: process.platform,
            downloadSummary,
            ...(superTtcRetirement ? { superTtcRetirement } : {}),
            postCheck: buildFontReport(postEnv)
          },
          null,
          2
        )
      );
      return;
    }
  }

  const home = os.homedir();
  const destDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Fonts')
      : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
      : path.join(home, '.local', 'share', 'fonts');

  fs.mkdirSync(destDir, { recursive: true });
  const installed = [];
  const skippedLocked = [];
  const extractedArchives = [];
  const archiveExtractErrors = [];
  const tempExtractDirs = [];
  const fontFileQueue = [];
  const seenSourceFiles = new Set();

  const collectFontsFromDir = (dir, depth = 0) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === '__MACOSX') continue;
        collectFontsFromDir(full, depth + 1);
      } else if (/\.(ttf|otf|ttc)$/i.test(entry)) {
        const key = canonicalPath(full).toLowerCase();
        if (!seenSourceFiles.has(key)) {
          seenSourceFiles.add(key);
          fontFileQueue.push({ full, entry });
        }
      } else if (depth <= 2 && /\.zip$/i.test(entry) && /sarasa|anthropic|font/i.test(entry)) {
        const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-font-zip-'));
        tempExtractDirs.push(stageDir);
        const ex = extractZipArchive(full, stageDir);
        if (ex.ok) {
          extractedArchives.push({ archive: full, method: ex.method });
          collectFontsFromDir(stageDir, depth + 1);
        } else {
          archiveExtractErrors.push({ archive: full, error: ex.error });
        }
      }
    }
  };

  try {
    for (const src of sourceInputs) {
      const st = fs.statSync(src);
      if (st.isFile()) {
        if (/\.zip$/i.test(src)) {
          const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-font-zip-'));
          tempExtractDirs.push(stageDir);
          const ex = extractZipArchive(src, stageDir);
          if (ex.ok) {
            extractedArchives.push({ archive: src, method: ex.method });
            collectFontsFromDir(stageDir, 0);
          } else {
            archiveExtractErrors.push({ archive: src, error: ex.error });
          }
        } else if (/\.(ttf|otf|ttc)$/i.test(src)) {
          const key = canonicalPath(src).toLowerCase();
          if (!seenSourceFiles.has(key)) {
            seenSourceFiles.add(key);
            fontFileQueue.push({ full: src, entry: path.basename(src) });
          }
        }
      } else if (st.isDirectory()) {
        collectFontsFromDir(src, 0);
      }
    }

    const seenDestPaths = new Set();
    for (const { full, entry } of fontFileQueue) {
      const destPath = path.join(destDir, entry);
      const destKey = canonicalPath(destPath).toLowerCase();
      if (seenDestPaths.has(destKey)) continue;
      seenDestPaths.add(destKey);
      let copied = false;
      if (isSameTargetPath(full, destPath)) {
        skippedLocked.push(destPath);
      } else {
        try {
          fs.copyFileSync(full, destPath);
          copied = true;
        } catch (err) {
          if (
            process.platform === 'win32' &&
            (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') &&
            fs.existsSync(destPath)
          ) {
            skippedLocked.push(destPath);
          } else {
            throw err;
          }
        }
      }
      if (copied) installed.push(destPath);
    }
  } finally {
    for (const d of tempExtractDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }

  const allTargetFontPaths = Array.from(new Set([...installed, ...skippedLocked]));
  let fontBroadcastOk = process.platform !== 'win32';
  let fontRegisteredCount = 0;
  let registryWrittenCount = process.platform === 'win32' ? 0 : allTargetFontPaths.length;
  let registryFailed = [];

  if (process.platform === 'win32' && allTargetFontPaths.length > 0) {
    fontBroadcastOk = false;
    const regItems = allTargetFontPaths.map((destPath) => {
      const entry = path.basename(destPath);
      const ext = path.extname(entry).toLowerCase();
      const typeSuffix = ext === '.otf' ? ' (OpenType)' : ' (TrueType)';
      const title = entry.replace(/\.(ttf|otf|ttc)$/i, '') + typeSuffix;
      return { path: destPath, title };
    });
    const listTmp = path.join(os.tmpdir(), `ag-fonts-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(listTmp, JSON.stringify(regItems), 'utf8');
      // 使用 .NET Microsoft.Win32.Registry UTF-16 原生写入 HKCU\...\Fonts（规避中文用户名下 reg.exe CP936 路径乱码），并合并广播 WM_FONTCHANGE
      const psNotify = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$ErrorActionPreference = "Stop"',
        'Add-Type -TypeDefinition @"',
        'using System; using System.Runtime.InteropServices;',
        'public static class AgFontBroadcast {',
        '  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern int AddFontResource(string lpFileName);',
        '  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool SendNotifyMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
        '}',
        '"@',
        `$parsed = Get-Content -LiteralPath '${listTmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
        '$items = @($parsed)',
        '$regOk = 0',
        '$regFailed = New-Object System.Collections.Generic.List[string]',
        '$sk = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts")',
        'if ($null -ne $sk) {',
        '  try {',
        '    foreach ($it in $items) {',
        '      if ($null -eq $it -or -not $it.path -or -not $it.title) { continue }',
        '      try {',
        '        $sk.SetValue([string]$it.title, [string]$it.path, [Microsoft.Win32.RegistryValueKind]::String)',
        '        $regOk++',
        '      } catch { $regFailed.Add([string]$it.title) }',
        '    }',
        '  } finally { $sk.Dispose() }',
        '} else {',
        '  foreach ($it in $items) { if ($it.title) { $regFailed.Add([string]$it.title) } }',
        '}',
        '$added = 0',
        'foreach ($it in $items) { if ($it -and $it.path -and ([AgFontBroadcast]::AddFontResource([string]$it.path) -gt 0)) { $added++ } }',
        '$notified = [AgFontBroadcast]::SendNotifyMessage([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero)',
        '[PSCustomObject]@{ regOk = $regOk; regFailed = @($regFailed); added = $added; notified = [bool]$notified } | ConvertTo-Json -Compress'
      ].join('\n');
      const psRes = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psNotify],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000
        }
      );
      if (psRes.status === 0) {
        const notifyData = JSON.parse(String(psRes.stdout || '').trim() || '{}');
        registryWrittenCount = Number(notifyData.regOk) || 0;
        registryFailed = Array.isArray(notifyData.regFailed)
          ? notifyData.regFailed
          : notifyData.regFailed
          ? [String(notifyData.regFailed)]
          : [];
        fontRegisteredCount = Number(notifyData.added) || 0;
        fontBroadcastOk = fontRegisteredCount > 0 && Boolean(notifyData.notified);
      } else {
        registryFailed = regItems.map((i) => i.title);
      }
    } catch {
      registryFailed = regItems.map((i) => i.title);
    } finally {
      try {
        if (fs.existsSync(listTmp)) fs.unlinkSync(listTmp);
      } catch {}
    }
  } else if (process.platform === 'linux' && allTargetFontPaths.length > 0) {
    try {
      execSync('fc-cache -f 2>/dev/null || true');
    } catch {}
  }

  const superTtcRetirement = shouldRetireSuperTtc
    ? retireWindowsSuperTtc({ destDir, force: hasFlag('--force') })
    : null;
  const postEnv = await detectEnvironment('auto');
  const postCheck = buildFontReport(postEnv);

  const noFontsFound = allTargetFontPaths.length === 0;
  const winRegistryFailed = process.platform === 'win32' && allTargetFontPaths.length > 0 && registryWrittenCount === 0;
  const downloadFailed = Boolean(downloadSummary && !downloadSummary.ok);
  const ok = !noFontsFound && !winRegistryFailed && !downloadFailed;
  const failureReason = downloadFailed
    ? 'font_download_failed'
    : noFontsFound
    ? 'no_font_files_found'
    : winRegistryFailed
    ? 'windows_font_registry_failed'
    : null;
  const restartAntigravityRequired = Boolean(
    process.platform === 'win32' && allTargetFontPaths.length > 0 && postEnv.runningProcesses.length > 0
  );

  console.log(
    JSON.stringify(
      {
        ok,
        ...(failureReason ? { reason: failureReason } : {}),
        platform: process.platform,
        destDir,
        installedCount: installed.length,
        skippedLockedCount: skippedLocked.length,
        registryWrittenCount,
        ...(registryFailed.length > 0 ? { registryFailed } : {}),
        fontRegisteredCount,
        fontBroadcastOk,
        ...(extractedArchives.length > 0 ? { extractedArchives } : {}),
        ...(archiveExtractErrors.length > 0 ? { archiveExtractErrors } : {}),
        ...(downloadSummary ? { downloadSummary } : {}),
        installed,
        skippedLocked,
        ...(superTtcRetirement ? { superTtcRetirement } : {}),
        restartAntigravityRequired,
        ...(restartAntigravityRequired
          ? {
              restartHint:
                'Windows DirectWrite caches system fonts per process. Restart Antigravity once (e.g. `node install.mjs relaunch` when idle) for newly installed fonts to take effect.'
            }
          : {}),
        postCheck
      },
      null,
      2
    )
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

function readWinHkcuFontRegistryEntries() {
  if (process.platform !== 'win32') return null;
  try {
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$sk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", $false)',
      'if ($null -eq $sk) { Write-Output "[]"; exit 0 }',
      'try {',
      '  $items = @(foreach ($n in $sk.GetValueNames()) {',
      '    if ($n) { [PSCustomObject]@{ name = [string]$n; data = [string]$sk.GetValue($n) } }',
      '  })',
      '  if ($items.Count -eq 0) { Write-Output "[]" } else { ConvertTo-Json -InputObject $items -Compress }',
      '} finally { $sk.Dispose() }'
    ].join('\n');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000
    });
    if (r.status === 0) {
      const parsed = JSON.parse(String(r.stdout || '').trim() || '[]');
      return Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {}
  // PowerShell 被策略拦截或超时时降级到 reg query 只读兜底
  try {
    const rq = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (rq.status === 0 && rq.stdout) {
      const items = [];
      for (const line of String(rq.stdout).split(/\r?\n/)) {
        const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/);
        if (m) items.push({ name: m[1].trim(), data: m[2].trim() });
      }
      return items;
    }
  } catch {}
  return null;
}

function retireWindowsSuperTtc({ destDir = null, force = false } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, reason: 'non-win32' };
  }
  const home = os.homedir();
  const userFontsDir =
    destDir || path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');
  let userFontList = [];
  try {
    if (fs.existsSync(userFontsDir)) userFontList = fs.readdirSync(userFontsDir);
  } catch {}
  const hasUiSplit = userFontList.some((f) => /^Sarasa[-_ ]?Ui[-_ ]?SC[-_ ].*\.ttf$/i.test(f));
  const hasMonoSplit = userFontList.some((f) => /^Sarasa[-_ ]?Mono[-_ ]?Slab[-_ ]?SC[-_ ].*\.ttf$/i.test(f));
  if (!force && (!hasUiSplit || !hasMonoSplit)) {
    return {
      ok: false,
      reason: 'split_sc_ttf_missing',
      hint: 'Install SarasaUiSC-*.ttf and SarasaMonoSlabSC-*.ttf first (or pass --force) before retiring Sarasa-SuperTTC.ttc.'
    };
  }

  const removedRegistryValues = [];
  const candidateTtcPaths = new Set();
  for (const f of userFontList) {
    if (/^Sarasa[ _-]?SuperTTC[^\\\/]*\.ttc$/i.test(f)) {
      candidateTtcPaths.add(path.join(userFontsDir, f));
    }
  }

  let gdiRemovedCount = 0;
  let broadcastOk = false;
  try {
    const seedTmp = path.join(os.tmpdir(), `ag-retire-ttc-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(seedTmp, JSON.stringify({ userFontsDir, initialPaths: Array.from(candidateTtcPaths) }), 'utf8');
    try {
      const psRetire = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$ErrorActionPreference = "SilentlyContinue"',
        'Add-Type -TypeDefinition @"',
        'using System; using System.Runtime.InteropServices;',
        'public static class AgFontRetire {',
        '  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern bool RemoveFontResource(string lpFileName);',
        '  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool SendNotifyMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);',
        '}',
        '"@',
        `$seed = Get-Content -LiteralPath '${seedTmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
        '$paths = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)',
        'foreach ($p in @($seed.initialPaths)) { if ($p) { [void]$paths.Add([string]$p) } }',
        '$removedNames = New-Object System.Collections.Generic.List[string]',
        '$sk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", $true)',
        'if ($null -ne $sk) {',
        '  try {',
        '    foreach ($n in @($sk.GetValueNames())) {',
        '      if (-not $n) { continue }',
        '      $d = [string]$sk.GetValue($n)',
        '      if (($n -match "Sarasa[ _-]?SuperTTC") -or ($d -match "Sarasa[ _-]?SuperTTC[^\\\\/]*\\.ttc$")) {',
        '        if ($d -and ($d -match "\\.ttc$")) {',
        '          $full = if ([System.IO.Path]::IsPathRooted($d)) { $d } else { Join-Path ([string]$seed.userFontsDir) $d }',
        '          [void]$paths.Add($full)',
        '        }',
        '        $sk.DeleteValue($n, $false)',
        '        if ($null -eq $sk.GetValue($n, $null)) { $removedNames.Add([string]$n) }',
        '      }',
        '    }',
        '  } finally { $sk.Dispose() }',
        '}',
        '$rem = 0',
        '$notified = $false',
        'if ($paths.Count -gt 0 -or $removedNames.Count -gt 0) {',
        '  foreach ($fp in $paths) { if ($fp) { for ($i = 0; $i -lt 4; $i++) { if ([AgFontRetire]::RemoveFontResource([string]$fp)) { $rem++ } else { break } } } }',
        '  $notified = [bool][AgFontRetire]::SendNotifyMessage([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero)',
        '}',
        '[PSCustomObject]@{ removedNames = @($removedNames); candidatePaths = @($paths); gdiRemoved = $rem; notified = $notified } | ConvertTo-Json -Compress'
      ].join('\n');
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psRetire], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000
      });
      if (r.status === 0) {
        const d = JSON.parse(String(r.stdout || '').trim() || '{}');
        if (Array.isArray(d.removedNames)) removedRegistryValues.push(...d.removedNames);
        if (Array.isArray(d.candidatePaths)) {
          for (const cp of d.candidatePaths) {
            if (cp) candidateTtcPaths.add(String(cp));
          }
        }
        gdiRemovedCount = Number(d.gdiRemoved) || 0;
        broadcastOk = Boolean(d.notified);
      }
    } finally {
      try {
        if (fs.existsSync(seedTmp)) fs.unlinkSync(seedTmp);
      } catch {}
    }
  } catch {}

  const deletedFiles = [];
  const lockedPendingRebootFiles = [];
  for (const fp of candidateTtcPaths) {
    if (!fp.toLowerCase().startsWith(userFontsDir.toLowerCase())) continue;
    if (!fs.existsSync(fp)) continue;
    try {
      fs.unlinkSync(fp);
      deletedFiles.push(fp);
    } catch {
      lockedPendingRebootFiles.push(fp);
    }
  }

  return {
    ok: true,
    removedRegistryValues,
    gdiRemovedCount,
    broadcastOk,
    deletedFiles,
    lockedPendingRebootFiles,
    effectiveOnNextAntigravityLaunch: true
  };
}

async function runUninstall() {
  const home = os.homedir();
  const defaultTarget = resolveGlobalInstallDir();
  const targetDir = path.resolve(getArg('--target-dir', resolveDefaultTargetDir()));
  const isCustomSandboxTarget =
    hasFlag('--target-dir') && !isSameTargetPath(targetDir, defaultTarget) && !hasFlag('--register-service');
  const userConfigPath = path.join(targetDir, 'user', 'config.json');
  const realDaemon = path.join(targetDir, 'core', 'daemon.mjs');

  if (isCustomSandboxTarget) {
    const localVbs = path.join(targetDir, 'AntigravityThemeDaemon.vbs');
    const localCacheDir = path.join(targetDir, '.cache');
    try {
      if (fs.existsSync(localVbs)) fs.unlinkSync(localVbs);
    } catch {}
    try {
      if (fs.existsSync(localCacheDir)) fs.rmSync(localCacheDir, { recursive: true, force: true });
    } catch {}
    console.log(`[Uninstall] Cleaned custom sandbox target (${targetDir}); global daemon and services were left untouched.`);
    return;
  }

  // 1. 先移除跨平台开机自启服务（防止 KeepAlive/Restart 自动拉起），再彻底终止残留后台守护进程，消除与 --once 还原注入的并发竞态
  if (process.platform === 'darwin') {
    const uid = process.getuid ? process.getuid() : 501;
    const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
    for (const label of ['com.antigravity.customfont', 'com.antigravity.theme']) {
      try {
        execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`);
      } catch {}
      for (let i = 0; i < 15; i++) {
        const res = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' });
        if (res.status !== 0) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      try {
        const plistFile = path.join(launchAgentsDir, `${label}.plist`);
        if (fs.existsSync(plistFile)) fs.unlinkSync(plistFile);
      } catch {}
    }
  } else if (process.platform === 'linux') {
    try {
      execSync('systemctl --user disable --now antigravity-theme.service 2>/dev/null || true');
      const serviceFile = path.join(home, '.config', 'systemd', 'user', 'antigravity-theme.service');
      if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
      execSync('systemctl --user daemon-reload 2>/dev/null || true');
    } catch {}
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const vbsFile = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AntigravityThemeDaemon.vbs');
    const localVbs = path.join(targetDir, 'AntigravityThemeDaemon.vbs');
    try {
      spawnSync('schtasks', ['/Delete', '/TN', 'AntigravityThemeDaemon', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {}
    try {
      spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AntigravityThemeDaemon', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {}
    try {
      if (fs.existsSync(vbsFile)) fs.unlinkSync(vbsFile);
      if (fs.existsSync(localVbs)) fs.unlinkSync(localVbs);
    } catch {}
  }
  stopRunningDaemonProcesses();
  removeCdpLaunchers();
  try {
    const cacheDir = path.join(targetDir, '.cache');
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch {}

  // 2. 在无后台守护进程干扰的纯净状态下，向打开的窗口发送一次禁用还原载荷，即时卸载样式并恢复英文原貌
  if (fs.existsSync(userConfigPath) && fs.existsSync(realDaemon)) {
    try {
      const origRaw = fs.readFileSync(userConfigPath, 'utf8');
      const cfg = JSON.parse(origRaw.replace(/^\uFEFF/, ''));
      cfg.enabled = false;
      fs.writeFileSync(userConfigPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', realDaemon, '--once'], {
        stdio: 'ignore',
        windowsHide: true
      });
      fs.writeFileSync(userConfigPath, origRaw, 'utf8');
    } catch {}
  }
  console.log('[Uninstall] Stopped daemon, removed autostart services & CDP launchers, and unloaded live styles. User config in ~/.gemini/antigravity/theme-patch/user/ is preserved.');
}

// ============================================================================
// 4. 路由分发
// ============================================================================
switch (subcommand) {
  case 'build-manifest': {
    try {
      const m = buildManifest(__dirname);
      console.log('Built core/manifest.json:', m.version, 'files:', Object.keys(m.files).length);
    } catch (err) {
      console.error('[ERROR]', err?.message || err);
      process.exit(1);
    }
    break;
  }
  case 'pack': {
    try {
      const packed = buildDistZip(__dirname, { updateBundleOnly: hasFlag('--update-bundle') });
      console.log(
        'Packed & verified dist archive:',
        packed.zipPath,
        `| core-update: ${packed.updateZipPath} (${packed.updateBytes}B)`,
        `| latest.json: ${packed.latestJsonPath}`,
        `(verified ${packed.filesVerified} core files)`
      );
    } catch (err) {
      console.error('[ERROR]', err?.message || err);
      process.exit(1);
    }
    break;
  }
  case 'doctor':
    await runDoctor();
    break;
  case 'install':
    await runInstall();
    break;
  case 'upgrade':
    await runUpgrade();
    break;
  case 'relaunch':
    await runRelaunch();
    break;
  case 'download-fonts':
    await runDownloadFontsCmd();
    break;
  case 'install-fonts':
    await runInstallFonts();
    break;
  case 'retire-super-ttc':
    console.log(JSON.stringify(retireWindowsSuperTtc({ force: hasFlag('--force') }), null, 2));
    break;
  case 'verify':
    await runVerify();
    break;
  case 'rollback':
    await runRollback();
    break;
  case 'uninstall':
    await runUninstall();
    break;
  default:
    console.log(`Usage:
  node install.mjs install          [--channel auto|stable|insiders] [--preset native|morandi|absolutely|claude-desktop-purewhite|vintage-deep] [--dark-preset onyx|claude-warm] [--sync-user] [--with-launcher]
  node install.mjs upgrade          [--check] [--version <vX.Y.Z>] [--mirror cloudflare-r2|github-release] [--force]
  node install.mjs relaunch         [--channel auto|stable|insiders] [--force]
  node install.mjs download-fonts   [--dir <download-dir>] [--all] [--force] [--super-ttc]
  node install.mjs install-fonts    --auto-download [--dir <download-dir>] [--force] [--super-ttc] [--retire-super-ttc]
  node install.mjs install-fonts    --from <font-folder-or-zip-path> [--retire-super-ttc]
  node install.mjs retire-super-ttc [--force]
  node install.mjs doctor           [--channel auto|stable|insiders]
  node install.mjs verify           [--safe-mode] [--channel auto|stable|insiders]
  node install.mjs rollback
  node install.mjs uninstall
  node install.mjs build-manifest   [--set-version <X.Y.Z>]
  node install.mjs pack             [--update-bundle] [--set-version <X.Y.Z>]`);
    break;
}
