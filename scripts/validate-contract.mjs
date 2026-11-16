import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const localDependencies = fileURLToPath(new URL('../.local-tools/contract-validation', import.meta.url));
const env = { ...process.env };
if (existsSync(localDependencies)) env.PYTHONPATH = [localDependencies, env.PYTHONPATH].filter(Boolean).join(delimiter);
const result = spawnSync(env.PYTHON ?? 'python', ['-m', 'unittest', 'discover', '-s', 'packages/contracts', '-p', 'test_*.py', '-v'],
  { cwd: root, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
