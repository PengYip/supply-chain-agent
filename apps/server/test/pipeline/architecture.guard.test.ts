import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pipelineRoot = join(here, '../../src/pipeline');
const domainRoot = join(here, '../../src/domain');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * L0/L1 分离守卫: pipeline 内核(机制层)不得声明贸易业务词汇, 只能从
 * domain(tradeSemantics/flowDirection) import。词汇以 TradeVocabulary
 * 数据形态注入, 内核再写死 Record/Set/switch 即视为分层泄漏回流。
 * 只匹配「声明」——import 与调用 domain 助手是合法的。
 */
describe('architecture guard: trade vocabulary lives in src/domain', () => {
  it('no pipeline kernel file re-declares trade vocabulary', () => {
    const offenders: string[] = [];
    for (const file of walk(pipelineRoot)) {
      const src = readFileSync(file, 'utf8');
      if (
        /const\s+(TRADE_VOCAB|REL_ROLE_BY_FIELD|COMMODITY_FIELDS|CONTRACT_FIELDS|EXECUTES_DOCTYPES|CHUNK_TAG_TAXONOMY)\s*=/.test(
          src,
        ) ||
        /function\s+(bindingRelationFor|getTaxonomy|normalizeCompanyName|resolveSelfSide)\s*\(/.test(src)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders, `kernel files re-declare business vocabulary: ${offenders.join(', ')}`).toEqual([]);
  });

  it('domain modules stay outside pipeline/ (演进为独立版本化包的落点)', () => {
    expect(existsSync(join(domainRoot, 'tradeSemantics.ts'))).toBe(true);
    expect(existsSync(join(domainRoot, 'flowDirection.ts'))).toBe(true);
    expect(existsSync(join(pipelineRoot, 'tag-taxonomy.ts'))).toBe(false);
    expect(existsSync(join(pipelineRoot, 'domain'))).toBe(false);
  });
});
