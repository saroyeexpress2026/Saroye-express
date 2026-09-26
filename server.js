'use strict';
/**
 * server.js — Saroye Express Inc. parcel & courier dispatch app.
 *
 * Self-hostable full-stack app:
 *   - Express serves the API and the frontend (./public) from one process.
 *   - SQLite (better-sqlite3) stores everything; file uploads live on local disk.
 *
 * Portals:
 *   /           customer home — request a delivery, track a parcel
 *   /track.html parcel tracking by tracking code
 *   /driver.html driver portal (register with documents, sign in, my jobs)
 *   /owner.html  owner portal (first-run setup, sign in, control center)
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('./db');

// ---------------------------------------------------------------------------
// Configuration (all overridable with environment variables)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '8', 10);
const BCRYPT_ROUNDS = 12;

// Owner first-run setup token. Whoever holds this token can create the owner
// account. Generated randomly at boot and printed to the server logs when no
// owner exists yet, so a random visitor can never claim the owner account.
// Operators may also set OWNER_SETUP_TOKEN explicitly.
let ownerSetupToken = process.env.OWNER_SETUP_TOKEN || null;

if (process.env.SESSION_SECRET == null) {
  console.warn('[warn] SESSION_SECRET not set — using a random one. Sessions will reset on restart.');
}
for (const sub of ['driver', 'owner', 'tmp']) {
  fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true });
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'saroye.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TRACKING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateTrackingCode() {
  for (;;) {
    let code = 'SE-';
    for (let i = 0; i < 6; i++) code += TRACKING_ALPHABET[crypto.randomInt(TRACKING_ALPHABET.length)];
    const exists = db.prepare('SELECT 1 FROM deliveries WHERE tracking_code = ?').get(code);
    if (!exists) return code;
  }
}

function randomFilename(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return crypto.randomBytes(16).toString('hex') + ext;
}

function normalizePostal(postal) {
  return (postal || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Find the active delivery zone whose postal prefix matches the given postal code. */
function matchZone(postal) {
  const norm = normalizePostal(postal);
  if (!norm) return null;
  const zones = db.prepare("SELECT * FROM zones WHERE active = 1").all();
  for (const z of zones) {
    const prefixes = z.postal_prefixes.split(',').map(s => normalizePostal(s)).filter(Boolean);
    for (const p of prefixes) {
      if (norm.startsWith(p)) return z;
    }
  }
  return null;
}

/** Record a status change on a delivery (timeline event). */
function setDeliveryStatus(deliveryId, status, note) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("UPDATE deliveries SET status = ?, updated_at = ? WHERE id = ?").run(status, now, deliveryId);
  db.prepare("INSERT INTO delivery_events (delivery_id, status, note) VALUES (?, ?, ?)").run(deliveryId, status, note || null);
}

