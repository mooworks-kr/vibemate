import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

// Sprint 22 (3wtr) — Spec Hub coverage. Each test mints a fresh tmpdir DB
// via createTempDb() and drives the domain functions against it.

let t: ReturnType<typeof createTempDb>;
beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

function makeProject(name = 'P'): string {
  return domain.createProject({ name, rootPath: t.dir }).id;
}

describe('documents — CRUD', () => {
  it('createDocument inserts a row with stamped timestamps and returns it', () => {
    const pid = makeProject();
    const doc = domain.createDocument({
      projectId: pid,
      kind: 'prd',
      title: '결제 흐름 PRD',
      content_md: '## 배경\n결제가 느림.',
    });
    expect(doc.id).toMatch(/^[a-z0-9]+$/);
    expect(doc.project_id).toBe(pid);
    expect(doc.kind).toBe('prd');
    expect(doc.title).toBe('결제 흐름 PRD');
    expect(doc.content_md).toContain('결제가 느림');
    expect(doc.created_at).toBeGreaterThan(0);
    expect(doc.created_at).toBe(doc.updated_at);
  });

  it('createDocument throws on unknown project_id', () => {
    expect(() => domain.createDocument({
      projectId: 'no-such-project',
      kind: 'prd',
      title: 'x',
    })).toThrow(/Project not found/);
  });

  it('defaults content_md to empty string when omitted', () => {
    const pid = makeProject();
    const d = domain.createDocument({ projectId: pid, kind: 'other', title: 't' });
    expect(d.content_md).toBe('');
  });

  it('updateDocument merges only provided fields and bumps updated_at', async () => {
    const pid = makeProject();
    const d = domain.createDocument({
      projectId: pid, kind: 'planning', title: '초안', content_md: 'A',
    });
    const originalCreatedAt = d.created_at;
    // Small wait — `now()` is millisecond-resolution and a same-ms update
    // would tie. The other tests don't rely on the bump itself, so a 2ms
    // gap is enough to make the assertion deterministic.
    await new Promise((r) => setTimeout(r, 2));

    const updated = domain.updateDocument(d.id, { title: '결제 초안' })!;
    expect(updated.title).toBe('결제 초안');
    expect(updated.content_md).toBe('A'); // untouched
    expect(updated.kind).toBe('planning');
    expect(updated.created_at).toBe(originalCreatedAt);
    expect(updated.updated_at).toBeGreaterThan(originalCreatedAt);
  });

  it('deleteDocument removes the row + cascades document_features', () => {
    const pid = makeProject();
    const feat = domain.createFeature({ projectId: pid, name: 'F' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });
    domain.linkDocumentToFeature(d.id, feat.id);

    expect(domain.deleteDocument(d.id)).toBe(true);
    expect(domain.getDocument(d.id)).toBeNull();
    // Junction row must be gone too — ON DELETE CASCADE.
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM document_features WHERE document_id = ?')
      .get(d.id) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('cascade: deleting a project drops its documents + junction rows', () => {
    const pid = makeProject();
    const feat = domain.createFeature({ projectId: pid, name: 'F' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });
    domain.linkDocumentToFeature(d.id, feat.id);

    getDb().prepare('DELETE FROM projects WHERE id = ?').run(pid);

    const docs = getDb().prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(d.id) as { n: number };
    const links = getDb().prepare('SELECT COUNT(*) AS n FROM document_features WHERE document_id = ?').get(d.id) as { n: number };
    expect(docs.n).toBe(0);
    expect(links.n).toBe(0);
  });
});

describe('documents — listing', () => {
  it('lists documents ordered by updated_at DESC by default', async () => {
    const pid = makeProject();
    const a = domain.createDocument({ projectId: pid, kind: 'prd', title: 'A' });
    await new Promise((r) => setTimeout(r, 2));
    const b = domain.createDocument({ projectId: pid, kind: 'planning', title: 'B' });
    await new Promise((r) => setTimeout(r, 2));
    const c = domain.createDocument({ projectId: pid, kind: 'retro', title: 'C' });

    const list = domain.listDocuments(pid);
    expect(list.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
  });

  it('filters by kind when opts.kind is set', () => {
    const pid = makeProject();
    domain.createDocument({ projectId: pid, kind: 'prd', title: 'P1' });
    domain.createDocument({ projectId: pid, kind: 'planning', title: 'PL1' });
    domain.createDocument({ projectId: pid, kind: 'prd', title: 'P2' });

    const prds = domain.listDocuments(pid, { kind: 'prd' });
    expect(prds).toHaveLength(2);
    expect(prds.every((d) => d.kind === 'prd')).toBe(true);
  });

  it('respects opts.limit and clamps to 1..500', () => {
    const pid = makeProject();
    for (let i = 0; i < 5; i++) {
      domain.createDocument({ projectId: pid, kind: 'other', title: `t-${i}` });
    }
    expect(domain.listDocuments(pid, { limit: 2 })).toHaveLength(2);
    // Bad inputs fall back to the default rather than throwing.
    expect(() => domain.listDocuments(pid, { limit: 0 })).not.toThrow();
    expect(() => domain.listDocuments(pid, { limit: 99999 })).not.toThrow();
  });
});

describe('documents — feature linkage', () => {
  it('linkDocumentToFeature is idempotent (composite PK INSERT OR IGNORE)', () => {
    const pid = makeProject();
    const f = domain.createFeature({ projectId: pid, name: 'F' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });

    domain.linkDocumentToFeature(d.id, f.id);
    expect(() => domain.linkDocumentToFeature(d.id, f.id)).not.toThrow();

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM document_features WHERE document_id = ?')
      .get(d.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('linkDocumentToFeature throws on unknown ids (better than SQLite\'s FK error)', () => {
    const pid = makeProject();
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });
    expect(() => domain.linkDocumentToFeature(d.id, 'no-feat')).toThrow(/Feature not found/);
    expect(() => domain.linkDocumentToFeature('no-doc', 'no-feat')).toThrow(/Document not found/);
  });

  it('unlinkDocumentFromFeature removes the row and returns true; idempotent on missing', () => {
    const pid = makeProject();
    const f = domain.createFeature({ projectId: pid, name: 'F' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });
    domain.linkDocumentToFeature(d.id, f.id);

    expect(domain.unlinkDocumentFromFeature(d.id, f.id)).toBe(true);
    // Second call has nothing to delete — returns false, doesn't throw.
    expect(domain.unlinkDocumentFromFeature(d.id, f.id)).toBe(false);
  });

  it('listDocumentsForFeature returns linked docs in updated_at DESC', async () => {
    const pid = makeProject();
    const f = domain.createFeature({ projectId: pid, name: 'F' });
    const older = domain.createDocument({ projectId: pid, kind: 'prd', title: 'old' });
    await new Promise((r) => setTimeout(r, 2));
    const newer = domain.createDocument({ projectId: pid, kind: 'planning', title: 'new' });
    domain.linkDocumentToFeature(older.id, f.id);
    domain.linkDocumentToFeature(newer.id, f.id);

    const got = domain.listDocumentsForFeature(f.id);
    expect(got.map((d) => d.title)).toEqual(['new', 'old']);
  });

  it('listFeaturesForDocument returns linked features', () => {
    const pid = makeProject();
    const f1 = domain.createFeature({ projectId: pid, name: 'F1' });
    const f2 = domain.createFeature({ projectId: pid, name: 'F2' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'shared' });

    domain.linkDocumentToFeature(d.id, f1.id);
    domain.linkDocumentToFeature(d.id, f2.id);

    const got = domain.listFeaturesForDocument(d.id);
    expect(got.map((f) => f.name).sort()).toEqual(['F1', 'F2']);
  });

  it('feature delete cascades to document_features but leaves documents intact', () => {
    const pid = makeProject();
    const f = domain.createFeature({ projectId: pid, name: 'F' });
    const d = domain.createDocument({ projectId: pid, kind: 'prd', title: 'x' });
    domain.linkDocumentToFeature(d.id, f.id);

    getDb().prepare('DELETE FROM features WHERE id = ?').run(f.id);

    // Document survives — it's an artifact, not tied to feature lifecycle.
    expect(domain.getDocument(d.id)).not.toBeNull();
    // But the link row is gone.
    const links = getDb()
      .prepare('SELECT COUNT(*) AS n FROM document_features WHERE document_id = ?')
      .get(d.id) as { n: number };
    expect(links.n).toBe(0);
  });
});

describe('documents — search FTS integration', () => {
  it('createDocument feeds search_fts (kind=document) via 0006 trigger', () => {
    const pid = makeProject();
    domain.createDocument({
      projectId: pid,
      kind: 'planning',
      title: '결제 기획',
      content_md: '주요 비범위 정리',
    });
    const hits = domain.searchProject(pid, '결제');
    expect(hits.some((h) => h.kind === 'document')).toBe(true);
  });

  it('updateDocument refreshes the FTS row (content_md change is indexed)', () => {
    const pid = makeProject();
    const d = domain.createDocument({ projectId: pid, kind: 'other', title: 'old', content_md: 'first' });

    expect(domain.searchProject(pid, 'second')).toHaveLength(0);
    domain.updateDocument(d.id, { content_md: 'second pass content' });
    expect(domain.searchProject(pid, 'second').some((h) => h.kind === 'document')).toBe(true);
    // Old content no longer matches — old FTS row replaced.
    expect(domain.searchProject(pid, 'first')).toHaveLength(0);
  });

  it('deleteDocument removes the FTS row (kind=document not surfaced anymore)', () => {
    const pid = makeProject();
    const d = domain.createDocument({
      projectId: pid, kind: 'prd', title: 'ephemeral', content_md: 'soon gone',
    });
    expect(domain.searchProject(pid, 'ephemeral')).toHaveLength(1);
    domain.deleteDocument(d.id);
    expect(domain.searchProject(pid, 'ephemeral')).toHaveLength(0);
  });

  it('document hits rank below feature/decision but above session (KIND_WEIGHT)', () => {
    const pid = makeProject();
    domain.createFeature({ projectId: pid, name: '검색어' });
    domain.logDecision({ projectId: pid, title: '검색어' });
    domain.createDocument({ projectId: pid, kind: 'planning', title: '검색어' });
    // Synthetic session so we get all 4 kinds with the same title.
    const sid = `s-${Math.random().toString(36).slice(2, 8)}`;
    getDb()
      .prepare('INSERT INTO sessions (id, project_id, started_at, summary) VALUES (?, ?, ?, ?)')
      .run(sid, pid, Date.now(), '검색어');

    const hits = domain.searchProject(pid, '검색어');
    const order = hits.map((h) => h.kind);
    expect(order.indexOf('feature')).toBeLessThan(order.indexOf('decision'));
    expect(order.indexOf('decision')).toBeLessThan(order.indexOf('document'));
    expect(order.indexOf('document')).toBeLessThan(order.indexOf('session'));
  });
});
