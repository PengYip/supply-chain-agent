// Injection Defense (integration point 1 of the tool-context contract).
//
// External document content (uploaded files, OCR output, parsed fields) entering
// the agent context window must be delimited as DATA, not instructions, so an
// attacker cannot embed prompt-injection text inside a document field value and
// have the model execute it. This module provides two primitives:
//
//   (1) tagExternal  -- wraps a string leaf in <external_content>..</external_content>
//                       sentinels. Applied to every external-derived STRING value a
//                       'tagged' tool returns (extract_fields, verify_document_fields).
//   (2) assertWithinRoot -- path allowlist for ingest_document. The tool may only
//                       read files under INGEST_ROOT, blocking traversal
//                       (../../etc/passwd) and absolute paths outside the root.
//
// This is the FIRST consumer of the tool-context contract (contextContract.ts):
// it reads env.INGEST_ROOT for the allowlist and is applied to exactly the tools
// the contract marks output:'tagged' / risk.injection:'external'.

import path from 'node:path';
import { env } from '../env.js';

/** Opening sentinel for external content. Treat as DATA, not instructions. */
export const EXTERNAL_OPEN = '<external_content source="document">';

/** Closing sentinel for external content. */
export const EXTERNAL_CLOSE = '</external_content>';

/**
 * Wrap external-derived content in the data delimiters. Empty string is returned
 * unchanged so empty values do not emit a misleading pair of sentinels (which
 * would add noise without protecting anything).
 */
export function tagExternal(content: string): string {
  if (content === '') return content;
  return `${EXTERNAL_OPEN}\n${content}\n${EXTERNAL_CLOSE}`;
}

/**
 * Resolve `filePath` and assert it lives inside INGEST_ROOT. Returns the resolved
 * absolute path on success; throws on any path that escapes the root.
 *
 * Implementation note: the root is normalized to `path.resolve(...) + path.sep`
 * before the startsWith check. A bare startsWith(ROOT) would be vulnerable to a
 * prefix collision (root '/a/b' would wrongly accept '/a/bc/evil.pdf'); appending
 * the separator closes that hole. A path equal to the root itself (a directory,
 * never a readable file) is rejected because it lacks the trailing separator.
 */
export function assertWithinRoot(filePath: string): string {
  const root = path.resolve(env.INGEST_ROOT) + path.sep;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root)) {
    throw new Error('reject path outside ingest root: ' + filePath);
  }
  return resolved;
}
