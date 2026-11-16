import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const contractRequire = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const { default: openapiTS, astToString } = contractRequire('openapi-typescript');

export const output = new URL('../packages/contracts/generated/api.d.ts', import.meta.url);
export async function generatedContract() {
  return '// Generated from openapi.yaml. Run pnpm contracts:generate; do not edit.\n' +
    astToString(await openapiTS(new URL('../packages/contracts/openapi.yaml', import.meta.url)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(new URL('../packages/contracts/generated/', import.meta.url), { recursive: true });
  await writeFile(output, await generatedContract());
  console.log('Generated packages/contracts/generated/api.d.ts');
}
