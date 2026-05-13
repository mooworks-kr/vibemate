import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

// Sprint 24 (ijze) — Context Brief coverage. Each test mints a fresh
// tmpdir DB and (when needed) drops a CLAUDE.md into the project root so
// the marker-extract path has something to read.

let t: ReturnType<typeof createTempDb>;
beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

const HOUR = 60 * 60 * 1000;

/** Write a CLAUDE.md to the temp project root with content wrapped in
 *  the vibemate markers — the same markers `migrateClaudeMd` uses. The
 *  brief extractor reads the body between them. */
function writeClaudeMd(rootPath: string, body: string): void {
  const content = `# Some User Title\n\nThe user's own intro paragraph.\n\n${domain.VIBEMATE_SECTION_BEGIN}\n${body}\n${domain.VIBEMATE_SECTION_END}\n\nUser content after the section.\n`;
  fs.writeFileSync(path.join(rootPath, 'CLAUDE.md'), content);
}

function makeProject(name = 'P'): { projectId: string; rootPath: string } {
  const p = domain.createProject({ name, rootPath: t.dir, tagline: '한 줄', goal: '목표', tech: ['ts', 'sqlite'] });
  return { projectId: p.id, rootPath: t.dir };
}

describe('getContextBrief — happy path', () => {
  it('returns markdown + sections covering every block in the inventory order', () => {
    const { projectId, rootPath } = makeProject('샘플 프로젝트');
    writeClaudeMd(rootPath, '\n## 이 프로젝트는 Vibemate가 활성화되어 있습니다\n\nguide body line\n');
    const feat = domain.createFeature({
      projectId, name: '결제', status: 'in_progress',
      goal: '결제 흐름 다듬기', spec_md: '## 범위\n- 카드 결제',
    });
    domain.addTask(feat.id, '카드 폼 작성');
    domain.addTask(feat.id, '검증 로직');
    domain.logDecision({ projectId, featureId: feat.id, title: 'PG 선택' });

    const brief = domain.getContextBrief(feat.id);
    // Sections — structural projection.
    expect(brief.sections.project.name).toBe('샘플 프로젝트');
    expect(brief.sections.project.tech).toEqual(['ts', 'sqlite']);
    expect(brief.sections.claude_guide.body).toContain('guide body line');
    expect(brief.sections.feature.name).toBe('결제');
    expect(brief.sections.feature.spec_md).toContain('## 범위');
    expect(brief.sections.open_tasks.map((t) => t.name)).toEqual(['카드 폼 작성', '검증 로직']);
    expect(brief.sections.recent_decisions[0]!.title).toBe('PG 선택');

    // Markdown — block ordering check via indexOf.
    const md = brief.markdown;
    expect(md.startsWith('# Context Brief')).toBe(true);
    const order = ['## 프로젝트', '## CLAUDE 가이드', '## 기능 — 결제', '## 열린 작업', '## 연결된 파일', '## 문서', '## 최근 결정', '## 최근 세션'];
    for (let i = 1; i < order.length; i++) {
      expect(md.indexOf(order[i]!)).toBeGreaterThan(md.indexOf(order[i - 1]!));
    }
  });

  it('throws on unknown feature id (matches getContext convention)', () => {
    expect(() => domain.getContextBrief('no-such-feature')).toThrow(/Feature not found/);
  });
});

describe('getContextBrief — CLAUDE.md handling', () => {
  it('skips the CLAUDE guide block when the file is absent', () => {
    const { projectId } = makeProject();
    const feat = domain.createFeature({ projectId, name: 'F' });
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.claude_guide.body).toBeNull();
    expect(brief.markdown).not.toContain('## CLAUDE 가이드');
  });

  it('skips the CLAUDE guide block when the file has no vibemate markers', () => {
    const { projectId, rootPath } = makeProject();
    fs.writeFileSync(path.join(rootPath, 'CLAUDE.md'), '# Just a user file\n\nNo marker here.\n');
    const feat = domain.createFeature({ projectId, name: 'F' });
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.claude_guide.body).toBeNull();
    expect(brief.markdown).not.toContain('## CLAUDE 가이드');
  });

  it('strips the template-version meta comment from the extracted body', () => {
    const { projectId, rootPath } = makeProject();
    writeClaudeMd(rootPath, '\n<!-- vibemate-template-version: 4 -->\n\n## 이 프로젝트…\n\nbody\n');
    const feat = domain.createFeature({ projectId, name: 'F' });
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.claude_guide.body).not.toContain('vibemate-template-version');
    expect(brief.sections.claude_guide.body).toContain('body');
  });

  it('excludes user content outside the markers (privacy guard)', () => {
    const { projectId, rootPath } = makeProject();
    // The writeClaudeMd helper itself adds "User content after the section"
    // outside the END marker — we never want to include it.
    writeClaudeMd(rootPath, '\nfriendly guide\n');
    const feat = domain.createFeature({ projectId, name: 'F' });
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.claude_guide.body).toContain('friendly guide');
    expect(brief.sections.claude_guide.body).not.toContain("User content after the section");
    expect(brief.sections.claude_guide.body).not.toContain("The user's own intro");
  });
});

