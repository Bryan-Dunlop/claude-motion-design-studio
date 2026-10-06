// The project folder store: free names for imports, folders renamed by hand, writes that fail half-way, rejected
// imports, and the API's guard against other sites.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, it } from 'vitest';
import { isLocalRequest } from '../../server/app';
import { Workspace } from '../../server/projects';
import { makeProject } from '../../src/shared/factories';
import { emptyProject, type Project } from '../../src/shared/schema';

const roots: string[] = [];
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-ws-'));
  roots.push(root);
  return { ws: new Workspace(root), root };
}
const project = (background = '#000000', assets: Project['assets'] = []) => makeProject({ ...emptyProject(), assets, settings: { ...emptyProject().settings, background } });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function zipOf(p: Project, files: Record<string, Buffer> = {}) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(p)));
  for (const [name, bytes] of Object.entries(files)) zip.addFile(name, bytes);
  return zip.toBuffer();
}
const folders = (root: string) => fs.readdirSync(root).filter((n) => n !== '.scratch' && n !== 'exports').sort();

describe('importing a .zip picks a free name', () => {
  it('a long name that already exists gets a number that fits (it used to loop forever)', () => {
    const { ws } = workspace();
    const long = 'Spring campaign launch video for the new product line - final cut v2 approved by client'; // 87 chars
    const zip = zipOf(project());
    const first = ws.importZip(zip, long).name;
    expect(first).toHaveLength(80);
    const second = ws.importZip(zip, long).name;
    expect(second).toBe(`${first.slice(0, 77).trimEnd()} 2`);
    expect(second.length).toBeLessThanOrEqual(80);
  });

  it('a 78-character name imported 12 times gets 12 different folders', () => {
    const { ws } = workspace();
    const name = 'x'.repeat(78);
    const zip = zipOf(project());
    const names = Array.from({ length: 12 }, () => ws.importZip(zip, name).name);
    expect(new Set(names).size).toBe(12);
    expect(names[1]).toBe(`${'x'.repeat(78)} 2`);
    expect(names[10]).toBe(`${'x'.repeat(77)} 11`);
  });
});

describe('a rejected or failed import leaves nothing behind', () => {
  it('an asset path that escapes the folder is refused before any folder is made', () => {
    const { ws, root } = workspace();
    for (const rel of ['../../ESCAPED.txt', '/tmp/ESCAPED_ABS.txt', 'assets/NUL.png']) {
      const bad = project('#000000', [{ id: 'a', originalName: 'x.png', relativePath: rel, type: 'image', hash: 'f'.repeat(64), width: 1, height: 1 }]);
      expect(() => ws.importZip(zipOf(bad, { 'assets/ok.png': Buffer.from('ok') }), 'Demo')).toThrow(/Unsafe path/);
    }
    expect(folders(root)).toEqual([]);
    // The next good import gets the plain name, not "Demo 4".
    expect(ws.importZip(zipOf(project()), 'Demo').name).toBe('Demo');
  });
});

describe('folders renamed or copied by hand open as themselves', () => {
  it('"Promo (1)", "Café promo", "Promo v1.2" and "日本語" open their own folder, not a sanitized look-alike', () => {
    const { ws, root } = workspace();
    ws.save('Promo', project('#ff0000'));
    ws.save('Promo 1', project('#00ff00'));
    // Copied by hand: mkdir + copyFile (fs.cpSync garbles non-ASCII folder names on Windows).
    for (const copy of ['Promo (1)', 'Café promo', 'Promo v1.2', '日本語']) {
      fs.mkdirSync(path.join(root, `${copy}.motion`));
      fs.copyFileSync(path.join(root, 'Promo.motion', 'project.json'), path.join(root, `${copy}.motion`, 'project.json'));
    }
    for (const name of ['Promo (1)', 'Café promo', 'Promo v1.2', '日本語']) {
      expect(ws.list().map((p) => p.name)).toContain(name);
      expect(ws.read(name).settings.background, name).toBe('#ff0000');
      expect(ws.projectName(name)).toBe(name);
    }
    // Saving writes back into that same folder.
    ws.save('Promo (1)', project('#0000ff'));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'Promo (1).motion', 'project.json'), 'utf8')).settings.background).toBe('#0000ff');
    expect(ws.read('Promo 1').settings.background).toBe('#00ff00');
  });

  it('a new name is still sanitized, and names with path tricks never reach outside the workspace', () => {
    const { ws, root } = workspace();
    expect(ws.projectName('New (draft)')).toBe('New draft');
    expect(ws.projectDir('New (draft)')).toBe(path.join(root, 'New draft.motion'));
    fs.mkdirSync(path.join(root, '..', 'outside.motion'), { recursive: true });
    fs.writeFileSync(path.join(root, '..', 'outside.motion', 'project.json'), JSON.stringify(project()));
    for (const name of ['../outside', '..\\outside', 'a/b', 'C:x']) expect(path.dirname(ws.projectDir(name))).toBe(root);
    fs.rmSync(path.join(root, '..', 'outside.motion'), { recursive: true, force: true });
  });
});

