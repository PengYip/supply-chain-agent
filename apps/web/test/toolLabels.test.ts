import { describe, expect, it } from 'vitest'
import { toolLabel } from '../src/lib/toolLabels'

describe('toolLabel', () => {
  it('maps every registered agent tool to a Chinese business alias', () => {
    const tools = [
      'query_business',
      'escalate_to_human',
      'load_skill',
      'ingest_document',
      'bind_document',
      'recall_documents',
      'execute_code',
      'inspect_extraction',
      'link_documents',
      'create_entity',
      'link_entities',
      'graph_query',
      'graph_find_entity',
      'present_document_review',
      'update_document_fields',
      'list_binding_proposals',
      'manage_template',
      'manage_quota',
      'gather_settlement_evidence',
      'confirm_settlement',
    ]

    for (const tool of tools) {
      expect(toolLabel(tool), `${tool} needs a Chinese alias`).not.toBe(tool)
      expect(toolLabel(tool).trim()).not.toBe('')
    }
  })

  it('falls back to the technical name for unknown tools', () => {
    expect(toolLabel('future_tool')).toBe('future_tool')
  })
})