describe('getContextBrief — caps and truncation markers', () => {
  it('caps linked_files at 20 by default and appends a `…등 N건 생략` line', () => {
    const { projectId } = makeProject();
    const feat = domain.createFeature({ projectId, name: 'F' });
    // 25 files; default cap is 20 → 5 overflow.
    for (let i = 0; i < 25; i++) {
      domain.linkFile({ featureId: feat.id, filePath: `src/f${i}.ts` });
    }
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.linked_files).toHaveLength(20);
    expect(brief.sections.linked_files_overflow).toBe(5);
    expect(brief.markdown).toContain('…등 5건 생략');
  });

  it('caps documents at 5 with overflow surfaced both in sections + markdown', () => {
    const { projectId } = makeProject();
    const feat = domain.createFeature({ projectId, name: 'F' });
    for (let i = 0; i < 7; i++) {
      const d = domain.createDocument({
        projectId, kind: 'planning', title: `doc-${i}`, content_md: 'x'.repeat(300),
      });
      domain.linkDocumentToFeature(d.id, feat.id);
    }
    const brief = domain.getContextBrief(feat.id);
    expect(brief.sections.documents).toHaveLength(5);
    expect(brief.sections.documents_overflow).toBe(2);
    // Document excerpts capped at 200 chars + ellipsis.
    for (const d of brief.sections.documents) {
      expect(d.excerpt.length).toBeLessThanOrEqual(201);
      expect(d.excerpt.endsWith('…')).toBe(true);
    }
  });

  it('honours an explicit caps override (linked_files=3)', () => {
    const { projectId } = makeProject();
    const feat = domain.createFeature({ projectId, name: 'F' });
    for (let i = 0; i < 10; i++) {
      domain.linkFile({ featureId: feat.id, filePath: `src/f${i}.ts` });
    }
    const brief = domain.getContextBrief(feat.id, { caps: { linked_files: 3 } });
    expect(brief.sections.linked_files).toHaveLength(3);
    expect(brief.sections.linked_files_overflow).toBe(7);
  });
});

describe('getContextBrief — ordering rules', () => {
  it('puts feature-tied decisions before project-wide decisions', () => {
    const { projectId } = makeProject();
    const f1 = domain.createFeature({ projectId, name: 'A' });
    const f2 = domain.createFeature({ projectId, name: 'B' });
    // Two decisions tied to f1, two to f2, two to nothing.
    domain.logDecision({ projectId, featureId: f1.id, title: 'f1-decision-1' });
    domain.logDecision({ projectId, featureId: f2.id, title: 'f2-decision' });
    domain.logDecision({ projectId, featureId: f1.id, title: 'f1-decision-2' });
    domain.logDecision({ projectId, title: 'orphan-decision' });

    const brief = domain.getContextBrief(f1.id);
    const titles = brief.sections.recent_decisions.map((d) => d.title);
    // f1-tied entries must show up first; the orphan + f2's come after.
    const firstFeatureIndex = titles.indexOf('f1-decision-2');
    const orphanIndex = titles.indexOf('orphan-decision');
    expect(firstFeatureIndex).toBeGreaterThanOrEqual(0);
    expect(orphanIndex).toBeGreaterThan(firstFeatureIndex);
  });

  it('picks recent_sessions from the same feature, newest first', () => {
    const { projectId } = makeProject();
    const feat = domain.createFeature({ projectId, name: 'F' });
    const db = getDb();
    const base = Date.now() - 10 * HOUR;
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO sessions (id, project_id, feature_id, started_at, summary)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`s-${i}`, projectId, feat.id, base + i * HOUR, `summary-${i}`);
    }
    const brief = domain.getContextBrief(feat.id);
    // Default cap is 3 — expect the 3 newest in DESC order.
    expect(brief.sections.recent_sessions.map((s) => s.summary)).toEqual([
      'summary-4', 'summary-3', 'summary-2',
    ]);
    expect(brief.sections.recent_sessions_overflow).toBe(2);
  });
});
