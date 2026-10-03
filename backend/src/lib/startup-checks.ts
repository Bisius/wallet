import { accessSync, constants, mkdirSync, statSync } from 'node:fs';

/**
 * A mistake in how the server is set up (a folder it cannot write to), reported before anything
 * starts. The message is meant to be read by whoever runs the server: it names the path and the
 * likely cause, and `index.ts` prints it and exits instead of showing a stack trace.
 */
export class StartupError extends Error {
  override readonly name = 'StartupError';
}

/** The likely cause of a failed file system call, in words, for the error codes a setup mistake gives. */
function cause(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const uid = process.getuid?.();
  const who =
    uid === undefined ? 'the user running Wallet' : `the user running Wallet (uid ${uid})`;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `${who} has no write permission there. In Docker, a bind-mounted folder must be writable by the container's user`;
    case 'EROFS':
      return 'the file system is mounted read-only';
    case 'ENOTDIR':
    case 'EEXIST':
      return 'a part of that path is a file, not a folder';
    case 'ENOSPC':
      return 'the disk is full';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Makes sure `dir` exists (creating it, with its parents, when it does not) and that the server can
 * write in it, which is what SQLite needs next to the database (the file itself, `-wal`, `-shm`) and
 * what a backup needs. `purpose` says what the folder is for ("database folder", "backup folder").
 * Throws a `StartupError` that names the path and the likely cause; touches nothing else.
 */
export function ensureWritableDir(dir: string, purpose: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new StartupError(
      `Cannot create the ${purpose} ${dir}: ${cause(error)}. Create it, or fix the permissions of its parent folder.`,
    );
  }
  try {
    if (!statSync(dir).isDirectory())
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new StartupError(
      `The ${purpose} ${dir} is not writable: ${cause(error)}. Fix its permissions (or point Wallet at another folder).`,
    );
  }
}

/**
 * What to throw for a failure of `createDb` / `runMigrations` on the database `path`: a
 * `StartupError` that names the file and the likely cause when the failure is one of the file
 * problems (better-sqlite3 alone says "unable to open database file" for a folder it cannot write
 * to, a read-only file, a path that is a directory and more, without saying which file), and the
 * original error otherwise, so a failing migration still shows its own stack.
 */
export function explainDatabaseError(path: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code !== 'string') return error;
  const detail = error instanceof Error ? error.message : String(error);

  if (/^SQLITE_(CANTOPEN|READONLY|PERM|IOERR|FULL)/.test(code)) {
    return new StartupError(
      `Cannot open the database ${path} for writing: ${detail} (${code}). Check that the file (if it exists) ` +
        `and its folder are writable by the user running Wallet, that the path is not a folder, and that ` +
        `the disk is not full or read-only.`,
    );
  }
  if (/^SQLITE_(NOTADB|CORRUPT)/.test(code)) {
    return new StartupError(
      `The database ${path} is not a valid SQLite database or is damaged: ${detail} (${code}). ` +
        `Do not delete it; restore a backup instead (docs/DOMAIN.md, "Backups").`,
    );
  }
  return error;
}
