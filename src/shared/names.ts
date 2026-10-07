// Project and file names that are safe on Windows, macOS and Linux. Shared by the server (folder names) and the
// Save-as dialog (so what the user sees is exactly what gets saved).
// Windows device names (COM0/LPT0 and COM¹–³/LPT¹–³ included, as Microsoft's naming rules list them, plus the console
// devices CONIN$/CONOUT$); "nul.txt" is the device too. sanitizeName strips '$' and superscripts before its check.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const RESERVED_WITH_EXT = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

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

/** Same project folder? Windows and macOS file systems ignore case, so "Promo" and "promo" are one folder there. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A short, safe file name that keeps the extension (asset files live several folders deep; Windows MAX_PATH is 260). */
export function safeFileName(original: string, maxLength = 60): string {
  const m = /(\.[A-Za-z0-9]{1,6})$/.exec(original);
  const ext = m ? m[1].toLowerCase() : '';
  const base = (m ? original.slice(0, -m[1].length) : original).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '') || 'file';
  return base.slice(0, Math.max(1, maxLength - ext.length)) + ext;
}

/**
 * One file or folder name that every OS stores as-is: none of the characters Windows forbids (<>:"/\|?* and control
 * characters — ':' would also address an NTFS stream), no trailing dot or space (Windows drops them silently, so two
 * names could become one file), and not a device name such as NUL or COM1 (with or without an extension).
 */
export function isPortableName(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\x00-\x1f]/.test(segment)) return false;
  return !/[. ]$/.test(segment) && !RESERVED_WITH_EXT.test(segment);
}
