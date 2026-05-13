import { sql } from '../db/database.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;

// ── Account lockout ─────────────────────────────────────────
// Tracks failed login attempts in the database. After MAX_FAILED_ATTEMPTS
// consecutive failures, the account is locked for LOCKOUT_DURATION_MINUTES.
// Successful login resets the counter.

export async function checkLockout(username) {
  const [user] = await sql`
    SELECT id, failed_login_attempts, locked_until
    FROM users
    WHERE LOWER(username) = LOWER(${username}) AND active = TRUE
  `;

  if (!user) return { locked: false }; // Don't reveal user existence

  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until).getTime();
    if (Date.now() < lockedUntil) {
      const minutesLeft = Math.ceil((lockedUntil - Date.now()) / 60000);
      return { locked: true, minutesLeft };
    }
    // Lockout expired — reset
    await sql`
      UPDATE users SET failed_login_attempts = 0, locked_until = NULL
      WHERE id = ${user.id}
    `;
  }

  return { locked: false };
}

export async function recordFailedAttempt(username) {
  const [user] = await sql`
    SELECT id, failed_login_attempts
    FROM users
    WHERE LOWER(username) = LOWER(${username})
  `;
  if (!user) return;

  const attempts = (user.failed_login_attempts || 0) + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await sql`
      UPDATE users
      SET failed_login_attempts = ${attempts},
          locked_until = now() + (${LOCKOUT_DURATION_MINUTES} || ' minutes')::interval
      WHERE id = ${user.id}
    `;
  } else {
    await sql`
      UPDATE users SET failed_login_attempts = ${attempts} WHERE id = ${user.id}
    `;
  }
}

export async function resetFailedAttempts(userId) {
  await sql`
    UPDATE users SET failed_login_attempts = 0, locked_until = NULL
    WHERE id = ${userId}
  `;
}
