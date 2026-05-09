import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VIBEMATE_LEGACY_MARKER,
  VIBEMATE_SECTION_BEGIN,
  VIBEMATE_SECTION_END,
  claudeMdTemplate,
  lineDiff,
  migrateClaudeMd,
} from '../domain.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-migrate-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('claudeMdTemplate', () => {
  it('wraps body in begin/end markers', () => {
    const t = claudeMdTemplate('myproj');
    expect(t.startsWith(VIBEMATE_SECTION_BEGIN)).toBe(true);
    expect(t.endsWith(VIBEMATE_SECTION_END)).toBe(true);
    expect(t).toContain('**Project ID**: `myproj`');
  });
});

describe('lineDiff', () => {
  it('marks unchanged / added / removed with prefixes', () => {
    const out = lineDiff(['a', 'b', 'c'], ['a', 'X', 'c']);
    expect(out).toEqual([' a', '-b', '+X', ' c']);
  });

  it('returns all + lines when old is empty', () => {
    expect(lineDiff([], ['a', 'b'])).toEqual(['+a', '+b']);
  });

  it('returns all - lines when new is empty', () => {
    expect(lineDiff(['a', 'b'], [])).toEqual(['-a', '-b']);
  });
});

describe('migrateClaudeMd', () => {
  function file(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it('creates a brand-new CLAUDE.md when the file is missing', () => {
    const target = path.join(tmpDir, 'CLAUDE.md');
    const r = migrateClaudeMd(target, { projectId: 'p1' });
    expect(r.changed).toBe(true);
    expect(r.detected).toBe('none');
    expect(r.result).toContain(`# ${path.basename(tmpDir)}`);
    expect(r.result).toContain(VIBEMATE_SECTION_BEGIN);
    expect(r.result).toContain(VIBEMATE_SECTION_END);
    expect(r.result).toContain('**Project ID**: `p1`');
  });

  it('appends a fresh section to a CLAUDE.md without any vibemate marker', () => {
    const target = file('CLAUDE.md', '# My Project\n\nUnrelated docs.\n');
    const r = migrateClaudeMd(target, { projectId: 'p2' });
    expect(r.changed).toBe(true);
    expect(r.detected).toBe('none');
    expect(r.result.startsWith('# My Project')).toBe(true);
    expect(r.result).toContain('Unrelated docs.');
    expect(r.result.indexOf(VIBEMATE_SECTION_BEGIN))
      .toBeGreaterThan(r.result.indexOf('Unrelated docs.'));
  });

  it('replaces a paired-marker section in place, preserving prefix and suffix', () => {
    const oldSection = `${VIBEMATE_SECTION_BEGIN}\n\n## OLD\n\nStale body.\n\n${VIBEMATE_SECTION_END}`;
    const before = '# Doc\n\nIntro paragraph.\n\n';
    const after = '\n\n## My own notes\n\nKept by user.\n';
    const target = file('CLAUDE.md', `${before}${oldSection}${after}`);

    const r = migrateClaudeMd(target, { projectId: 'p3' });
    expect(r.changed).toBe(true);
    expect(r.detected).toBe('paired');
    // Prefix preserved
    expect(r.result).toContain('Intro paragraph.');
    // Suffix preserved (this is the key migration property — pair markers
    // mean we know the section ends, so user content after stays put).
    expect(r.result).toContain('## My own notes');
    expect(r.result).toContain('Kept by user.');
    // New content swapped in
    expect(r.result).toContain('**Project ID**: `p3`');
    expect(r.result).not.toContain('## OLD');
    expect(r.result).not.toContain('Stale body.');
  });

  it('treats a legacy single-marker as section-runs-to-EOF', () => {
    const legacy =
      `${VIBEMATE_LEGACY_MARKER}\n\n## 이 프로젝트는 Vibemate가 활성화되어 있습니다\n\n**Project ID**: \`legacy-id\`\n\n세션 시작 시: ...\n`;
    const before = '# Doc\n\nUser intro.\n\n';
    const target = file('CLAUDE.md', before + legacy);

    const r = migrateClaudeMd(target, { projectId: 'fallback-id' });
    expect(r.changed).toBe(true);
    expect(r.detected).toBe('legacy');
    expect(r.result).toContain('User intro.');
    expect(r.result).toContain(VIBEMATE_SECTION_BEGIN);
    // Legacy marker is replaced with paired markers
    expect(r.result).not.toContain(VIBEMATE_LEGACY_MARKER);
    // Project ID preservation: the legacy section's id wins over the
    // caller-supplied fallback (matches the dogfood rename case).
    expect(r.result).toContain('**Project ID**: `legacy-id`');
    expect(r.result).not.toContain('fallback-id');
  });

  it('returns changed=false when the paired section already matches the latest template', () => {
    // Build a file whose body is exactly the current template — migration
    // should be a no-op.
    const target = file('CLAUDE.md', `# Doc\n\n${claudeMdTemplate('p5')}\n`);
    const r = migrateClaudeMd(target, { projectId: 'p5' });
    expect(r.changed).toBe(false);
    expect(r.diff).toBe('');
  });

  it('produces a diff that highlights only the changed lines', () => {
    // Vintage section with one outdated line, otherwise identical scaffolding.
    const stale = `${VIBEMATE_SECTION_BEGIN}\n\n## 이 프로젝트는 Vibemate가 활성화되어 있습니다\n\n**Project ID**: \`p6\`\n\n옛날 안내문.\n\n${VIBEMATE_SECTION_END}`;
    const target = file('CLAUDE.md', `# Doc\n\n${stale}\n`);

    const r = migrateClaudeMd(target, { projectId: 'p6' });
    expect(r.changed).toBe(true);
    // The diff should at least mention the new known-current line
    // ("세션 시작 시:") and drop the stale one.
    expect(r.diff).toContain('+세션 시작 시:');
    expect(r.diff).toContain('-옛날 안내문.');
  });

  it('idempotent on repeat: applying twice yields the same content', () => {
    const target = file('CLAUDE.md', '# Doc\n');
    const r1 = migrateClaudeMd(target, { projectId: 'p7' });
    fs.writeFileSync(target, r1.result);

    const r2 = migrateClaudeMd(target, { projectId: 'p7' });
    expect(r2.changed).toBe(false);
  });

  it('preserves a user-edited Project ID when the caller passes a different one', () => {
    // User-customised section with a manually renamed Project ID. Caller
    // resolves from CWD and would pass a different id — we must keep the
    // user's value (matches vibemate's own dogfood: testft → vibemate rename).
    const stale =
      `${VIBEMATE_SECTION_BEGIN}\n\n## 이 프로젝트는 Vibemate가 활성화되어 있습니다\n\n**Project ID**: \`user-renamed\`\n\n옛 본문.\n\n${VIBEMATE_SECTION_END}`;
    const target = file('CLAUDE.md', `# Doc\n\n${stale}\n`);

    const r = migrateClaudeMd(target, { projectId: 'caller-resolved' });
    expect(r.changed).toBe(true);
    // User's id stays
    expect(r.result).toContain('**Project ID**: `user-renamed`');
    // Caller's id is NOT injected
    expect(r.result).not.toContain('caller-resolved');
  });

  it('uses the caller-supplied Project ID when no prior section exists', () => {
    // No marker yet → no user-edit to preserve, fall through to caller's id.
    const target = file('CLAUDE.md', '# Doc\n\nSomething.\n');
    const r = migrateClaudeMd(target, { projectId: 'fresh-id' });
    expect(r.result).toContain('**Project ID**: `fresh-id`');
  });

  it('embeds the template version meta-line so future migrations can detect vintage', () => {
    const target = path.join(tmpDir, 'CLAUDE.md');
    const r = migrateClaudeMd(target, { projectId: 'p8' });
    expect(r.result).toContain('<!-- vibemate-template-version: 2 -->');
  });
});
