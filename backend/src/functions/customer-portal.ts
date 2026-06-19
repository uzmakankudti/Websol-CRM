/**
 * Customer self-service portal — email-OTP login + read-only own-data views.
 *
 * Public (anonymous) auth endpoints:
 *   POST /api/portal/request-otp   email           -> always { ok, message } (no enumeration)
 *   POST /api/portal/verify-otp    email + code    -> { token, customer, contact }
 *
 * Customer-session endpoints (require an aud:'customer' token; scoped to the
 * customer_id baked into that token — a customer can only ever see their own
 * company's records):
 *   GET  /api/portal/me
 *   GET  /api/portal/contracts
 *   GET  /api/portal/printers
 *   GET  /api/portal/tickets
 *
 * Security notes:
 *   - request-otp responds identically whether or not the email is a known,
 *     portal-enabled contact (no account enumeration).
 *   - Only an HMAC hash of the OTP is stored; codes are single-use, expire
 *     after OTP_TTL_MINUTES, and are limited to OTP_MAX_ATTEMPTS guesses.
 *   - OTP requests are throttled per email (OTP_MAX_PER_WINDOW per window).
 *   - The session token carries no staff permissions; every data query is
 *     filtered by ctx.customerId taken from the verified token, never from
 *     client input.
 */
import crypto from 'crypto';
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { generateOtp, hashOtp, issueCustomerToken } from '../shared/auth';
import { requireCustomer } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp } from '../shared/http';

// --- Tunables -----------------------------------------------------------------
const OTP_TTL_MINUTES = 10; // how long a code stays valid
const OTP_MAX_ATTEMPTS = 5; // wrong guesses before the code is locked
const OTP_REQUEST_WINDOW_MINUTES = 15; // throttle window for code requests
const OTP_MAX_PER_WINDOW = 5; // max codes per email per window

// Identical response for every request-otp call, so the presence/absence of an
// account is never observable from the outside.
const GENERIC_OTP_RESPONSE = {
  ok: true,
  message: 'If that email is registered for portal access, a login code has been sent.',
};

/** Whether a real email provider is wired up; when false we log codes to the console (dev). */
function emailConfigured(): boolean {
  return process.env.PORTAL_EMAIL_ENABLED === 'true';
}

function normaliseEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Constant-time comparison of two equal-length hex digests. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

interface ContactRow extends RowDataPacket {
  id: number;
  customer_id: number;
  email: string;
  name: string;
  portal_enabled: number;
}

interface OtpRow extends RowDataPacket {
  id: number;
  contact_id: number;
  customer_id: number;
  code_hash: string;
  attempts: number;
}

