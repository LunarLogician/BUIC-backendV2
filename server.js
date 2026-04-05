const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const serverless = require('serverless-http');
const cors = require('cors');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://bu-frontend-three.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, webhooks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-secret'],
}));

// ─── Middleware ───────────────────────────────────────────────────────────
// For webhook route: capture raw body for HMAC signature verification
app.use('/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }));
// For all other routes: normal JSON parsing
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/lemonsqueezy')) return next();
  express.json()(req, res, next);
});

// Import webhook routes
const webhookRoutes = require('./routes/webhook');

// ── Firebase Admin ────────────────────────────────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Vercel: pass the service account JSON as an environment variable
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    const fs = require('fs');
    const serviceAccountPath = path.join(__dirname, 'buic-839ab-firebase-adminsdk-fbsvc-70e45a5e33.json');
    if (fs.existsSync(serviceAccountPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(require(serviceAccountPath)),
      });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  }
}
const db = admin.firestore();

// ── Write premium_paid = true to Firestore ────────────────────────────────
async function markEnrollmentPaidInFirestore(enrollment) {
  await db.collection('students').doc(enrollment).set(
    { premium_paid: true, premiumSince: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ── Manual admin: activate Pro for an enrollment ──────────────────────────
// POST /api/set-paid { enrollment, secret }
app.post('/api/set-paid', async (req, res) => {
  const { enrollment, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!enrollment) {
    return res.status(400).json({ error: 'enrollment is required' });
  }
  try {
    await markEnrollmentPaidInFirestore(enrollment);
    res.json({ success: true, message: `Pro activated for ${enrollment}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Manual admin: revoke Pro ──────────────────────────────────────────────
// POST /api/revoke-paid { enrollment, secret }
app.post('/api/revoke-paid', async (req, res) => {
  const { enrollment, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!enrollment) {
    return res.status(400).json({ error: 'enrollment is required' });
  }
  try {
    await db.collection('students').doc(enrollment).set(
      { premium_paid: false },
      { merge: true }
    );
    res.json({ success: true, message: `Pro revoked for ${enrollment}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list all Pro users ─────────────────────────────────────────────
app.get('/api/admin/payments', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const snap = await db.collection('students').where('premium_paid', '==', true).get();
    const results = snap.docs.map(d => ({ enrollment: d.id, ...d.data() }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Track download intent (email + role stats) & store to paid_orders ────
app.post('/api/track-download', async (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid email' });
  try {
    const normalizedEmail = email.toLowerCase().trim();

    // Store to download_leads (analytics - always)
    await db.collection('download_leads').add({
      email,
      role: role || 'unknown',
      ts: new Date().toISOString(),
    });

    // Check if email already exists in paid_orders (prevent duplicates)
    const existing = await db.collection('paid_orders').where('email', '==', normalizedEmail).limit(1).get();
    
    if (existing.empty) {
      // New email - store to paid_orders
      await db.collection('paid_orders').add({
        email: normalizedEmail,
        order_id: 'download-form-' + Date.now(),
        paid_at: new Date(),
      });
      console.log(`✓ NEW: Stored email ${normalizedEmail} to paid_orders`);
    } else {
      // Duplicate - just log it, user can still download
      console.log(`ℹ️ DUPLICATE: Email ${normalizedEmail} already in paid_orders, skipped`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('track-download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get secure APK download URL ─────────────────────────────────────────────
// POST /api/get-download-url (no email required)
// Security: LemonSqueezy already verified payment before redirecting here
app.post('/api/get-download-url', async (req, res) => {
  const { email } = req.body || {};
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Check if this email exists in paid_orders collection (proof they paid)
    const snap = await db.collection('paid_orders')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: 'No payment found for this email. Please verify you used the correct email from your payment.' });
    }

    // Email verified! Generate signed URL from Firebase Storage
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    const apkPath = process.env.APK_STORAGE_PATH || 'app-release.apk';

    if (!bucketName) {
      return res.status(500).json({ error: 'Storage not configured' });
    }

    const bucket = admin.storage().bucket(bucketName);
    const file = bucket.file(apkPath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });

    res.json({ url });
  } catch (err) {
    console.error('Error generating download URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Mount webhook routes ─────────────────────────────────────────────────
app.use('/', webhookRoutes);

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Local dev: listen on port; Vercel: export handler ───────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}

module.exports = app;
module.exports.handler = serverless(app);
