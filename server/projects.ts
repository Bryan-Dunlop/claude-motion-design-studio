// Filesystem layer: project folders (<name>.motion/project.json + assets/) and the scratch asset store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { isPortableName, sanitizeName } from '../src/shared/names';
import { ProjectSchema, type Asset, type Project } from '../src/shared/schema';

export { sanitizeName };

export class Workspace {
  readonly root: string;
  readonly scratch: string;
  readonly exports: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.scratch = path.join(this.root, '.scratch');
    this.exports = path.join(this.root, 'exports');
    fs.mkdirSync(this.scratch, { recursive: true });
    fs.mkdirSync(this.exports, { recursive: true });
  }

  /** Validate a user-supplied project name and return its folder. */
  projectDir(name: string): string {
    const clean = sanitizeName(name);
    if (!clean) throw new HttpError(400, 'Invalid project name');
    return path.join(this.root, `${clean}.motion`);
  }

  list(): { name: string; modified: number }[] {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('.motion') && fs.existsSync(path.join(this.root, d.name, 'project.json')))
      .map((d) => ({
        name: d.name.slice(0, -'.motion'.length),
        modified: fs.statSync(path.join(this.root, d.name, 'project.json')).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified);
  }

  read(name: string): Project {
    return readProjectDir(this.projectDir(name));
  }

  /**
   * Save project.json and copy any not-yet-stored assets in (byte-for-byte). `from` is the project this one was opened
   * as (Save as… / format copies): its folder is searched before the scratch store, because assets of an opened or
   * imported project may exist only there. `missing` lists the files found nowhere (saved as references only).
   */
  save(name: string, data: unknown, from?: string): { project: Project; missing: string[] } {
    const project = parseProject(data);
    const dir = this.projectDir(name);
    const fromDir = from && sanitizeName(from) ? this.projectDir(from) : null;
    const missing: string[] = [];
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    for (const a of project.assets) {
      const dest = safeJoin(dir, a.relativePath);
      if (fs.existsSync(dest)) continue;
      const src = this.resolveAsset(fromDir, a);
      if (!src) {
        missing.push(a.originalName);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const tmp = path.join(dir, 'project.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    renameWithRetry(tmp, path.join(dir, 'project.json'));
    return { project, missing };
  }

  /** Store uploaded bytes untouched, addressed by sha256. */
  storeScratch(bytes: Buffer, filename: string): { hash: string } {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(this.scratch, hash + extOf(filename));
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return { hash };
  }

  scratchFile(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const hit = fs.readdirSync(this.scratch).find((f) => f.startsWith(hash));
    return hit ? path.join(this.scratch, hit) : null;
  }

  /** Locate an asset's bytes: the project folder first, then the scratch store. */
  resolveAsset(projectDir: string | null, asset: Pick<Asset, 'relativePath' | 'hash'>): string | null {
    if (projectDir) {
      try {
        const p = safeJoin(projectDir, asset.relativePath);
        if (fs.existsSync(p)) return p;
      } catch {
        /* bad path -> treat as missing */
      }
    }
    return this.scratchFile(asset.hash);
  }

  zip(project: Project, projectDir: string | null): Buffer {
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify(project, null, 2)));
    for (const a of project.assets) {
      const file = this.resolveAsset(projectDir, a);
      if (file) zip.addFile(a.relativePath, fs.readFileSync(file));
    }
    return zip.toBuffer();
  }

  importZip(bytes: Buffer, preferredName: string): { name: string; project: Project } {
    const zip = new AdmZip(bytes);
    // Entry names use '/', except in zips made by Windows PowerShell 5.1's Compress-Archive, which writes '\'.
    const entries = new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [toSlashes(e.entryName), e]));
    const jsonName = [...entries.keys()].find((n) => n.replace(/^[^/]+\.motion\//, '') === 'project.json');
    if (!jsonName) throw new HttpError(400, 'Zip does not contain a project.json');
    const prefix = jsonName.slice(0, -'project.json'.length);
    const project = parseProject(parseJsonText(entries.get(jsonName)!.getData().toString('utf8')));
    let name = sanitizeName(preferredName) || 'Imported';
    for (let i = 2; fs.existsSync(this.projectDir(name)); i++) name = `${sanitizeName(preferredName) || 'Imported'} ${i}`;
    const dir = this.projectDir(name);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    for (const a of project.assets) {
      const e = entries.get(prefix + toSlashes(a.relativePath));
      if (!e) continue;
      const dest = safeJoin(dir, a.relativePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
    }
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
    return { name, project };
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseProject(data: unknown): Project {
  const r = ProjectSchema.safeParse(data);
  if (!r.success) throw new HttpError(400, `Invalid project: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function readProjectDir(dir: string): Project {
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) throw new HttpError(404, `No project.json in ${dir}`);
  return parseProject(parseJsonText(fs.readFileSync(file, 'utf8')));
}

/** project.json text, possibly edited by hand: Windows Notepad saves UTF-8 with a byte-order mark, which JSON.parse rejects. */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new HttpError(400, `project.json is not valid JSON (${(e as Error).message})`);
  }
}

function toSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function extOf(filename: string): string {
  const m = /\.[a-zA-Z0-9]{1,6}$/.exec(filename);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Join and refuse anything that escapes the base folder (zip-slip / ../ protection). Every part of `rel` must also be a
 * name Windows can store (isPortableName): a project made on a Mac must open on a PC, and a crafted project/zip must not
 * reach a device such as NUL or an NTFS stream ("logo.png:x"). '\' separates folders on every OS (as on Windows), so a
 * path written on Windows ("assets\logo.png") names the same file on a Mac instead of a file with a '\' in its name.
 */
export function safeJoin(base: string, rel: string): string {
  const p = path.resolve(base, toSlashes(rel));
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new HttpError(400, `Unsafe path: ${rel}`);
  if (!rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.').every(isPortableName)) throw new HttpError(400, `Unsafe path: ${rel}`);
  return p;
}

/** On Windows an antivirus scanner or indexer can briefly lock a fresh file (EPERM/EACCES/EBUSY): retry a few times. */
export function renameWithRetry(from: string, to: string, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* short synchronous back-off */
      }
    }
  }
}
