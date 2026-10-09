import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicERPInformation } from '../src/server/erp-public-information.server.ts';

const output = process.argv[2];
if (!output) throw new Error('Supply an output directory');
await mkdir(output, { recursive: true });
for (const kind of ['support', 'privacy']) {
  const response = publicERPInformation(kind);
  await writeFile(resolve(output, `${kind}.html`), await response.text(), { flag: 'wx' });
}
console.log('Rendered support page and explicitly marked privacy draft');
