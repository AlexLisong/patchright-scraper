import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
try {
  writeFileSync('.env', `API_KEY=${randomBytes(32).toString('hex')}\nHOST=127.0.0.1\nPORT=8787\nHEADLESS=false\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random API key (not printed).');
} catch (error) { if (error.code !== 'EEXIST') throw error; }
const result = spawnSync('npx', ['patchright', 'install', 'chromium'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
