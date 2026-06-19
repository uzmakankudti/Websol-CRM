/**
 * Field Service Management (Module 7) — service ticket endpoints.
 *
 * A service ticket is an on-site work order a field technician executes on a
 * mobile device. It travels through a lifecycle as the technician is assigned,
 * drives to site, checks in (GPS + arrival time vs SLA), captures meter
 * readings (with a photo), records parts used (auto-deducting inventory), and
 * closes with a customer signature or OTP. Tickets that can't be resolved
 * within SLA are escalated to a senior technician.
 *
 *   GET   /api/service-tickets                 list (filters)            service.read
 *   GET   /api/service-tickets/my              caller's tickets, sorted  service.read
 *   GET   /api/service-tickets/{id}            detail + history + meters service.read
 *   POST  /api/service-tickets                 create / raise a ticket   service.create
 *   PATCH /api/service-tickets/{id}            edit details              service.update
 *   POST  /api/service-tickets/{id}/assign     assign a technician       service.assign
 *   POST  /api/service-tickets/{id}/transit    en route (notifies cust.) service.update
 *   POST  /api/service-tickets/{id}/checkin    GPS check-in (arrival)    service.update
 *   POST  /api/service-tickets/{id}/start      begin work on site        service.update
 *   POST  /api/service-tickets/{id}/meter      capture meter reading     service.update
 *   POST  /api/service-tickets/{id}/parts      record part used          service.update
 *   POST  /api/service-tickets/{id}/close      close w/ signature or OTP service.close
 *   POST  /api/service-tickets/{id}/escalate   escalate to senior tech   service.escalate
 *   POST  /api/service-tickets/{id}/cancel     cancel a ticket           service.update
 *   POST  /api/service-tickets/sync            offline batch sync        service.update
 *
 * Business rules enforced:
 *   BR-004  Meter reading must be >= the previous reading for that printer.
 *   BR-005  Delta over previous > 3x the printer's monthly allowance →
 *           flagged for approval (stored PENDING, not rejected).
 *   BR-006  Colour printers require BOTH B/W and colour meter values.
 *   BR-021  (reused) Recording a part never drives stock below zero.
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS, AuthContext } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TicketRow extends RowDataPacket {
  id: number;
  ticket_no: string;
  visit_type: string;
  priority: string;
  status: string;
  customer_id: number;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  site_id: number | null;
  site_name: string | null;
  site_address: string | null;
  site_city: string | null;
  site_lat: string | null;
  site_lng: string | null;
  contract_id: number | null;
  contract_no: string | null;
  printer_id: number | null;
  printer_serial: string | null;
  printer_model: string | null;
  printer_is_colour: number | null;
  assigned_to: number | null;
  assigned_to_name: string | null;
  escalated_to: number | null;
  escalated_to_name: string | null;
  description: string | null;
  // Helpdesk fields (added by migration 009)
  source: string;
  sla_tier: string | null;
  issue_category_id: number | null;
  issue_category_name: string | null;
  // Raiser classification (added by migration 011)
  raiser_type: string;
  raiser_party: string;
  raiser_user_id: number | null;
  raiser_contact_id: number | null;
  raiser_name: string | null;
  raiser_email: string | null;
  raiser_user_name: string | null;
  reopen_count: number;
  last_resolved_at: string | null;
  scheduled_date: string | null;
  sla_due_at: string | null;
  in_transit_at: string | null;
  checked_in_at: string | null;
  checkin_lat: string | null;
  checkin_lng: string | null;
  sla_met: number | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  closed_at: string | null;
  close_method: string | null;
  signature_name: string | null;
  signature_image: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISIT_TYPES = [
  'INSTALLATION', 'PREVENTIVE_MAINTENANCE', 'CORRECTIVE',
  'METER_READING', 'TONER_REPLACEMENT', 'COLLECTION',
] as const;

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const RAISER_TYPES  = ['EMPLOYEE', 'CUSTOMER'] as const;
const RAISER_PARTIES = ['INTERNAL', 'EXTERNAL'] as const;

/** SLA response window (hours) by priority — fallback when no contract tier is supplied. */
const SLA_HOURS: Record<string, number> = { CRITICAL: 4, HIGH: 8, MEDIUM: 24, LOW: 72 };

/** BR-013: SLA response hours by contract SLA tier (overrides priority when a contract is linked). */
const SLA_TIER_HOURS: Record<string, number> = { PLATINUM: 2, GOLD: 4, SILVER: 8, BRONZE: 24 };

/** Statuses considered "active" (work still outstanding). */
const ACTIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_TRANSIT', 'ON_SITE', 'IN_PROGRESS'] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ticketIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid service ticket id');
  return id;
}

function str(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s || null;
}

