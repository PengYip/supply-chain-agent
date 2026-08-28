import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkills, discoverSkillsFrom, loadSkillFrom, loadSkillByName, resetSkillCache, buildSkillIndexSection,
} from '../../src/harness/skillDiscovery.js';

// Skill 发现层单测(2026-08-28 Skill 化): frontmatter 解析/坏技能跳过/按名加载/索引段。
// 目录不存在与坏 frontmatter 必须是"跳过/空", 不允许阻塞启动(spec §9)。

const GOOD = `---
name: demo-skill
description: 演示技能。
whenToUse: 测试时加载。
---
正文第一行
`;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sca-skills-'));
}

let root: string;
beforeEach(() => { root = makeRoot(); resetSkillCache(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); resetSkillCache(); });

describe('skillDiscovery', () => {
  it('解析 frontmatter 三要素', () => {
    mkdirSync(join(root, 'demo-skill'));
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    const skills = discoverSkillsFrom(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'demo-skill',
      description: '演示技能。',
      whenToUse: '测试时加载。',
      path: 'skills/demo-skill/SKILL.md',
    });
  });

  it('缺 frontmatter / 缺字段 / 目录名不一致 -> 跳过; 目录不存在 -> 空', () => {
    mkdirSync(join(root, 'bad1'));
    writeFileSync(join(root, 'bad1', 'SKILL.md'), '没有 frontmatter', 'utf-8');
    mkdirSync(join(root, 'bad2'));
    writeFileSync(join(root, 'bad2', 'SKILL.md'), '---\nname: bad2\n---\n正文', 'utf-8');
    mkdirSync(join(root, 'wrong-dir'));
    writeFileSync(join(root, 'wrong-dir', 'SKILL.md'), GOOD.replace('demo-skill', 'other'), 'utf-8');
    expect(discoverSkillsFrom(root)).toEqual([]);
    expect(discoverSkillsFrom(join(root, 'not-exist'))).toEqual([]);
  });

  it('loadSkillFrom 返回剥离 frontmatter 的正文; 未知名 -> null', () => {
    mkdirSync(join(root, 'demo-skill'));
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    const def = loadSkillFrom('demo-skill', root);
    expect(def?.content).toBe('正文第一行');
    expect(def?.name).toBe('demo-skill');
    expect(loadSkillFrom('nope', root)).toBeNull();
  });

  it('loadSkillByName 走默认目录缓存', async () => {
    resetSkillCache();
    const skills = discoverSkills();
    if (skills.some((s) => s.name === 'settlement-valuation')) {
      const def = await loadSkillByName('settlement-valuation');
      expect(def?.content).toContain('暂估');
    } else {
      expect(await loadSkillByName('settlement-valuation')).toBeNull();
    }
  });

  it('buildSkillIndexSection: 无技能空串; 有技能含名字与规则', () => {
    expect(buildSkillIndexSection([])).toBe('');
    const section = buildSkillIndexSection([
      { name: 'demo-skill', description: '演示技能。', whenToUse: '测试时加载。', path: 'skills/demo-skill/SKILL.md' },
    ]);
    expect(section).toContain('可用技能');
    expect(section).toContain('demo-skill');
    expect(section).toContain('load_skill');
  });
});
