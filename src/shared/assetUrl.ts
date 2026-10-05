import type { Asset } from './schema';

/** URL the editor uses to fetch an asset: the saved project folder first, else the unsaved scratch store. */
export function assetUrl(projectName: string | null, asset: Pick<Asset, 'relativePath' | 'hash'>): string {
  const q = new URLSearchParams({ path: asset.relativePath, hash: asset.hash });
  if (projectName) q.set('project', projectName);
  return `/api/asset?${q}`;
}