/** Number of failed owner logins for this username in the last 15 minutes. */
function recentOwnerFailures(username) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM owner_login_attempts
    WHERE username = ? AND success = 0
      AND attempted_at > datetime('now', '-15 minutes')
  `).get(username);
  return row.n;
}

function recordOwnerAttempt(username, success) {
  if (success) {
    db.prepare('DELETE FROM owner_login_attempts WHERE username = ?').run(username);
  } else {
    db.prepare('INSERT INTO owner_login_attempts (username, success) VALUES (?, 0)').run(username);
  }
}

function ownerExists() {
  return !!db.prepare('SELECT 1 FROM owners LIMIT 1').get();
}

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------
function requireOwner(req, res, next) {
  if (!req.session.ownerId) return res.status(401).json({ error: 'Owner sign-in required.' });
  const owner = db.prepare('SELECT id FROM owners WHERE id = ?').get(req.session.ownerId);
  if (!owner) {
    delete req.session.ownerId;
    return res.status(401).json({ error: 'Owner sign-in required.' });
  }
  next();
}

function requireDriver(req, res, next) {
  if (!req.session.driverId) return res.status(401).json({ error: 'Driver sign-in required.' });
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.session.driverId);
  if (!driver) {
    delete req.session.driverId;
    return res.status(401).json({ error: 'Driver sign-in required.' });
  }
  req.driver = driver;
  next();
}

function requireApprovedDriver(req, res, next) {
  requireDriver(req, res, () => {
    if (req.driver.status !== 'approved') {
      return res.status(403).json({ error: 'Your driver application is not approved yet.', status: req.driver.status });
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Uploads (disk storage, validated)
// ---------------------------------------------------------------------------
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
]);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'tmp')),
  filename: (req, file, cb) => cb(null, randomFilename(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files (JPG, PNG, WEBP, GIF) or PDF documents are allowed.'));
  },
});

/** Move an uploaded tmp file into its permanent subfolder; returns the stored relative path. */
function storeUpload(file, subfolder) {
  const dest = path.join(UPLOAD_DIR, subfolder, path.basename(file.path));
  fs.renameSync(file.path, dest);
  return path.join(subfolder, path.basename(file.path)); // stored relative to UPLOAD_DIR
}

function discardUploads(files) {
  for (const f of files || []) {
    try { fs.unlinkSync(f.path); } catch (_) { /* already gone */ }
  }
}

/** Safely resolve a stored relative upload path inside UPLOAD_DIR. Returns null if invalid. */
function resolveUpload(relPath) {
  if (!relPath || relPath.includes('..')) return null;
  const abs = path.resolve(UPLOAD_DIR, relPath);
  if (!abs.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

// Login rate limiting (per IP), plus the owner lockout below.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ===========================================================================
// CUSTOMER-FACING API
// ===========================================================================

/** Active delivery zones, shown on the customer request form. */
app.get('/api/zones/active', (req, res) => {
  const zones = db.prepare('SELECT id, name, base_price, per_km_price, same_day FROM zones WHERE active = 1 ORDER BY name').all();
  res.json({ zones });
});

/** Create a delivery request. */
app.post('/api/deliveries', (req, res) => {
  const b = req.body || {};
  const required = ['senderName', 'senderPhone', 'pickupAddress', 'recipientName', 'recipientPhone', 'dropoffAddress'];
  for (const f of required) {
    if (!b[f] || String(b[f]).trim() === '') {
      return res.status(400).json({ error: `Missing required field: ${f}` });
    }
  }
  const zone = matchZone(b.dropoffPostal);
  const code = generateTrackingCode();
  const info = db.prepare(`
    INSERT INTO deliveries
      (tracking_code, sender_name, sender_phone, pickup_address, pickup_postal,
       recipient_name, recipient_phone, dropoff_address, dropoff_postal,
       parcel_description, parcel_weight_kg, zone_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested')
  `).run(
    code,
    String(b.senderName).trim(), String(b.senderPhone).trim(), String(b.pickupAddress).trim(), (b.pickupPostal || '').trim() || null,
    String(b.recipientName).trim(), String(b.recipientPhone).trim(), String(b.dropoffAddress).trim(), (b.dropoffPostal || '').trim() || null,
    (b.parcelDescription || '').trim() || null,
    b.parcelWeightKg ? Number(b.parcelWeightKg) : null,
    zone ? zone.id : null
  );
  db.prepare('INSERT INTO delivery_events (delivery_id, status, note) VALUES (?, ?, ?)').run(info.lastInsertRowid, 'requested', 'Delivery request received.');
  res.status(201).json({
    trackingCode: code,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    message: 'Delivery request received. The owner will review and approve it.',
  });
});

/** Public parcel tracking: timeline of status events for a tracking code. */
app.get('/api/track/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const d = db.prepare('SELECT * FROM deliveries WHERE tracking_code = ?').get(code);
  if (!d) return res.status(404).json({ error: 'No parcel found with that tracking code.' });
  const events = db.prepare('SELECT status, note, created_at FROM delivery_events WHERE delivery_id = ? ORDER BY id').all(d.id);
  const zone = d.zone_id ? db.prepare('SELECT id, name FROM zones WHERE id = ?').get(d.zone_id) : null;
  res.json({
    trackingCode: d.tracking_code,
    status: d.status,
    recipientName: d.recipient_name,
    recipientPhone: d.recipient_phone,
    dropoffAddress: d.dropoff_address,
    pickupAddress: d.pickup_address,
    parcelDescription: d.parcel_description,
    zone,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    events,
  });
});

// ===========================================================================
// DRIVER PORTAL API
// ===========================================================================

/** Driver registration with document uploads. Starts as "pending review". */
app.post('/api/driver/register',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'licence', maxCount: 1 },
    { name: 'permit', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files || {};
    try {
      const { email, password, fullName, phone } = req.body || {};
      if (!email || !password || !fullName || !phone) {
        return res.status(400).json({ error: 'Name, email, phone and password are all required.' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      if (!files.licence || !files.permit) {
        return res.status(400).json({ error: 'Driving licence and work permit / PR card are both required.' });
      }
      const exists = db.prepare('SELECT 1 FROM drivers WHERE email = ?').get(String(email).toLowerCase());
      if (exists) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });

      const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
      const photoPath = files.photo ? storeUpload(files.photo[0], 'driver') : null;
      const licencePath = storeUpload(files.licence[0], 'driver');
      const permitPath = storeUpload(files.permit[0], 'driver');
      const info = db.prepare(`
        INSERT INTO drivers (email, password_hash, full_name, phone, photo_path, licence_path, permit_path, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(String(email).toLowerCase(), passwordHash, String(fullName).trim(), String(phone).trim(), photoPath, licencePath, permitPath);
      req.session.driverId = info.lastInsertRowid;
      res.status(201).json({ message: 'Application submitted. It is now pending review by the owner.' });
    } catch (err) {
      discardUploads([...(files.photo || []), ...(files.licence || []), ...(files.permit || [])]);
      res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  }
);

