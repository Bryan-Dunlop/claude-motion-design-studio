// Path checks that must behave the same on Windows and POSIX. `p` defaults to the running OS's path module; tests pass
// path.win32 / path.posix to check the other OS's rules on any machine.
import path from 'node:path';

type PathLib = Pick<typeof path, 'resolve'>;

/**
 * Is `file` inside `dir` (or `dir` itself)? Used by the dev server's file-watch filter: chokidar may report Windows
 * paths with either separator and any drive-letter case, and paths can contain glob characters ("C:\Me (Work)"), so
 * this compares normalised strings instead of globs. Case-insensitive (Windows and macOS file systems are).
 */
export function isInside(file: string, dir: string, p: PathLib = path): boolean {
  const norm = (x: string) => p.resolve(x).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(file);
  const b = norm(dir);
  return a === b || a.startsWith(`${b}/`);
}

/** Folders under the project root the dev server never watches (test output, the e2e workspace, Vite's cache). */
export function isIgnoredFolder(file: string): boolean {
  return /[\\/](test-results|\.e2e-workspace|\.vite)([\\/]|$)/.test(file);
}
