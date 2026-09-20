import fs from 'node:fs';
import { runTask, validateTaskOptions } from './runner.js';
import { cloudConsentNotice } from './task.js';

const MAX_FILE_BYTES = 64 * 1024;
const BOOLEAN_FLAGS = new Map([
  ['--enable-fast-agent', 'enabled'],
  ['--dry-run', 'dryRun'],
  ['--allow-text-helper', 'allowTextHelper'],
  ['--ask-on-block', 'askOnBlock'],
]);
const VALUE_FLAGS = new Map([
  ['--url', 'url'], ['--goal', 'goal'], ['--trace', 'tracePath'],
  ['--max-steps', 'maxSteps'], ['--max-model-calls', 'maxModelCalls'],
  ['--timeout-ms', 'timeoutMs'], ['--allow-domain', 'allowedDomains'],
  ['--click-name', 'clickNames'],
  ['--allowlist', 'allowlistFile'], ['--assertions', 'assertionsFile'],
  ['--inputs', 'inputsFile'],
]);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_TASK' });
}

function readArrayFile(filename, label) {
  let fd;
  try {
    // Do not open pipes/devices or follow symlinks while reading task data.
    if (!fs.lstatSync(filename).isFile()) throw invalid(`${label} must be a regular JSON file.`);
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw invalid(`${label} must be a JSON file of at most 64 KiB.`);
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size <= MAX_FILE_BYTES) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_FILE_BYTES) throw invalid(`${label} must be a JSON file of at most 64 KiB.`);
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!Array.isArray(value)) throw invalid(`${label} must contain a JSON array.`);
    return value;
  } catch (error) {
    if (error?.code === 'INVALID_TASK') throw error;
    // Native JSON and filesystem errors can include file contents or local paths.
    throw invalid(`${label} could not be read as a bounded JSON array.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Parse and validate all local arguments before any bridge or model operation. */
export function parseRunArgs(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw invalid('Run arguments must be strings.');
  }
  const options = { enabled: false, dryRun: false, allowTextHelper: false, askOnBlock: false, allowedDomains: [], clickNames: [] };
  const files = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = BOOLEAN_FLAGS.get(flag) || VALUE_FLAGS.get(flag);
    if (!key) throw invalid('Unknown run option. See docs/JEV_FAST_AGENT.md for supported flags.');
    if (seen.has(flag) && !['--allow-domain', '--click-name'].includes(flag)) throw invalid(`Duplicate ${flag} option.`);
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw invalid(`${flag} requires a value.`);
    if (['maxSteps', 'maxModelCalls', 'timeoutMs'].includes(key)) {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw invalid(`${flag} requires a positive integer.`);
      }
      options[key] = Number(value);
    } else if (key === 'allowedDomains') {
      options.allowedDomains.push(value);
    } else if (key === 'clickNames') {
      options.clickNames.push(value);
    } else if (key.endsWith('File')) {
      files[key] = value;
    } else {
      options[key] = value;
    }
  }
  if (files.allowlistFile) options.allowedDomains.push(...readArrayFile(files.allowlistFile, 'Allowlist'));
  if (files.assertionsFile) options.assertions = readArrayFile(files.assertionsFile, 'Assertions');
  if (files.inputsFile) options.inputs = readArrayFile(files.inputsFile, 'Inputs');
  return validateTaskOptions(options);
}

/** Run command with injectable runner and streams for offline interface tests. */
export async function runCli(argv, {
  runTaskImpl = runTask,
  stdout = process.stdout,
  stderr = process.stderr,
  signalSource = process,
  dependencies = {},
} = {}) {
  let options;
  try {
    options = parseRunArgs(argv);
  } catch (error) {
    const result = {
      status: 'error', verified: false, blockedReason: 'INVALID_TASK',
      summary: error?.code === 'INVALID_TASK' ? error.message : 'Invalid local task configuration.',
    };
    stdout.write(JSON.stringify(result) + '\n');
    return 1;
  }
  if (options.enabled && !options.dryRun) stderr.write(cloudConsentNotice(options.allowTextHelper, dependencies.env) + '\n');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signalSource.once('SIGINT', abort);
  signalSource.once('SIGTERM', abort);
  try {
    const result = await runTaskImpl({ ...options, signal: controller.signal }, dependencies);
    stdout.write(JSON.stringify(result) + '\n');
    return ['completed', 'dry_run', 'completion_candidate'].includes(result.status) ? 0 : 1;
  } catch {
    stdout.write(JSON.stringify({
      status: 'error', verified: false, blockedReason: 'INTERNAL',
      summary: 'The fast task stopped unexpectedly; no automatic retry was attempted.',
    }) + '\n');
    return 1;
  } finally {
    signalSource.removeListener('SIGINT', abort);
    signalSource.removeListener('SIGTERM', abort);
  }
}