app.post('/api/driver/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const driver = db.prepare('SELECT * FROM drivers WHERE email = ?').get(String(email || '').toLowerCase());
  if (!driver || !(await bcrypt.compare(String(password || ''), driver.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  req.session.driverId = driver.id;
  res.json({ message: 'Signed in.', status: driver.status });
});

app.post('/api/driver/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Signed out.' }));
});

/** Driver's own profile, application status, and any owner correction notes. */
app.get('/api/driver/me', requireDriver, (req, res) => {
  const d = req.driver;
  const zone = d.service_zone_id ? db.prepare('SELECT id, name FROM zones WHERE id = ?').get(d.service_zone_id) : null;
  res.json({
    id: d.id, email: d.email, fullName: d.full_name, phone: d.phone,
    status: d.status, correctionNotes: d.correction_notes, zone,
    docs: { photo: d.photo_path, licence: d.licence_path, permit: d.permit_path },
    hasPhoto: !!d.photo_path, hasLicence: !!d.licence_path, hasPermit: !!d.permit_path,
    createdAt: d.created_at,
  });
});

/** Jobs assigned to this driver — drivers see ONLY their own jobs. */
app.get('/api/driver/jobs', requireApprovedDriver, (req, res) => {
  const jobs = db.prepare(`
    SELECT d.*, z.name AS zone_name
    FROM deliveries d LEFT JOIN zones z ON z.id = d.zone_id
    WHERE d.driver_id = ? AND d.status NOT IN ('rejected', 'cancelled')
    ORDER BY d.updated_at DESC
  `).all(req.driver.id);
  res.json({ jobs: jobs.map(stripDriverSensitive) });
});

