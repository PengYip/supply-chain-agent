import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildOntologyVocabSection } from '../../src/harness/agent.js';

describe('system prompt ontology vocabulary section (wave3)', () => {
  it('system prompt carries ontology vocabulary section', () => {
    expect(SYSTEM_PROMPT).toContain('GoodsReceiptEvent');
    expect(SYSTEM_PROMPT).toContain('BELONGS_TO');
    expect(SYSTEM_PROMPT).toContain('本体词汇');
    expect(SYSTEM_PROMPT).toContain('entity=ontology');
  });

  it('buildOntologyVocabSection renders a bounded section (<=25 lines, header + tail)', () => {
    const sec = buildOntologyVocabSection();
    const lines = sec.split('\n');
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(lines[0]).toContain('本体词汇');
    expect(lines[lines.length - 1]).toContain('entity=ontology/neighbors/writeoff');
    // 12 实体名逐个出现在节内
    for (const name of ['TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit', 'TradeProject',
      'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
      'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent']) {
      expect(sec).toContain(name);
    }
  });
});
