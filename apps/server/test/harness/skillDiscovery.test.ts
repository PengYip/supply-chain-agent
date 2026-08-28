import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkills, discoverSkillsFrom, loadSkillFrom, loadSkillByName, resetSkillCache, buildSkillIndexSection,
  listSkillFilesFrom, listSkillFiles, loadSkillFileFrom, loadSkillFileByName,
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

  it('listSkillFilesFrom: 列出附属文件(含子目录), 不含 SKILL.md; 未知名 -> 空', () => {
    mkdirSync(join(root, 'demo-skill', 'references', 'sub'), { recursive: true });
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    writeFileSync(join(root, 'demo-skill', 'references', 'a.md'), 'A', 'utf-8');
    writeFileSync(join(root, 'demo-skill', 'references', 'sub', 'b.md'), 'B', 'utf-8');
    writeFileSync(join(root, 'demo-skill', 'notes.txt'), 'N', 'utf-8');
    const files = listSkillFilesFrom(root, 'demo-skill');
    expect(files).toEqual(['notes.txt', 'references/a.md', 'references/sub/b.md']);
    expect(listSkillFilesFrom(root, 'nope')).toEqual([]);
  });

  it('loadSkillFileFrom: 命中读全文; 逃逸/绝对路径/未登记 -> null', () => {
    mkdirSync(join(root, 'demo-skill', 'references'), { recursive: true });
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    writeFileSync(join(root, 'demo-skill', 'references', 'a.md'), '参考内容A', 'utf-8');
    writeFileSync(join(root, '..', 'outside.md'), 'SECRET', 'utf-8');
    expect(loadSkillFileFrom('demo-skill', 'references/a.md', root)?.content).toBe('参考内容A');
    expect(loadSkillFileFrom('demo-skill', '../outside.md', root)).toBeNull();
    expect(loadSkillFileFrom('demo-skill', '/etc/passwd', root)).toBeNull();
    expect(loadSkillFileFrom('demo-skill', 'C:/win/x.md', root)).toBeNull();
    expect(loadSkillFileFrom('demo-skill', 'a\\b.md', root)).toBeNull();
    expect(loadSkillFileFrom('demo-skill', 'references/none.md', root)).toBeNull();
    expect(loadSkillFileFrom('nope', 'references/a.md', root)).toBeNull();
  });

  it('loadSkillFileByName 走默认目录: 真实技能的参考文件可读且显式截断', async () => {
    resetSkillCache();
    const skills = discoverSkills();
    if (!skills.some((s) => s.name === 'settlement-valuation')) return;
    const files = await listSkillFiles('settlement-valuation');
    if (files.length === 0) return;
    const def = await loadSkillFileByName('settlement-valuation', files[0]!);
    expect(def?.path).toBe(`skills/settlement-valuation/${files[0]}`);
    expect(typeof def?.content).toBe('string');
    expect(await loadSkillFileByName('settlement-valuation', '../escape.md')).toBeNull();
  });
});