function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** MySQL DATETIME string for "now" (UTC), or echo a caller-supplied timestamp. */
function nowOr(occurredAt: unknown): string {
  const s = str(occurredAt);
  if (s) return s.replace('T', ' ').slice(0, 19);
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const TICKET_SELECT = `
  SELECT t.*,
         cu.name  AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
         s.name   AS site_name, s.address AS site_address, s.city AS site_city,
         s.geo_lat AS site_lat, s.geo_lng AS site_lng,
         ct.contract_no AS contract_no,
         p.serial_no AS printer_serial, p.model AS printer_model, p.is_colour AS printer_is_colour,
         au.full_name AS assigned_to_name,
         eu.full_name AS escalated_to_name,
         cb.full_name AS created_by_name,
         cat.name AS issue_category_name,
         ru.full_name AS raiser_user_name
    FROM service_tickets t
    JOIN customers cu        ON cu.id = t.customer_id
    LEFT JOIN customer_sites s ON s.id  = t.site_id
    LEFT JOIN contracts ct     ON ct.id = t.contract_id
    LEFT JOIN printers p       ON p.id  = t.printer_id
    LEFT JOIN users au         ON au.id = t.assigned_to
    LEFT JOIN users eu         ON eu.id = t.escalated_to
    LEFT JOIN users cb         ON cb.id = t.created_by
    LEFT JOIN helpdesk_issue_categories cat ON cat.id = t.issue_category_id
    LEFT JOIN users ru         ON ru.id = t.raiser_user_id`;

async function findTicket(id: number): Promise<TicketRow | null> {
  const rows = await query<TicketRow[]>(`${TICKET_SELECT} WHERE t.id = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

function toTicketPublic(row: TicketRow) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    visitType: row.visit_type,
    priority: row.priority,
    status: row.status,
    customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone, email: row.customer_email },
    site: row.site_id
      ? { id: row.site_id, name: row.site_name, address: row.site_address, city: row.site_city,
          lat: row.site_lat != null ? Number(row.site_lat) : null,
          lng: row.site_lng != null ? Number(row.site_lng) : null }
      : null,
    contractId: row.contract_id,
    contractNo: row.contract_no,
    printer: row.printer_id
      ? { id: row.printer_id, serialNo: row.printer_serial, model: row.printer_model, isColour: !!row.printer_is_colour }
      : null,
    assignedTo: row.assigned_to ? { id: row.assigned_to, fullName: row.assigned_to_name } : null,
    escalatedTo: row.escalated_to ? { id: row.escalated_to, fullName: row.escalated_to_name } : null,
    description: row.description,
    source: row.source ?? 'PHONE',
    slaTier: row.sla_tier ?? null,
    issueCategory: row.issue_category_id
      ? { id: row.issue_category_id, name: row.issue_category_name }
      : null,
    reopenCount: row.reopen_count ?? 0,
    lastResolvedAt: row.last_resolved_at ?? null,
    scheduledDate: row.scheduled_date,
    slaDueAt: row.sla_due_at,
    inTransitAt: row.in_transit_at,
    checkedInAt: row.checked_in_at,
    checkinLat: row.checkin_lat != null ? Number(row.checkin_lat) : null,
    checkinLng: row.checkin_lng != null ? Number(row.checkin_lng) : null,
    slaMet: row.sla_met == null ? null : !!row.sla_met,
    resolvedAt: row.resolved_at,
    resolutionNotes: row.resolution_notes,
    closedAt: row.closed_at,
    closeMethod: row.close_method,
    signatureName: row.signature_name,
    hasSignature: !!row.signature_image,
    escalatedAt: row.escalated_at,
    escalationReason: row.escalation_reason,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    raiser: {
      type: (row.raiser_type as string) ?? 'EMPLOYEE',
      party: (row.raiser_party as string) ?? 'INTERNAL',
      userId: row.raiser_user_id ?? null,
      contactId: row.raiser_contact_id ?? null,
      name: row.raiser_name ?? null,
      email: row.raiser_email ?? null,
      displayName: row.raiser_user_name ?? row.raiser_name ?? null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Write a status transition + its history row in one place. */
async function transition(
  ticketId: number,
  from: string,
  to: string,
  reason: string | null,
  changedBy: number,
  extraSet = '',
  extraParams: unknown[] = [],
): Promise<void> {
  await query(
    `UPDATE service_tickets SET status = ?${extraSet ? ', ' + extraSet : ''} WHERE id = ?`,
    [to, ...extraParams, ticketId],
  );
  await query(
    `INSERT INTO service_ticket_status_history (ticket_id, from_status, to_status, reason, changed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [ticketId, from, to, reason, changedBy],
  );
}

function assertStatus(ticket: TicketRow, allowed: readonly string[], action: string): void {
  if (!allowed.includes(ticket.status)) {
    throw new HttpError(
      422,
      `Cannot ${action} a ticket in ${ticket.status} status. Allowed from: ${allowed.join(', ')}`,
      'INVALID_TRANSITION',
    );
  }
}

// ===========================================================================
// Internal action functions — shared by the HTTP handlers and the sync
// endpoint. Each takes an already-fetched ticket and performs its mutation,
// history, audit and (where relevant) side-effects. They return a small
// result object; callers re-fetch the ticket for the response.
// ===========================================================================

/** Signature every internal ticket-action conforms to. */
type TicketAction = (
  ctx: AuthContext,
  ticket: TicketRow,
  payload: Record<string, unknown>,
  ip: string | null,
) => Promise<Record<string, unknown>>;

async function applyTransit(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['ASSIGNED'], 'mark in transit');
  const at = nowOr(payload.occurredAt);

  await transition(ticket.id, ticket.status, 'IN_TRANSIT', 'Technician en route', ctx.userId,
    'in_transit_at = ?', [at]);

  // "In Transit" triggers a customer notification (queued + marked sent here).
  const recipient = ticket.customer_phone ?? ticket.customer_email ?? null;
  const message = `Your technician is on the way for ticket ${ticket.ticket_no}.`;
  await query(
    `INSERT INTO service_notifications (ticket_id, channel, recipient, message, status)
     VALUES (?, ?, ?, ?, 'SENT')`,
    [ticket.id, ticket.customer_phone ? 'SMS' : 'EMAIL', recipient, message],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'transit',
    changes: { after: { status: 'IN_TRANSIT', notified: recipient } }, ipAddress: ip,
  });
  return { notified: recipient, message };
}

