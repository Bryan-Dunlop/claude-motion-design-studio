// Starting the local server for people, not developers: where projects go, plain messages instead of stack traces when
// the port is taken, and opening the editor in the browser.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where projects and exports go when MOTION_WORKSPACE isn't set: a "Motion Studio" folder in the home folder (on Windows
 * C:\Users\<you>\Motion Studio), outside the app folder, so they survive replacing or deleting the app folder to
 * update it. An app folder that already has a `workspace` folder with something in it (the default before) keeps
 * using that one, so nobody's projects seem to vanish.
 */
export function defaultWorkspace(appDir: string = process.cwd(), home: string = os.homedir()): string {
  const old = path.join(appDir, 'workspace');
  try {
    if (fs.readdirSync(old).length > 0) return old;
  } catch {
    /* no such folder */
  }
  return path.join(home, 'Motion Studio');
}

/** How to start on another port, in the words of this system's terminal. */
function otherPort(port: number, platform: NodeJS.Platform): string {
  const next = port + 1;
  return platform === 'win32'
    ? `In Command Prompt:  set PORT=${next}  then  npm start\n  (in PowerShell:  $env:PORT=${next}  then  npm start)`
    : `PORT=${next} npm start`;
}

/** A plain explanation of why the server could not start listening, or null for errors that need the full details. */
export function startupProblem(e: NodeJS.ErrnoException, port: number, platform: NodeJS.Platform = process.platform): string | null {
  if (e.code === 'EADDRINUSE') {
    return [
      `Port ${port} is already in use by another program, so Motion Studio could not start.`,
      'To run Motion Studio on another port:',
      `  ${otherPort(port, platform)}`,
    ].join('\n');
  }
  if (e.code === 'EACCES') {
    return [
      `This computer does not let programs use port ${port} (Windows often reserves ports for Hyper-V, WSL or Docker), so Motion Studio could not start.`,
      'Start it on another port:',
      `  ${otherPort(port, platform)}`,
    ].join('\n');
  }
  return null;
}

/** Is Motion Studio already answering on this port (started in another window)? */
export async function motionStudioAt(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await r.json()) as { workspace?: unknown };
    return r.ok && typeof body.workspace === 'string';
  } catch {
    return false;
  }
}

/** The command that opens `url` in the default browser. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Open `url` in the default browser; if that fails, the address printed at start-up still works. */
export function openInBrowser(url: string) {
  const [command, args] = browserCommand(url);
  try {
    spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
      .on('error', () => console.log(`  (Could not open your browser: open ${url} yourself.)`))
      .unref();
  } catch {
    console.log(`  (Could not open your browser: open ${url} yourself.)`);
  }
}

/** Everything the built editor (dist/) is made from: the two pages, the source, the build config and the packages. */
function buildInputs(root: string): string[] {
  const files = ['index.html', 'render.html', 'vite.config.ts', 'package-lock.json'];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk('src');
  return files.sort();
}

/** A fingerprint of buildInputs: when it changes (an update), the editor is built again. */
export function buildStamp(root: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of buildInputs(root)) {
    const file = path.join(root, rel);
    h.update(rel).update('\0').update(fs.existsSync(file) ? fs.readFileSync(file) : '').update('\0');
  }
  return h.digest('hex');
}

/**
 * `npm start` serves the editor built into `<root>/dist` (no live-reload code in the page, React's faster production
 * mode). Build it when it is missing or older than the source (the first start, and the first after an update); a
 * few seconds. Returns whether it built.
 */
export async function ensureBuilt(root: string, say: (line: string) => void = console.log): Promise<boolean> {
  const dist = path.join(root, 'dist');
  const stampFile = path.join(dist, '.motion-build');
  const want = buildStamp(root);
  const have = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : '';
  if (have === want && fs.existsSync(path.join(dist, 'index.html')) && fs.existsSync(path.join(dist, 'render.html'))) return false;
  say('  Preparing the editor (the first time, and after an update; a few seconds)…');
  const { build } = await import('vite');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });
  // Written last: a build that stopped half-way is built again next time.
  fs.writeFileSync(stampFile, want);
  return true;
}
