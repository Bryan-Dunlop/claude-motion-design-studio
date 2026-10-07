// Starting the app for non-developers: where projects go by default, plain messages when the port is taken, the
// browser command, and the launcher's "install first?" check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browserCommand, buildStamp, defaultWorkspace, startupProblem } from '../../server/startup';
// @ts-expect-error plain JavaScript module (scripts/ runs before the TypeScript tooling is installed)
import { installedStamp, needsInstall, STAMP_FILE } from '../../scripts/needs-install.mjs';

const roots: string[] = [];
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-start-'));
  roots.push(dir);
  return dir;
};

describe('defaultWorkspace', () => {
  it('is "Motion Studio" in the home folder, outside the app folder, so replacing the app folder keeps the projects', () => {
    const app = tmp();
    const home = tmp();
    expect(defaultWorkspace(app, home)).toBe(path.join(home, 'Motion Studio'));
    // An empty leftover `workspace` folder doesn't count.
    fs.mkdirSync(path.join(app, 'workspace'));
    expect(defaultWorkspace(app, home)).toBe(path.join(home, 'Motion Studio'));
  });

  it('keeps using an app folder\'s own `workspace` folder that already has projects in it (the old default)', () => {
    const app = tmp();
    fs.mkdirSync(path.join(app, 'workspace', 'Promo.motion'), { recursive: true });
    expect(defaultWorkspace(app, tmp())).toBe(path.join(app, 'workspace'));
  });
});

describe('startupProblem', () => {
  it('explains a port that is already in use, with the command for this system', () => {
    const e = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:5173'), { code: 'EADDRINUSE' });
    const win = startupProblem(e, 5173, 'win32')!;
    expect(win).toContain('Port 5173 is already in use by another program, so Motion Studio could not start.');
    expect(win).toContain('set PORT=5174');
    expect(win).toContain('$env:PORT=5174');
    expect(startupProblem(e, 5173, 'linux')).toContain('PORT=5174 npm start');
  });

  it('explains a port Windows has reserved (EACCES), and leaves other errors alone', () => {
    const e = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:5173'), { code: 'EACCES' });
    expect(startupProblem(e, 5173, 'win32')).toMatch(/does not let programs use port 5173 .*Hyper-V/);
    expect(startupProblem(Object.assign(new Error('boom'), { code: 'EMFILE' }), 5173)).toBeNull();
  });
});

describe('browserCommand', () => {
  it('opens the default browser on each system', () => {
    const url = 'http://127.0.0.1:5173';
    expect(browserCommand(url, 'win32')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', url]]);
    expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
  });
});

describe('the launcher\'s install check (scripts/needs-install.mjs)', () => {
  it('asks for an install when nothing is installed, after an update changes package-lock.json, and not otherwise', () => {
    const dir = tmp();
    const lock = path.join(dir, 'package-lock.json');
    fs.writeFileSync(lock, '{"lockfileVersion":3}');
    expect(needsInstall(dir)).toBe(true);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, STAMP_FILE), installedStamp(dir));
    expect(needsInstall(dir)).toBe(false);
    fs.writeFileSync(lock, '{"lockfileVersion":3,"packages":{}}');
    expect(needsInstall(dir)).toBe(true);
  });
});

describe('buildStamp (npm start builds the editor again when this changes)', () => {
  it('changes when a source file, a page or the packages change, and only then', () => {
    const root = tmp();
    for (const f of ['index.html', 'render.html', 'vite.config.ts', 'package-lock.json']) fs.writeFileSync(path.join(root, f), f);
    fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app', 'main.tsx'), 'one');
    const first = buildStamp(root);
    expect(buildStamp(root)).toBe(first);
    fs.writeFileSync(path.join(root, 'workspace.txt'), 'not an input');
    expect(buildStamp(root)).toBe(first);
    fs.writeFileSync(path.join(root, 'src', 'app', 'main.tsx'), 'two');
    const second = buildStamp(root);
    expect(second).not.toBe(first);
    fs.writeFileSync(path.join(root, 'src', 'app', 'new.ts'), '');
    expect(buildStamp(root)).not.toBe(second);
    fs.writeFileSync(path.join(root, 'package-lock.json'), 'updated');
    expect(buildStamp(root)).not.toBe(second);
  });
});
