const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const serverless = require('serverless-http');
const cors = require('cors');
const crypto = require('crypto');

// Load environment variables from .env file
require('dotenv').config();

console.log('\n🚀 ════════════════════════════════════════════════════════════════════════════');
console.log('🔧 SERVER INITIALIZATION STARTED');
console.log('════════════════════════════════════════════════════════════════════════════');
console.log('📍 Environment:', process.env.NODE_ENV || 'development');
console.log('🕐 Timestamp:', new Date().toISOString());
console.log('════════════════════════════════════════════════════════════════════════════\n');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://bu-frontend-three.vercel.app',
  'https://bu-frontend-muhammad-zubairs-projects-9d625f29.vercel.app',
  'https://bu-frontend-git-main-muhammad-zubairs-projects-9d625f29.vercel.app',
  'https://bubuddy.site',
  'https://www.bubuddy.site',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8000'
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, webhooks, ngrok)



    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('🔴 CORS blocked - Origin:', origin);
      console.log('📋 Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-secret'],
}));

// ─── Middleware ───────────────────────────────────────────────────────────
// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// For webhook routes: capture raw body for HMAC signature verification
app.use('/webhooks/lemonsqueezy', express.raw({ type: 'application/json' }));
app.use('/api/subscription/webhook', express.raw({ type: 'application/json' }));

// For all other routes: normal JSON parsing
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/lemonsqueezy') || req.path.startsWith('/api/subscription/webhook')) return next();
  express.json()(req, res, next);
});

// Import webhook routes
const webhookRoutes = require('./routes/webhook');

