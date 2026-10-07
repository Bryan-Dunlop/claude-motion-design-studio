// B3 Windows hardening: project names, asset paths every OS can store, files made with Windows tools (Notepad's BOM,
// PowerShell zips), the dev server's watch filter on Windows paths, and Save as… copying assets that only exist in the
// source project's folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, it } from 'vitest';
import { isIgnoredFolder, isInside } from '../../server/paths';
import { HttpError, safeJoin, Workspace } from '../../server/projects';
import { makeProject } from '../../src/shared/factories';
import { isPortableName, sameName, sanitizeName } from '../../src/shared/names';
import { emptyProject } from '../../src/shared/schema';

describe('sanitizeName (project folder names)', () => {
  it('never returns a Windows device name, COM0/LPT0 included, whatever surrounds it', () => {
    for (const n of ['CON', 'prn', 'Aux', 'NUL', 'COM0', 'com9', 'LPT0', 'lpt1']) expect(sanitizeName(n)).toBe(`${n}_`);
    // Trailing dots/spaces and the .motion suffix are removed before the check.
    expect(sanitizeName('nul.motion')).toBe('nul_');
    expect(sanitizeName('  CON . . ')).toBe('CON_');
    expect(sanitizeName('con.txt')).toBe('contxt'); // the dot goes, so it is no longer a device name
    expect(sanitizeName('COM10')).toBe('COM10');
  });
  it('drops characters Windows forbids and trailing dots/spaces', () => {
    expect(sanitizeName('Promo: v2 <final>?')).toBe('Promo v2 final');
    expect(sanitizeName('Launch...   ')).toBe('Launch');
    expect(sanitizeName('a|b*c"d')).toBe('abcd');
  });
  it('compares names the way Windows and macOS folders do (case-insensitive)', () => {
    expect(sameName('Promo', 'promo')).toBe(true);
    expect(sameName('Promo', 'Promo 2')).toBe(false);
  });
});

