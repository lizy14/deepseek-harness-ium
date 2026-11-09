import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digestPattern = /^[a-f0-9]{64}$/i;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const attemptId = value => typeof value === 'string' && idPattern.test(value) ? value : randomUUID();
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Replace one generated receipt atomically; failure to invalidate stops dependent work. */
function writeReceipt(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.readFileSync(target);
  const temporary = target + '.' + randomUUID() + '.tmp';
  if (path.dirname(temporary) !== path.dirname(target)) throw new Error('Unexpected receipt staging path');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  // Both resolved rename destinations are fixed within the receipt's own directory.
  fs.renameSync(temporary, target);
}

/** Reject superseded owners before writing; callers serialize builds within one work directory. */
export function beginAttempt(file, { kind, id = randomUUID(), requestedBuildVersion = null } = {}) {
  if (!idPattern.test(id)) throw new Error('Invalid receipt attempt ID');
  const identity = { schemaVersion: 2, kind, attemptId: id, startedAt: new Date().toISOString() };
  let record = {
    ...identity, result: 'RUNNING', sourceInputSha256: null, requestedBuildVersion,
    artifactHashes: {}, staticPackagedChecksPassed: false, nativeDesktopAcceptancePassed: false,
  };
  writeReceipt(file, record);
  const own = () => {
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (latest.attemptId !== id) throw new Error('Receipt was superseded by a newer attempt');
  };
  const save = (fields, result) => {
    own();
    record = { ...record, ...fields, ...identity, result };
    writeReceipt(file, record);
    return record;
  };
  return {
    id,
    get record() { return { ...record }; },
    update(fields) { return save(fields, 'RUNNING'); },
    pass(fields = {}, { requireArtifacts = true } = {}) {
      const candidate = { ...record, ...fields };
      if (!digestPattern.test(candidate.sourceInputSha256 ?? '')) throw new Error('PASS requires a verified source input digest');
      if (typeof candidate.requestedBuildVersion !== 'string' || !candidate.requestedBuildVersion.trim()) throw new Error('PASS requires an explicit requested build version');
      const hashes = candidate.artifactHashes;
      if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.values(hashes).some(value => !digestPattern.test(value))) throw new Error('Invalid artifact hashes');
      if (requireArtifacts && Object.keys(hashes).length === 0) throw new Error('PASS requires artifact hashes');
      return save({ ...fields, finishedAt: new Date().toISOString() }, 'PASS');
    },
    fail(error) {
      return save({ finishedAt: new Date().toISOString(), error: String(error?.message ?? error), artifactHashes: {}, staticPackagedChecksPassed: false, nativeDesktopAcceptancePassed: false }, 'FAIL');
    },
    notRun(reason) {
      return save({ finishedAt: new Date().toISOString(), reason, artifactHashes: {}, staticPackagedChecksPassed: false, nativeDesktopAcceptancePassed: false }, 'NOT_RUN');
    },
  };
}

export function verifiedInput(file, expectedDigest) {
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (input.sourceVerified !== true || !digestPattern.test(input.sourceInputSha256 ?? '')) throw new Error('A verified source input receipt is required');
  if (expectedDigest !== undefined && expectedDigest !== input.sourceInputSha256) throw new Error('Requested source input digest differs from verified inputs');
  return input;
}

export function failAttempts(error, ...attempts) {
  const failures = [];
  for (const attempt of attempts.filter(Boolean)) {
    try { attempt.fail(error); } catch (failure) { failures.push(failure); }
  }
  if (failures.length) throw new AggregateError([error, ...failures], 'Operation failed and a current FAIL receipt could not be written');
  throw error;
}
