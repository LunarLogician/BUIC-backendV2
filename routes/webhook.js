// BU Assistant Backend - Lemonsqueezy Webhook Handler
// Handles payment confirmations and APK download delivery

const express = require('express');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

// ───── Configuration ─────
const LEMONSQUEEZY_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

console.log('\n🔌 ════════════════════════════════════════════════════════════════════════════');
console.log('🪝 WEBHOOK MODULE LOADED');
console.log('════════════════════════════════════════════════════════════════════════════');
console.log('✅ Lemonsqueezy Secret Configured:', !!LEMONSQUEEZY_WEBHOOK_SECRET);
console.log('✅ SendGrid API Key Configured:', !!SENDGRID_API_KEY);
console.log('════════════════════════════════════════════════════════════════════════════\n');

// APK configuration
const APK_CONFIG = {
    basic: {
        name: 'BU_Assistant_v1.1.0_BASIC.apk',
        size: '52.5 MB',
        price: '₨280',
        url: process.env.APK_DOWNLOAD_URL_BASIC || 'https://downloads.example.com/BU_Assistant_v1.1.0_BASIC.apk',
        features: ['Timetable', 'Attendance', 'Class Alarms', 'Auto-Sync']
    },
    pro: {
        name: 'BU_Assistant_v1.1.0_PRO.apk',
        size: '53.8 MB',
        price: '₨450/month',
        url: process.env.APK_DOWNLOAD_URL_PRO || 'https://downloads.example.com/BU_Assistant_v1.1.0_PRO.apk',
        features: ['Everything in Basic', 'Assignments', 'Quizzes', 'Notifications', 'Advanced Filtering']
    }
};

// Email transporter setup
let emailTransporter = null;
if (process.env.SMTP_HOST) {
    emailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
} else if (SENDGRID_API_KEY) {
    // Using SendGrid
    emailTransporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        auth: {
            user: 'apikey',
            pass: SENDGRID_API_KEY
        }
    });
}

// ───── Lemonsqueezy Webhook Handler ─────
/**
 * POST /webhooks/lemonsqueezy
 * 
 * Receives payment confirmations from Lemonsqueezy
 * Verifies webhook signature and updates Firestore
 */
