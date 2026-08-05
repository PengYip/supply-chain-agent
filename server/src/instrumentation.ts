// OpenTelemetry instrumentation for Langfuse.
//
// This module MUST be the first thing imported by the server entrypoint
// (index.ts) so that tracing is initialized before the AI SDK registers its
// tracers. AI SDK 6 emits native OTel spans for the agent loop
// (invoke_agent -> invoke_step -> execute_tool), which Langfuse turns into its
// trace tree.
//
// Ordering note: this runs BEFORE env.ts, so we must load the project-root
// .env HERE (before constructing LangfuseSpanProcessor, which reads
// LANGFUSE_*). `LangfuseSpanProcessor` auto-builds its OTLP/HTTP exporter from
// those env vars -- do NOT hand-write an OTLP exporter.
//
// Telemetry is best-effort: any failure to start/export must never break the
// business request path (streamText).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { GenAiSemConvEnricher } from './telemetry/genAiEnricher.js';

// Load project-root .env (server/src/instrumentation.ts -> ../../.env) so that
// LANGFUSE_* are present in process.env before the processor is constructed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ESM guarantees this module body evaluates exactly once per process, so
// `instrumentationStarted` also doubles as the idempotency guard.
export const instrumentationStarted = (() => {
  const endpoint = process.env.LANGFUSE_BASE_URL;
  const hasKeys =
    !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;
  try {
    const sdk = new NodeSDK({
      serviceName: 'supply-chain-agent-server',
      // GenAiSemConvEnricher derives gen_ai.input.messages / gen_ai.output.messages
      // from the AI SDK 6 ai.* content attributes so Langfuse's Input/Output fields
      // populate. It wraps and delegates to LangfuseSpanProcessor.
      spanProcessors: [new GenAiSemConvEnricher(new LangfuseSpanProcessor())],
    });
    sdk.start();
    if (endpoint && hasKeys) {
      console.log(`Langfuse instrumentation started, endpoint=${endpoint}`);
    } else {
      console.log(
        'Langfuse instrumentation started (LANGFUSE_* not fully set; spans will not export).',
      );
    }
    // Best-effort flush on shutdown so buffered spans are not lost.
    process.on('SIGTERM', () => {
      sdk.shutdown().catch(() => {});
    });
    return true;
  } catch (err) {
    console.error(
      'Langfuse instrumentation failed to start (non-fatal, continuing):',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
})();
