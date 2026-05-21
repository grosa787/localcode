#!/usr/bin/env node
// postinstall: download the matching prebuilt LocalCode binary from GitHub Releases.
//
// Expected release asset naming (produced by the separate release workflow):
//   localcode-<os>-<arch>.tar.gz      (contains a single `localcode` executable)
//   localcode-<os>-<arch>.tar.gz.sha256   (single-line: "<hex>  localcode-<os>-<arch>.tar.gz")
//
// Env overrides:
//   LOCALCODE_BINARY_URL     full URL to the tarball (skips GitHub lookup)
//   LOCALCODE_SKIP_DOWNLOAD  if set to "1", skip postinstall entirely
//   LOCALCODE_VERSION        override package.version (e.g. for nightlies)
//   LOCALCODE_REPO           "owner/repo" override (default: grosa787/localcode)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const url = require('node:url');
const zlib = require('node:zlib');

const PKG_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor');
const VERSION_MARKER = path.join(VENDOR_DIR, '.installed-version');
const PKG_JSON = require(path.join(PKG_ROOT, 'package.json'));

const REPO = process.env.LOCALCODE_REPO || 'grosa787/localcode';
const VERSION = process.env.LOCALCODE_VERSION || PKG_JSON.version;

function log(msg) {
  process.stdout.write(`localcode (postinstall): ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`localcode (postinstall): ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`localcode (postinstall) ERROR: ${msg}\n`);
  process.stderr.write(
    'You can retry with: npm install -g @grosa787/localcode\n' +
      'Or set LOCALCODE_BINARY_URL to a direct tarball URL and reinstall.\n' +
      'Or set LOCALCODE_SKIP_DOWNLOAD=1 and place the binary at packages/npm/vendor/localcode manually.\n',
  );
  process.exit(1);
}

function platformTuple() {
  const platMap = { darwin: 'darwin', linux: 'linux' };
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const plat = platMap[process.platform];
  const arch = archMap[process.arch];
  if (!plat || !arch) {
    die(
      `unsupported platform: ${process.platform}/${process.arch}. ` +
        `LocalCode supports darwin/linux on x64/arm64. ` +
        `Windows users: please use WSL.`,
    );
  }
  return { plat, arch };
}

function defaultAssetName({ plat, arch }) {
  return `localcode-${plat}-${arch}.tar.gz`;
}

