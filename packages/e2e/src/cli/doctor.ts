/** `e2e doctor --json`: cheap preflight for a host before a run or task. */

import fs from 'node:fs';
import { unsupportedRuntimeMessage } from '../internal/node-version.ts';
import { packageVersion } from '../internal/package-version.ts';
import { envValue } from '../internal/env.ts';
import { discoverConfig, loadConfigModule } from '../config/load.ts';
import { resolveConfig, type CliOverrides } from '../config/resolve.ts';

export interface DoctorOptions {
  readonly json?: boolean;
  readonly config?: string;
  readonly cwd?: string;
}

export type DoctorStatus = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message?: string;
  readonly targets?: readonly string[];
  readonly reads?: readonly string[];
  readonly code?: string;
}

export interface DoctorResult {
  readonly version: string;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface CredentialEnv {
  readonly id: string;
  readonly label: string;
}

const MODEL_ENV_VARS: readonly CredentialEnv[] = [
  { id: 'AI_GATEWAY_API_KEY', label: 'Vercel AI Gateway' },
  { id: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
];

export async function doctor(options: DoctorOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const result = await runDoctor(options, cwd);
  if (options.json !== false) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`e2e ${result.version}: ${result.ok ? 'ok' : 'not ready'}`);
    for (const check of result.checks) {
      const suffix = check.message ? `: ${check.message}` : '';
      console.log(`${check.status.toUpperCase()} ${check.id}${suffix}`);
    }
  }
  return result.ok ? 0 : 2;
}

async function runDoctor(options: DoctorOptions, cwd: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  checks.push(nodeCheck());

  let config;
  let discoveredPath: string | undefined;
  let projectRoot = cwd;
  try {
    const discovered = discoverConfig(cwd, options.config);
    discoveredPath = discovered.configPath;
    projectRoot = discovered.projectRoot;
    if (discovered.configPath === undefined) {
      checks.push({
        id: 'config',
        status: 'fail',
        message: 'no config file found; run e2e init or pass --config <path>',
      });
      return { version: packageVersion(import.meta.url, '../../package.json', '0.0.0'), ok: false, checks };
    }

    try {
      config = await loadConfigModule(discovered.configPath);
      checks.push({ id: 'config', status: 'pass', message: discovered.configPath });
    } catch (cause) {
      checks.push({
        id: 'config',
        status: 'fail',
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return { version: packageVersion(import.meta.url, '../../package.json', '0.0.0'), ok: false, checks };
    }

    let resolved;
    try {
      resolved = resolveConfig(config, {
        projectRoot,
        configPath: discovered.configPath,
        env: process.env,
        cli: {} as CliOverrides,
      });
    } catch (cause) {
      checks.push({
        id: 'config',
        status: 'fail',
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return { version: packageVersion(import.meta.url, '../../package.json', '0.0.0'), ok: false, checks };
    }

    const credentialReads = missingCredentialReads(discovered.configPath);
    checks.push(credentialReads.length === 0
      ? { id: 'model-credentials', status: 'pass', reads: credentialReads }
      : {
          id: 'model-credentials',
          status: 'fail',
          code: 'MODEL_UNAVAILABLE',
          message: `missing: ${credentialReads.join(', ')}`,
          reads: credentialReads,
        });

    checks.push({
      id: 'targets',
      status: resolved.targets.length > 0 ? 'pass' : 'skip',
      targets: resolved.targets.map((target: { name: string }) => target.name),
    });
  } catch (cause) {
    checks.push({
      id: 'config',
      status: 'fail',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  checks.push({
    id: 'browser',
    status: 'skip',
    message: 'browser installation is not checked by doctor; e2e run reports it',
  });

  const ok = checks.every((check) => check.status !== 'fail');
  return { version: packageVersion(import.meta.url, '../../package.json', '0.0.0'), ok, checks };
}

function nodeCheck(): DoctorCheck {
  const message = unsupportedRuntimeMessage(process.versions);
  if (message === undefined) return { id: 'node', status: 'pass', message: process.version };
  return { id: 'node', status: 'fail', message };
}

function missingCredentialReads(configPath: string): string[] {
  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  const unread: string[] = [];
  for (const entry of MODEL_ENV_VARS) {
    if (content.includes(entry.id) && !envValue(process.env, entry.id)) {
      unread.push(entry.id);
    }
  }
  return unread;
}