function stripDriverSensitive(d) {
  return {
    id: d.id, trackingCode: d.tracking_code,
    senderName: d.sender_name, senderPhone: d.sender_phone,
    pickupAddress: d.pickup_address, pickupPostal: d.pickup_postal,
    recipientName: d.recipient_name, recipientPhone: d.recipient_phone,
    dropoffAddress: d.dropoff_address, dropoffPostal: d.dropoff_postal,
    parcelDescription: d.parcel_description, parcelWeightKg: d.parcel_weight_kg,
    zoneName: d.zone_name || null, status: d.status,
    ownerNotes: d.owner_notes, createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

/** Driver advances the status of one of their own jobs. */
app.post('/api/driver/jobs/:id/status', requireApprovedDriver, (req, res) => {
  const allowed = ['picked_up', 'in_transit', 'delivered'];
  const { status, note } = req.body || {};
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Drivers can only mark: picked up, in transit, delivered.' });
  }
  const d = db.prepare('SELECT * FROM deliveries WHERE id = ? AND driver_id = ?').get(req.params.id, req.driver.id);
  if (!d) return res.status(404).json({ error: 'Job not found.' });
  setDeliveryStatus(d.id, status, note || 'Updated by driver.');
  res.json({ message: 'Status updated.', status });
});

/** Driver resubmits documents after the owner requested corrections. */
app.post('/api/driver/resubmit',
  requireDriver,
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'licence', maxCount: 1 },
    { name: 'permit', maxCount: 1 },
  ]),
  (req, res) => {
    const files = req.files || {};
    try {
      if (req.driver.status !== 'corrections_requested') {
        discardUploads([...(files.photo || []), ...(files.licence || []), ...(files.permit || [])]);
        return res.status(400).json({ error: 'Resubmission is only needed when the owner requested corrections.' });
      }
      const updates = [];
      const params = [];
      if (files.photo) {
        updates.push('photo_path = ?'); params.push(storeUpload(files.photo[0], 'driver'));
      }
      if (files.licence) {
        updates.push('licence_path = ?'); params.push(storeUpload(files.licence[0], 'driver'));
      }
      if (files.permit) {
        updates.push('permit_path = ?'); params.push(storeUpload(files.permit[0], 'driver'));
      }
      updates.push("status = 'pending'");
      updates.push('correction_notes = NULL');
      params.push(req.driver.id);
      db.prepare(`UPDATE drivers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      res.json({ message: 'Documents resubmitted. Your application is pending review again.' });
    } catch (err) {
      discardUploads([...(files.photo || []), ...(files.licence || []), ...(files.permit || [])]);
      res.status(500).json({ error: 'Resubmission failed. Please try again.' });
    }
  }
);

/** A driver downloads their OWN documents. */
app.get('/api/driver/files/*', requireDriver, (req, res) => {
  const rel = req.params[0];
  const abs = resolveUpload(rel);
  if (!abs) return res.status(404).json({ error: 'File not found.' });
  const mine = [req.driver.photo_path, req.driver.licence_path, req.driver.permit_path];
  if (!mine.includes(rel)) return res.status(403).json({ error: 'Not your document.' });
  res.sendFile(abs);
});

// ===========================================================================
// OWNER PORTAL API
// ===========================================================================

/** Is the owner account set up yet? (No token exposed here.) */
app.get('/api/owner/setup-state', (req, res) => {
  res.json({ configured: ownerExists(), signedIn: !!req.session.ownerId });
});

/**
 * First-run owner setup. Requires the one-time setup token (printed to the
 * server logs at boot, or set via OWNER_SETUP_TOKEN) so a random visitor can
 * never claim the owner account. Collects identity verification documents.
 */
app.post('/api/owner/setup',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'govId', maxCount: 1 },
    { name: 'authorityProof', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files || {};
    const cleanup = () => discardUploads([...(files.photo || []), ...(files.govId || []), ...(files.authorityProof || [])]);
    try {
      if (ownerExists()) { cleanup(); return res.status(403).json({ error: 'The owner account is already set up.' }); }
      const { setupToken, username, password, fullName, email, phone } = req.body || {};
      if (!ownerSetupToken || setupToken !== ownerSetupToken) {
        cleanup();
        return res.status(403).json({ error: 'Invalid setup token. The token is printed in the server logs at first boot.' });
      }
      if (!username || !password || !fullName || !email || !phone) {
        cleanup();
        return res.status(400).json({ error: 'Username, password, full legal name, email and phone are all required.' });
      }
      if (String(password).length < 10) { cleanup(); return res.status(400).json({ error: 'Owner password must be at least 10 characters.' }); }
      if (!files.govId || !files.authorityProof) {
        cleanup();
        return res.status(400).json({ error: 'Government photo ID and proof of company authority are both required.' });
      }
      const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
      const photoPath = files.photo ? storeUpload(files.photo[0], 'owner') : null;
      const govIdPath = storeUpload(files.govId[0], 'owner');
      const authorityProofPath = storeUpload(files.authorityProof[0], 'owner');
      const info = db.prepare(`
        INSERT INTO owners (username, password_hash, full_name, email, phone, photo_path, gov_id_path, authority_proof_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(String(username).trim(), passwordHash, String(fullName).trim(), String(email).trim(), String(phone).trim(), photoPath, govIdPath, authorityProofPath);
      // Single-use token: once the owner exists, setup is closed forever.
      ownerSetupToken = null;
      req.session.ownerId = info.lastInsertRowid;
      res.status(201).json({ message: 'Owner account created. You are signed in.' });
    } catch (err) {
      cleanup();
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'That username is taken.' });
      }
      res.status(500).json({ error: 'Owner setup failed. Please try again.' });
    }
  }
);

