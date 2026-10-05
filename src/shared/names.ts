// Project and file names that are safe on Windows, macOS and Linux. Shared by the server (folder names) and the
// Save-as dialog (so what the user sees is exactly what gets saved).
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Letters, digits, spaces, '-' and '_' only; no trailing dots/spaces; never a Windows reserved device name. */
export function sanitizeName(name: string): string {
  let clean = name
    .replace(/\.motion$/i, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  if (RESERVED.test(clean)) clean = `${clean}_`;
  return clean;
}

/** A short, safe file name that keeps the extension (asset files live several folders deep; Windows MAX_PATH is 260). */
export function safeFileName(original: string, maxLength = 60): string {
  const m = /(\.[A-Za-z0-9]{1,6})$/.exec(original);
  const ext = m ? m[1].toLowerCase() : '';
  const base = (m ? original.slice(0, -m[1].length) : original).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '') || 'file';
  return base.slice(0, Math.max(1, maxLength - ext.length)) + ext;
}
