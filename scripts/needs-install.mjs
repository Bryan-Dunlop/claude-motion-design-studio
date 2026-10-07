// `node scripts/needs-install.mjs` exits with 1 when `npm install` should run first: nothing installed yet, or
// package-lock.json changed since the last install (the app was updated). Used by Start Motion Studio.cmd.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Written by scripts/postinstall.mjs after every install, relative to the app folder. */
export const STAMP_FILE = 'node_modules/.motion-studio-installed';

/** What the stamp says for the app folder's current package-lock.json (throws without one). */
export function installedStamp(dir = '.') {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
}

export function needsInstall(dir = '.') {
  try {
    return fs.readFileSync(path.join(dir, STAMP_FILE), 'utf8').trim() !== installedStamp(dir);
  } catch {
    return true;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(needsInstall() ? 1 : 0);
