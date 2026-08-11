import { tool } from 'ai';
import { z } from 'zod';
import https from 'node:https';
import { tagExternal } from '../../harness/injectionDefense.js';

// CubeSandbox code execution tool. Connects to a deployed CubeSandbox instance
// (E2B-compatible REST API) and executes Python code in an isolated microVM
// sandbox. The sandbox runs Python 3.12 with the standard library; no network
// egress, no persistent state between calls.
//
// Protocol (verified end-to-end against CubeSandbox v0.6.0):
//   1. Create:  POST {cubeApiUrl}/sandboxes  {"templateID": alias}
//      -> {"sandboxID": "...", "domain": "cube.app", ...}
//   2. Execute: POST https://49999-{sandboxID}.{domain}/execute  {"code": "..."}
//      -> NDJSON stream (one JSON per line):
//         {"type": "number_of_executions", "execution_count": N}
//         {"type": "stdout", "text": "...", "timestamp": "..."}
//         {"type": "stderr", "text": "...", "timestamp": "..."}
//         {"type": "result", "text": "...", "is_main_result": true}
//         {"type": "error", "name": "...", "value": "...", "traceback": [...]}
//         {"type": "end_of_execution"}
//   3. Kill:    DELETE {cubeApiUrl}/sandboxes/{sandboxID}  -> 204
//
// Lifecycle: per-call (MVP). Each invocation creates a fresh sandbox, runs
// code, and tears it down in `finally`. A session-level reuse upgrade is
// possible later by caching sandboxID on the session and reusing it.
//
// Injection defense: all stdout/stderr/result/error text is wrapped with
// tagExternal() because user code can print arbitrary content (including
// prompt-injection text) to stdout. The output contract is 'tagged'.

export interface ExecuteCodeDeps {
  /** CubeAPI REST endpoint, e.g. http://172.18.10.150:3040 */
  cubeApiUrl: string;
  /** Sandbox domain for {port}-{sandboxID}.{domain} URL construction. */
  sandboxDomain: string;
  /** Template alias to instantiate (must exist on the CubeSandbox cluster). */
  templateAlias: string;
}

/** Timeout for the entire code execution (ms). */
const EXECUTE_TIMEOUT_MS = 30_000;

interface SandboxCreateResponse {
  sandboxID: string;
  domain: string;
}

interface NDJSONMessage {
  type: 'stdout' | 'stderr' | 'result' | 'error' | 'number_of_executions' | 'end_of_execution';
  text?: string;
  timestamp?: string;
  execution_count?: number;
  name?: string;
  value?: string;
  traceback?: string[];
  is_main_result?: boolean;
}

/**
 * Create a sandbox instance via cube-api REST.
 * Uses fetch (HTTP, no TLS issues on port 3040).
 */
async function createSandbox(
  apiUrl: string,
  templateAlias: string,
): Promise<SandboxCreateResponse> {
  const res = await fetch(`${apiUrl}/sandboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateID: templateAlias }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `cube-api: failed to create sandbox (HTTP ${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as SandboxCreateResponse;
}

/**
 * Kill a sandbox instance via cube-api REST. Best-effort: errors are swallowed
 * because this runs in a finally block and must not mask the real result/error.
 */
async function killSandbox(apiUrl: string, sandboxId: string): Promise<void> {
  try {
    await fetch(`${apiUrl}/sandboxes/${sandboxId}`, { method: 'DELETE' });
  } catch {
    // Swallow: cleanup failure is non-fatal.
  }
}

/**
 * Execute Python code in the sandbox via the envd code interpreter (port 49999).
 * Uses node:https directly (not fetch) to set rejectUnauthorized=false for the
 * self-signed mkcert certificate on CubeProxy.
 *
 * Returns the raw NDJSON response body (one JSON object per line).
 */
function executeInSandbox(
  sandboxId: string,
  domain: string,
  code: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hostname = `49999-${sandboxId}.${domain}`;
    const bodyStr = JSON.stringify({ code });
    const req = https.request(
      {
        hostname,
        port: 443,
        path: '/execute',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'E2b-Sandbox-Id': sandboxId,
          'E2b-Sandbox-Port': '49999',
        },
        rejectUnauthorized: false, // CubeProxy uses mkcert self-signed CA
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`sandbox execute failed (HTTP ${res.statusCode})`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      },
    );
    req.setTimeout(EXECUTE_TIMEOUT_MS, () => {
      req.destroy(new Error(`sandbox execute timed out after ${EXECUTE_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Parse NDJSON response into typed messages.
 */
function parseNDJSON(raw: string): NDJSONMessage[] {
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as NDJSONMessage;
      } catch {
        // Skip unparseable lines (shouldn't happen with a well-behaved envd).
        return { type: 'end_of_execution' as const };
      }
    });
}

export function buildExecuteCodeTool(deps: ExecuteCodeDeps) {
  return tool({
    description:
      '在隔离沙箱中执行 Python 3.12 代码。适用于数值计算、数据分析、单据对账、公式验算、批量处理等需要精确计算或数据处理的场景。沙箱环境无网络访问、无持久状态，每次调用独立。返回代码的 stdout、stderr、执行结果和错误信息（如有）。',
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          '要执行的 Python 代码。支持标准库（math, json, datetime, re, statistics 等），' +
            '无第三方包。多行代码用换行分隔。',
        ),
    }),
    execute: async ({ code }) => {
      let sandbox: SandboxCreateResponse | null = null;
      try {
        // 1. Create sandbox
        sandbox = await createSandbox(deps.cubeApiUrl, deps.templateAlias);

        // 2. Execute code
        const raw = await executeInSandbox(sandbox.sandboxID, deps.sandboxDomain, code);
        const messages = parseNDJSON(raw);

        // 3. Aggregate results
        const stdout = messages
          .filter((m) => m.type === 'stdout')
          .map((m) => m.text ?? '')
          .join('');
        const stderr = messages
          .filter((m) => m.type === 'stderr')
          .map((m) => m.text ?? '')
          .join('');
        const results = messages.filter((m) => m.type === 'result');
        const errors = messages.filter((m) => m.type === 'error');
        const execCount = messages.find((m) => m.type === 'number_of_executions');

        const hasError = errors.length > 0;

        // Wrap all external-derived text with tagExternal for injection defense.
        return {
          status: hasError ? ('error' as const) : ('success' as const),
          executionCount: execCount?.execution_count ?? 1,
          stdout: stdout ? tagExternal(stdout) : '',
          stderr: stderr ? tagExternal(stderr) : '',
          results: results.map((r) => ({
            text: tagExternal(r.text ?? ''),
            is_main_result: r.is_main_result ?? false,
          })),
          error: hasError
            ? {
                name: errors[0]?.name ?? 'UnknownError',
                value: tagExternal(errors[0]?.value ?? ''),
                traceback: (errors[0]?.traceback ?? []).map(tagExternal),
              }
            : null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'error' as const,
          executionCount: 0,
          stdout: '',
          stderr: '',
          results: [],
          error: {
            name: 'SandboxError',
            value: tagExternal(msg),
            traceback: [],
          },
        };
      } finally {
        // 4. Kill sandbox (always, even on error)
        if (sandbox) {
          await killSandbox(deps.cubeApiUrl, sandbox.sandboxID);
        }
      }
    },
  });
}
