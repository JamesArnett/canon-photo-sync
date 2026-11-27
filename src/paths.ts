import { constants, access, lstat, mkdir, realpath, readdir, statfs, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function within(root: string, path: string) {
  return path === root || path.startsWith(root + sep);
}
export class ImportPaths {
  constructor(readonly roots: string[]) {}
  async directory(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path || !this.roots.some(root => within(root, path))) {
      throw Error('Path outside approved import roots');
    }
    if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) {
      throw Error('Import path must be a real directory without symbolic links');
    }
    return path;
  }
  async create(path: string) {
    await this.directory(dirname(path));
    if (resolve(path) !== path) throw Error('Invalid directory path');
    await mkdir(path, { mode: 0o750 });
    return this.directory(path);
  }
  async browse(path?: string) {
    if (path === undefined) return { roots: this.roots };
    await this.directory(path);
    const entries = await readdir(path, { withFileTypes: true });
    return { path, directories: entries.filter(e => e.isDirectory()).map(e => e.name).sort(), free: await this.free(path) };
  }
  async free(path: string) {
    const s = await statfs(await this.directory(path));
    return s.bavail * s.bsize;
  }
  async check(path: string) {
    await this.directory(path);
    await access(path, constants.W_OK | constants.X_OK);
    const probe = join(path, '.canon-probe-' + randomUUID());
    const handle = await open(probe, 'wx', 0o600);
    try { await handle.close(); } finally { await unlink(probe); }
    return this.free(path);
  }
}
export function safeName(name: string) {
  return Array.from(basename(name.replaceAll('\\', '/')).normalize('NFC')
    .replace(/[^\p{L}\p{N}. _-]/gu, '_').replace(/^[. ]+|[. ]+$/g, '')).slice(0, 48).join('') || 'media';
}
