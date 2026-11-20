import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// People's sessions, kept beside the board so that restarting it, as an update does, signs nobody out.
//
// The file holds what the board needs to know a cookie again and nothing that would make one: for each
// session the SHA-256 of its token, whose it is, until when, and a stamp of the password it was made
// under, as agents' tokens are kept. The dashboard's CSRF token is derived from the session's token,
// so it is not kept either. Only the board's own user may read the file.
//
// A session ends when its person signs out, when its seven days run out, and when the password it
// was made under is no longer the person's: changed from the dashboard or reset on the server's
// console, with the server stopped or not. To sign everyone out, stop the board and delete the file.

export const SESSION_MS = 7 * 86_400_000;

export interface Session {
  user: string;
  until: number;
  /** The person's password stamp when the session was made (Board.passwordStamp). */
  stamp: string;
}

/** The token the dashboard sends with every change: known to whoever holds the cookie, and to nobody from a hash. */
export const csrfOf = (token: string): string => createHash('sha256').update(`rayboard csrf\0${token}`).digest('base64url');

/** The sessions in `file` that have not ended; none when there is no file, or it cannot be read. */
export function loadSessions(file: string | null, log: (line: string) => void): Map<string, Session> {
  const sessions = new Map<string, Session>();
  if (file === null || !existsSync(file)) return sessions;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) throw new Error('not an object');
    const at = Date.now();
    for (const [key, s] of Object.entries(saved as Record<string, unknown>)) {
      const { user, until, stamp } = (s ?? {}) as Partial<Session>;
      // No session outlasts its seven days, whatever the file says.
      if (/^[0-9a-f]{64}$/.test(key) && typeof user === 'string' && typeof stamp === 'string' && typeof until === 'number' && until > at) {
        sessions.set(key, { user, until: Math.min(until, at + SESSION_MS), stamp });
      }
    }
  } catch (err) {
    log(`sessions: ${file} could not be read, so everyone signs in again (${err instanceof Error ? err.message : String(err)})`);
  }
  return sessions;
}

/**
 * Writes the sessions whole, through a file of the board's user alone that then takes the old one's place.
 * A file that cannot be written is deleted: the sessions still hold until the board stops, but one that
 * has ended must not come back with the old file.
 */
export function saveSessions(file: string | null, sessions: Map<string, Session>, log: (line: string) => void): void {
  if (file === null) return;
  const next = `${file}.next`;
  try {
    rmSync(next, { force: true });
    writeFileSync(next, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    renameSync(next, file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      rmSync(file, { force: true });
      log(`sessions: ${file} could not be written (${why}); it is deleted, so a restart signs everyone out`);
    } catch {
      log(`sessions: ${file} could neither be written nor deleted (${why}); delete it before the board starts again, or sessions that ended may come back`);
    }
  }
}
