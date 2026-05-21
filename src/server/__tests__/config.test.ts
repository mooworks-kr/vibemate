import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type Config,
} from '../config.js';

// Sprint 30 (wkq6, ADR-0027) — config roundtrip + defaults + partial-patch
// merge. Each test gets its own throwaway file under os.tmpdir() so the
// user's ~/.vibemate/config.json never gets touched.

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemate-config-test-'));
  cfgPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('defaultConfig', () => {
  it('returns 127.0.0.1 bind + null token + no remote', () => {
    expect(defaultConfig()).toEqual<Config>({
      server: { host: '127.0.0.1', token: null },
      remote: { url: null, token: null },
    });
  });

  it('returns a fresh object on each call (no shared state)', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.server.host = '0.0.0.0';
    expect(b.server.host).toBe('127.0.0.1');
  });
});

describe('loadConfig', () => {
  it('returns defaults when the file does not exist', () => {
    expect(loadConfig(cfgPath)).toEqual(defaultConfig());
  });

  it('returns defaults when the file is unparseable JSON', () => {
    fs.writeFileSync(cfgPath, '{ not valid json');
    expect(loadConfig(cfgPath)).toEqual(defaultConfig());
  });

  it('returns defaults when fields are missing on disk', () => {
    // Half-written file (mid-migration / hand-edited) — we should still
    // produce a fully-populated Config.
    fs.writeFileSync(cfgPath, JSON.stringify({ server: { host: '0.0.0.0' } }));
    const loaded = loadConfig(cfgPath);
    expect(loaded.server.host).toBe('0.0.0.0');
    expect(loaded.server.token).toBeNull();
    expect(loaded.remote).toEqual({ url: null, token: null });
  });
});

describe('saveConfig', () => {
  it('roundtrips the full config', () => {
    const written = saveConfig({
      server: { host: '0.0.0.0', token: 'abc123' },
      remote: { url: 'http://192.168.1.10:7321', token: 'xyz789' },
    }, cfgPath);
    expect(written).toEqual({
      server: { host: '0.0.0.0', token: 'abc123' },
      remote: { url: 'http://192.168.1.10:7321', token: 'xyz789' },
    });
    expect(loadConfig(cfgPath)).toEqual(written);
  });

  it('partial patch leaves untouched fields alone', () => {
    saveConfig({ server: { token: 'first' } }, cfgPath);
    // Only change remote.url — server.token should survive.
    const after = saveConfig({ remote: { url: 'http://x:7321' } }, cfgPath);
    expect(after.server.token).toBe('first');
    expect(after.remote.url).toBe('http://x:7321');
    expect(after.remote.token).toBeNull();
  });

  it('explicit null clears a previously-set token (pm token clear path)', () => {
    saveConfig({ server: { token: 'will-be-cleared' } }, cfgPath);
    const after = saveConfig({ server: { token: null } }, cfgPath);
    expect(after.server.token).toBeNull();
  });

  it('creates the parent directory if missing', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'a', 'config.json');
    saveConfig({ server: { host: '0.0.0.0' } }, nestedPath);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('writes file with 0600 permissions (secrets-friendly)', () => {
    saveConfig({ server: { token: 'secret' } }, cfgPath);
    const stat = fs.statSync(cfgPath);
    // mode & 0o777 strips file-type bits, leaving just rwxrwxrwx.
    // 0o600 = -rw------- (owner read/write only).
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
