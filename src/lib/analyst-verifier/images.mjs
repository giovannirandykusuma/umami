import { createHash, randomBytes } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';

export const IMAGE_LIMIT = 1024 * 1024;
export const JOB_IMAGE_LIMIT = 6 * IMAGE_LIMIT;
export const RETENTION_MS = 15 * 60_000;
export const FETCH_TTL_MS = 60_000;

// PNG-only release boundary. Validate framing, checksums and bounded decompression;
// a MIME declaration or magic prefix alone is never sufficient.
export function validateImage(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMAGE_LIMIT)
    throw new Error('image_size');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime !== 'image/png' || !png) throw new Error('image_type');
  let offset = 8;
  let width;
  let height;
  let channels;
  let ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('invalid_png');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error('invalid_png_crc');
    const data = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== 'IHDR') throw new Error('invalid_png');
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) throw new Error('invalid_png');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (
        !width ||
        !height ||
        width > 1440 ||
        height > 1000 ||
        data[8] !== 8 ||
        !channels ||
        data[10] ||
        data[11] ||
        data[12]
      )
        throw new Error('png_dimensions_or_format');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') {
      if (size || end !== bytes.length) throw new Error('invalid_png');
      ended = true;
      offset = end;
      break;
    } else if (!['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type))
      throw new Error('unsupported_png_chunk');
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error('invalid_png');
  const rowSize = width * channels + 1;
  const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowSize * height });
  if (decoded.length !== rowSize * height) throw new Error('invalid_png_data');
  for (let y = 0; y < height; y++)
    if (decoded[y * rowSize] > 4) throw new Error('invalid_png_filter');
  return createHash('sha256').update(bytes).digest('hex');
}

export function createArtifactStore({ authorize, now = Date.now }) {
  const artifacts = new Map();
  // Invalidate authority checks already in flight when pixels are removed.
  let removalEpoch = 0;
  const sweep = () => {
    for (const [id, value] of artifacts)
      if (value.expiresAt <= now()) {
        clearTimeout(value.timer);
        artifacts.delete(id);
      }
  };
  return {
    async put(scope, images) {
      sweep();
      if (
        !images.length ||
        images.length > 6 ||
        images.reduce((n, i) => n + i.bytes.length, 0) > JOB_IMAGE_LIMIT
      )
        throw new Error('image_budget');
      const hashes = images.map(i => validateImage(i.bytes, i.mime));
      const epoch = removalEpoch;
      if (!(await authorize(scope)) || epoch !== removalEpoch) throw new Error('revoked');
      const id = randomBytes(32).toString('base64url');
      const timer = setTimeout(() => artifacts.delete(id), RETENTION_MS);
      timer.unref();
      artifacts.set(id, {
        scope: structuredClone(scope),
        images: images.map(i => ({ ...i, bytes: Buffer.from(i.bytes) })),
        timer,
        hashes,
        expiresAt: now() + RETENTION_MS,
        fetchExpiresAt: now() + FETCH_TTL_MS,
      });
      return { id, hashes };
    },
    async get(id, principal) {
      sweep();
      const item = artifacts.get(id);
      if (!item || item.fetchExpiresAt <= now()) throw new Error('expired_artifact');
      if (item.scope.userId !== principal.userId || item.scope.taskId !== principal.taskId)
        throw new Error('out_of_scope');
      const epoch = removalEpoch;
      if (!(await authorize(item.scope)) || epoch !== removalEpoch) {
        clearTimeout(item.timer);
        artifacts.delete(id);
        throw new Error('revoked');
      }
      if (artifacts.get(id) !== item || item.expiresAt <= now() || item.fetchExpiresAt <= now())
        throw new Error('expired_artifact');
      return item.images.map((i, index) => ({
        ...i,
        bytes: Buffer.from(i.bytes),
        hash: item.hashes[index],
      }));
    },
    discard(id) {
      removalEpoch++;
      clearTimeout(artifacts.get(id)?.timer);
      artifacts.delete(id);
    },
    cleanup({ userId, taskId }) {
      removalEpoch++;
      for (const [id, item] of artifacts)
        if (item.scope.userId === userId || item.scope.taskId === taskId) {
          clearTimeout(item.timer);
          artifacts.delete(id);
        }
    },
    size() {
      sweep();
      return artifacts.size;
    },
  };
}
