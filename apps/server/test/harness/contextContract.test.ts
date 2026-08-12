import { describe, it, expect } from 'vitest';
import {
  TOOL_CONTEXT_CONTRACTS,
  getContract,
  hasContract,
  assertAllToolsContracted,
  getTaggedOutputTools,
  getExternalHandlingTools,
} from '../../src/harness/contextContract.js';
import { getPermission } from '../../src/harness/permissionGate.js';
import { listToolNames } from '../../src/harness/roleToolRegistry.js';

// The canonical tool names the trader role actually exposes (the union of
// BASE_TOOLS_FOR_ROLE + the DbContext-dependent appends, including recall). Sourced
// from the registry so a newly-added tool forces a test update here (no silent drift).
const EXPECTED_TOOLS = [
  'query_contract',
  'query_orders',
  'cross_check',
  'link_document',
  'create_payment',
  'escalate_to_human',
  'verify_document_fields',
  'ingest_document',
  'extract_fields',
  'bind_document',
  'recall_documents',
  'execute_code',
  'inspect_extraction',
] as const;

describe('tool-context contract registry', () => {
  it('contracts every tool the trader role exposes', () => {
    const live = listToolNames('trader');
    // listToolNames is the source of truth for "which tools can go live".
    const missing = live.filter((n) => !hasContract(n));
    expect(missing, `tools missing contracts: ${missing.join(', ')}`).toEqual([]);
    // And the explicit expected set is exactly contracted too.
    for (const name of EXPECTED_TOOLS) {
      expect(hasContract(name), `${name} should have a contract`).toBe(true);
    }
  });

  it('has exactly the expected set of contracted tool names', () => {
    expect(Object.keys(TOOL_CONTEXT_CONTRACTS).sort()).toEqual(
      [...EXPECTED_TOOLS].sort(),
    );
  });

  it('getContract returns the registered contract', () => {
    const c = getContract('create_payment');
    expect(c.risk.level).toBe('L3');
    expect(c.persist).toBe('business');
  });

  it('getContract throws for an unknown tool (contract is mandatory)', () => {
    expect(() => getContract('does_not_exist')).toThrow(/no contract registered/);
  });

  it('hasContract returns false for unregistered names', () => {
    expect(hasContract('nope')).toBe(false);
  });

  it('assertAllToolsContracted passes for the full live toolset', () => {
    expect(() => assertAllToolsContracted(listToolNames('trader'))).not.toThrow();
  });

  it('assertAllToolsContracted throws listing the offending names', () => {
    expect(() =>
      assertAllToolsContracted(['query_contract', 'ghost_tool', 'phantom']),
    ).toThrow(/ghost_tool, phantom/);
  });
});

describe('contract injection-exposure mapping (integration point 1)', () => {
  it('marks tools that RETURN external-derived content as output tagged', () => {
    // extract_fields + verify_document_fields return field/OCR strings derived
    // from uploaded documents, and recall_documents returns BM25 snippets of
    // ingested doc text -> all must be wrapped in <external_content>. execute_code
    // runs user-supplied Python whose stdout can carry injection payloads too.
    expect(getTaggedOutputTools().sort()).toEqual(
      ['execute_code', 'extract_fields', 'inspect_extraction', 'recall_documents', 'verify_document_fields'].sort(),
    );
  });

  it('marks tools that HANDLE external content (even when output is raw)', () => {
    // ingest_document returns only a {docId,...} handle (output raw) but still
    // parsed an untrusted file -> injection external. extract/verify both handle
    // AND return external content. recall_documents reads back that doc text.
    // execute_code runs untrusted user code (injection external).
    expect(getExternalHandlingTools().sort()).toEqual(
      ['execute_code', 'extract_fields', 'ingest_document', 'inspect_extraction', 'recall_documents', 'verify_document_fields'].sort(),
    );
  });

  it('ingest_document output is raw but injection is external', () => {
    const c = getContract('ingest_document');
    expect(c.output).toBe('raw');
    expect(c.risk.injection).toBe('external');
  });
});

describe('contract <-> permissionGate consistency', () => {
  it('every contracted tool with a permission level agrees with the gate', () => {
    // The contract risk.level and the PermissionGate must not disagree for any
    // tool that is registered in BOTH places. Guards against drift when a tool
    // is re-leveled in one place but not the other.
    for (const [name, contract] of Object.entries(TOOL_CONTEXT_CONTRACTS)) {
      const gateLevel = getPermission(name);
      if (gateLevel === undefined) continue; // not in the gate (ok)
      expect(
        contract.risk.level,
        `${name}: contract says ${contract.risk.level} but gate says ${gateLevel}`,
      ).toBe(gateLevel);
    }
  });
});