/** Owner sign-in. Locks for 15 minutes after 5 failed attempts. */
app.post('/api/owner/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (!name || !password) return res.status(400).json({ error: 'Username and password are required.' });

  if (recentOwnerFailures(name) >= 5) {
    return res.status(429).json({ error: 'Too many failed attempts. Sign-in is locked for 15 minutes.' });
  }
  const owner = db.prepare('SELECT * FROM owners WHERE username = ?').get(name);
  const ok = owner && await bcrypt.compare(String(password), owner.password_hash);
  recordOwnerAttempt(name, !!ok);
  if (!ok) {
    const remaining = Math.max(0, 5 - recentOwnerFailures(name));
    return res.status(401).json({ error: `Invalid username or password. ${remaining} attempt(s) left before a 15-minute lockout.` });
  }
  req.session.ownerId = owner.id;
  res.json({ message: 'Signed in as owner.' });
});

app.post('/api/owner/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Signed out.' }));
});

app.get('/api/owner/me', requireOwner, (req, res) => {
  const o = db.prepare('SELECT id, username, full_name, email, phone, created_at FROM owners WHERE id = ?').get(req.session.ownerId);
  res.json({ owner: o });
});

// ---- Orders ---------------------------------------------------------------
app.get('/api/owner/orders', requireOwner, (req, res) => {
  const orders = db.prepare(`
    SELECT d.*,
           dr.full_name AS driver_name, dr.email AS driver_email,
           z.name AS zone_name
    FROM deliveries d
    LEFT JOIN drivers dr ON dr.id = d.driver_id
    LEFT JOIN zones z ON z.id = d.zone_id
    ORDER BY d.created_at DESC
  `).all();
  res.json({ orders });
});

/** Check a driver is approved AND serves the delivery's zone. */
function driverFitsZone(driverId, delivery) {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return { ok: false, error: 'Driver not found.' };
  if (driver.status !== 'approved') return { ok: false, error: 'Driver is not approved.' };
  if (delivery.zone_id) {
    if (driver.service_zone_id !== delivery.zone_id) {
      const zone = db.prepare('SELECT name FROM zones WHERE id = ?').get(delivery.zone_id);
      return { ok: false, error: `Driver is not assigned to the delivery zone (${zone ? zone.name : 'unknown'}).` };
    }
  }
  return { ok: true, driver };
}

/** Approve a delivery request and assign a driver (location-aware). */
app.post('/api/owner/orders/:id/approve', requireOwner, (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) return res.status(404).json({ error: 'Order not found.' });
  if (delivery.status !== 'requested') return res.status(400).json({ error: 'Only requested orders can be approved.' });
  const { driverId, note } = req.body || {};
  if (!driverId) return res.status(400).json({ error: 'Choose a driver to assign.' });
  const fit = driverFitsZone(driverId, delivery);
  if (!fit.ok) return res.status(400).json({ error: fit.error });
  db.prepare('UPDATE deliveries SET driver_id = ? WHERE id = ?').run(driverId, delivery.id);
  setDeliveryStatus(delivery.id, 'approved', note || `Approved and assigned to ${fit.driver.full_name}.`);
  res.json({ message: 'Order approved and assigned.' });
});