async function applyCheckIn(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['IN_TRANSIT', 'ASSIGNED'], 'check in');

  const lat = payload.lat != null ? Number(payload.lat) : null;
  const lng = payload.lng != null ? Number(payload.lng) : null;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new HttpError(400, 'GPS lat and lng are required to check in', 'GPS_REQUIRED');
  }
  const at = nowOr(payload.occurredAt);
  // SLA met if arrival is at or before the SLA deadline (or no deadline set).
  const slaMet = ticket.sla_due_at ? (at <= ticket.sla_due_at ? 1 : 0) : 1;

  await transition(ticket.id, ticket.status, 'ON_SITE', 'Arrived on site (GPS check-in)', ctx.userId,
    'checked_in_at = ?, checkin_lat = ?, checkin_lng = ?, sla_met = ?', [at, lat, lng, slaMet]);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'checkin',
    changes: { after: { status: 'ON_SITE', checkedInAt: at, slaMet: !!slaMet } }, ipAddress: ip,
  });
  return { slaMet: !!slaMet, checkedInAt: at };
}

async function applyStart(ctx: AuthContext, ticket: TicketRow, _payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['ON_SITE'], 'start work on');
  await transition(ticket.id, ticket.status, 'IN_PROGRESS', 'Work started', ctx.userId);
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'start',
    changes: { after: { status: 'IN_PROGRESS' } }, ipAddress: ip,
  });
  return {};
}

async function applyMeter(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  if (!ticket.printer_id) {
    throw new HttpError(422, 'Ticket has no printer to read a meter for', 'NO_PRINTER');
  }

  // Printer details drive BR-005 (allowance) and BR-006 (colour required).
  const [printer] = await query<RowDataPacket[]>(
    `SELECT id, is_colour, monthly_allowance_bw, monthly_allowance_colour FROM printers WHERE id = ? LIMIT 1`,
    [ticket.printer_id],
  );
  if (!printer) throw new HttpError(404, 'Printer not found');

  const readingBw = posInt(payload.readingBw);
  if (readingBw == null) throw new HttpError(400, 'readingBw is required and must be a non-negative integer');

  const isColour = !!printer.is_colour;
  let readingColour: number | null = null;
  if (payload.readingColour != null && String(payload.readingColour) !== '') {
    readingColour = posInt(payload.readingColour);
    if (readingColour == null) throw new HttpError(400, 'readingColour must be a non-negative integer');
  }

  // BR-006: colour printers require both meters.
  if (isColour && readingColour == null) {
    throw new HttpError(400, 'This is a colour printer — both B/W and colour readings are required', 'COLOUR_READING_REQUIRED');
  }

  // Previous reading for this printer (the highest/most recent on record).
  const [prev] = await query<RowDataPacket[]>(
    `SELECT reading_bw, reading_colour FROM meter_readings
      WHERE printer_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [ticket.printer_id],
  );
  const prevBw: number | null = prev ? Number(prev.reading_bw) : null;
  const prevColour: number | null = prev && prev.reading_colour != null ? Number(prev.reading_colour) : null;

  // BR-004: readings only ever increase.
  if (prevBw != null && readingBw < prevBw) {
    throw new HttpError(422, `B/W reading ${readingBw} is below the previous reading ${prevBw}`, 'READING_BELOW_PREVIOUS');
  }
  if (prevColour != null && readingColour != null && readingColour < prevColour) {
    throw new HttpError(422, `Colour reading ${readingColour} is below the previous reading ${prevColour}`, 'READING_BELOW_PREVIOUS');
  }

  const deltaBw = prevBw != null ? readingBw - prevBw : null;
  const deltaColour = (prevColour != null && readingColour != null) ? readingColour - prevColour : null;

  // BR-005: delta beyond 3x the monthly allowance is flagged for approval.
  const allowanceBw = printer.monthly_allowance_bw != null ? Number(printer.monthly_allowance_bw) : null;
  const allowanceColour = printer.monthly_allowance_colour != null ? Number(printer.monthly_allowance_colour) : null;
  let needsApproval = false;
  if (deltaBw != null && allowanceBw != null && allowanceBw > 0 && deltaBw > 3 * allowanceBw) needsApproval = true;
  if (deltaColour != null && allowanceColour != null && allowanceColour > 0 && deltaColour > 3 * allowanceColour) needsApproval = true;

  const result = await query<ResultSetHeader>(
    `INSERT INTO meter_readings
       (ticket_id, printer_id, reading_bw, reading_colour, previous_bw, previous_colour,
        delta_bw, delta_colour, photo_image, needs_approval, approval_status, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ticket.id, ticket.printer_id, readingBw, readingColour, prevBw, prevColour,
      deltaBw, deltaColour, str(payload.photoImage),
      needsApproval ? 1 : 0, needsApproval ? 'PENDING' : 'NONE', ctx.userId,
    ],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'meter_reading', entityId: result.insertId, action: 'create',
    changes: { after: { ticketId: ticket.id, printerId: ticket.printer_id, readingBw, readingColour, deltaBw, deltaColour, needsApproval } },
    ipAddress: ip,
  });

  return { meterReadingId: result.insertId, deltaBw, deltaColour, needsApproval, previousBw: prevBw, previousColour: prevColour };
}

