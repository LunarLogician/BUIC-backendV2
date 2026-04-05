const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const serverless = require('serverless-http');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────
app.use(express.json());

// Import webhook routes
const webhookRoutes = require('./routes/webhook');

// ── Firebase Admin ────────────────────────────────────────────────────────
if (!admin.apps.length) {
  const fs = require('fs');
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath)),
    });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
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
