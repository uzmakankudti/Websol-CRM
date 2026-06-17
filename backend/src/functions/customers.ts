/**
 * Customer & Contract Management — customer endpoints.
 *
 *   GET    /api/customers                         list customers
 *   GET    /api/customers/{id}                    customer + sites + contacts + contracts
 *   POST   /api/customers                         create customer profile   (customers.create)
 *   PATCH  /api/customers/{id}                     edit customer profile      (customers.update)
 *   POST   /api/customers/{id}/sites              add a site/location         (customers.update)
 *   PATCH  /api/customers/{id}/sites/{siteId}     edit a site                 (customers.update)
 *   DELETE /api/customers/{id}/sites/{siteId}     remove a site               (customers.update)
 *   POST   /api/customers/{id}/contacts           add a contact               (customers.update)
 *   PATCH  /api/customers/{id}/contacts/{contactId} edit a contact            (customers.update)
 *   DELETE /api/customers/{id}/contacts/{contactId} remove a contact          (customers.update)
 *
 * The customer profile, sites and contacts are the company record that
 * contracts hang off. Contracts themselves live in functions/contracts.ts.
 */
import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { query } from '../shared/db';
import { requireAuth, requirePermission, PERMISSIONS } from '../shared/rbac';
import { writeAudit } from '../shared/audit';
import { error, handle, json, readJson, clientIp, HttpError } from '../shared/http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CustomerRow extends RowDataPacket {
  id: number;
  name: string;
  registration_no: string | null;
  vat_no: string | null;
  industry: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  billing_email: string | null;
  billing_phone: string | null;
  status: string;
  notes: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

interface SiteRow extends RowDataPacket {
  id: number;
  customer_id: number;
  name: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  is_primary: number;
  created_at: string;
}