describe('asset paths every OS can store', () => {
  it('isPortableName: no reserved devices (also with an extension), no trailing dot/space, no forbidden characters', () => {
    for (const ok of ['a1b2c3d4-logo.png', 'assets', 'my_file-2.woff2', 'CONSOLE.png', 'com10.wav']) expect(isPortableName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'NUL', 'nul.txt', 'COM1.wav', 'lpt0.png', 'aux.tar.gz', 'logo.png.', 'logo.png ', 'logo.png:stream', 'a<b', 'a|b', 'a"b', 'a?b', 'a*b', 'a\u0001b']) {
      expect(isPortableName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('isPortableName: also COM¹–³/LPT¹–³ (Microsoft lists them) and the console devices CONIN$/CONOUT$', () => {
    for (const bad of ['COM¹', 'com².wav', 'LPT³.png', 'CONIN$', 'conout$.txt']) expect(isPortableName(bad), bad).toBe(false);
    for (const ok of ['COM⁴', 'CONIN', 'conin$x.png']) expect(isPortableName(ok), ok).toBe(true);
  });

  it('safeJoin refuses escapes and names Windows cannot store, accepts app-made paths', () => {
    const base = path.join(os.tmpdir(), 'P.motion');
    expect(safeJoin(base, 'assets/1a2b3c4d-logo.png')).toBe(path.join(base, 'assets', '1a2b3c4d-logo.png'));
    for (const bad of ['../x.png', 'assets/../../x.png', '/etc/passwd', 'assets/NUL', 'assets/con.png', 'assets/logo.png:evil', 'assets/logo.png.', 'assets/a?.png']) {
      expect(() => safeJoin(base, bad), bad).toThrow(/Unsafe path/);
    }
  });

  it('safeJoin: "\\" separates folders on every OS, so a path written on Windows names the same file on a Mac', () => {
    const base = path.join(os.tmpdir(), 'P.motion');
    expect(safeJoin(base, 'assets\\1a2b3c4d-logo.png')).toBe(path.join(base, 'assets', '1a2b3c4d-logo.png'));
    for (const bad of ['..\\x.png', 'assets\\..\\..\\x.png', '\\etc\\passwd', 'assets\\NUL']) expect(() => safeJoin(base, bad), bad).toThrow(/Unsafe path/);
  });
});

describe('files made with Windows tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-wintools-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const asset = { id: 'a', originalName: 'logo.png', relativePath: 'assets/0badc0de-logo.png', type: 'image' as const, hash: 'e'.repeat(64), width: 1, height: 1 };
  const project = makeProject({ ...emptyProject(), assets: [asset] });
  const writeProject = (name: string, text: string) => {
    fs.mkdirSync(path.join(root, `${name}.motion`), { recursive: true });
    fs.writeFileSync(path.join(root, `${name}.motion`, 'project.json'), text);
  };

  it('opens a project.json saved by Notepad (UTF-8 with a byte-order mark)', () => {
    writeProject('Notepad', `\uFEFF${JSON.stringify(project, null, 2).replace(/\n/g, '\r\n')}`);
    expect(new Workspace(root).read('Notepad')).toEqual(project);
  });

  it('a broken project.json is a plain "not valid JSON" error (400), not a server crash', () => {
    writeProject('Broken', '{ "schemaVersion": 2,');
    const err = (() => {
      try {
        new Workspace(root).read('Broken');
      } catch (e) {
        return e as HttpError;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(400);
    expect(err?.message).toMatch(/^project\.json is not valid JSON \(/);
  });

  it('imports a .zip made by Windows PowerShell 5.1 Compress-Archive ("\\" in entry names), assets included', () => {
    const zip = new AdmZip();
    zip.addFile('Promo.motion/project.json', Buffer.from(`\uFEFF${JSON.stringify(project)}`));
    zip.addFile(`Promo.motion/${asset.relativePath}`, Buffer.from('logo bytes'));
    // AdmZip always writes '/', so swap the separators inside the finished file (same length; names aren't checksummed).
    const bytes = Buffer.from(zip.toBuffer().toString('latin1').replace(/Promo\.motion\/(project\.json|assets\/0badc0de-logo\.png)/g, (m) => m.replace(/\//g, '\\')), 'latin1');
    expect(new AdmZip(bytes).getEntries().map((e) => e.entryName).sort()).toEqual(['Promo.motion\\assets\\0badc0de-logo.png', 'Promo.motion\\project.json']);

    const { name, project: imported } = new Workspace(root).importZip(bytes, 'Promo');
    expect(name).toBe('Promo');
    expect(imported).toEqual(project);
    expect(fs.readFileSync(path.join(root, 'Promo.motion', asset.relativePath), 'utf8')).toBe('logo bytes');
  });
});

describe('dev server watch filter (Windows paths)', () => {
  it('matches Windows paths whatever the separators and drive-letter case, with glob characters in them', () => {
    const ws = 'C:\\Users\\Me (Work)\\motion\\.e2e-workspace';
    expect(isInside('C:\\Users\\Me (Work)\\motion\\.e2e-workspace\\Promo.motion\\project.json', ws, path.win32)).toBe(true);
    expect(isInside('c:/users/me (work)/motion/.e2e-workspace/.scratch/abc.png', ws, path.win32)).toBe(true);
    expect(isInside('C:\\Users\\Me (Work)\\motion\\.e2e-workspace', `${ws}\\`, path.win32)).toBe(true);
    // A sibling folder that merely starts with the same letters is not inside.
    expect(isInside('C:\\Users\\Me (Work)\\motion\\.e2e-workspace2\\x.json', ws, path.win32)).toBe(false);
    expect(isInside('C:\\Users\\Me (Work)\\motion\\src\\app\\App.tsx', ws, path.win32)).toBe(false);
  });
  it('POSIX paths', () => {
    expect(isInside('/home/me/motion/workspace/A.motion/project.json', '/home/me/motion/workspace', path.posix)).toBe(true);
    expect(isInside('/home/me/motion/workspace-old/x', '/home/me/motion/workspace', path.posix)).toBe(false);
  });
  it('test output, the e2e workspace and the Vite cache are never watched (either separator)', () => {
    expect(isIgnoredFolder('C:\\repo\\test-results\\a\\trace.zip')).toBe(true);
    expect(isIgnoredFolder('/repo/.e2e-workspace/A.motion/project.json')).toBe(true);
    expect(isIgnoredFolder('C:/repo/.vite/deps/react.js')).toBe(true);
    expect(isIgnoredFolder('/home/me/workspace/motion/src/app/App.tsx')).toBe(false);
  });
});

describe('Save as… copies assets from the project it came from', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-ws-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('an asset that exists only in the source folder (opened/imported project) is copied byte-for-byte', () => {
    const ws = new Workspace(root);
    const bytes = Buffer.from('not in the scratch store');
    const asset = { id: 'a', originalName: 'logo.png', relativePath: 'assets/00000000-logo.png', type: 'image' as const, hash: 'f'.repeat(64), width: 1, height: 1 };
    const project = makeProject({ ...emptyProject(), assets: [asset] });
    fs.mkdirSync(path.join(root, 'Source.motion', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Source.motion', asset.relativePath), bytes);
    fs.writeFileSync(path.join(root, 'Source.motion', 'project.json'), JSON.stringify(project));

    // Without the source the asset can't be found (it isn't in scratch), and the save says so…
    expect(ws.save('Lost', project).missing).toEqual(['logo.png']);
    expect(fs.existsSync(path.join(root, 'Lost.motion', asset.relativePath))).toBe(false);
    // …with it, Save as… carries it over.
    expect(ws.save('Copy 9x16', project, 'Source').missing).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'Copy 9x16.motion', asset.relativePath))).toEqual(bytes);
    // An invalid source name is ignored rather than failing the save.
    expect(() => ws.save('Other', project, '../..')).not.toThrow();
  });
});