async function applyParts(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  const consumableId = Number(payload.consumableId);
  if (!Number.isInteger(consumableId) || consumableId <= 0) throw new HttpError(400, 'consumableId is required');
  const warehouseId = Number(payload.warehouseId);
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) throw new HttpError(400, 'warehouseId is required');
  const qty = posInt(payload.quantity);
  if (qty == null || qty <= 0) throw new HttpError(400, 'quantity must be a positive integer');

  // Current stock at this location (missing row treated as zero).
  const [stock] = await query<RowDataPacket[]>(
    `SELECT qty_on_hand FROM consumable_stock WHERE warehouse_id = ? AND consumable_id = ? LIMIT 1`,
    [warehouseId, consumableId],
  );
  const onHand = stock ? Number(stock.qty_on_hand) : 0;

  // BR-021: never drive stock negative.
  if (onHand - qty < 0) {
    throw new HttpError(
      422,
      `Insufficient stock for this part. On hand: ${onHand}, requested: ${qty}.`,
      'INSUFFICIENT_STOCK',
    );
  }

  // Auto-deduct inventory.
  await query(
    `UPDATE consumable_stock SET qty_on_hand = qty_on_hand - ? WHERE warehouse_id = ? AND consumable_id = ?`,
    [qty, warehouseId, consumableId],
  );

  const result = await query<ResultSetHeader>(
    `INSERT INTO service_parts_used (ticket_id, consumable_id, warehouse_id, quantity, recorded_by)
     VALUES (?, ?, ?, ?, ?)`,
    [ticket.id, consumableId, warehouseId, qty, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_parts_used', entityId: result.insertId, action: 'create',
    changes: { after: { ticketId: ticket.id, consumableId, warehouseId, quantity: qty, newOnHand: onHand - qty } },
    ipAddress: ip,
  });

  return { partUsedId: result.insertId, newOnHand: onHand - qty };
}

async function applyClose(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['ON_SITE', 'IN_PROGRESS', 'RESOLVED'], 'close');

  const method = String(payload.method ?? '').trim().toUpperCase();
  if (method !== 'SIGNATURE' && method !== 'OTP') {
    throw new HttpError(400, "Close method must be 'SIGNATURE' or 'OTP'", 'INVALID_CLOSE_METHOD');
  }

  const signatureName = str(payload.signatureName);
  const signatureImage = str(payload.signatureImage);
  if (method === 'SIGNATURE' && !signatureName) {
    throw new HttpError(400, 'signatureName is required to close with a signature', 'SIGNATURE_REQUIRED');
  }
  if (method === 'OTP') {
    const otp = str(payload.otp);
    if (!otp || !/^\d{4,8}$/.test(otp)) {
      throw new HttpError(400, 'A valid OTP (4-8 digits) is required to close with OTP', 'OTP_REQUIRED');
    }
  }

  // BR-014: a resolution note is mandatory regardless of close method.
  const resolutionNotes = str(payload.resolutionNotes);
  if (!resolutionNotes) {
    throw new HttpError(400, 'resolutionNotes is required to close a ticket (BR-014)', 'RESOLUTION_NOTES_REQUIRED');
  }

  const at = nowOr(payload.occurredAt);

  await transition(
    ticket.id, ticket.status, 'CLOSED', 'Ticket closed', ctx.userId,
    `closed_at = ?, resolved_at = COALESCE(resolved_at, ?), last_resolved_at = ?,
     close_method = ?, signature_name = ?, signature_image = ?, resolution_notes = ?`,
    [at, at, at, method, method === 'SIGNATURE' ? signatureName : null,
      method === 'SIGNATURE' ? signatureImage : null, resolutionNotes],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'close',
    changes: { after: { status: 'CLOSED', method, signatureName: method === 'SIGNATURE' ? signatureName : null } },
    ipAddress: ip,
  });

  return { method };
}

async function applyResolve(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['ON_SITE', 'IN_PROGRESS', 'ESCALATED'], 'resolve');

  const resolutionNotes = str(payload.resolutionNotes);
  if (!resolutionNotes) {
    throw new HttpError(400, 'resolutionNotes is required to resolve a ticket (BR-014)', 'RESOLUTION_NOTES_REQUIRED');
  }
  const at = nowOr(payload.occurredAt);

  await transition(
    ticket.id, ticket.status, 'RESOLVED', resolutionNotes, ctx.userId,
    'resolved_at = ?, last_resolved_at = ?, resolution_notes = ?', [at, at, resolutionNotes],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'resolve',
    changes: { after: { status: 'RESOLVED', resolutionNotes } }, ipAddress: ip,
  });
  return { resolvedAt: at };
}

async function applyEscalate(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ['ASSIGNED', 'IN_TRANSIT', 'ON_SITE', 'IN_PROGRESS'], 'escalate');

  const seniorId = Number(payload.seniorTechnicianId);
  if (!Number.isInteger(seniorId) || seniorId <= 0) throw new HttpError(400, 'seniorTechnicianId is required');

  const [senior] = await query<RowDataPacket[]>(
    `SELECT id, is_active FROM users WHERE id = ? LIMIT 1`,
    [seniorId],
  );
  if (!senior) throw new HttpError(404, 'Senior technician not found');
  if (!senior.is_active) throw new HttpError(422, 'Senior technician account is inactive', 'INACTIVE_USER');

  const reason = str(payload.reason) ?? 'Unable to resolve within SLA';
  const at = nowOr(payload.occurredAt);

  await transition(
    ticket.id, ticket.status, 'ESCALATED', reason, ctx.userId,
    'escalated_to = ?, escalated_at = ?, escalation_reason = ?', [seniorId, at, reason],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'escalate',
    reason,
    changes: { after: { status: 'ESCALATED', escalatedTo: seniorId } }, ipAddress: ip,
  });

  return { escalatedTo: seniorId, reason };
}

