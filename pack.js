'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const JOB_DIR = path.resolve(ROOT, '..');
const FINALS_DIR = process.env.GALLERY_SRC || path.join(ROOT, 'web');
const POSTERS_DIR = path.join(ROOT, 'posters');
const ENC_DIR = path.join(ROOT, 'enc');
const KEY_PATH = path.join(require('node:os').homedir(), '.config', 'dm-gallery', 'bundle.key');
const MAX_BLOB_BYTES = 95_000_000;

function keyFromHex(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.trim())) {
    throw new Error('GALLERY_KEY must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value.trim(), 'hex');
}

async function loadKey() {
  if (process.env.GALLERY_KEY) return keyFromHex(process.env.GALLERY_KEY);
  try {
    return keyFromHex(await fs.readFile(KEY_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  const priorMask = process.umask(0o077);
  try {
    const handle = await fs.open(KEY_PATH, 'wx', 0o600);
    try {
      await handle.writeFile(crypto.randomBytes(32).toString('hex') + '\n', 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    process.umask(priorMask);
  }
  return keyFromHex(await fs.readFile(KEY_PATH, 'utf8'));
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(blob, key) {
  if (blob.length < 28) throw new Error('Encrypted asset is shorter than its AES-GCM header.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..') &&
    /^[A-Za-z0-9._/-]+$/.test(name);
}

async function readPreviousManifest(key) {
  try {
    const encoded = await fs.readFile(path.join(ENC_DIR, 'manifest.bin'));
    const parsed = JSON.parse(decrypt(encoded, key).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Previous manifest is not an object.');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Could not read the existing encrypted manifest. Check that the bundle key matches.');
  }
}

async function atomicWrite(target, bytes, mode = 0o600) {
  const temporary = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fs.writeFile(temporary, bytes, { mode });
  await fs.rename(temporary, target);
}

async function main() {
  const key = await loadKey();
  const galleryPath = path.join(ROOT, 'gallery.json');
  const gallery = JSON.parse(await fs.readFile(galleryPath, 'utf8'));
  if (!Array.isArray(gallery.variants)) throw new Error('gallery.json must contain a variants array.');
  await fs.mkdir(ENC_DIR, { recursive: true });
  await fs.mkdir(POSTERS_DIR, { recursive: true });
  const oldManifest = await readPreviousManifest(key);
  const sources = new Map();
  sources.set('index.html', {
    bytes: await fs.readFile(path.join(ROOT, 'site', 'index.html')),
    type: 'text/html; charset=utf-8'
  });
  sources.set('gallery.json', {
    bytes: await fs.readFile(galleryPath),
    type: 'application/json; charset=utf-8'
  });

  const finalNames = (await fs.readdir(FINALS_DIR)).filter((name) => name.toLowerCase().endsWith('.mp4')).sort();
  const posterNames = (await fs.readdir(POSTERS_DIR)).filter((name) => name.toLowerCase().endsWith('.jpg')).sort();
  const availablePosters = new Set(posterNames);
  for (const name of finalNames) {
    if (!safeName(name) || name.includes('/')) throw new Error('Unsafe video filename in finals directory.');
    const expectedPoster = name.replace(/\.mp4$/i, '.jpg');
    if (!availablePosters.has(expectedPoster)) {
      throw new Error('Missing poster for final video: ' + name + ' (expected posters/' + expectedPoster + ').');
    }
    const source = path.join(FINALS_DIR, name);
    const bytes = await fs.readFile(source);
    if (bytes.length === 0) throw new Error('Video file is empty: ' + name);
    if (bytes.length >= MAX_BLOB_BYTES) throw new Error('Video exceeds the 95 MB encrypted-blob limit: ' + name);
    sources.set(name, { bytes, type: 'video/mp4' });
  }

  for (const name of posterNames) {
    if (!safeName(name) || name.includes('/')) throw new Error('Unsafe poster filename.');
    sources.set('posters/' + name, {
      bytes: await fs.readFile(path.join(POSTERS_DIR, name)),
      type: 'image/jpeg'
    });
  }

  const manifest = {};
  const retained = new Set(['manifest.bin']);
  let reused = 0;
  for (const [name, item] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (item.bytes.length + 28 >= MAX_BLOB_BYTES) {
      throw new Error('Encrypted blob would exceed the 95 MB limit: ' + name);
    }
    const plainHash = sha256(item.bytes);
    const blobName = sha256(Buffer.from(name, 'utf8')).slice(0, 12) + '.bin';
    const blobPath = path.join(ENC_DIR, blobName);
    const prior = oldManifest[name];
    let keepBlob = false;
    if (prior && prior.sha256 === plainHash && prior.blob === blobName) {
      try {
        const oldPlain = decrypt(await fs.readFile(blobPath), key);
        keepBlob = sha256(oldPlain) === plainHash;
      } catch {
        keepBlob = false;
      }
    }
    if (keepBlob) {
      reused += 1;
    } else {
      await atomicWrite(blobPath, encrypt(item.bytes, key));
    }
    retained.add(blobName);
    manifest[name] = {
      blob: blobName,
      size: item.bytes.length,
      type: item.type,
      sha256: plainHash
    };
    console.log((keepBlob ? 'kept ' : 'packed ') + name + ' (' + item.bytes.length + ' bytes)');
  }

  for (const name of await fs.readdir(ENC_DIR)) {
    if (name.endsWith('.bin') && !retained.has(name)) await fs.unlink(path.join(ENC_DIR, name));
  }
  await atomicWrite(path.join(ENC_DIR, 'manifest.bin'), encrypt(Buffer.from(JSON.stringify(manifest), 'utf8'), key));
  console.log('Encrypted ' + (sources.size - reused) + ' assets; reused ' + reused + ' unchanged blobs.');
  console.log('Manifest entries: ' + Object.keys(manifest).length + '. No plaintext media was written into the repository.');
}

main().catch((error) => {
  console.error('Gallery pack failed: ' + error.message);
  process.exitCode = 1;
});