interface ContactRow extends RowDataPacket {
  id: number;
  customer_id: number;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_primary: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STATUS = ['ACTIVE', 'INACTIVE'] as const;

function customerIdParam(request: HttpRequest): number {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid customer id');
  return id;
}

function subIdParam(request: HttpRequest, key: string): number {
  const id = Number(request.params[key]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Invalid ${key}`);
  return id;
}

function toCustomerPublic(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    registrationNo: row.registration_no,
    vatNo: row.vat_no,
    industry: row.industry,
    website: row.website,
    email: row.email,
    phone: row.phone,
    billingAddress: row.billing_address,
    billingEmail: row.billing_email,
    billingPhone: row.billing_phone,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSitePublic(row: SiteRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
  };
}

function toContactPublic(row: ContactRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
  };
}

async function findCustomer(id: number): Promise<CustomerRow | null> {
  const rows = await query<CustomerRow[]>(
    `SELECT c.*, u.full_name AS created_by_name
       FROM customers c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = ?
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/customers
// ---------------------------------------------------------------------------
export const listCustomers = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersRead);

  const where: string[] = [];
  const params: unknown[] = [];

  const status = request.query.get('status');
  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  const q = request.query.get('q');
  if (q) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.registration_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = await query<CustomerRow[]>(
    `SELECT c.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM contracts ct WHERE ct.customer_id = c.id) AS contract_count,
            (SELECT COUNT(*) FROM contracts ct WHERE ct.customer_id = c.id AND ct.status = 'ACTIVE') AS active_contract_count
       FROM customers c
       LEFT JOIN users u ON u.id = c.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.name ASC`,
    params,
  );

  return json(200, {
    customers: rows.map((r) => ({
      ...toCustomerPublic(r),
      contractCount: Number((r as RowDataPacket).contract_count) || 0,
      activeContractCount: Number((r as RowDataPacket).active_contract_count) || 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/customers/{id}
// ---------------------------------------------------------------------------
export const getCustomer = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersRead);

  const id = customerIdParam(request);
  const customer = await findCustomer(id);
  if (!customer) return error(404, 'Customer not found');

  const sites = await query<SiteRow[]>(
    `SELECT * FROM customer_sites WHERE customer_id = ? ORDER BY is_primary DESC, name ASC`,
    [id],
  );
  const contacts = await query<ContactRow[]>(
    `SELECT * FROM customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC, name ASC`,
    [id],
  );

  // Contract summaries for the customer (full detail lives under /contracts/{id}).
  const contracts = await query<RowDataPacket[]>(
    `SELECT c.id, c.contract_no, c.start_date, c.end_date, c.monthly_lease_fee,
            c.per_click_bw, c.per_click_colour, c.sla_tier, c.status,
            EXISTS(SELECT 1 FROM contract_documents d WHERE d.contract_id = c.id) AS has_document
       FROM contracts c
      WHERE c.customer_id = ?
      ORDER BY c.created_at DESC`,
    [id],
  );

  return json(200, {
    customer: toCustomerPublic(customer),
    sites: sites.map(toSitePublic),
    contacts: contacts.map(toContactPublic),
    contracts: contracts.map((c) => ({
      id: c.id,
      contractNo: c.contract_no,
      startDate: c.start_date,
      endDate: c.end_date,
      monthlyLeaseFee: parseFloat(c.monthly_lease_fee),
      perClickBw: parseFloat(c.per_click_bw),
      perClickColour: parseFloat(c.per_click_colour),
      slaTier: c.sla_tier,
      status: c.status,
      hasDocument: !!c.has_document,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/customers
// ---------------------------------------------------------------------------
export const createCustomer = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersCreate);

  const body = await readJson<Record<string, unknown>>(request);
  const name = String(body.name ?? '').trim();
  if (!name) return error(400, 'Customer name is required');

  const status = (body.status as string) ?? 'ACTIVE';
  if (!VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
    return error(400, `status must be one of: ${VALID_STATUS.join(', ')}`);
  }

  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s || null;
  };

  const result = await query<ResultSetHeader>(
    `INSERT INTO customers
       (name, registration_no, vat_no, industry, website, email, phone,
        billing_address, billing_email, billing_phone, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      str(body.registrationNo),
      str(body.vatNo),
      str(body.industry),
      str(body.website),
      str(body.email),
      str(body.phone),
      str(body.billingAddress),
      str(body.billingEmail),
      str(body.billingPhone),
      status,
      str(body.notes),
      ctx.userId,
    ],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer',
    entityId: result.insertId,
    action: 'create',
    changes: { after: { name, status } },
    ipAddress: clientIp(request),
  });

  const created = await findCustomer(result.insertId);
  return json(201, { customer: created ? toCustomerPublic(created) : null });
});

// ---------------------------------------------------------------------------
// PATCH /api/customers/{id}
// ---------------------------------------------------------------------------
export const updateCustomer = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const id = customerIdParam(request);
  const existing = await findCustomer(id);
  if (!existing) return error(404, 'Customer not found');

  const body = await readJson<Record<string, unknown>>(request);

  const fieldMap: Record<string, string> = {
    name: 'name',
    registrationNo: 'registration_no',
    vatNo: 'vat_no',
    industry: 'industry',
    website: 'website',
    email: 'email',
    phone: 'phone',
    billingAddress: 'billing_address',
    billingEmail: 'billing_email',
    billingPhone: 'billing_phone',
    notes: 'notes',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  for (const [key, column] of Object.entries(fieldMap)) {
    if (body[key] === undefined) continue;
    if (key === 'name') {
      const name = String(body.name ?? '').trim();
      if (!name) return error(400, 'Customer name cannot be empty');
      sets.push('name = ?');
      params.push(name);
      after.name = name;
    } else {
      const value = body[key] == null ? null : String(body[key]).trim() || null;
      sets.push(`${column} = ?`);
      params.push(value);
      after[key] = value;
    }
  }

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
      return error(400, `status must be one of: ${VALID_STATUS.join(', ')}`);
    }
    sets.push('status = ?');
    params.push(status);
    after.status = status;
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(id);
  await query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, params);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer',
    entityId: id,
    action: 'update',
    changes: { after },
    ipAddress: clientIp(request),
  });

  const updated = await findCustomer(id);
  return json(200, { customer: updated ? toCustomerPublic(updated) : null });
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------
export const createSite = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const customer = await findCustomer(customerId);
  if (!customer) return error(404, 'Customer not found');

  const body = await readJson<Record<string, unknown>>(request);
  const name = String(body.name ?? '').trim();
  if (!name) return error(400, 'Site name is required');

  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s || null;
  };
  const isPrimary = body.isPrimary ? 1 : 0;

  // Only one primary site per customer.
  if (isPrimary) {
    await query(`UPDATE customer_sites SET is_primary = 0 WHERE customer_id = ?`, [customerId]);
  }

  const result = await query<ResultSetHeader>(
    `INSERT INTO customer_sites
       (customer_id, name, address, city, postal_code, contact_name, contact_phone, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      name,
      str(body.address),
      str(body.city),
      str(body.postalCode),
      str(body.contactName),
      str(body.contactPhone),
      isPrimary,
    ],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer_site',
    entityId: result.insertId,
    action: 'create',
    changes: { after: { customerId, name } },
    ipAddress: clientIp(request),
  });

  const rows = await query<SiteRow[]>(`SELECT * FROM customer_sites WHERE id = ? LIMIT 1`, [
    result.insertId,
  ]);
  return json(201, { site: rows[0] ? toSitePublic(rows[0]) : null });
});

export const updateSite = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const siteId = subIdParam(request, 'siteId');

  const rows = await query<SiteRow[]>(
    `SELECT * FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1`,
    [siteId, customerId],
  );
  if (!rows.length) return error(404, 'Site not found');

  const body = await readJson<Record<string, unknown>>(request);
  const map: Record<string, string> = {
    name: 'name',
    address: 'address',
    city: 'city',
    postalCode: 'postal_code',
    contactName: 'contact_name',
    contactPhone: 'contact_phone',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] === undefined) continue;
    if (key === 'name') {
      const name = String(body.name ?? '').trim();
      if (!name) return error(400, 'Site name cannot be empty');
      sets.push('name = ?');
      params.push(name);
    } else {
      sets.push(`${column} = ?`);
      params.push(body[key] == null ? null : String(body[key]).trim() || null);
    }
  }
  if (body.isPrimary !== undefined) {
    if (body.isPrimary) {
      await query(`UPDATE customer_sites SET is_primary = 0 WHERE customer_id = ?`, [customerId]);
    }
    sets.push('is_primary = ?');
    params.push(body.isPrimary ? 1 : 0);
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(siteId);
  await query(`UPDATE customer_sites SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await query<SiteRow[]>(`SELECT * FROM customer_sites WHERE id = ? LIMIT 1`, [
    siteId,
  ]);
  return json(200, { site: updated[0] ? toSitePublic(updated[0]) : null });
});

export const deleteSite = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const siteId = subIdParam(request, 'siteId');

  const rows = await query<SiteRow[]>(
    `SELECT id FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1`,
    [siteId, customerId],
  );
  if (!rows.length) return error(404, 'Site not found');

  await query(`DELETE FROM customer_sites WHERE id = ?`, [siteId]);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer_site',
    entityId: siteId,
    action: 'delete',
    changes: { before: { customerId } },
    ipAddress: clientIp(request),
  });

  return json(200, { deleted: true });
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export const createContact = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const customer = await findCustomer(customerId);
  if (!customer) return error(404, 'Customer not found');

  const body = await readJson<Record<string, unknown>>(request);
  const name = String(body.name ?? '').trim();
  if (!name) return error(400, 'Contact name is required');

  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s || null;
  };
  const isPrimary = body.isPrimary ? 1 : 0;
  if (isPrimary) {
    await query(`UPDATE customer_contacts SET is_primary = 0 WHERE customer_id = ?`, [customerId]);
  }

  const result = await query<ResultSetHeader>(
    `INSERT INTO customer_contacts (customer_id, name, title, email, phone, is_primary)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [customerId, name, str(body.title), str(body.email), str(body.phone), isPrimary],
  );

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer_contact',
    entityId: result.insertId,
    action: 'create',
    changes: { after: { customerId, name } },
    ipAddress: clientIp(request),
  });

  const rows = await query<ContactRow[]>(`SELECT * FROM customer_contacts WHERE id = ? LIMIT 1`, [
    result.insertId,
  ]);
  return json(201, { contact: rows[0] ? toContactPublic(rows[0]) : null });
});

export const updateContact = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const contactId = subIdParam(request, 'contactId');