function defaultAssetUrl({ plat, arch, version }) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const asset = defaultAssetName({ plat, arch });
  return `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
}

function defaultChecksumUrl(assetUrl) {
  return `${assetUrl}.sha256`;
}

function httpGet(targetUrl, { redirectDepth = 0 } = {}) {
  if (redirectDepth > 5) {
    return Promise.reject(new Error(`too many redirects fetching ${targetUrl}`));
  }
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new url.URL(targetUrl);
    } catch (err) {
      reject(new Error(`invalid URL: ${targetUrl}`));
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`unsupported protocol ${parsed.protocol} in ${targetUrl}`));
      return;
    }
    const req = transport.get(
      targetUrl,
      {
        headers: {
          'User-Agent': `localcode-npm-shim/${VERSION}`,
          Accept: 'application/octet-stream',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          // Resolve relative locations against the current URL.
          const next = new url.URL(res.headers.location, parsed).toString();
          httpGet(next, { redirectDepth: redirectDepth + 1 }).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching ${targetUrl}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`timeout fetching ${targetUrl}`));
    });
  });
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseChecksumFile(text) {
  // Format: "<hex>  <filename>" or just "<hex>"
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const match = first.trim().match(/^([0-9a-fA-F]{64})\b/);
  return match ? match[1].toLowerCase() : null;
}

// Minimal tar reader: handles ustar regular files (typeflag '0' or '\0').
// Sufficient for our release artifact which contains a single binary.
function extractTarGz(buf) {
  const tarBuf = zlib.gunzipSync(buf);
  const files = [];
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/[\0 ]+$/, '');
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]) || '0';
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      files.push({ name, data: tarBuf.subarray(dataStart, dataEnd) });
    }
    // Move past data, padded to 512.
    offset = dataEnd + (512 - (size % 512)) % 512;
  }
  return files;
}

function findBinaryInTar(files) {
  // Prefer exactly `localcode`; fall back to anything basename=localcode.
  const exact = files.find((f) => f.name === 'localcode' || f.name.endsWith('/localcode'));
  if (exact) return exact;
  return files.find((f) => path.basename(f.name) === 'localcode');
}

async function downloadAndInstall({ assetUrl, checksumUrl }) {
  log(`downloading ${assetUrl}`);
  const archiveBuf = await httpGet(assetUrl);

  // Checksum verification. If the .sha256 file isn't available we proceed with a warning
  // (so this works even when releases temporarily omit checksums) — but never silently
  // when LOCALCODE_BINARY_URL was set: the user must opt out of the .sha256 check via
  // LOCALCODE_SKIP_CHECKSUM=1.
  let expectedSha = null;
  try {
    const checksumBuf = await httpGet(checksumUrl);
    expectedSha = parseChecksumFile(checksumBuf.toString('utf8'));
  } catch (err) {
    if (process.env.LOCALCODE_SKIP_CHECKSUM === '1') {
      warn(`skipping checksum check (LOCALCODE_SKIP_CHECKSUM=1): ${err.message}`);
    } else if (process.env.LOCALCODE_BINARY_URL) {
      die(
        `could not fetch checksum file ${checksumUrl}: ${err.message}\n` +
          `Set LOCALCODE_SKIP_CHECKSUM=1 to bypass (NOT recommended).`,
      );
    } else {
      warn(`checksum file unavailable, continuing without verification: ${err.message}`);
    }
  }

  if (expectedSha) {
    const got = sha256Hex(archiveBuf);
    if (got !== expectedSha) {
      die(
        `checksum mismatch for ${assetUrl}\n` +
          `  expected: ${expectedSha}\n` +
          `  got:      ${got}\n` +
          `Refusing to install a binary that does not match the published checksum.`,
      );
    }
    log(`checksum OK (sha256 ${expectedSha.slice(0, 12)}…)`);
  }

  log('extracting archive');
  const entries = extractTarGz(archiveBuf);
  const binEntry = findBinaryInTar(entries);
  if (!binEntry) {
    die(`tarball did not contain a 'localcode' executable (found: ${entries.map((e) => e.name).join(', ') || 'nothing'})`);
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const destPath = path.join(VENDOR_DIR, 'localcode');
  // Write atomically — tmp file, then rename.
  const tmpPath = path.join(VENDOR_DIR, `localcode.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, binEntry.data);
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);
  fs.writeFileSync(VERSION_MARKER, VERSION);
  log(`installed binary at ${destPath}`);
}

function alreadyInstalled() {
  if (!fs.existsSync(path.join(VENDOR_DIR, 'localcode'))) return false;
  if (!fs.existsSync(VERSION_MARKER)) return false;
  try {
    const installed = fs.readFileSync(VERSION_MARKER, 'utf8').trim();
    return installed === VERSION;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.LOCALCODE_SKIP_DOWNLOAD === '1') {
    log('LOCALCODE_SKIP_DOWNLOAD=1 set; skipping binary download.');
    return;
  }

  if (alreadyInstalled()) {
    log(`binary already installed for version ${VERSION}, skipping download.`);
    return;
  }

  const tuple = platformTuple();
  const assetUrl = process.env.LOCALCODE_BINARY_URL || defaultAssetUrl({ ...tuple, version: VERSION });
  const checksumUrl = process.env.LOCALCODE_CHECKSUM_URL || defaultChecksumUrl(assetUrl);

  try {
    await downloadAndInstall({ assetUrl, checksumUrl });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    die(
      `failed to download/install binary: ${msg}\n` +
        `  asset:    ${assetUrl}\n` +
        `  checksum: ${checksumUrl}\n` +
        `If you are offline or behind a proxy, set LOCALCODE_SKIP_DOWNLOAD=1, install manually, ` +
        `then place the binary at ${path.join(VENDOR_DIR, 'localcode')}.`,
    );
  }
}

main();
