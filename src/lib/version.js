
//

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(file, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))[key];
  } catch {
    return null;
  }
}

export const VERSION = read('package.json', 'version') || '0.0.0';
export const EXT_VERSION = read('extension/manifest.json', 'version') || '0.0.0';
