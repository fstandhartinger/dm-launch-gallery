'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const SITE_DIR = path.join(ROOT, 'site');
const ENC_DIR = path.join(ROOT, 'enc');
const PLAIN_DIR = path.join(os.tmpdir(), 'gallery');
const KEY_PATH = path.join(os.homedir(), '.config', 'dm-gallery', 'bundle.key');
const PORT = Number(process.env.PORT || '8080');

function readKey() {
  let value = process.env.GALLERY_KEY;
  if (!value) {
    try {
      value = fs.readFileSync(KEY_PATH, 'utf8');
    } catch {
      throw new Error('GALLERY_KEY is required, or provide ~/.config/dm-gallery/bundle.key.');
    }
  }
  value = String(value).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('GALLERY_KEY must contain exactly 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}

function readPrefix() {
  const prefix = process.env.GALLERY_PATH;
  if (typeof prefix !== 'string' ||
      !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/.test(prefix)) {
    throw new Error('GALLERY_PATH must be a secret URL prefix with leading and trailing slashes.');
  }
  return prefix;
}

function decrypt(blob, key) {
  if (blob.length < 28) throw new Error('Encrypted asset is shorter than its AES-GCM header.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

function validAssetName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..') &&
    /^[A-Za-z0-9._/-]+$/.test(name);
}

async function unpack(key) {
  await fsp.rm(PLAIN_DIR, { recursive: true, force: true });
  await fsp.mkdir(PLAIN_DIR, { recursive: true, mode: 0o700 });
  const manifestBytes = await fsp.readFile(path.join(ENC_DIR, 'manifest.bin'));
  const manifest = JSON.parse(decrypt(manifestBytes, key).toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Encrypted manifest is not an object.');
  }
  const files = new Map();
  for (const [name, item] of Object.entries(manifest)) {
    if (!validAssetName(name) || !item || typeof item !== 'object' ||
        typeof item.blob !== 'string' || !/^[a-f0-9]{12}\.bin$/.test(item.blob) ||
        !Number.isSafeInteger(item.size) || item.size < 0 ||
        typeof item.type !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) {
      throw new Error('Encrypted manifest contains an invalid entry.');
    }
    const blob = await fsp.readFile(path.join(ENC_DIR, item.blob));
    const plain = decrypt(blob, key);
    const digest = crypto.createHash('sha256').update(plain).digest('hex');
    if (plain.length !== item.size || digest !== item.sha256) {
      throw new Error('Encrypted asset integrity check failed for ' + name + '.');
    }
    const target = path.resolve(PLAIN_DIR, name);
    if (!target.startsWith(PLAIN_DIR + path.sep)) throw new Error('Asset path escaped the temporary directory.');
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(target, plain, { mode: 0o600 });
    files.set(name, { size: item.size, type: item.type });
  }
  return files;
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

function commonHeaders(type) {
  return {
    'Accept-Ranges': type === 'video/mp4' ? 'bytes' : 'none',
    'Cache-Control': 'private, max-age=300',
    'Content-Type': type,
    'X-Robots-Tag': 'noindex, nofollow'
  };
}

function sendText(res, status, body, headers = {}) {
  const bytes = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    ...headers
  });
  res.end(bytes);
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function serveFile(req, res, filePath, type, logicalName) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendText(res, 404, 'not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'not found');

  const headers = commonHeaders(type);
  if (new URL(req.url, 'http://localhost').searchParams.has('download') && logicalName) {
    const filename = path.basename(logicalName).replace(/["\r\n]/g, '_');
    headers['Content-Disposition'] = 'attachment; filename="' + filename + '"';
  }
  const rangeHeader = type === 'video/mp4' && req.method === 'GET' ? req.headers.range : undefined;
  const range = parseRange(rangeHeader, stat.size);
  if (range === false) {
    return sendText(res, 416, 'range not satisfiable', {
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes */' + stat.size,
      'X-Robots-Tag': 'noindex, nofollow'
    });
  }
  if (range) {
    headers['Content-Length'] = range.end - range.start + 1;
    headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + stat.size;
    res.writeHead(206, headers);
    return fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
  return sendText(res, 404, 'not found', { 'X-Robots-Tag': 'noindex, nofollow' });
}

async function start() {
  const key = readKey();
  const prefix = readPrefix();
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be between 1 and 65535.');
  const files = await unpack(key);
  const catalog = Buffer.from(JSON.stringify({ files: Object.fromEntries(files) }), 'utf8');

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/healthz') return sendText(res, 200, 'ok');
      if (!pathname.startsWith(prefix)) return notFound(res);

      let relative;
      try {
        relative = decodeURIComponent(pathname.slice(prefix.length));
      } catch {
        return notFound(res);
      }
      if (relative === '') relative = 'index.html';
      if (!validAssetName(relative)) return notFound(res);
      if (relative === 'catalog.json') {
        res.writeHead(200, {
          ...commonHeaders('application/json; charset=utf-8'),
          'Content-Length': catalog.length
        });
        return res.end(req.method === 'HEAD' ? undefined : catalog);
      }
      if (files.has(relative)) {
        const entry = files.get(relative);
        return serveFile(req, res, path.join(PLAIN_DIR, relative), entry.type, relative);
      }

      const staticPath = path.resolve(SITE_DIR, relative);
      if (!staticPath.startsWith(SITE_DIR + path.sep)) return notFound(res);
      const type = MIME[path.extname(staticPath).toLowerCase()];
      if (!type) return notFound(res);
      return serveFile(req, res, staticPath, type, relative);
    } catch {
      if (!res.headersSent) return sendText(res, 500, 'internal error', { 'X-Robots-Tag': 'noindex, nofollow' });
      res.destroy();
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('Decision Models private gallery listening on port ' + PORT + ' at configured prefix.');
    console.log('Decrypted and integrity-checked ' + files.size + ' assets into /tmp/gallery/.');
  });
  const stop = () => server.close(() => {
    fsp.rm(PLAIN_DIR, { recursive: true, force: true }).finally(() => process.exit(0));
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch((error) => {
  console.error('Gallery startup failed: ' + error.message);
  process.exitCode = 1;
});
