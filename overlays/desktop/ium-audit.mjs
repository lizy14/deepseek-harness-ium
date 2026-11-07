import fs from 'node:fs';
import path from 'node:path';

/** Record only blocked mechanism/hostname facts in the isolated local home; never URLs or request data. */
export function createPolicyAudit(harnessHome) {
  if (typeof harnessHome !== 'string' || !path.isAbsolute(harnessHome)) throw new Error('Ium policy audit requires an absolute Harness home');
  const directory = path.join(harnessHome, 'logs');
  const file = path.join(directory, 'network-policy-blocks.jsonl');
  return record => {
    if (!record || typeof record.mechanism !== 'string' || typeof record.hostname !== 'string') return;
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(record.mechanism) || !/^[a-zA-Z0-9.:-]{1,255}$/.test(record.hostname)) return;
    const entry = { time: new Date().toISOString(), mechanism: record.mechanism, hostname: record.hostname };
    fs.mkdirSync(directory, { recursive: true });
    try {
      if (fs.statSync(file).size >= 1024 * 1024) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  };
}