async function applyCancel(ctx: AuthContext, ticket: TicketRow, payload: Record<string, unknown>, ip: string | null) {
  assertStatus(ticket, ACTIVE_STATUSES, 'cancel');
  const reason = str(payload.reason) ?? 'Cancelled';
  await transition(ticket.id, ticket.status, 'CANCELLED', reason, ctx.userId);
  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: ticket.id, action: 'cancel',
    reason, changes: { after: { status: 'CANCELLED' } }, ipAddress: ip,
  });
  return { reason };
}

// ===========================================================================
// HTTP handlers
// ===========================================================================

// --- GET /api/service-tickets ----------------------------------------------
export const listTickets = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const status = request.query.get('status');
  if (status) { where.push('t.status = ?'); params.push(status.toUpperCase()); }

  const visitType = request.query.get('visitType');
  if (visitType) { where.push('t.visit_type = ?'); params.push(visitType.toUpperCase()); }

  const assignedTo = request.query.get('assignedTo');
  if (assignedTo) { where.push('t.assigned_to = ?'); params.push(Number(assignedTo)); }

  const date = request.query.get('date');
  if (date) { where.push('t.scheduled_date = ?'); params.push(date); }

  const q = request.query.get('q');
  if (q) {
    where.push('(t.ticket_no LIKE ? OR cu.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const raiserType = request.query.get('raiserType');
  if (raiserType) { where.push('t.raiser_type = ?'); params.push(raiserType.toUpperCase()); }

  const rows = await query<TicketRow[]>(
    `${TICKET_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY FIELD(t.priority,'CRITICAL','HIGH','MEDIUM','LOW'), t.created_at DESC`,
    params,
  );
  return json(200, { tickets: rows.map(toTicketPublic) });
});

// --- GET /api/service-tickets/my -------------------------------------------
// Today's tickets for the caller, sorted by priority then geography.
export const myTickets = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceRead);

  const date = request.query.get('date'); // optional YYYY-MM-DD; default = all open assigned
  const lat = request.query.get('lat');
  const lng = request.query.get('lng');

  const where: string[] = ['t.assigned_to = ?', "t.status NOT IN ('CLOSED','CANCELLED')"];
  const params: unknown[] = [ctx.userId];
  if (date) { where.push('(t.scheduled_date = ? OR t.scheduled_date IS NULL)'); params.push(date); }

  // Geography: if the device sends its position, sort by great-circle distance
  // to each site; otherwise fall back to city name then SLA deadline.
  let geoSelect = '';
  let geoOrder = 't.sla_due_at ASC, s.city ASC';
  const orderParams: unknown[] = [];
  if (lat && lng && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
    geoSelect = `,
      (6371 * ACOS(
        LEAST(1, COS(RADIANS(?)) * COS(RADIANS(s.geo_lat)) * COS(RADIANS(s.geo_lng) - RADIANS(?))
        + SIN(RADIANS(?)) * SIN(RADIANS(s.geo_lat))))) AS distance_km`;
    geoOrder = '(s.geo_lat IS NULL), distance_km ASC, t.sla_due_at ASC';
    orderParams.push(Number(lat), Number(lng), Number(lat));
  }

  const rows = await query<TicketRow[]>(
    `${TICKET_SELECT}${geoSelect}
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(t.priority,'CRITICAL','HIGH','MEDIUM','LOW'), ${geoOrder}`,
    [...orderParams, ...params],
  );
  return json(200, { tickets: rows.map(toTicketPublic) });
});

// --- GET /api/service-tickets/{id} -----------------------------------------
export const getTicket = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceRead);

  const id = ticketIdParam(request);
  const ticket = await findTicket(id);
  if (!ticket) return error(404, 'Service ticket not found');

  const history = await query<RowDataPacket[]>(
    `SELECT h.from_status, h.to_status, h.reason, h.changed_by, h.changed_at, u.full_name AS changed_by_name
       FROM service_ticket_status_history h
       JOIN users u ON u.id = h.changed_by
      WHERE h.ticket_id = ? ORDER BY h.changed_at ASC, h.id ASC`,
    [id],
  );
  const meters = await query<RowDataPacket[]>(
    `SELECT id, reading_bw, reading_colour, previous_bw, previous_colour, delta_bw, delta_colour,
            needs_approval, approval_status, recorded_at
       FROM meter_readings WHERE ticket_id = ? ORDER BY recorded_at DESC, id DESC`,
    [id],
  );
  const parts = await query<RowDataPacket[]>(
    `SELECT spu.id, spu.consumable_id, spu.warehouse_id, spu.quantity, spu.recorded_at,
            c.sku, c.name AS consumable_name, w.name AS warehouse_name
       FROM service_parts_used spu
       JOIN consumables c ON c.id = spu.consumable_id
       JOIN warehouses  w ON w.id = spu.warehouse_id
      WHERE spu.ticket_id = ? ORDER BY spu.recorded_at ASC, spu.id ASC`,
    [id],
  );
  const notifications = await query<RowDataPacket[]>(
    `SELECT id, channel, recipient, message, status, created_at
       FROM service_notifications WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`,
    [id],
  );

  return json(200, {
    ticket: toTicketPublic(ticket),
    history: history.map((h) => ({
      fromStatus: h.from_status, toStatus: h.to_status, reason: h.reason,
      changedBy: { id: h.changed_by, fullName: h.changed_by_name }, changedAt: h.changed_at,
    })),
    meterReadings: meters.map((m) => ({
      id: m.id, readingBw: m.reading_bw, readingColour: m.reading_colour,
      previousBw: m.previous_bw, previousColour: m.previous_colour,
      deltaBw: m.delta_bw, deltaColour: m.delta_colour,
      needsApproval: !!m.needs_approval, approvalStatus: m.approval_status, recordedAt: m.recorded_at,
    })),
    partsUsed: parts.map((p) => ({
      id: p.id, consumableId: p.consumable_id, sku: p.sku, name: p.consumable_name,
      warehouseId: p.warehouse_id, warehouseName: p.warehouse_name, quantity: p.quantity, recordedAt: p.recorded_at,
    })),
    notifications: notifications.map((n) => ({
      id: n.id, channel: n.channel, recipient: n.recipient, message: n.message, status: n.status, createdAt: n.created_at,
    })),
  });
});

