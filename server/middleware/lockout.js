import { getDb } from '../db/database.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// ── Account lockout ─────────────────────────────────────────
// Tracks failed login attempts in the database. After MAX_FAILED_ATTEMPTS
// consecutive failures, the account is locked for LOCKOUT_DURATION_MS.
// Successful login resets the counter.

export function checkLockout(username) {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, failed_login_attempts, locked_until FROM users WHERE LOWER(username) = LOWER(?) AND active = 1
  `).get(username);

  if (!user) return { locked: false }; // Don't reveal user existence

  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until).getTime();
    if (Date.now() < lockedUntil) {
      const minutesLeft = Math.ceil((lockedUntil - Date.now()) / 60000);
      return { locked: true, minutesLeft };
    }
    // Lockout expired — reset
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  return { locked: false };
}

export function recordFailedAttempt(username) {
  const db = getDb();
  const user = db.prepare('SELECT id, failed_login_attempts FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  if (!user) return;

  const attempts = (user.failed_login_attempts || 0) + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, lockedUntil, user.id);
  } else {
    db.prepare('UPDATE users SET failed_login_attempts = ? WHERE id = ?')
      .run(attempts, user.id);
  }
}

export function resetFailedAttempts(userId) {
  const db = getDb();
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}