describe('a write that stopped half-way (disk full) is repaired, never trusted', () => {
  it('the hash store rewrites a cut-off file when the same bytes are uploaded again', () => {
    const { ws, root } = workspace();
    const bytes = crypto.randomBytes(5000);
    const file = path.join(root, '.scratch', `${sha(bytes)}.wav`);
    fs.writeFileSync(file, bytes.subarray(0, 1200));
    expect(ws.storeScratch(bytes, 'music.wav').hash).toBe(sha(bytes));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(path.join(root, '.scratch')).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('Save replaces a cut-off copy in the project folder, but keeps a file replaced by hand', () => {
    const { ws, root } = workspace();
    const bytes = crypto.randomBytes(5000);
    const { hash } = ws.storeScratch(bytes, 'logo.png');
    const asset = { id: 'a', originalName: 'logo.png', relativePath: `assets/${hash.slice(0, 8)}-logo.png`, type: 'image' as const, hash, width: 1, height: 1 };
    const p = project('#000000', [asset]);
    const dest = path.join(root, 'Ad.motion', asset.relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes.subarray(0, 3000));
    ws.save('Ad', p);
    expect(fs.readFileSync(dest).equals(bytes)).toBe(true);
    // A different (hand-replaced) file is left alone.
    const other = crypto.randomBytes(100);
    fs.writeFileSync(dest, other);
    ws.save('Ad', p);
    expect(fs.readFileSync(dest).equals(other)).toBe(true);
  });
});

describe('isLocalRequest (the API answers only the editor on this computer)', () => {
  it('accepts localhost and IP addresses, with or without a matching Origin', () => {
    for (const host of ['127.0.0.1:5173', 'localhost:5173', '[::1]:5173', '192.168.1.20:5173', 'LOCALHOST:80']) expect(isLocalRequest(host, undefined), host).toBe(true);
    expect(isLocalRequest('127.0.0.1:5173', 'http://127.0.0.1:5173')).toBe(true);
    expect(isLocalRequest('[::1]:5173', 'http://[::1]:5173')).toBe(true);
    expect(isLocalRequest('studio.lan:5173', undefined, 'studio.lan')).toBe(true);
  });

  it('refuses another host name (DNS rebinding) and pages from other sites', () => {
    expect(isLocalRequest('attacker.example:5173', undefined)).toBe(false);
    expect(isLocalRequest(undefined, undefined)).toBe(false);
    expect(isLocalRequest('127.0.0.1:5173', 'http://attacker.example')).toBe(false);
    expect(isLocalRequest('127.0.0.1:5173', 'http://127.0.0.1:9999')).toBe(false);
    expect(isLocalRequest('127.0.0.1:5173', 'null')).toBe(false);
  });
});

describe('Workspace.zip', () => {
  it('packs project.json and every asset file it can find, byte for byte (from the project folder or the store)', () => {
    const { ws, root } = workspace();
    const inStore = crypto.randomBytes(300);
    const inFolder = crypto.randomBytes(200);
    const a = { id: 'a', originalName: 'a.png', relativePath: `assets/${sha(inStore).slice(0, 8)}-a.png`, type: 'image' as const, hash: sha(inStore), width: 1, height: 1 };
    const b = { id: 'b', originalName: 'b.png', relativePath: `assets/${sha(inFolder).slice(0, 8)}-b.png`, type: 'image' as const, hash: sha(inFolder), width: 1, height: 1 };
    ws.storeScratch(inStore, 'a.png');
    const p = project('#123456', [a, b]);
    fs.mkdirSync(path.join(root, 'Z.motion', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Z.motion', b.relativePath), inFolder);
    const zip = new AdmZip(ws.zip(p, path.join(root, 'Z.motion')));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual([a.relativePath, b.relativePath, 'project.json'].sort());
    expect(zip.getEntry(a.relativePath)!.getData().equals(inStore)).toBe(true);
    expect(zip.getEntry(b.relativePath)!.getData().equals(inFolder)).toBe(true);
    expect(JSON.parse(zip.getEntry('project.json')!.getData().toString('utf8')).settings.background).toBe('#123456');
  });
});
