import chokidar from 'chokidar';
import path from 'node:path';
import { listProjects } from './domain.js';
import * as domain from './domain.js';
import { shouldIgnoreFile } from './lib.js';

const watchers: Map<string, ReturnType<typeof chokidar.watch>> = new Map();

/**
 * Watch all registered projects' root paths for file changes.
 * Each change is attached to the project's currently-open session (if any).
 */
export function startFileWatcher(): void {
  const projects = listProjects();
  for (const p of projects) {
    addProjectWatch(p.id, p.root_path);
  }
  console.log(`[vibemate] watching ${projects.length} project(s)`);
}

export function addProjectWatch(projectId: string, rootPath: string): void {
  if (watchers.has(projectId)) return;

  const watcher = chokidar.watch(rootPath, {
    ignored: (filePath: string) => {
      const rel = path.relative(rootPath, filePath);
      return shouldIgnoreFile(rel);
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add', (filePath) => recordEdit(projectId, rootPath, filePath, 'created'));
  watcher.on('change', (filePath) => recordEdit(projectId, rootPath, filePath, 'modified'));
  watcher.on('error', (err) => console.error(`[vibemate] watcher error (${projectId}):`, err));

  watchers.set(projectId, watcher);
}

export function stopAllWatchers(): Promise<void[]> {
  const promises: Promise<void>[] = [];
  for (const [id, w] of watchers) {
    promises.push(w.close());
    watchers.delete(id);
  }
  return Promise.all(promises);
}

function recordEdit(
  projectId: string,
  rootPath: string,
  filePath: string,
  editType: 'created' | 'modified',
): void {
  const rel = domain.relativizeToProject(filePath, rootPath);
  if (!rel || shouldIgnoreFile(rel)) return;
  domain.recordFileEdit(projectId, rel, editType);
}