app.post('/api/owner/orders/:id/reject', requireOwner, (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) return res.status(404).json({ error: 'Order not found.' });
  if (delivery.status !== 'requested') return res.status(400).json({ error: 'Only requested orders can be rejected.' });
  setDeliveryStatus(delivery.id, 'rejected', (req.body || {}).note || 'Rejected by owner.');
  res.json({ message: 'Order rejected.' });
});

/** Reassign an approved order to a different driver (same zone rule). */
app.post('/api/owner/orders/:id/assign', requireOwner, (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) return res.status(404).json({ error: 'Order not found.' });
  const { driverId } = req.body || {};
  if (!driverId) return res.status(400).json({ error: 'Choose a driver.' });
  const fit = driverFitsZone(driverId, delivery);
  if (!fit.ok) return res.status(400).json({ error: fit.error });
  db.prepare('UPDATE deliveries SET driver_id = ? WHERE id = ?').run(driverId, delivery.id);
  db.prepare('INSERT INTO delivery_events (delivery_id, status, note) VALUES (?, ?, ?)').run(delivery.id, delivery.status, `Reassigned to ${fit.driver.full_name} by owner.`);
  res.json({ message: 'Driver reassigned.' });
});

/** Owner overrides the delivery status directly. */
app.post('/api/owner/orders/:id/status', requireOwner, (req, res) => {
  const allowed = ['received', 'picked_up', 'in_transit', 'delivered', 'cancelled'];
  const { status, note } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) return res.status(404).json({ error: 'Order not found.' });
  setDeliveryStatus(delivery.id, status, note || 'Updated by owner.');
  res.json({ message: 'Status updated.', status });
});

app.get('/api/owner/orders/:id/events', requireOwner, (req, res) => {
  const events = db.prepare('SELECT status, note, created_at FROM delivery_events WHERE delivery_id = ? ORDER BY id').all(req.params.id);
  res.json({ events });
});

// ---- Drivers --------------------------------------------------------------
app.get('/api/owner/drivers', requireOwner, (req, res) => {
  const drivers = db.prepare(`
    SELECT d.id, d.email, d.full_name, d.phone, d.status, d.correction_notes, d.created_at,
           z.id AS zone_id, z.name AS zone_name,
           d.photo_path, d.licence_path, d.permit_path
    FROM drivers d LEFT JOIN zones z ON z.id = d.service_zone_id
    ORDER BY d.created_at DESC
  `).all();
  res.json({ drivers });
});

/** Approve a driver application and assign their service zone. */
app.post('/api/owner/drivers/:id/approve', requireOwner, (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  const { zoneId } = req.body || {};
  if (zoneId) {
    const zone = db.prepare('SELECT id FROM zones WHERE id = ? AND active = 1').get(zoneId);
    if (!zone) return res.status(400).json({ error: 'Zone not found or paused.' });
  }
  db.prepare("UPDATE drivers SET status = 'approved', correction_notes = NULL, service_zone_id = ? WHERE id = ?")
    .run(zoneId || null, driver.id);
  res.json({ message: 'Driver approved.' });
});

/** Ask the driver to fix their application, with notes they can read. */
app.post('/api/owner/drivers/:id/request-corrections', requireOwner, (req, res) => {
  const { notes } = req.body || {};
  if (!notes || String(notes).trim() === '') return res.status(400).json({ error: 'Please write what the driver needs to fix.' });
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  db.prepare("UPDATE drivers SET status = 'corrections_requested', correction_notes = ? WHERE id = ?").run(String(notes).trim(), driver.id);
  res.json({ message: 'Correction request sent.' });
});

app.post('/api/owner/drivers/:id/reject', requireOwner, (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  db.prepare("UPDATE drivers SET status = 'rejected' WHERE id = ?").run(driver.id);
  res.json({ message: 'Driver application rejected.' });
});

/** Change a driver's service zone later. */
app.post('/api/owner/drivers/:id/zone', requireOwner, (req, res) => {
  const { zoneId } = req.body || {};
  if (zoneId) {
    const zone = db.prepare('SELECT id FROM zones WHERE id = ?').get(zoneId);
    if (!zone) return res.status(400).json({ error: 'Zone not found.' });
  }
  db.prepare('UPDATE drivers SET service_zone_id = ? WHERE id = ?').run(zoneId || null, req.params.id);
  res.json({ message: 'Service zone updated.' });
});

