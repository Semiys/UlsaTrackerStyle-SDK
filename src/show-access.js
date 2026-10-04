import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve(process.env.DATA_DIR ?? './data', 'access.json');
console.log(JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2));
