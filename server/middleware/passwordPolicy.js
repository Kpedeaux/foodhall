// ── Password policy ─────────────────────────────────────────
// Financial data requires strong passwords. This enforces:
// - Minimum 10 characters
// - At least one uppercase letter
// - At least one lowercase letter
// - At least one number
// - At least one special character

const MIN_LENGTH = 10;

export function validatePassword(password) {
  const errors = [];

  if (!password || password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&* etc.)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