/** Owner downloads any driver or owner document. */
app.get('/api/owner/files/*', requireOwner, (req, res) => {
  const abs = resolveUpload(req.params[0]);
  if (!abs) return res.status(404).json({ error: 'File not found.' });
  res.sendFile(abs);
});

// ---- Zones ----------------------------------------------------------------
app.get('/api/owner/zones', requireOwner, (req, res) => {
  res.json({ zones: db.prepare('SELECT * FROM zones ORDER BY name').all() });
});

app.post('/api/owner/zones', requireOwner, (req, res) => {
  const { name, postalPrefixes, basePrice, perKmPrice, sameDay } = req.body || {};
  if (!name || String(name).trim() === '') return res.status(400).json({ error: 'Zone name is required.' });
  if (!postalPrefixes || String(postalPrefixes).trim() === '') {
    return res.status(400).json({ error: 'At least one postal code prefix is required.' });
  }
  const info = db.prepare(`
    INSERT INTO zones (name, postal_prefixes, base_price, per_km_price, same_day, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(String(name).trim(), String(postalPrefixes).trim(),
    Number(basePrice) || 0, Number(perKmPrice) || 0, sameDay ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid, message: 'Zone created.' });
});

app.put('/api/owner/zones/:id', requireOwner, (req, res) => {
  const z = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!z) return res.status(404).json({ error: 'Zone not found.' });
  const { name, postalPrefixes, basePrice, perKmPrice, sameDay } = req.body || {};
  db.prepare(`
    UPDATE zones SET name = ?, postal_prefixes = ?, base_price = ?, per_km_price = ?, same_day = ?
    WHERE id = ?
  `).run(
    name != null && String(name).trim() !== '' ? String(name).trim() : z.name,
    postalPrefixes != null ? String(postalPrefixes).trim() : z.postal_prefixes,
    basePrice != null ? Number(basePrice) || 0 : z.base_price,
    perKmPrice != null ? Number(perKmPrice) || 0 : z.per_km_price,
    sameDay != null ? (sameDay ? 1 : 0) : z.same_day,
    z.id
  );
  res.json({ message: 'Zone updated.' });
});

/** Pause (active=0) or reactivate (active=1) a zone. */
app.post('/api/owner/zones/:id/toggle', requireOwner, (req, res) => {
  const z = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!z) return res.status(404).json({ error: 'Zone not found.' });
  db.prepare('UPDATE zones SET active = ? WHERE id = ?').run(z.active ? 0 : 1, z.id);
  res.json({ message: z.active ? 'Zone paused.' : 'Zone activated.', active: z.active ? 0 : 1 });
});

app.delete('/api/owner/zones/:id', requireOwner, (req, res) => {
  const z = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!z) return res.status(404).json({ error: 'Zone not found.' });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE service_zone_id = ?').get(z.id).n
    + db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE zone_id = ?').get(z.id).n;
  if (inUse > 0) return res.status(400).json({ error: 'Zone is in use by drivers or deliveries. Pause it instead of deleting.' });
  db.prepare('DELETE FROM zones WHERE id = ?').run(z.id);
  res.json({ message: 'Zone deleted.' });
});

// ===========================================================================
// FRONTEND + BOOT
// ===========================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Multer / validation errors → clean JSON
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
  next();
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('  Saroye Express Inc. — parcel & courier dispatch');
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log('='.repeat(60));
  if (!ownerExists()) {
    if (!ownerSetupToken) {
      ownerSetupToken = crypto.randomBytes(24).toString('hex');
    }
    console.log('');
    console.log('  *** FIRST-RUN OWNER SETUP ***');
    console.log('  No owner account exists yet. To create it, open /owner.html');
    console.log('  and enter this one-time setup token:');
    console.log('');
    console.log('      ' + ownerSetupToken);
    console.log('');
    console.log('  Keep this token private — anyone with it can claim the');
    console.log('  owner account. (Or set OWNER_SETUP_TOKEN in your .env.)');
    console.log('');
  } else {
    console.log('  Owner account is configured.');
  }
});
