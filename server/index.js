import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db/database.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import vendorRoutes from './routes/vendors.js';
import exportRoutes from './routes/export.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Security headers ────────────────────────────────────────
// Helmet sets X-Content-Type-Options, X-Frame-Options, CSP, HSTS, etc.
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false, // Disable CSP in dev (Vite injects scripts)
  crossOriginEmbedderPolicy: false, // Allow loading external resources
}));

// ── Trust proxy ─────────────────────────────────────────────
// Required for rate limiting to work behind reverse proxies (nginx, Cloudflare, DO LB, etc.)
// Set to 1 for single proxy hop (App Platform's load balancer is one hop).
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// ── CORS ────────────────────────────────────────────────────
// In production, only allow requests from your actual domain.
// In development, allow localhost on common ports.
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));

// ── Global rate limiter ─────────────────────────────────────
app.use('/api/', apiLimiter);

// Initialize database
initDb();

// ── Health checks (outside the /api/ rate limiter) ──────────
// `/health` is the canonical path App Platform / DO load balancers ping.
// `/api/health` is retained for backwards compatibility with existing clients.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/vendor', vendorRoutes);
app.use('/api/export', exportRoutes);

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── JSON 404 for any unmatched /api route ───────────────────
// Prevents the SPA fallback (production) or connection close (dev)
// from sending HTML/empty responses that crash client JSON parsers.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ────────────────────────────────────
// Guarantees a JSON body on every error path so the frontend's
// `res.json()` call never hits "Unexpected end of JSON input".
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  const message = err?.message || 'Internal server error';
  if (res.headersSent) {
    // Response already started — just end it. Client will see a
    // shorter-than-expected body, but the error middleware in apiFetch
    // catches the parse error with a friendly message.
    return res.end();
  }
  res.status(status).json({ error: message });
});

// ── Process-level safety nets ───────────────────────────────
// Log unhandled rejections / exceptions instead of letting Node crash
// silently mid-request (which is what produces an empty HTTP response
// and the frontend's "Unexpected end of JSON input" error).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// ── Listen ──────────────────────────────────────────────────
// App Platform / Heroku-style platforms inject PORT at runtime.
// Bind 0.0.0.0 so the container's port routing reaches us.
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FoodHall API listening on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`  Local:  http://localhost:${PORT}`);
    console.log(`  Vite:   http://localhost:3000`);
  }
});
