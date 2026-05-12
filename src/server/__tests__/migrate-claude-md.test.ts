import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VIBEMATE_LEGACY_MARKER,
  VIBEMATE_SECTION_BEGIN,
  VIBEMATE_SECTION_END,
  VIBEMATE_TEMPLATE_VERSION,
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

  it('is stamped with the current VIBEMATE_TEMPLATE_VERSION', () => {
    // The number lives in two places (the constant + the rendered comment).
    // Asserting both prevents an accidental skew where the body says one
    // vintage and the constant says another — that would make
    // `migrateClaudeMd` think it's up-to-date when it isn't.
    expect(VIBEMATE_TEMPLATE_VERSION).toBe(4);
    expect(claudeMdTemplate('p')).toContain(
      `<!-- vibemate-template-version: ${VIBEMATE_TEMPLATE_VERSION} -->`,
    );
  });

  it('includes the v4 session-end notes template (ADR-0020)', () => {
    // Sprint 23: the structured notes template — Claude Code follows it,
    // and the resulting first-200-chars feed `last_session.notes_excerpt`.
    // Pin the exact headings so an accidental rephrase shows up in CI.
    const t = claudeMdTemplate('p');
    expect(t).toContain('## 완료');
    expect(t).toContain('## 남은 일');
    expect(t).toContain('## 결정');
    expect(t).toContain('notes');
    expect(t).toContain('last_session.notes_excerpt');
  });

  it('includes the v3 spec_md workflow guidance (ADR-0017)', () => {
    // The whole point of Sprint 17: every freshly-rendered template must
    // tell Claude Code to consult spec_md before working on a feature.
    // These exact strings are the ones the model is steered by, so we pin
    // them down to catch accidental rewording during future edits.
    const t = claudeMdTemplate('myproj');
    expect(t).toContain('Feature 작업 시작 시');
    expect(t).toContain('`pm_set_active_feature`');
    expect(t).toContain('`spec_md`');
    expect(t).toContain('범위 / 비범위 / 의존');
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
    // Bumped 3→4 in Sprint 23 (ADR-0020) when the structured notes template
    // landed. Tracks `VIBEMATE_TEMPLATE_VERSION`; bump together.
    expect(r.result).toContain('<!-- vibemate-template-version: 4 -->');
  });

  it('migrates a v3 paired section to v4 in place (Sprint 23, structured notes)', () => {
    // v3 section markers are unchanged (still `vibemate-section:v2`), but
    // the inline `template-version: 3` meta-line + missing notes guidance
    // mark the file as outdated. The migrator should swap the body
    // wholesale.
    const v3Body = [
      VIBEMATE_SECTION_BEGIN,
      '<!-- vibemate-template-version: 3 -->',
      '',
      '## 이 프로젝트는 Vibemate가 활성화되어 있습니다',
      '',
      '**Project ID**: `vintage-v3`',
      '',
      '세션 시작 시:',
      '1. `pm_session_start` 호출',
      '',
      '세션 종료 직전:',
      '- `pm_session_end` 호출 (session_id, 한 줄 요약, primary_feature_id)',
      '',
      VIBEMATE_SECTION_END,
    ].join('\n');
    const before = '# Doc\n\nIntro.\n\n';
    const after = '\n\n## My notes\n\nKeep me.\n';
    const target = file('CLAUDE.md', `${before}${v3Body}${after}`);

    const r = migrateClaudeMd(target, { projectId: 'caller-ignored' });
    expect(r.changed).toBe(true);
    expect(r.detected).toBe('paired');
    expect(r.result).not.toContain('vibemate-template-version: 3');
    expect(r.result).toContain('vibemate-template-version: 4');
    // v4 structured-notes guidance must be present.
    expect(r.result).toContain('## 완료');
    expect(r.result).toContain('## 남은 일');
    expect(r.result).toContain('## 결정');
    // Project ID and suffix preserved.
    expect(r.result).toContain('**Project ID**: `vintage-v3`');
    expect(r.result).toContain('## My notes');
    expect(r.result).toContain('Keep me.');
  });

  it('migrates a v2 paired section to the latest version in place, preserving prefix/suffix and Project ID', () => {
    // Synthesise a realistic vintage-v2 CLAUDE.md: same section markers we
    // ship today (they're stable identifiers — `VIBEMATE_SECTION_BEGIN`
    // intentionally still says `:v2` per the comment in domain.ts), with the
    // old `template-version: 2` stamp inside. Prefix/suffix simulate the
    // typical "user added some prose around the section" shape.
    //
    // The test asserts against `VIBEMATE_TEMPLATE_VERSION` (currently 4 in
    // Sprint 23) so it survives future bumps — newer versions still need
    // to migrate vintage-v2 sections cleanly, only the destination version
    // string changes.
    const v2Body = [
      VIBEMATE_SECTION_BEGIN,
      '<!-- vibemate-template-version: 2 -->',
      '',
      '## 이 프로젝트는 Vibemate가 활성화되어 있습니다',
      '',
      '**Project ID**: `vintage-v2`',
      '',
      '세션 시작 시:',
      '1. `pm_session_start` 호출',
      '',
      VIBEMATE_SECTION_END,
    ].join('\n');
    const before = '# My Doc\n\nIntro paragraph.\n\n';
    const after = '\n\n## Notes the user wrote after the section\n\nKeep me.\n';
    const target = file('CLAUDE.md', `${before}${v2Body}${after}`);

    const r = migrateClaudeMd(target, { projectId: 'caller-ignored' });

    expect(r.changed).toBe(true);
    expect(r.detected).toBe('paired');
    // Version stamp swapped to the current latest.
    expect(r.result).not.toContain('vibemate-template-version: 2');
    expect(r.result).toContain(`vibemate-template-version: ${VIBEMATE_TEMPLATE_VERSION}`);
    // v3 workflow lines spliced in (Sprint 17 — still part of the body in v4).
    expect(r.result).toContain('Feature 작업 시작 시');
    expect(r.result).toContain('`spec_md`');
    // User-edited Project ID preserved (caller's id is NOT injected).
    expect(r.result).toContain('**Project ID**: `vintage-v2`');
    expect(r.result).not.toContain('caller-ignored');
    // Suffix kept — this is the migration guarantee for paired markers.
    expect(r.result).toContain('## Notes the user wrote after the section');
    expect(r.result).toContain('Keep me.');
    // Prefix kept.
    expect(r.result).toContain('Intro paragraph.');
  });
});