router.post('/webhooks/lemonsqueezy', async (req, res) => {
    try {
        console.log('\n🪝 ════════════════════════════════════════════════════════════════════════════');
        console.log('📨 WEBHOOK REQUEST RECEIVED');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log('Headers:', Object.keys(req.headers));
        console.log('Body type:', Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body);
        console.log('Body size:', Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length, 'bytes');
        
        // Verify webhook signature
        const signature = req.headers['x-signature'] || req.headers['x-lemonsqueezy-signature'];
        console.log('Signature header found:', !!signature);
        console.log('Secret configured:', !!LEMONSQUEEZY_WEBHOOK_SECRET);
        
        if (!verifyLemonsqueezySignature(req.body, signature)) {
            console.warn('🚫 ❌ WEBHOOK SIGNATURE VERIFICATION FAILED');
            console.warn('Expected signature format from header:', signature?.substring(0, 20) + '...');
            return res.status(401).json({ error: 'Invalid signature' });
        }
        console.log('✅ Signature verified\n');

        // Parse body (raw buffer from express.raw middleware)
        const event = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
        
        console.log('\n🪝 ════════════════════════════════════════════════════════════════════════════');
        console.log('💳 LEMONSQUEEZY WEBHOOK RECEIVED');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log('� Full Event Data:');
        console.log(JSON.stringify(event, null, 2).substring(0, 1000));
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        // Handle different event types
        switch (event.meta.event_name) {
            case 'order_created':
            case 'order_completed':
            case 'order:created':
            case 'order:completed':
                await handleOrderCompleted(event.data, event.meta);
                break;

            case 'subscription_created':
            case 'subscription_updated':
            case 'subscription:created':
            case 'subscription:updated':
                await handleSubscriptionEvent(event.data, event.meta);
                break;

            case 'subscription_resumed':
            case 'subscription:resumed':
                await handleSubscriptionResumed(event.data, event.meta);
                break;

            case 'subscription_paused':
            case 'subscription_cancelled':
            case 'subscription:paused':
            case 'subscription:cancelled':
                await handleSubscriptionCancelled(event.data, event.meta);
                break;

            default:
                console.log(`⚠️ Unhandled event: ${event.meta.event_name}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Alternative webhook endpoint - same as /webhooks/lemonsqueezy
 * POST /api/subscription/webhook
 * 
 * Some Lemonsqueezy configurations may use this endpoint instead
 */
router.post('/api/subscription/webhook', async (req, res) => {
    try {
        console.log('\n🪝 ════════════════════════════════════════════════════════════════════════════');
        console.log('📨 WEBHOOK REQUEST RECEIVED (Alternative Endpoint)');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log('Headers:', Object.keys(req.headers));
        console.log('Body type:', Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body);
        console.log('Body size:', Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length, 'bytes');
        
        // Verify webhook signature
        const signature = req.headers['x-signature'] || req.headers['x-lemonsqueezy-signature'];
        console.log('Signature header found:', !!signature);
        console.log('Secret configured:', !!LEMONSQUEEZY_WEBHOOK_SECRET);
        
        if (!verifyLemonsqueezySignature(req.body, signature)) {
            console.warn('🚫 ❌ WEBHOOK SIGNATURE VERIFICATION FAILED');
            console.warn('Expected signature format from header:', signature?.substring(0, 20) + '...');
            return res.status(401).json({ error: 'Invalid signature' });
        }
        console.log('✅ Signature verified\n');

        // Parse body
        const event = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
        
        console.log('\n🪝 ════════════════════════════════════════════════════════════════════════════');
        console.log('💳 LEMONSQUEEZY WEBHOOK RECEIVED');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log('📌 Event Type:', event.meta.event_name);
        console.log('🆔 Event ID:', event.meta.event_id);
        console.log('⏰ Created At:', event.meta.created_at);
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        // Handle different event types
        switch (event.meta.event_name) {
            case 'order_created':
            case 'order_completed':
            case 'order:created':
            case 'order:completed':
                await handleOrderCompleted(event.data, event.meta);
                break;

            case 'subscription_created':
            case 'subscription_updated':
            case 'subscription:created':
            case 'subscription:updated':
                await handleSubscriptionEvent(event.data, event.meta);
                break;

            case 'subscription_resumed':
            case 'subscription:resumed':
                await handleSubscriptionResumed(event.data, event.meta);
                break;

            case 'subscription_paused':
            case 'subscription_cancelled':
            case 'subscription:paused':
            case 'subscription:cancelled':
                await handleSubscriptionCancelled(event.data, event.meta);
                break;

            default:
                console.log(`⚠️ Unhandled event: ${event.meta.event_name}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Handle completed orders
 */
async function handleOrderCompleted(orderData, meta) {
  try {
    console.log('\n📋 ════════════════════════════════════════════════════════════════════════════');
    console.log('🔍 ORDER DATA RECEIVED:');
    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('Full orderData:');
    console.log(JSON.stringify(orderData, null, 2).substring(0, 2000));
    console.log('════════════════════════════════════════════════════════════════════════════\n');
    
    // Try different paths to find email
    const customerEmail = 
      orderData?.attributes?.user_email ||
      orderData?.attributes?.customer_email ||
      orderData?.customer_email ||
      orderData?.data?.attributes?.customer_email ||
      orderData?.relationships?.customer?.data?.attributes?.email;
    
    // Extract enrollment ID from custom data sent during checkout
    const customData = orderData?.attributes?.custom_data || meta?.custom_data || {};
    const enrollment = customData.enrollment || customData.user_enrollment;
    
    console.log('🔎 Attempting data extraction:');
    console.log('   Email:', customerEmail);
    console.log('   Enrollment ID:', enrollment);
    console.log('   Custom Data:', customData);
    
    if (!customerEmail) {
      console.warn('⚠️ No email found in order', orderData.id);
      return;
    }

    console.log('\n✅ ════════════════════════════════════════════════════════════════════════════');
    console.log('💰 ORDER COMPLETED');
    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('📧 Customer Email:', customerEmail);
    console.log('🎓 Enrollment ID:', enrollment || 'Not provided');
    console.log('🆔 Order ID:', orderData.id);
    console.log('💵 Amount:', orderData.attributes?.total || 'N/A');
    console.log('💱 Currency:', orderData.attributes?.currency || 'N/A');
    console.log('📱 Product:', orderData.attributes?.first_order_item?.product_name || 'N/A');
    console.log('════════════════════════════════════════════════════════════════════════════');

    // Write to paid_orders with order_id as doc ID to prevent duplicates
    await admin.firestore().collection('paid_orders').doc(String(orderData.id)).set({
      email: customerEmail.toLowerCase().trim(),
      order_id: String(orderData.id),
      order_number: orderData.attributes?.order_number,
      product: orderData.attributes?.first_order_item?.product_name,
      amount: orderData.attributes?.total,
      currency: orderData.attributes?.currency,
      paid_at: new Date(),
    }, { merge: true });

    console.log('✅ Payment recorded in paid_orders for', customerEmail);
    console.log('📝 Document added to paid_orders collection with order ID:', orderData.id);

    // ✅ NEW: If enrollment ID provided, also write to students/{enrollment}
    if (enrollment) {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 30);
      
      await admin.firestore().collection('students').doc(enrollment).set({
        premium_paid: true,
        premiumSince: admin.firestore.FieldValue.serverTimestamp(),
        premiumExpiresAt: admin.firestore.Timestamp.fromDate(expiryDate),
        payment_verified_at: new Date().toISOString(),
        order_id: String(orderData.id),
        email: customerEmail.toLowerCase().trim(),
      }, { merge: true });

      console.log('✅ Payment UNLOCKED for enrollment:', enrollment);
      console.log('   ✓ premium_paid: true');
      console.log('   ✓ premiumExpiresAt:', expiryDate.toISOString());
      console.log('   ✓ order_id:', orderData.id);
    } else {
      console.warn('⚠️ No enrollment ID in order - payment recorded but NOT linked to student account');
      console.warn('   App will NOT recognize payment. User must provide enrollment manually.');
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error handling order:', error);
    throw error;
  }
}

/**
 * Calculate subscription expiry date (30 days from now or from Lemonsqueezy renewal date)
 */
function calculateSubscriptionExpiry(subscriptionData) {
    // Check if Lemonsqueezy provides a renewal date
    const renewsAt = subscriptionData?.attributes?.renews_at || subscriptionData?.attributes?.next_billing_date;
    
    if (renewsAt) {
        console.log(`📅 Using Lemonsqueezy renewal date: ${renewsAt}`);
        return new Date(renewsAt).toISOString();
    }
    
    // Default: 30 days from now
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    console.log(`📅 Calculated 30-day expiry: ${expiryDate.toISOString()}`);
    return expiryDate.toISOString();
}

/**
 * Handle subscription events (recurring payments)
 */
async function handleSubscriptionEvent(subscriptionData, meta) {
    try {
        console.log(`Processing subscription: ${subscriptionData.id}`);

        const customAttributes = meta?.custom_data || subscriptionData.attributes?.custom_data || {};
        const enrollment = customAttributes.enrollment || subscriptionData.attributes?.customer_email;
        const plan = customAttributes.plan || 'pro';

        if (!enrollment) {
            console.warn(`No enrollment ID found for subscription ${subscriptionData.id}`);
            return;
        }

        const status = subscriptionData.attributes?.status;
        const expiryDate = calculateSubscriptionExpiry(subscriptionData);
        const verifiedAt = new Date().toISOString();

        // Update Firestore subscription status with expiry tracking
        await admin.firestore().collection('students').doc(enrollment).set({
            subscription_id: subscriptionData.id,
            subscription_status: status,
            premium_paid: ['active', 'paused'].includes(status),
            premium_plan: plan,
            premium_expires_at: expiryDate,
            payment_verified_at: verifiedAt,
            subscription_updated_date: new Date()
        }, { merge: true });

        console.log(`✅ Updated Firestore subscription for enrollment: ${enrollment}`);
        console.log(`   ✓ premium_expires_at: ${expiryDate}`);
        console.log(`   ✓ payment_verified_at: ${verifiedAt}`);

        // Send confirmation if newly activated
        if (status === 'active' && subscriptionData.attributes?.customer_email) {
            await sendSubscriptionConfirmationEmail(
                subscriptionData.attributes.customer_email,
                enrollment,
                plan,
                subscriptionData.id
            );
        }
    } catch (error) {
        console.error('Error handling subscription:', error);
        throw error;
    }
}

/**
 * Handle subscription resumption
 */
async function handleSubscriptionResumed(subscriptionData, meta) {
    try {
        console.log(`Subscription resumed: ${subscriptionData.id}`);

        const customAttributes = meta?.custom_data || subscriptionData.attributes?.custom_data || {};
        const enrollment = customAttributes.enrollment || subscriptionData.attributes?.customer_email;

        if (!enrollment) return;

        const expiryDate = calculateSubscriptionExpiry(subscriptionData);
        const verifiedAt = new Date().toISOString();

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: true,
            subscription_status: 'active',
            premium_expires_at: expiryDate,
            payment_verified_at: verifiedAt,
            subscription_resumed_date: new Date()
        }, { merge: true });

        console.log(`✅ Subscription resumed for enrollment: ${enrollment}`);
        console.log(`   ✓ premium_expires_at: ${expiryDate}`);
        console.log(`   ✓ payment_verified_at: ${verifiedAt}`);
    } catch (error) {
        console.error('Error handling subscription resumption:', error);
        throw error;
    }
}

/**
 * Handle subscription cancellation
 */
async function handleSubscriptionCancelled(subscriptionData, meta) {
    try {
        console.log(`Subscription cancelled: ${subscriptionData.id}`);

        const customAttributes = meta?.custom_data || subscriptionData.attributes?.custom_data || {};
        const enrollment = customAttributes.enrollment || subscriptionData.attributes?.customer_email;

        if (!enrollment) return;

        // Set expiry date to now when cancelled
        const now = new Date().toISOString();

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: false,
            subscription_status: subscriptionData.attributes?.status,
            premium_expires_at: now,
            subscription_ended_date: new Date()
        }, { merge: true });

        console.log(`✅ Subscription cancelled for enrollment: ${enrollment}`);
        console.log(`   ✓ premium_paid set to: false`);
        console.log(`   ✓ premium_expires_at set to: ${now}`);
    } catch (error) {
        console.error('Error handling subscription cancellation:', error);
        throw error;
    }
}

// ───── Email Handlers ─────

/**
 * Send order confirmation with APK download link
 */
async function sendOrderConfirmationEmail(customerEmail, enrollment, plan, orderId) {
    if (!emailTransporter) {
        console.warn('Email transporter not configured');
        return;
    }

    const apkConfig = APK_CONFIG[plan] || APK_CONFIG.pro;
    const downloadUrl = `${process.env.APP_URL || 'https://app.example.com'}/download.html?enrollment=${enrollment}&plan=${plan}&token=${generateToken(enrollment)}`;

    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@buassistant.com',
        to: customerEmail,
        subject: `🎉 Download BU Assistant ${plan.toUpperCase()} - Order #${orderId}`,
        html: generateOrderEmailHTML(apkConfig, plan, downloadUrl, enrollment)
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`✓ Order confirmation email sent to ${customerEmail}`);
    } catch (error) {
        console.error(`Error sending email to ${customerEmail}:`, error);
    }
}