// --- POST /api/service-tickets ---------------------------------------------
export const createTicket = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceCreate);

  const body = await readJson<Record<string, unknown>>(request);

  const visitType = String(body.visitType ?? '').trim().toUpperCase();
  if (!VISIT_TYPES.includes(visitType as (typeof VISIT_TYPES)[number])) {
    return error(400, `visitType must be one of: ${VISIT_TYPES.join(', ')}`);
  }

  const customerId = Number(body.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) return error(400, 'customerId is required');

  const priority = String(body.priority ?? 'MEDIUM').trim().toUpperCase();
  if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
    return error(400, `priority must be one of: ${PRIORITIES.join(', ')}`);
  }

  const source = ['PHONE', 'PORTAL', 'EMAIL'].includes(String(body.source ?? '').trim().toUpperCase())
    ? String(body.source).trim().toUpperCase()
    : 'PHONE';
  const issueCategoryId = body.issueCategoryId != null ? Number(body.issueCategoryId) : null;
  const autoAssign = !!body.autoAssign;

  // Raiser classification (migration 011).
  const raiserTypeRaw = String(body.raiserType ?? '').trim().toUpperCase();
  const raiserType: string = RAISER_TYPES.includes(raiserTypeRaw as (typeof RAISER_TYPES)[number])
    ? raiserTypeRaw
    : 'EMPLOYEE';
  const defaultParty = raiserType === 'EMPLOYEE' ? 'INTERNAL' : 'EXTERNAL';
  const raiserPartyRaw = String(body.raiserParty ?? '').trim().toUpperCase();
  const raiserParty: string = RAISER_PARTIES.includes(raiserPartyRaw as (typeof RAISER_PARTIES)[number])
    ? raiserPartyRaw
    : defaultParty;

  let raiserUserId: number | null = null;
  let raiserContactId: number | null = null;
  let raiserName: string | null = null;
  let raiserEmail: string | null = null;

  if (raiserType === 'EMPLOYEE') {
    raiserUserId = body.raiserUserId != null ? Number(body.raiserUserId) : ctx.userId;
    raiserName   = str(body.raiserName);
    raiserEmail  = str(body.raiserEmail) ?? ctx.email;
  } else {
    raiserName = str(body.raiserName);
    if (!raiserName) {
      return error(400, 'raiserName is required when raiserType is CUSTOMER', 'RAISER_NAME_REQUIRED');
    }
    raiserContactId = body.raiserContactId != null ? Number(body.raiserContactId) : null;
    raiserEmail     = str(body.raiserEmail);
  }

  // Verify customer exists.
  const [customer] = await query<RowDataPacket[]>(`SELECT id FROM customers WHERE id = ? LIMIT 1`, [customerId]);
  if (!customer) return error(404, 'Customer not found');

  let assignedTo: number | null = body.assignedTo != null ? Number(body.assignedTo) : null;
  const contractId = body.contractId != null ? Number(body.contractId) : null;
  const siteId = body.siteId != null ? Number(body.siteId) : null;

  // BR-013: SLA hours from contract tier when a contract is supplied; else priority fallback.
  let slaTier: string | null = null;
  let slaHours = SLA_HOURS[priority];
  if (contractId) {
    const [contract] = await query<RowDataPacket[]>(
      `SELECT id, sla_tier FROM contracts WHERE id = ? AND customer_id = ? LIMIT 1`,
      [contractId, customerId],
    );
    if (!contract) return error(404, 'Contract not found or does not belong to this customer');
    slaTier = contract.sla_tier as string;
    slaHours = SLA_TIER_HOURS[slaTier] ?? slaHours;
  }

  // Auto-assign: find the least-busy FIELD_TECHNICIAN in the same region as the site.
  if (autoAssign && !assignedTo && siteId) {
    const [site] = await query<RowDataPacket[]>(
      `SELECT city FROM customer_sites WHERE id = ? LIMIT 1`, [siteId],
    );
    if (site?.city) {
      const [tech] = await query<RowDataPacket[]>(
        `SELECT u.id FROM users u
          JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'FIELD_TECHNICIAN' AND u.is_active = 1 AND u.region = ?
         ORDER BY (SELECT COUNT(*) FROM service_tickets st
                   WHERE st.assigned_to = u.id
                     AND st.status NOT IN ('CLOSED','CANCELLED')) ASC
         LIMIT 1`,
        [site.city],
      );
      if (tech) assignedTo = Number(tech.id);
    }
  }

  // Order number: SVC-YYYY-NNNN.
  const year = new Date().getFullYear();
  const [countRow] = await query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM service_tickets WHERE YEAR(created_at) = ?`,
    [year],
  );
  const seq = String(Number(countRow.cnt) + 1).padStart(4, '0');
  const ticketNo = `SVC-${year}-${seq}`;

  const slaDueAt = new Date(Date.now() + slaHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const startStatus = assignedTo ? 'ASSIGNED' : 'OPEN';

  const result = await query<ResultSetHeader>(
    `INSERT INTO service_tickets
       (ticket_no, visit_type, priority, status, customer_id, site_id, contract_id, printer_id,
        assigned_to, description, scheduled_date, sla_due_at, source, sla_tier, issue_category_id,
        raiser_type, raiser_party, raiser_user_id, raiser_contact_id, raiser_name, raiser_email,
        created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ticketNo, visitType, priority, startStatus, customerId,
      siteId, contractId,
      body.printerId != null ? Number(body.printerId) : null,
      assignedTo, str(body.description), str(body.scheduledDate), slaDueAt,
      source, slaTier, issueCategoryId,
      raiserType, raiserParty, raiserUserId, raiserContactId, raiserName, raiserEmail,
      ctx.userId,
    ],
  );
  const newId = result.insertId;

  await query(
    `INSERT INTO service_ticket_status_history (ticket_id, from_status, to_status, reason, changed_by)
     VALUES (?, NULL, ?, 'Ticket raised', ?)`,
    [newId, startStatus, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: newId, action: 'create',
    changes: { after: { ticketNo, visitType, priority, customerId, assignedTo, raiserType, raiserParty } }, ipAddress: clientIp(request),
  });

  const created = await findTicket(newId);
  return json(201, { ticket: created ? toTicketPublic(created) : null });
});

