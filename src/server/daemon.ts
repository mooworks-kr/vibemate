import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './lib.js';
import { startHttpServer } from './http.js';
import { startFileWatcher, stopAllWatchers } from './watcher.js';

const PID_FILE = path.join(defaultDataDir(), 'daemon.pid');

export async function startDaemon(port: number = 7321): Promise<void> {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    if (isProcessAlive(existingPid)) {
      console.log(`[vibemate] daemon already running (pid ${existingPid})`);
      return;
    }
    fs.unlinkSync(PID_FILE);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));

  startHttpServer(port);
  startFileWatcher();

  const cleanup = async () => {
    console.log('[vibemate] shutting down…');
    await stopAllWatchers();
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export function stopDaemon(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    console.log('[vibemate] no daemon running');
    return false;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[vibemate] sent SIGTERM to pid ${pid}`);
    return true;
  } catch (err) {
    console.log('[vibemate] daemon process not found, cleaning up pid file');
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

export function daemonStatus(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PID_FILE)) return { running: false };
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
  if (isProcessAlive(pid)) return { running: true, pid };
  return { running: false };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
