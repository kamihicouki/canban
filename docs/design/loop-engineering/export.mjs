// Documentation asset exporter; does not run the Canban application.
// Usage: node export.mjs /absolute/path/to/node_modules
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.argv[2] ? join(resolve(process.argv[2]), 'package.json') : import.meta.url);
const sharp = require('sharp');
const png = join(root, 'overview.png');
await sharp(join(root, 'overview.svg'), { density: 144 }).png().toFile(png);
const { width, height } = await sharp(png).metadata();
console.log(`Exported ${png} (${width}×${height})`);