// --- PATCH /api/service-tickets/{id} ---------------------------------------
export const updateTicket = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceUpdate);

  const id = ticketIdParam(request);
  const ticket = await findTicket(id);
  if (!ticket) return error(404, 'Service ticket not found');

  if (!['OPEN', 'ASSIGNED'].includes(ticket.status)) {
    return error(422, `Cannot edit a ticket in ${ticket.status} status`, 'TICKET_NOT_EDITABLE');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  if (body.priority !== undefined) {
    const priority = String(body.priority).toUpperCase();
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) return error(400, 'Invalid priority');
    sets.push('priority = ?'); params.push(priority); after.priority = priority;
  }
  if (body.description !== undefined) { sets.push('description = ?'); params.push(str(body.description)); after.description = str(body.description); }
  if (body.scheduledDate !== undefined) { sets.push('scheduled_date = ?'); params.push(str(body.scheduledDate)); after.scheduledDate = str(body.scheduledDate); }
  if (body.siteId !== undefined) { const v = body.siteId == null ? null : Number(body.siteId); sets.push('site_id = ?'); params.push(v); after.siteId = v; }
  if (body.printerId !== undefined) { const v = body.printerId == null ? null : Number(body.printerId); sets.push('printer_id = ?'); params.push(v); after.printerId = v; }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE service_tickets SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: id, action: 'update',
    changes: { after }, ipAddress: clientIp(request),
  });

  const updated = await findTicket(id);
  return json(200, { ticket: updated ? toTicketPublic(updated) : null });
});

