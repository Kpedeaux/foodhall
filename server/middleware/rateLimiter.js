import rateLimit from 'express-rate-limit';

// ── Login rate limiter ──────────────────────────────────────
// Strict: 10 attempts per 15 minutes per IP
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  skipSuccessfulRequests: true, // Only count failures
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  // Use default IP-based key generator (handles IPv6 correctly)
});

// ── General API rate limiter ────────────────────────────────
// Generous but prevents abuse: 200 requests per minute per IP
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// ── Password reset rate limiter ─────────────────────────────
// Prevent brute-forcing password resets
export const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password change attempts. Please try again later.' },
});