// ── Firebase Admin ────────────────────────────────────────────────────────
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Vercel: pass the service account JSON as an environment variable
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('✅ Firebase initialized from environment variable');
    } else {
      const fs = require('fs');
      const serviceAccountPath = path.join(__dirname, 'buic-839ab-firebase-adminsdk-fbsvc-70e45a5e33.json');
      if (fs.existsSync(serviceAccountPath)) {
        admin.initializeApp({
          credential: admin.credential.cert(require(serviceAccountPath)),
        });
        console.log('✅ Firebase initialized from service account file');
      } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
        console.log('✅ Firebase initialized with application default credentials');
      }
    }
  } catch (err) {
    console.error('❌ Firebase initialization error:', err.message);
    process.exit(1);
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
    // Query paid_orders collection for complete payment data
    const snap = await db.collection('paid_orders').get();
    const results = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        order_id: data.order_id,
        email: data.email,
        product: data.product,
        amount: data.amount,
        currency: data.currency,
        paid_at: data.paid_at,
        status: 'Submitted',
        ...data
      };
    });
    res.json(results.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Join payments with student enrollment data
app.get('/api/admin/payments-with-enrollment', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // Get all paid orders
    const paidSnap = await db.collection('paid_orders').get();
    const results = [];
    
    for (const paidDoc of paidSnap.docs) {
      const paymentData = paidDoc.data();
      const paymentWithId = {
        order_id: paymentData.order_id,
        email: paymentData.email,
        product: paymentData.product,
        amount: paymentData.amount,
        currency: paymentData.currency,
        paid_at: paymentData.paid_at,
        status: 'Paid'
      };
      
      // Try to find matching student/enrollment by order_id
      const studentSnap = await db.collection('students')
        .where('order_id', '==', String(paymentData.order_id))
        .limit(1)
        .get();
      
      if (!studentSnap.empty) {
        const studentDoc = studentSnap.docs[0];
        const studentData = studentDoc.data();
        results.push({
          ...paymentWithId,
          enrollment: studentDoc.id,
          premium_paid: studentData.premium_paid,
          premiumExpiresAt: studentData.premiumExpiresAt,
          premiumSince: studentData.premiumSince,
          lastSeen: studentData.lastSeen,
          attendance: studentData.attendance
        });
      } else {
        results.push({
          ...paymentWithId,
          enrollment: 'Not Linked',
          premium_paid: false,
          premiumExpiresAt: null
        });
      }
    }
    
    res.json(results.sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Get device locks
app.get('/api/admin/device-locks', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const snap = await db.collection('device_locks').get();
    const results = [];
    
    snap.docs.forEach(doc => {
      const data = doc.data();
      const docId = doc.id; // email|enrollment format or direct key
      
      results.push({
        id: docId,
        email: data.email,
        enrollment: docId.split('|')[1] || docId,
        device_id: data.device_id,
        deviceHash: data.deviceHash,
        deviceName: data.deviceName,
        downloadCount: data.downloadCount || 0,
        lastDownload: data.lastDownload,
        firstDownload: data.firstDownload,
        role: data.role
      });
    });
    
    res.json(results.sort((a, b) => new Date(b.lastDownload) - new Date(a.lastDownload)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/track-download', async (req, res) => {
  const { email, role, ts } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid email' });
  
  console.log('\n🛒 ════════════════════════════════════════════════════════════════════════════');
  console.log('📝 CHECKOUT INITIATED FROM FRONTEND');
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log('📧 Email:', email);
  console.log('👤 Role:', role || 'unknown');
  console.log('⏰ Timestamp:', ts ? new Date(ts).toISOString() : new Date().toISOString());
  console.log('🌐 User Agent:', req.headers['user-agent']?.substring(0, 80));
  console.log('📍 IP Address:', req.ip);
  console.log('════════════════════════════════════════════════════════════════════════════\n');
  
  try {
    // ONLY store to analytics, NOT to paid_orders
    await db.collection('download_leads').add({
      email,
      role: role || 'unknown',
      ts: new Date().toISOString(),
    });
    console.log('✅ Checkout tracked in Firestore');
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error tracking checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TEST: Simulate Lemonsqueezy Webhook ──────────────────────────────────
// POST /api/test-webhook { email }
// Use this to test the webhook flow without configuring Lemonsqueezy
app.post('/api/test-webhook', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid email' });
  }

  console.log('\n🧪 ════════════════════════════════════════════════════════════════════════════');
  console.log('🔬 TEST WEBHOOK TRIGGERED');
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log('📧 Test Email:', email);
  console.log('⏰ Triggered At:', new Date().toISOString());
  console.log('════════════════════════════════════════════════════════════════════════════\n');

  try {
    // Simulate Lemonsqueezy order completion
    await db.collection('paid_orders').add({
      email: email.toLowerCase().trim(),
      order_id: 'TEST_' + Date.now(),
      paid_at: new Date(),
      test: true,
    });

    console.log('✅ Test order recorded for', email);
    console.log('📝 Document added to paid_orders collection\n');

    res.json({
      success: true,
      message: `Test payment recorded for ${email}. Check Firebase paid_orders collection.`
    });
  } catch (err) {
    console.error('❌ Error simulating webhook:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get secure APK download URL ─────────────────────────────────────────────
// POST /api/get-download-url { email, enrollment, deviceHash, role }
// Triple-lock: email + enrollment + role + device (all must match)
app.post('/api/get-download-url', async (req, res) => {
  const { email, enrollment, deviceHash, role } = req.body || {};
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  
  if (!deviceHash) {
    return res.status(400).json({ error: 'Device hash required' });
  }

  if (!role) {
    return res.status(400).json({ error: 'Role (student/faculty/admin) required' });
  }

  // Enrollment ID only required for students
  if (role === 'student' && !enrollment) {
    return res.status(400).json({ error: 'Enrollment ID required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedRole = role.toLowerCase().trim();

  try {
    // 1️⃣ Check if this email exists in paid_orders
    const paidSnap = await db.collection('paid_orders')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (paidSnap.empty) {
      console.warn(`⚠️ Download attempt - no payment found for ${normalizedEmail}`);
      return res.status(404).json({ error: 'No payment found for this email.' });
    }

    // 2️⃣ Check if device lock exists for this combo
    // IMPORTANT: Lock by EMAIL+ROLE only - one device per person, regardless of enrollment
    // This prevents account sharing across different courses/enrollments
    const deviceLockId = `${normalizedEmail}|${normalizedRole}`;
    const lockSnap = await db.collection('device_locks').doc(deviceLockId).get();

    // Get server-side IP address (can't be spoofed by client)
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgentHeader = req.headers['user-agent'] || 'MISSING_USER_AGENT';
    
    // Create a unique device identifier: hash of IP + User-Agent (not client-provided)
    const signatureInput = `${clientIp}:${userAgentHeader}`;
    const serverDeviceSignature = crypto
      .createHash('sha256')
      .update(signatureInput)
      .digest('hex');
    
    console.log(`\n🔐 DEVICE LOCK CHECK for ${normalizedEmail}/${normalizedRole}`);
    console.log(`   Client IP: ${clientIp}`);
    console.log(`   User-Agent: ${userAgentHeader.substring(0, 60)}`);
    console.log(`   Signature: ${serverDeviceSignature}`);

    if (lockSnap.exists) {
      const lockData = lockSnap.data();
      console.log(`   Lock EXISTS. Stored signature: ${lockData.serverDeviceSignature || 'NONE'}`);
      console.log(`   Stored IP: ${lockData.clientIp || 'NONE'}`);
      
      // Device already registered - verify it matches
      // Use server-generated signature, not client deviceHash
      // Handle migration: if old lock doesn't have serverDeviceSignature, treat as new device
      const registeredSignature = lockData.serverDeviceSignature;
      
      console.log(`   Checking signature match:`);
      console.log(`     Registered: ${registeredSignature || 'NONE (old format lock)'}`);
      console.log(`     Current:    ${serverDeviceSignature}`);
      console.log(`     Match: ${registeredSignature === serverDeviceSignature ? '✅ YES' : '❌ NO'}`);
      
      if (registeredSignature && registeredSignature !== serverDeviceSignature) {
        console.warn(`❌ DEVICE MISMATCH REJECTED: ${normalizedEmail}/${normalizedRole}`);
        console.warn(`   Registered device IP: ${lockData.clientIp || 'unknown'}`);
        console.warn(`   Attempted device IP: ${clientIp}`);
        return res.status(403).json({ 
          error: normalizedRole === 'student' 
            ? 'This enrollment is already registered on a different device. Contact support to transfer to a new device.'
            : 'This account is already registered on a different device. Contact support to transfer to a new device.',
          registered_device: lockData.clientIp || 'unknown',
          current_device: clientIp
        });
      }
      
      if (registeredSignature) {
        console.log(`✅ ACCEPTED: Same device, download allowed`);
      } else {
        console.log(`✅ MIGRATING: Old lock format, updating to new signature`);
      }
    } else {
      console.log(`   Lock DOES NOT exist yet - first download`);
    }

    // 3️⃣ Update/create device lock with this combo
    // IMPORTANT: Only SET device info on FIRST download. Lock it in place.
    // On subsequent downloads, only increment counters - NEVER change device signature.
    
    const isFirstDownload = !lockSnap.exists;
    
    const lockData = {
      // Always update these on every download:
      email: normalizedEmail,
      role: normalizedRole,
      lastDownload: new Date(),
      downloadCount: admin.firestore.FieldValue.increment(1)
    };
    
    // ONLY set device info on FIRST DOWNLOAD - lock it in place forever:
    if (isFirstDownload) {
      lockData.deviceHash = deviceHash;                    // Keep for backwards compatibility
      lockData.serverDeviceSignature = serverDeviceSignature;  // Lock this device!
      lockData.clientIp = clientIp;                         // Lock this IP!
      lockData.userAgent = req.headers['user-agent'];       // Lock this browser!
      lockData.firstDownload = new Date();
      console.log(`🔒 DEVICE LOCKED on first download: ${clientIp}`);
    } else {
      // SUBSEQUENT downloads - only update counters, preserve device info from first download
      lockData.firstDownload = lockSnap.data().firstDownload;
      console.log(`✓ Download allowed from already-registered device`);
    }
    
    // Add enrollment only for students
    if (normalizedRole === 'student' && enrollment) {
      lockData.enrollment = enrollment;
    }
    
    await db.collection('device_locks').doc(deviceLockId).set(lockData, { merge: true });

    console.log(`📊 Device lock status: ${deviceLockId.substring(0, 30)}...`);

    // 4️⃣ Generate signed download URL from Firebase Storage
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

    res.json({ 
      url, 
      message: 'Download authorized for this device',
      security: {
        email: normalizedEmail,
        ...(normalizedRole === 'student' && { enrollment: enrollment }),
        role: normalizedRole,
        device: deviceHash.substring(0, 12)
      }
    });
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
