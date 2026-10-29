/* eslint-disable no-console */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { list } from 'tar';
import maxmind from 'maxmind';

const db = 'GeoLite2-City';
const filename = path.resolve(process.cwd(), 'geo', `${db}.mmdb`);

async function validate(file) {
  const reader = await maxmind.open(file);
  if (reader.metadata.databaseType !== db) throw new Error('Expected GeoLite2-City database');
  if (!reader.get('8.8.8.8')?.country?.iso_code) throw new Error('Geo database lookup failed');
  console.log('Validated GeoLite2-City database');
}

try {
  // Offline preflight; also used after the Docker build, regardless of skip settings.
  if (process.argv[2] === '--check') {
    await validate(process.argv[3] || filename);
  } else if (
    process.env.SKIP_BUILD_GEO ||
    (process.env.VERCEL && !process.env.BUILD_GEO)
  ) {
    // A download may be skipped, never the required asset validation.
    await validate(filename);
  } else {
    const url = process.env.GEO_DATABASE_URL || (process.env.MAXMIND_LICENSE_KEY
      ? `https://download.maxmind.com/app/geoip_download?edition_id=${db}&license_key=${process.env.MAXMIND_LICENSE_KEY}&suffix=tar.gz`
      : `https://raw.githubusercontent.com/GitSquared/node-geolite2-redist/master/redist/${db}.tar.gz`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.download`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Geo download HTTP ${response.status}`);
      if (new URL(url).pathname.endsWith('.mmdb')) {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
      } else {
        const writes = [];
        let found = false;
        await pipeline(Readable.fromWeb(response.body), createGunzip(), list({
          onReadEntry(entry) {
            if (path.basename(entry.path) === `${db}.mmdb` && !found) {
              found = true;
              const write = pipeline(entry, fs.createWriteStream(temporary));
              // Attach immediately so a disk error cannot become an unhandled rejection.
              write.catch(() => {});
              writes.push(write);
            } else entry.resume();
          },
        }));
        await Promise.all(writes);
        if (!found) throw new Error('Geo archive missing GeoLite2-City.mmdb');
      }
      await validate(temporary);
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
} catch {
  // Never print download URLs: they may contain a license key.
  console.error('Required GeoLite2-City database missing, invalid, or download failed');
  process.exitCode = 1;
}