/**
 * Send subscription confirmation email
 */
async function sendSubscriptionConfirmationEmail(customerEmail, enrollment, plan, subscriptionId) {
    if (!emailTransporter) {
        console.warn('Email transporter not configured');
        return;
    }

    const apkConfig = APK_CONFIG[plan] || APK_CONFIG.pro;
    const downloadUrl = `${process.env.APP_URL || 'https://app.example.com'}/download.html?enrollment=${enrollment}&plan=${plan}&token=${generateToken(enrollment)}`;

    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@buassistant.com',
        to: customerEmail,
        subject: `✅ Welcome to BU Assistant ${plan.toUpperCase()} - Subscription #${subscriptionId}`,
        html: generateSubscriptionEmailHTML(apkConfig, plan, downloadUrl, enrollment)
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`✓ Subscription confirmation email sent to ${customerEmail}`);
    } catch (error) {
        console.error(`Error sending subscription email to ${customerEmail}:`, error);
    }
}

// ───── API Endpoint for Email Sending via Frontend ─────

/**
 * POST /api/send-download-link
 * 
 * Called from download.html when user requests email link
 */
router.post('/api/send-download-link', async (req, res) => {
    try {
        const { email, plan, apk, enrollment } = req.body;

        // Validate input
        if (!email || !plan || !apk) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Fetch enrollment from Firestore
        const enrollmentDoc = await admin.firestore()
            .collection('students')
            .doc(enrollment)
            .get();

        if (!enrollmentDoc.exists || !enrollmentDoc.data().premium_paid) {
            return res.status(403).json({ error: 'Invalid or expired access' });
        }

        const apkConfig = APK_CONFIG[plan];
        if (!apkConfig) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        // Send email with download link
        await sendDownloadLinkEmail(email, plan, apkConfig, enrollment);

        res.json({ success: true, message: `Email sent to ${email}` });
    } catch (error) {
        console.error('Error sending download link:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Send direct download link email
 */
async function sendDownloadLinkEmail(email, plan, apkConfig, enrollment) {
    if (!emailTransporter) {
        throw new Error('Email service not configured');
    }

    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@buassistant.com',
        to: email,
        subject: `📱 Your BU Assistant Download Link (${plan.toUpperCase()})`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
                <h2>📱 Your BU Assistant Download</h2>
                <p>Hello!</p>
                <p>Here's your download link for <strong>BU Assistant ${plan.toUpperCase()}</strong>:</p>
                
                <div style="margin: 30px 0; padding: 20px; background: #F4F7FB; border-radius: 8px;">
                    <p style="margin: 0 0 15px;">
                        <a href="${apkConfig.url}" 
                           style="background: #0E5CAD; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                            Download APK (${apkConfig.size})
                        </a>
                    </p>
                    <p style="margin: 0; font-size: 12px; color: #666;">
                        <strong>File:</strong> ${apkConfig.name}
                    </p>
                </div>
                
                <p><strong>Installation Instructions:</strong></p>
                <ol>
                    <li>Download the APK file to your device</li>
                    <li>Open Settings → Security → Enable "Unknown Sources"</li>
                    <li>Open the APK file and tap "Install"</li>
                    <li>Launch BU Assistant and log in with your enrollment ID</li>
                </ol>
                
                <p style="color: #666; font-size: 12px; margin-top: 30px;">
                    This link is valid for 30 days. If you need help, reply to this email.
                </p>
            </div>
        `
    };

    await emailTransporter.sendMail(mailOptions);
    console.log(`✓ Download link email sent to ${email}`);
}

// ───── Helper Functions ─────

/**
 * Verify Lemonsqueezy webhook signature
 */
function verifyLemonsqueezySignature(body, signature) {
    // In development, allow unsigned webhooks if secret is not configured
    if (!LEMONSQUEEZY_WEBHOOK_SECRET) {
        console.warn('⚠️ LEMONSQUEEZY_WEBHOOK_SECRET not configured - allowing unsigned webhooks (DEVELOPMENT ONLY)');
        return true;
    }

    if (!signature) {
        console.error('❌ No x-signature header provided in webhook');
        return false;
    }

    try {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const expectedSignature = crypto
            .createHmac('sha256', LEMONSQUEEZY_WEBHOOK_SECRET)
            .update(payload)
            .digest('hex');

        console.log('🔐 Signature verification details:');
        console.log('   Received signature:', signature.substring(0, 16) + '...');
        console.log('   Expected signature:', expectedSignature.substring(0, 16) + '...');
        console.log('   Payload size:', payload.length, 'bytes');

        const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
        
        console.log('   Signatures match:', isValid);
        return isValid;
    } catch (err) {
        console.error('❌ Signature verification error:', err.message);
        return false;
    }
}

/**
 * Generate secure token for enrollment
 */
function generateToken(enrollment) {
    return crypto
        .createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
        .update(enrollment + Date.now())
        .digest('hex');
}

/**
 * Generate order confirmation email HTML
 */
function generateOrderEmailHTML(apkConfig, plan, downloadUrl, enrollment) {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2>🎉 Order Confirmed!</h2>
            <p>Hello ${enrollment},</p>
            <p>Thank you for purchasing <strong>BU Assistant ${plan.toUpperCase()}</strong>!</p>
            
            <div style="margin: 30px 0; padding: 20px; background: #E8F5E9; border-left: 4px solid #2E7D32; border-radius: 4px;">
                <h3 style="color: #2E7D32; margin-top: 0;">✓ Your purchase includes:</h3>
                <ul style="color: #1B5E20;">
                    ${apkConfig.features.map(f => `<li>${f}</li>`).join('')}
                </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="${downloadUrl}" 
                   style="background: #0E5CAD; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                    Download BU Assistant
                </a>
            </div>
            
            <p style="color: #666; font-size: 13px;">
                <strong>File:</strong> ${apkConfig.name} (${apkConfig.size})<br/>
                <strong>Enrollment:</strong> ${enrollment}
            </p>
            
            <hr style="border: none; border-top: 1px solid #EEE; margin: 30px 0;">
            <p style="color: #999; font-size: 12px;">
                If you didn't make this purchase or have questions, please contact support@buassistant.com
            </p>
        </div>
    `;
}

/**
 * Generate subscription email HTML
 */
function generateSubscriptionEmailHTML(apkConfig, plan, downloadUrl, enrollment) {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2>✅ Subscription Started!</h2>
            <p>Hello ${enrollment},</p>
            <p>Your <strong>BU Assistant ${plan.toUpperCase()}</strong> subscription is now active!</p>
            
            <div style="margin: 30px 0; padding: 20px; background: #E3F2FD; border-left: 4px solid #0E5CAD; border-radius: 4px;">
                <h3 style="color: #0E5CAD; margin-top: 0;">📋 Subscription Details:</h3>
                <ul style="color: #1565C0;">
                    ${apkConfig.features.map(f => `<li>${f}</li>`).join('')}
                    <li><strong>Auto-renews monthly</strong></li>
                </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="${downloadUrl}" 
                   style="background: #0E5CAD; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                    Download BU Assistant
                </a>
            </div>
            
            <p style="color: #666; font-size: 13px;">
                <strong>File:</strong> ${apkConfig.name} (${apkConfig.size})<br/>
                <strong>Enrollment:</strong> ${enrollment}
            </p>
            
            <hr style="border: none; border-top: 1px solid #EEE; margin: 30px 0;">
            <p style="color: #999; font-size: 12px;">
                Manage your subscription: <a href="${process.env.SUBSCRIPTION_MANAGEMENT_URL || '#'}" style="color: #0E5CAD;">View Account</a><br/>
                Questions? Contact support@buassistant.com
            </p>
        </div>
    `;
}

// ───── Admin Endpoints ─────
// Middleware to verify admin secret
function verifyAdminSecret(req, res, next) {
    const adminSecret = req.headers['x-admin-secret'];
    const expectedSecret = process.env.ADMIN_SECRET || 'dev-admin-secret';
    
    if (!adminSecret || adminSecret !== expectedSecret) {
        console.warn('🚫 Admin access denied - invalid secret');
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}

/**
 * POST /api/admin/set-premium
 * Manually activate premium for an enrollment (for testing/manual fixes)
 * 
 * Body: { enrollment, expiryDays: 30 }
 * Headers: { x-admin-secret: "..." }
 */
router.post('/api/admin/set-premium', verifyAdminSecret, async (req, res) => {
    try {
        const { enrollment, expiryDays = 30, plan = 'pro' } = req.body;
        
        if (!enrollment) {
            return res.status(400).json({ error: 'Missing enrollment' });
        }

        const now = new Date();
        const expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + expiryDays);

        const updateData = {
            premium_paid: true,
            premium_plan: plan,
            premium_expires_at: expiryDate.toISOString(),
            payment_verified_at: now.toISOString(),
            manually_set_by_admin: true,
            admin_set_date: now.toISOString()
        };

        console.log(`\n📝 Writing to Firestore:`, updateData);
        
        const writeResult = await admin.firestore().collection('students').doc(enrollment).set(updateData, { merge: true });
        
        console.log(`✅ Firestore write successful`, writeResult);

        console.log(`\n✅ ════════════════════════════════════════════════════════════════════════════`);
        console.log('🔓 ADMIN: Premium Manually Activated');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log(`📧 Enrollment: ${enrollment}`);
        console.log(`💰 Plan: ${plan}`);
        console.log(`📅 Expires: ${expiryDate.toISOString()}`);
        console.log(`⏱️  Days: ${expiryDays}`);
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        res.json({
            success: true,
            enrollment,
            premium_paid: true,
            premium_expires_at: expiryDate.toISOString(),
            expires_in_days: expiryDays
        });
    } catch (error) {
        console.error('❌ Admin set-premium error:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/admin/check-premium/:enrollment
 * Check premium status for an enrollment
 */
router.get('/api/admin/check-premium/:enrollment', verifyAdminSecret, async (req, res) => {
    try {
        const { enrollment } = req.params;
        
        const doc = await admin.firestore().collection('students').doc(enrollment).get();
        
        if (!doc.exists) {
            return res.status(404).json({ error: 'Enrollment not found' });
        }

        const data = doc.data();
        const expiryDate = data.premium_expires_at ? new Date(data.premium_expires_at) : null;
        const now = new Date();
        const daysRemaining = expiryDate ? Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)) : null;
        const isExpired = expiryDate && expiryDate < now;

        console.log(`\n🔍 ════════════════════════════════════════════════════════════════════════════`);
        console.log('📋 ADMIN: Check Premium Status');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log(`📧 Enrollment: ${enrollment}`);
        console.log(`💰 Premium Paid: ${data.premium_paid}`);
        console.log(`📅 Expires At: ${data.premium_expires_at || 'N/A'}`);
        console.log(`⏱️  Days Remaining: ${daysRemaining !== null ? daysRemaining : 'N/A'}`);
        console.log(`⚠️  Expired: ${isExpired}`);
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        res.json({
            enrollment,
            premium_paid: data.premium_paid || false,
            premium_plan: data.premium_plan || 'none',
            premium_expires_at: data.premium_expires_at,
            payment_verified_at: data.payment_verified_at,
            subscription_status: data.subscription_status || 'none',
            days_remaining: daysRemaining,
            is_expired: isExpired,
            verified_at: data.payment_verified_at
        });
    } catch (error) {
        console.error('❌ Admin check-premium error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/admin/revoke-premium
 * Manually revoke premium for an enrollment
 */
router.post('/api/admin/revoke-premium', verifyAdminSecret, async (req, res) => {
    try {
        const { enrollment } = req.body;
        
        if (!enrollment) {
            return res.status(400).json({ error: 'Missing enrollment' });
        }

        const now = new Date();

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: false,
            premium_expires_at: now.toISOString(),
            subscription_revoked_by_admin: true,
            admin_revoke_date: now.toISOString()
        }, { merge: true });

        console.log(`\n✅ ════════════════════════════════════════════════════════════════════════════`);
        console.log('🔓 ADMIN: Premium Manually Revoked');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log(`📧 Enrollment: ${enrollment}`);
        console.log(`❌ Premium Paid: false`);
        console.log(`📅 Revoked At: ${now.toISOString()}`);
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        res.json({
            success: true,
            enrollment,
            premium_paid: false,
            premium_expires_at: now.toISOString()
        });
    } catch (error) {
        console.error('❌ Admin revoke-premium error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/admin/extend-expiry
 * Extend expiry date for an enrollment
 */
router.post('/api/admin/extend-expiry', verifyAdminSecret, async (req, res) => {
    try {
        const { enrollment, days = 30 } = req.body;
        
        if (!enrollment) {
            return res.status(400).json({ error: 'Missing enrollment' });
        }

        // Get current expiry if exists
        const doc = await admin.firestore().collection('students').doc(enrollment).get();
        let currentExpiry = new Date();
        
        if (doc.exists && doc.data().premium_expires_at) {
            currentExpiry = new Date(doc.data().premium_expires_at);
        }

        // Add days to current expiry
        const newExpiry = new Date(currentExpiry);
        newExpiry.setDate(newExpiry.getDate() + days);

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_expires_at: newExpiry.toISOString(),
            admin_extended_date: new Date().toISOString(),
            admin_extended_days: days
        }, { merge: true });

        console.log(`\n✅ ════════════════════════════════════════════════════════════════════════════`);
        console.log('🔓 ADMIN: Expiry Extended');
        console.log('════════════════════════════════════════════════════════════════════════════');
        console.log(`📧 Enrollment: ${enrollment}`);
        console.log(`📅 Old Expiry: ${currentExpiry.toISOString()}`);
        console.log(`📅 New Expiry: ${newExpiry.toISOString()}`);
        console.log(`➕ Days Added: ${days}`);
        console.log('════════════════════════════════════════════════════════════════════════════\n');

        res.json({
            success: true,
            enrollment,
            old_expiry: currentExpiry.toISOString(),
            new_expiry: newExpiry.toISOString(),
            days_added: days
        });
    } catch (error) {
        console.error('❌ Admin extend-expiry error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
