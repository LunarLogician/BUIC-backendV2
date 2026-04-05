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
        // Verify webhook signature
        const signature = req.headers['x-signature'] || req.headers['x-lemonsqueezy-signature'];
        if (!verifyLemonsqueezySignature(req.body, signature)) {
            console.warn('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Parse body (raw buffer from express.raw middleware)
        const event = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
        console.log(`Received Lemonsqueezy webhook: ${event.meta.event_name}`);

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
                console.log(`Unhandled event: ${event.meta.event_name}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Handle completed orders
 */
async function handleOrderCompleted(orderData, meta) {
    try {
        console.log(`Processing payment for order: ${orderData.id}`);

        // Extract customer and plan info
        // LemonSqueezy sends custom_data under meta, not orderData.attributes
        const customAttributes = meta?.custom_data || orderData.attributes?.custom_data || {};
        const enrollment = customAttributes.enrollment || orderData.attributes?.customer_email;
        const plan = customAttributes.plan || 'pro';

        if (!enrollment) {
            console.warn(`No enrollment ID found for order ${orderData.id}`);
            return;
        }

        // Update Firestore - Mark enrollment as premium paid (students collection)
        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: true,
            premium_plan: plan,
            payment_date: new Date(),
            order_id: orderData.id,
            order_status: orderData.attributes?.status || 'completed'
        }, { merge: true });

        // Store paid order for APK download access (keyed by email)
        const customerEmail = orderData.attributes?.customer_email;
        if (customerEmail) {
            await admin.firestore().collection('paid_orders').add({
                email: customerEmail.toLowerCase().trim(),
                order_id: String(orderData.id),
                paid_at: new Date(),
            });
        }

        console.log(`✓ Updated Firestore for enrollment: ${enrollment}`);

        // Send order confirmation email with download link
        if (orderData.attributes?.customer_email) {
            await sendOrderConfirmationEmail(
                orderData.attributes.customer_email,
                enrollment,
                plan,
                orderData.id
            );
        }
    } catch (error) {
        console.error('Error handling order:', error);
        throw error;
    }
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

        // Update Firestore subscription status
        await admin.firestore().collection('students').doc(enrollment).set({
            subscription_id: subscriptionData.id,
            subscription_status: status,
            premium_paid: ['active', 'paused'].includes(status),
            premium_plan: plan,
            subscription_updated_date: new Date()
        }, { merge: true });

        console.log(`✓ Updated Firestore subscription for enrollment: ${enrollment}`);

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

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: true,
            subscription_status: 'active',
            subscription_resumed_date: new Date()
        }, { merge: true });

        console.log(`✓ Subscription resumed for enrollment: ${enrollment}`);
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

        await admin.firestore().collection('students').doc(enrollment).set({
            premium_paid: false,
            subscription_status: subscriptionData.attributes?.status,
            subscription_ended_date: new Date()
        }, { merge: true });

        console.log(`✓ Subscription cancelled for enrollment: ${enrollment}`);
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
    if (!LEMONSQUEEZY_WEBHOOK_SECRET || !signature) {
        console.warn('Missing webhook secret or signature');
        return false;
    }

    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const expectedSignature = crypto
        .createHmac('sha256', LEMONSQUEEZY_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
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

module.exports = router;
