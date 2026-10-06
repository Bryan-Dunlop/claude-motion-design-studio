// Local HTTP server: filesystem access (projects, assets, zip) and export jobs.
// The Vite dev middleware is mounted on the same port so the editor and render page share one origin.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { exportFileName, exportSize, parseExportOptions } from '../src/shared/exportSize';
import { decodeAudioInfo } from './audioDecode';
import { acceptFrame, cancel, fail, ffmpegAvailable, finishFrames, freeOutFile, getJob, publicJob, startExport, FFMPEG_HELP } from './exporter';
import { isIgnoredFolder, isInside } from './paths';
import { HttpError, parseProject, sanitizeName, Workspace } from './projects';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface StartedServer {
  url: string;
  workspace: Workspace;
  close: () => Promise<void>;
}

export async function startServer(opts: { port: number; workspace: string; host?: string; hmr?: boolean }): Promise<StartedServer> {
  const ws = new Workspace(opts.workspace);
  const app = express();
  const raw = express.raw({ type: () => true, limit: '1gb' });
  const json = express.json({ limit: '50mb' });
  let baseUrl = '';

  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
  const param = (req: Request, key: string) => String(req.params[key] ?? '');

  app.get('/api/health', (_req, res) => {
    res.json({ ffmpeg: ffmpegAvailable(), ffmpegHelp: FFMPEG_HELP, workspace: ws.root });
  });

  // ---------------------------------------------------------------- projects
  app.get('/api/projects', (_req, res) => {
    res.json(ws.list());
  });
  app.get('/api/projects/:name', wrap((req, res) => {
    res.json({ name: sanitizeName(param(req, 'name')), project: ws.read(param(req, 'name')) });
  }));
  /** ?from=<name>: the project it was opened as (Save as…), whose folder holds assets that may not be in scratch. */
  app.put('/api/projects/:name', json, wrap((req, res) => {
    const { project, missing } = ws.save(param(req, 'name'), req.body, req.query.from ? String(req.query.from) : undefined);
    res.json({ name: sanitizeName(param(req, 'name')), project, missing });
  }));

  // ---------------------------------------------------------------- assets
  app.post('/api/assets', raw, wrap((req, res) => {
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Empty upload');
    res.json(ws.storeScratch(req.body, filename));
  }));
  /** ?project=<name>&path=<relativePath>&hash=<sha256> */
  const assetFile = (req: Request) => {
    const name = String(req.query.project ?? '');
    const dir = name ? ws.projectDir(name) : null;
    const file = ws.resolveAsset(dir, { relativePath: String(req.query.path ?? ''), hash: String(req.query.hash ?? '') });
    if (!file) throw new HttpError(404, 'Asset missing');
    return file;
  };
  app.get('/api/asset', wrap((req, res) => {
    res.sendFile(assetFile(req), { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } });
  }));
  /** Length + waveform peaks of an audio asset, decoded by ffmpeg (for formats the browser can't decode). Same query. */
  app.get('/api/audio-info', wrap(async (req, res) => {
    const file = assetFile(req);
    if (!ffmpegAvailable()) throw new HttpError(424, FFMPEG_HELP);
    try {
      res.json(await decodeAudioInfo(file));
    } catch (e) {
      throw new HttpError(422, `Could not decode this audio file: ${(e as Error).message}`);
    }
  }));

  // ---------------------------------------------------------------- zip
  app.post('/api/zip', json, wrap((req, res) => {
    const project = parseProject(req.body.project);
    const name = req.body.name ? String(req.body.name) : '';
    const dir = name ? ws.projectDir(name) : null;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeName(name) || 'project'}.motion.zip"`);
    res.send(ws.zip(project, dir));
  }));
  app.post('/api/import-zip', raw, wrap((req, res) => {
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'Imported.zip'));
    const preferred = filename.replace(/\.zip$/i, '').replace(/\.motion$/i, '');
    res.json(ws.importZip(req.body, preferred));
  }));

  // ---------------------------------------------------------------- export
  /** Body: { project, name?, scale?, crf?, preset?, audio? } — every export option is optional (ExportOptionsSchema). */
  app.post('/api/export', json, wrap(async (req, res) => {
    const project = parseProject(req.body.project);
    const parsed = parseExportOptions(req.body ?? {});
    if (!parsed.ok) throw new HttpError(400, `Invalid export options: ${parsed.error}`);
    const options = parsed.options;
    const name = req.body.name ? sanitizeName(String(req.body.name)) : '';
    const { outW, outH } = exportSize(project.settings, options.scale);
    const now = new Date();
    // Two exports in the same second would otherwise share (and overwrite) one file.
    const outFile = freeOutFile(ws.exports, (n) => exportFileName(name, outW, outH, now, n));
    const projectDir = name ? ws.projectDir(name) : null;
    try {
      const job = await startExport({ project, projectDir, outFile, baseUrl, options, resolveAsset: (a) => ws.resolveAsset(projectDir, a) });
      // Failures also go to the server log (the dialog shows them too); cancelling is not a failure.
      job.finished.catch((err: Error) => job.status === 'error' && console.error(`[export] ${path.basename(outFile)} failed: ${err.message}`));
      res.json(publicJob(job));
    } catch (e) {
      const err = e as Error & { status?: number };
      throw new HttpError(err.status ?? 500, err.message);
    }
  }));
  const jobOr404 = (req: Request) => {
    const job = getJob(param(req, 'id'));
    if (!job) throw new HttpError(404, 'No such export job');
    return job;
  };
  app.get('/api/jobs/:id', wrap((req, res) => res.json(publicJob(jobOr404(req)))));
  app.post('/api/jobs/:id/cancel', wrap((req, res) => {
    const job = jobOr404(req);
    cancel(job);
    res.json(publicJob(job));
  }));
  app.get('/api/jobs/:id/download', wrap((req, res) => {
    const job = jobOr404(req);
    if (job.status !== 'done') throw new HttpError(409, 'Export not finished');
    res.download(job.outFile, path.basename(job.outFile), { dotfiles: 'allow' });
  }));
  // Used by render.html running inside headless Chromium: the project and the output frame size + renderFrame scale.
  app.get('/api/jobs/:id/project', wrap((req, res) => {
    const job = jobOr404(req);
    res.json({ project: job.project, ...job.size });
  }));
  app.get('/api/jobs/:id/asset/:assetId', wrap((req, res) => {
    const job = jobOr404(req);
    const asset = job.project.assets.find((a) => a.id === param(req, 'assetId'));
    const file = asset && ws.resolveAsset(job.projectDir, asset);
    if (!file) throw new HttpError(404, 'Asset missing');
    res.sendFile(file, { dotfiles: 'allow' });
  }));
  app.post('/api/jobs/:id/frame/:n', raw, wrap(async (req, res) => {
    const job = jobOr404(req);
    try {
      await acceptFrame(job, Number(param(req, 'n')), req.body as Buffer);
    } catch (e) {
      if (job.status === 'rendering') fail(job, (e as Error).message);
      throw new HttpError(409, (e as Error).message);
    }
    res.json({ ok: true });
  }));
  app.post('/api/jobs/:id/done', wrap((req, res) => {
    finishFrames(jobOr404(req));
    res.json({ ok: true });
  }));
  app.post('/api/jobs/:id/fail', json, wrap((req, res) => {
    fail(jobOr404(req), String(req.body?.message ?? 'Render page failed'));
    res.json({ ok: true });
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`[server] ${req.method} ${req.path} failed: ${err.stack ?? err.message}`);
    res.status(status).json({ error: err.message });
  });

  // ---------------------------------------------------------------- frontend
  // Live-reload websocket shares this HTTP server, so there is never a second port to clash.
  const httpServer = http.createServer(app);
  let closeVite: () => Promise<void> = async () => undefined;
  const dist = path.join(ROOT, 'dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
  } else {
    const vite = await createViteServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: opts.hmr === false ? false : { server: httpServer },
        ws: opts.hmr === false ? false : undefined,
        // A function, not a glob: absolute paths can contain glob characters (e.g. "C:\\Users\\Me (Work)").
        watch: { ignored: [(p: string) => isInside(p, ws.root) || isIgnoredFolder(p)] },
      },
      appType: 'mpa',
      logLevel: 'warn',
    });
    app.use(vite.middlewares);
    closeVite = () => vite.close();
  }

  const host = opts.host ?? '127.0.0.1';
  const server = await new Promise<http.Server>((resolve) => {
    httpServer.listen(opts.port, host, () => resolve(httpServer));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://${host}:${port}`;
  return {
    url: baseUrl,
    workspace: ws,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await closeVite();
    },
  };
}