// --- POST /api/service-tickets/{id}/assign ---------------------------------
export const assignTicket = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceAssign);

  const id = ticketIdParam(request);
  const ticket = await findTicket(id);
  if (!ticket) return error(404, 'Service ticket not found');
  if (['CLOSED', 'CANCELLED'].includes(ticket.status)) {
    return error(422, `Cannot assign a ${ticket.status} ticket`, 'INVALID_TRANSITION');
  }

  const body = await readJson<Record<string, unknown>>(request);
  const technicianId = Number(body.technicianId);
  if (!Number.isInteger(technicianId) || technicianId <= 0) return error(400, 'technicianId is required');

  const [tech] = await query<RowDataPacket[]>(`SELECT id, is_active FROM users WHERE id = ? LIMIT 1`, [technicianId]);
  if (!tech) return error(404, 'Technician not found');
  if (!tech.is_active) return error(422, 'Technician account is inactive', 'INACTIVE_USER');

  // Assigning from OPEN advances to ASSIGNED; reassigning keeps the status.
  const newStatus = ticket.status === 'OPEN' ? 'ASSIGNED' : ticket.status;
  await query(`UPDATE service_tickets SET assigned_to = ?, status = ? WHERE id = ?`, [technicianId, newStatus, id]);
  await query(
    `INSERT INTO service_ticket_status_history (ticket_id, from_status, to_status, reason, changed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, ticket.status, newStatus, `Assigned to technician ${technicianId}`, ctx.userId],
  );

  await writeAudit({
    actorUserId: ctx.userId, actorEmail: ctx.email,
    entityType: 'service_ticket', entityId: id, action: 'assign',
    changes: { after: { assignedTo: technicianId, status: newStatus } }, ipAddress: clientIp(request),
  });

  const updated = await findTicket(id);
  return json(200, { ticket: updated ? toTicketPublic(updated) : null });
});

/**
 * Build a thin HTTP wrapper around an internal action function: fetch the
 * ticket, run the action, re-fetch, and return { ticket, ...result }.
 */
function actionHandler(permission: string, fn: TicketAction) {
  return handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
    const ctx = requireAuth(request);
    requirePermission(ctx, permission);
    const id = ticketIdParam(request);
    const ticket = await findTicket(id);
    if (!ticket) return error(404, 'Service ticket not found');
    const body = await readJson<Record<string, unknown>>(request);
    const result = await fn(ctx, ticket, body, clientIp(request));
    const updated = await findTicket(id);
    return json(200, { ticket: updated ? toTicketPublic(updated) : null, ...result });
  });
}

export const transitTicket = actionHandler(PERMISSIONS.serviceUpdate, applyTransit);
export const checkInTicket = actionHandler(PERMISSIONS.serviceUpdate, applyCheckIn);
export const startTicket = actionHandler(PERMISSIONS.serviceUpdate, applyStart);
export const meterTicket = actionHandler(PERMISSIONS.serviceUpdate, applyMeter);
export const partsTicket = actionHandler(PERMISSIONS.serviceUpdate, applyParts);
export const resolveTicket = actionHandler(PERMISSIONS.serviceResolve, applyResolve);
export const closeTicket = actionHandler(PERMISSIONS.serviceClose, applyClose);
export const escalateTicket = actionHandler(PERMISSIONS.serviceEscalate, applyEscalate);
export const cancelTicket = actionHandler(PERMISSIONS.serviceUpdate, applyCancel);

// --- POST /api/service-tickets/sync ----------------------------------------
// Offline batch sync. The mobile app queues actions while offline, each with a
// unique clientActionId; this endpoint applies them in order and is idempotent
// (a replayed clientActionId is skipped). One bad action never blocks the rest.
const SYNC_ACTIONS: Record<string, TicketAction> = {
  transit: applyTransit,
  checkin: applyCheckIn,
  start: applyStart,
  meter: applyMeter,
  parts: applyParts,
  close: applyClose,
  escalate: applyEscalate,
  cancel: applyCancel,
};

export const syncTickets = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.serviceUpdate);

  const body = await readJson<{ actions?: unknown[] }>(request);
  const actions = Array.isArray(body.actions) ? body.actions : [];
  const ip = clientIp(request);

  const results: Array<Record<string, unknown>> = [];

  for (const raw of actions) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const clientActionId = str(a.clientActionId);
    const type = String(a.type ?? '').trim().toLowerCase();
    const ticketId = Number(a.ticketId);
    const payload = (a.payload ?? {}) as Record<string, unknown>;

    if (!clientActionId) { results.push({ status: 'ERROR', error: 'clientActionId required' }); continue; }

    // Idempotency: skip an action we've already applied.
    const [seen] = await query<RowDataPacket[]>(
      `SELECT id FROM service_sync_log WHERE client_action_id = ? LIMIT 1`,
      [clientActionId],
    );
    if (seen) { results.push({ clientActionId, status: 'DUPLICATE' }); continue; }

    const fn = SYNC_ACTIONS[type];
    if (!fn) { results.push({ clientActionId, status: 'ERROR', error: `Unknown action type '${type}'` }); continue; }

    try {
      const ticket = await findTicket(ticketId);
      if (!ticket) { results.push({ clientActionId, status: 'ERROR', error: 'Ticket not found' }); continue; }

      const result = await fn(ctx, ticket, payload, ip);
      await query(
        `INSERT INTO service_sync_log (client_action_id, action_type, ticket_id, result, synced_by)
         VALUES (?, ?, ?, 'APPLIED', ?)`,
        [clientActionId, type, ticketId, ctx.userId],
      );
      results.push({ clientActionId, status: 'APPLIED', ...result });
    } catch (err) {
      if (err instanceof HttpError) {
        results.push({ clientActionId, status: 'ERROR', code: err.code, error: err.message });
      } else {
        results.push({ clientActionId, status: 'ERROR', error: 'Internal error' });
      }
    }
  }

  return json(200, { results });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('service-tickets-list',     { methods: ['GET'],   authLevel: 'anonymous', route: 'service-tickets',              handler: listTickets });
app.http('service-tickets-my',       { methods: ['GET'],   authLevel: 'anonymous', route: 'service-tickets/my',           handler: myTickets });
app.http('service-tickets-sync',     { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/sync',         handler: syncTickets });
app.http('service-tickets-get',      { methods: ['GET'],   authLevel: 'anonymous', route: 'service-tickets/{id}',         handler: getTicket });
app.http('service-tickets-create',   { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets',              handler: createTicket });
app.http('service-tickets-update',   { methods: ['PATCH'], authLevel: 'anonymous', route: 'service-tickets/{id}',         handler: updateTicket });
app.http('service-tickets-assign',   { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/assign',  handler: assignTicket });
app.http('service-tickets-transit',  { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/transit', handler: transitTicket });
app.http('service-tickets-checkin',  { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/checkin', handler: checkInTicket });
app.http('service-tickets-start',    { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/start',   handler: startTicket });
app.http('service-tickets-meter',    { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/meter',   handler: meterTicket });
app.http('service-tickets-parts',    { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/parts',   handler: partsTicket });
app.http('service-tickets-resolve',  { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/resolve', handler: resolveTicket });
app.http('service-tickets-close',    { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/close',   handler: closeTicket });
app.http('service-tickets-escalate', { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/escalate',handler: escalateTicket });
app.http('service-tickets-cancel',   { methods: ['POST'],  authLevel: 'anonymous', route: 'service-tickets/{id}/cancel',  handler: cancelTicket });
