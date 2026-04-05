const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const serverless = require('serverless-http');
const cors = require('cors');
const crypto = require('crypto');

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

// ── Generate device-locked download hash ────────────────────────────────
function generateDownloadHash(email, deviceId) {
  const data = `${email}:${deviceId}:${process.env.DOWNLOAD_SALT || 'buic-default-salt'}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

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
  const { email, role, device_id } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid email' });
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const downloadHash = generateDownloadHash(normalizedEmail, device_id);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Store to download_leads (analytics - always)
    await db.collection('download_leads').add({
      email,
      role: role || 'unknown',
      device_id,
      ts: new Date().toISOString(),
    });

    // Check if email already exists in paid_orders (prevent duplicates)
    const existing = await db.collection('paid_orders').where('email', '==', normalizedEmail).limit(1).get();
    
    if (existing.empty) {
      // New email - store to paid_orders with device_id and hash
      await db.collection('paid_orders').add({
        email: normalizedEmail,
        device_id,
        download_hash: downloadHash,
        order_id: 'download-form-' + Date.now(),
        paid_at: new Date(),
        expires_at: expiresAt,
        payment_verified: false, // NOT verified until webhook/payment API confirms
      });
      console.log(`✓ NEW: Stored email ${normalizedEmail} with device ${device_id} (pending verification)`);
      res.json({ ok: true, download_hash: downloadHash });
    } else {
      // Email already registered
      const existingData = existing.docs[0].data();
      const registeredDevice = existingData.device_id;
      
      if (registeredDevice === device_id) {
        // SAME DEVICE - refresh hash and expiry
        const docId = existing.docs[0].id;
        await db.collection('paid_orders').doc(docId).update({
          download_hash: downloadHash,
          expires_at: expiresAt,
        });
        console.log(`ℹ️ SAME DEVICE: Refreshed hash for ${normalizedEmail} on device ${device_id}`);
        res.json({ ok: true, download_hash: downloadHash });
      } else {
        // DIFFERENT DEVICE - REJECTED!
        console.log(`❌ BLOCKED: Attempt from different device! Email ${normalizedEmail} registered on ${registeredDevice}, attempted from ${device_id}`);
        return res.status(403).json({ error: 'This email is already registered on a different device. Contact support to change devices.' });
      }
    }
  } catch (err) {
    console.error('track-download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get secure APK download URL (device-locked) ──────────────────────────
// POST /api/get-download-url { email, device_id }
// Only same device that registered the email can download
// AND payment must be verified
app.post('/api/get-download-url', async (req, res) => {
  const { email, device_id } = req.body || {};
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (!device_id) {
    return res.status(400).json({ error: 'device_id required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const expectedHash = generateDownloadHash(normalizedEmail, device_id);

  try {
    // Check if email + device_id match in paid_orders (device-locked verification)
    const snap = await db.collection('paid_orders')
      .where('email', '==', normalizedEmail)
      .where('download_hash', '==', expectedHash)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(403).json({ error: 'Download not authorized for this device. Please register with the same device used during payment.' });
    }

    const paidOrder = snap.docs[0].data();
    
    // CHECK: Payment must be verified
    if (!paidOrder.payment_verified) {
      return res.status(403).json({ error: 'Payment not yet verified. Please complete the payment verification first.' });
    }
    
    if (paidOrder.expires_at && new Date(paidOrder.expires_at.toDate()) < new Date()) {
      return res.status(403).json({ error: 'Download link expired. Please re-register.' });
    }

    // Device verified AND payment verified! Generate signed URL from Firebase Storage
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

    console.log(`✓ Download authorized for ${normalizedEmail} on device ${device_id}`);
    res.json({ url });
  } catch (err) {
    console.error('Error generating download URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Verify payment from LemonSqueezy ──────────────────────────────────────
// POST /api/verify-payment { order_id, email }
// Called after successful LemonSqueezy payment
app.post('/api/verify-payment', async (req, res) => {
  const { order_id, email } = req.body || {};
  
  if (!order_id || !email || !email.includes('@')) {
    return res.status(400).json({ error: 'order_id and email required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const lemonApiKey = process.env.LEMON_SQUEEZY_API_KEY;

  if (!lemonApiKey) {
    console.error('⚠️ LEMON_SQUEEZY_API_KEY not configured');
    return res.status(500).json({ error: 'Payment verification service not configured' });
  }

  try {
    // Query LemonSqueezy API to verify the order
    const lemonResponse = await fetch(`https://api.lemonsqueezy.com/v1/orders/${order_id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${lemonApiKey}` },
    });

    if (!lemonResponse.ok) {
      console.log(`❌ LemonSqueezy order lookup failed:`, lemonResponse.status);
      return res.status(403).json({ error: 'Order not found or invalid' });
    }

    const orderData = await lemonResponse.json();
    const order = orderData.data;

    // Basic validation: order should exist and be completed
    if (!order || order.attributes.status !== 'completed') {
      return res.status(403).json({ error: 'Order not completed or invalid' });
    }

    console.log(`✓ LemonSqueezy order ${order_id} verified`);

    // Find email in paid_orders and mark as verified
    const snap = await db.collection('paid_orders')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: 'Email not registered. Please register first before payment.' });
    }

    const docId = snap.docs[0].id;
    const existingData = snap.docs[0].data();

    // Update to mark payment as verified
    await db.collection('paid_orders').doc(docId).update({
      payment_verified: true,
      verified_at: new Date(),
      lemon_order_id: order_id,
    });

    console.log(`✓ Payment verified for ${normalizedEmail}, order ${order_id}`);
    res.json({ ok: true, message: 'Payment verified successfully' });
  } catch (err) {
    console.error('verify-payment error:', err);
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