// --- POST /api/portal/request-otp --------------------------------------------
export const requestOtp = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const { email } = await readJson<{ email?: string }>(request);
  const addr = normaliseEmail(email);
  const ip = clientIp(request);

  // Never reveal anything via the response shape.
  if (!addr) return json(200, GENERIC_OTP_RESPONSE);

  // Throttle by email regardless of whether it resolves to a contact. (Unknown
  // emails create no rows and so are naturally rate-free, but the response is
  // identical either way, so this leaks nothing.)
  const recent = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM customer_otp
      WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [addr, OTP_REQUEST_WINDOW_MINUTES],
  );
  if (Number(recent[0]?.n ?? 0) >= OTP_MAX_PER_WINDOW) {
    await writeAudit({
      actorUserId: null,
      actorEmail: addr,
      entityType: 'customer_portal',
      action: 'otp_throttled',
      ipAddress: ip,
    });
    return json(200, GENERIC_OTP_RESPONSE);
  }

  // Resolve to a known, portal-enabled contact with a usable email.
  const contacts = await query<ContactRow[]>(
    `SELECT id, customer_id, email, name, portal_enabled
       FROM customer_contacts
      WHERE LOWER(email) = ? AND portal_enabled = 1
      ORDER BY is_primary DESC, id ASC
      LIMIT 1`,
    [addr],
  );
  const contact = contacts[0];
  if (!contact) {
    // Unknown / disabled — respond exactly the same, do not generate a code.
    return json(200, GENERIC_OTP_RESPONSE);
  }

  const { code, codeHash } = generateOtp();
  await query(
    `INSERT INTO customer_otp (contact_id, customer_id, email, code_hash, expires_at, created_ip)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
    [contact.id, contact.customer_id, addr, codeHash, OTP_TTL_MINUTES, ip],
  );

  if (emailConfigured()) {
    // TODO: hand off to the email provider here.
  } else {
    // No provider wired up — surface the code on the server console for dev.
    // eslint-disable-next-line no-console
    console.log(
      `\n[customer-portal] No email service configured (set PORTAL_EMAIL_ENABLED=true to enable).\n` +
        `  DEV LOGIN CODE for ${addr}: ${code}  (expires in ${OTP_TTL_MINUTES} minutes)\n`,
    );
  }

  await writeAudit({
    actorUserId: null,
    actorEmail: addr,
    entityType: 'customer_portal',
    entityId: contact.customer_id,
    action: 'otp_requested',
    ipAddress: ip,
  });

  return json(200, GENERIC_OTP_RESPONSE);
});

// --- POST /api/portal/verify-otp ----------------------------------------------
export const verifyOtp = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const { email, code } = await readJson<{ email?: string; code?: string }>(request);
  const addr = normaliseEmail(email);
  const ip = clientIp(request);
  const submitted = typeof code === 'string' ? code.trim() : '';

  if (!addr || !submitted) return error(400, 'Email and code are required', 'MISSING_FIELDS');

  // Same generic rejection for unknown email, wrong code, and expired code.
  const invalid = () => error(401, 'Invalid or expired code', 'INVALID_CODE');

  const rows = await query<OtpRow[]>(
    `SELECT id, contact_id, customer_id, code_hash, attempts
       FROM customer_otp
      WHERE email = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1`,
    [addr],
  );
  const otp = rows[0];
  if (!otp) return invalid();

  // Attempt limit (defends the small 6-digit space).
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await query(`UPDATE customer_otp SET consumed_at = NOW() WHERE id = ?`, [otp.id]);
    await writeAudit({
      actorUserId: null,
      actorEmail: addr,
      entityType: 'customer_portal',
      entityId: otp.customer_id,
      action: 'otp_locked',
      ipAddress: ip,
    });
    return error(429, 'Too many attempts. Please request a new code.', 'TOO_MANY_ATTEMPTS');
  }

  if (!hashesEqual(hashOtp(submitted), otp.code_hash)) {
    const attempts = otp.attempts + 1;
    const lock = attempts >= OTP_MAX_ATTEMPTS;
    await query(
      `UPDATE customer_otp SET attempts = ?${lock ? ', consumed_at = NOW()' : ''} WHERE id = ?`,
      [attempts, otp.id],
    );
    await writeAudit({
      actorUserId: null,
      actorEmail: addr,
      entityType: 'customer_portal',
      entityId: otp.customer_id,
      action: lock ? 'otp_locked' : 'otp_failed',
      ipAddress: ip,
    });
    return invalid();
  }

  // Success — burn the code (single use) and issue a scoped session token.
  await query(`UPDATE customer_otp SET consumed_at = NOW() WHERE id = ?`, [otp.id]);
  await query(`UPDATE customer_contacts SET last_portal_login_at = NOW() WHERE id = ?`, [
    otp.contact_id,
  ]);

  const token = issueCustomerToken({ sub: otp.contact_id, cid: otp.customer_id, email: addr });

  const customers = await query<RowDataPacket[]>(
    `SELECT id, name FROM customers WHERE id = ? LIMIT 1`,
    [otp.customer_id],
  );
  const customer = customers[0];

  await writeAudit({
    actorUserId: null,
    actorEmail: addr,
    entityType: 'customer_portal',
    entityId: otp.customer_id,
    action: 'login',
    ipAddress: ip,
  });

  return json(200, {
    token,
    customer: customer ? { id: customer.id, name: customer.name } : { id: otp.customer_id },
    contact: { id: otp.contact_id, email: addr },
  });
});

// --- GET /api/portal/me -------------------------------------------------------
export const portalMe = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireCustomer(request);
  const rows = await query<RowDataPacket[]>(
    `SELECT id, name, email, phone FROM customers WHERE id = ? LIMIT 1`,
    [ctx.customerId],
  );
  const customer = rows[0];
  if (!customer) return error(401, 'Session is no longer valid', 'UNAUTHENTICATED');
  return json(200, {
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    contact: { id: ctx.contactId, email: ctx.email },
  });
});

// --- GET /api/portal/contracts -----------------------------------------------
export const portalContracts = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireCustomer(request);
  const rows = await query<RowDataPacket[]>(
    `SELECT id, contract_no, start_date, end_date, monthly_lease_fee, sla_tier, status
       FROM contracts
      WHERE customer_id = ?
      ORDER BY created_at DESC`,
    [ctx.customerId],
  );
  return json(200, {
    contracts: rows.map((r) => ({
      id: r.id,
      contractNo: r.contract_no,
      startDate: r.start_date,
      endDate: r.end_date,
      monthlyLeaseFee: r.monthly_lease_fee,
      slaTier: r.sla_tier,
      status: r.status,
    })),
  });
});

// --- GET /api/portal/printers -------------------------------------------------
export const portalPrinters = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireCustomer(request);
  // Only printers attached to one of THIS customer's contracts.
  const rows = await query<RowDataPacket[]>(
    `SELECT p.id, p.serial_no, p.asset_no, p.brand, p.model, p.status, p.location, ct.contract_no
       FROM printers p
       JOIN contracts ct ON ct.id = p.current_contract_id
      WHERE ct.customer_id = ?
      ORDER BY p.serial_no ASC`,
    [ctx.customerId],
  );
  return json(200, {
    printers: rows.map((r) => ({
      id: r.id,
      serialNo: r.serial_no,
      assetNo: r.asset_no,
      brand: r.brand,
      model: r.model,
      status: r.status,
      location: r.location,
      contractNo: r.contract_no,
    })),
  });
});

// --- GET /api/portal/tickets --------------------------------------------------
export const portalTickets = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireCustomer(request);
  const rows = await query<RowDataPacket[]>(
    `SELECT id, ticket_no, visit_type, priority, status, description, scheduled_date,
            sla_due_at, created_at
       FROM service_tickets
      WHERE customer_id = ?
      ORDER BY created_at DESC`,
    [ctx.customerId],
  );
  return json(200, {
    tickets: rows.map((r) => ({
      id: r.id,
      ticketNo: r.ticket_no,
      visitType: r.visit_type,
      priority: r.priority,
      status: r.status,
      description: r.description,
      scheduledDate: r.scheduled_date,
      slaDueAt: r.sla_due_at,
      createdAt: r.created_at,
    })),
  });
});

// --- Registrations ------------------------------------------------------------
app.http('portal-request-otp', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'portal/request-otp',
  handler: requestOtp,
});
app.http('portal-verify-otp', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'portal/verify-otp',
  handler: verifyOtp,
});
app.http('portal-me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'portal/me',
  handler: portalMe,
});
app.http('portal-contracts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'portal/contracts',
  handler: portalContracts,
});
app.http('portal-printers', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'portal/printers',
  handler: portalPrinters,
});
app.http('portal-tickets', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'portal/tickets',
  handler: portalTickets,
});
