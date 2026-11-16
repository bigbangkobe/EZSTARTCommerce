import { readFile } from 'node:fs/promises';
import { generatedContract, output } from './generate-contract.mjs';

const actual = await readFile(output, 'utf8').catch(() => '');
if (actual !== await generatedContract()) {
  console.error('Generated contract is missing or stale. Run pnpm contracts:generate.');
  process.exitCode = 1;
} else {
  console.log('Generated contract is current.');
}