  const rows = await query<ContactRow[]>(
    `SELECT * FROM customer_contacts WHERE id = ? AND customer_id = ? LIMIT 1`,
    [contactId, customerId],
  );
  if (!rows.length) return error(404, 'Contact not found');

  const body = await readJson<Record<string, unknown>>(request);
  const map: Record<string, string> = {
    name: 'name',
    title: 'title',
    email: 'email',
    phone: 'phone',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] === undefined) continue;
    if (key === 'name') {
      const name = String(body.name ?? '').trim();
      if (!name) return error(400, 'Contact name cannot be empty');
      sets.push('name = ?');
      params.push(name);
    } else {
      sets.push(`${column} = ?`);
      params.push(body[key] == null ? null : String(body[key]).trim() || null);
    }
  }
  if (body.isPrimary !== undefined) {
    if (body.isPrimary) {
      await query(`UPDATE customer_contacts SET is_primary = 0 WHERE customer_id = ?`, [
        customerId,
      ]);
    }
    sets.push('is_primary = ?');
    params.push(body.isPrimary ? 1 : 0);
  }

  if (!sets.length) return error(400, 'No changes supplied');

  params.push(contactId);
  await query(`UPDATE customer_contacts SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await query<ContactRow[]>(
    `SELECT * FROM customer_contacts WHERE id = ? LIMIT 1`,
    [contactId],
  );
  return json(200, { contact: updated[0] ? toContactPublic(updated[0]) : null });
});

export const deleteContact = handle(async (request: HttpRequest): Promise<HttpResponseInit> => {
  const ctx = requireAuth(request);
  requirePermission(ctx, PERMISSIONS.customersUpdate);

  const customerId = customerIdParam(request);
  const contactId = subIdParam(request, 'contactId');

  const rows = await query<ContactRow[]>(
    `SELECT id FROM customer_contacts WHERE id = ? AND customer_id = ? LIMIT 1`,
    [contactId, customerId],
  );
  if (!rows.length) return error(404, 'Contact not found');

  await query(`DELETE FROM customer_contacts WHERE id = ?`, [contactId]);

  await writeAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    entityType: 'customer_contact',
    entityId: contactId,
    action: 'delete',
    changes: { before: { customerId } },
    ipAddress: clientIp(request),
  });

  return json(200, { deleted: true });
});

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------
app.http('customers-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'customers',
  handler: listCustomers,
});
app.http('customers-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'customers',
  handler: createCustomer,
});
app.http('customers-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'customers/{id}',
  handler: getCustomer,
});
app.http('customers-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'customers/{id}',
  handler: updateCustomer,
});
app.http('customers-sites-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'customers/{id}/sites',
  handler: createSite,
});
app.http('customers-sites-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'customers/{id}/sites/{siteId}',
  handler: updateSite,
});
app.http('customers-sites-delete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'customers/{id}/sites/{siteId}',
  handler: deleteSite,
});
app.http('customers-contacts-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'customers/{id}/contacts',
  handler: createContact,
});
app.http('customers-contacts-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'customers/{id}/contacts/{contactId}',
  handler: updateContact,
});
app.http('customers-contacts-delete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'customers/{id}/contacts/{contactId}',
  handler: deleteContact,
});
