/**
 * Idempotent development seed.
 * Run: npm run seed   (from backend/)
 *
 * Safe to re-run: uses INSERT … ON DUPLICATE KEY UPDATE / INSERT IGNORE throughout.
 * Passwords are hashed via the real hashPassword() from shared/auth so seeded
 * users can log in immediately.
 *
 * Requires the four DB env vars to be set (the npm script supplies them):
 *   DB_HOST  DB_USER  DB_PASSWORD  DB_NAME
 */

import mysql from 'mysql2/promise';
import { hashPassword } from './shared/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysAgo(n: number): string { return daysFromNow(-n); }
function addHours(h: number): string {
  return new Date(Date.now() + h * 3_600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const db = await mysql.createConnection({
    host:     'localhost',
    user:     'websol',
    password: 'Websol@Local123',
    database: 'websol_crm',
  });

  // Thin wrapper — returns the result set for both DML and SELECT
  async function q(sql: string, params: Array<string | number | boolean | null | Date | Buffer> = []) {
    const [result] = await db.execute(sql, params);
    return result as mysql.RowDataPacket[] & mysql.ResultSetHeader;
  }

  // ── 1. USERS ──────────────────────────────────────────────────────────────
  console.log('\n[1/10] Seeding users…');

  // Keep the original admin account unlocked and ready
  await q(`UPDATE users
           SET failed_login_count=0, locked_until=NULL, must_change_password=0
           WHERE email='admin@websol.local'`);

  interface UserSeed { email: string; fullName: string; roleId: number; }
  const userSeeds: UserSeed[] = [
    { email: 'ceo@websol.local',             fullName: 'Alice CEO',             roleId: 1   },
    { email: 'sales.manager@websol.local',   fullName: 'Bob Sales Manager',     roleId: 2   },
    { email: 'sales.rep@websol.local',       fullName: 'Carol Sales Rep',       roleId: 3   },
    { email: 'contracts.mgr@websol.local',   fullName: 'David Contracts Mgr',   roleId: 4   },
    { email: 'warehouse.mgr@websol.local',   fullName: 'Eve Warehouse Mgr',     roleId: 5   },
    { email: 'warehouse.staff@websol.local', fullName: 'Frank Warehouse Staff', roleId: 6   },
    { email: 'dispatch@websol.local',        fullName: 'Grace Dispatch Coord',  roleId: 7   },
    { email: 'technician@websol.local',      fullName: 'Hank Technician',       roleId: 8   },
    { email: 'csr@websol.local',             fullName: 'Ivy CSR',               roleId: 9   },
    { email: 'csr.super@websol.local',       fullName: 'Jack CSR Supervisor',   roleId: 10  },
    { email: 'billing@websol.local',         fullName: 'Karen Billing Exec',    roleId: 11  },
    { email: 'finance.mgr@websol.local',     fullName: 'Leo Finance Mgr',       roleId: 12  },
    { email: 'sysadmin@websol.local',        fullName: 'Mia Sys Admin',         roleId: 13  },
    { email: 'toner@websol.local',           fullName: 'Ned Toner Coord',       roleId: 14  },
    { email: 'senior.tech@websol.local',     fullName: 'Olivia Senior Tech',    roleId: 333 },
    { email: 'ops.mgr@websol.local',         fullName: 'Paul Ops Manager',      roleId: 454 },
  ];

  const uid: Record<string, number> = {};
  const [adminRow] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM users WHERE email='admin@websol.local'`,
  );
  uid['admin@websol.local'] = adminRow[0]?.id ?? 1;

  for (const u of userSeeds) {
    await q(
      `INSERT INTO users (email, full_name, password_hash, role_id, must_change_password, is_active)
       VALUES (?,?,?,?,0,1)
       ON DUPLICATE KEY UPDATE
         full_name=VALUES(full_name), password_hash=VALUES(password_hash),
         role_id=VALUES(role_id), must_change_password=0,
         is_active=1, failed_login_count=0, locked_until=NULL`,
      [u.email, u.fullName, hashPassword('Test@1234'), u.roleId],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM users WHERE email=?`, [u.email],
    );
    uid[u.email] = r[0].id;
  }

  const ADMIN  = uid['admin@websol.local'];
  const SM     = uid['sales.manager@websol.local'];
  const SR     = uid['sales.rep@websol.local'];
  const CM     = uid['contracts.mgr@websol.local'];
  const WM     = uid['warehouse.mgr@websol.local'];
  const DC     = uid['dispatch@websol.local'];
  const TECH   = uid['technician@websol.local'];
  const TONER  = uid['toner@websol.local'];
  const STECH  = uid['senior.tech@websol.local'];

  console.log(`   ${userSeeds.length} users upserted.`);

  // ── 2. LEADS ──────────────────────────────────────────────────────────────
  console.log('[2/10] Seeding leads…');

  interface LeadSeed {
    company: string; contact: string; email: string; phone: string;
    source: string; stage: string; printers: number; assignedTo: number;
    note?: string; lostReason?: string;
  }
  const leadSeeds: LeadSeed[] = [
    { company: 'Acme Corp',        contact: 'Tom Acme',   email: 'tom@acme.com',    phone: '0800100001', source: 'REFERRAL',   stage: 'NEW',           printers: 5,  assignedTo: SR },
    { company: 'Beta Industries',  contact: 'Sue Beta',   email: 'sue@beta.com',    phone: '0800100002', source: 'WEBSITE',    stage: 'CONTACTED',     printers: 3,  assignedTo: SR },
    { company: 'Gamma Ltd',        contact: 'Ray Gamma',  email: 'ray@gamma.com',   phone: '0800100003', source: 'COLD_CALL',  stage: 'PROPOSAL_SENT', printers: 10, assignedTo: SR },
    { company: 'Delta Group',      contact: 'Liz Delta',  email: 'liz@delta.com',   phone: '0800100004', source: 'EXHIBITION', stage: 'WON',           printers: 8,  assignedTo: SR, note: 'Ready to convert' },
    { company: 'Epsilon Partners', contact: 'Jon Eps',    email: 'jon@epsilon.com', phone: '0800100005', source: 'REFERRAL',   stage: 'LOST',          printers: 2,  assignedTo: SR, lostReason: 'Chose competitor on price' },
    { company: 'Zeta Solutions',   contact: 'Amy Zeta',   email: 'amy@zeta.com',    phone: '0800100006', source: 'OTHER',      stage: 'WON',           printers: 15, assignedTo: SM, note: 'Won — no quotation yet (blocked per BR-024)' },
  ];

  const leadId: Record<string, number> = {};
  for (const l of leadSeeds) {
    await q(
      `INSERT INTO leads
         (company_name,contact_name,contact_email,contact_phone,source,stage,stage_note,
          expected_printers,assigned_to,lost_reason,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE stage=VALUES(stage), stage_note=VALUES(stage_note),
         lost_reason=VALUES(lost_reason), assigned_to=VALUES(assigned_to)`,
      [l.company, l.contact, l.email, l.phone, l.source, l.stage,
       l.note ?? null, l.printers, l.assignedTo, l.lostReason ?? null, ADMIN],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM leads WHERE company_name=?`, [l.company],
    );
    leadId[l.company] = r[0].id;
  }

  // Approved quotation on Gamma (PROPOSAL_SENT) — satisfies BR-024 for conversion
  await q(
    `INSERT INTO lead_quotations
       (lead_id,monthly_lease_fee,per_page_bw,per_page_colour,discount_pct,notes,status,
        approved_by,approved_at,created_by)
     VALUES (?,1200.00,0.01200,0.05000,5.00,'Seed quotation','APPROVED',?,NOW(),?)
     ON DUPLICATE KEY UPDATE status='APPROVED', approved_by=VALUES(approved_by), approved_at=NOW()`,
    [leadId['Gamma Ltd'], SM, SR],
  );
  const [qRows] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM lead_quotations WHERE lead_id=? ORDER BY id LIMIT 1`,
    [leadId['Gamma Ltd']],
  );
  if (qRows[0]) {
    await q(
      `INSERT IGNORE INTO lead_quotation_printers (quotation_id,printer_model,quantity) VALUES (?,?,?)`,
      [qRows[0].id, 'Lexmark MX622adhe', 10],
    );
  }

  // Approved quotation on Delta (WON — ready to convert)
  await q(
    `INSERT INTO lead_quotations
       (lead_id,monthly_lease_fee,per_page_bw,per_page_colour,discount_pct,notes,status,
        approved_by,approved_at,created_by)
     VALUES (?,2500.00,0.01000,0.04500,10.00,'Delta approved','APPROVED',?,NOW(),?)
     ON DUPLICATE KEY UPDATE status='APPROVED', approved_by=VALUES(approved_by)`,
    [leadId['Delta Group'], SM, SR],
  );

  console.log(`   ${leadSeeds.length} leads upserted.`);

  // ── 3. CUSTOMERS + SITES ──────────────────────────────────────────────────
  console.log('[3/10] Seeding customers & sites…');

  interface CustSeed { name: string; industry: string; email: string; phone: string; status: string; }
  const custSeeds: CustSeed[] = [
    { name: 'Acme Corp (Customer)', industry: 'Manufacturing', email: 'billing@acme-c.com',   phone: '0800200001', status: 'ACTIVE'   },
    { name: 'Omega Logistics',      industry: 'Logistics',     email: 'billing@omega.com',    phone: '0800200002', status: 'ACTIVE'   },
    { name: 'Pinnacle Finance',     industry: 'Finance',       email: 'billing@pinnacle.com', phone: '0800200003', status: 'ACTIVE'   },
    { name: 'Summit Retail',        industry: 'Retail',        email: 'billing@summit.com',   phone: '0800200004', status: 'ACTIVE'   },
    { name: 'Legacy Systems Ltd',   industry: 'Technology',    email: 'billing@legacy.com',   phone: '0800200005', status: 'INACTIVE' },
  ];

  const custId: Record<string, number> = {};
  for (const c of custSeeds) {
    await q(
      `INSERT INTO customers (name,industry,billing_email,billing_phone,status,created_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE industry=VALUES(industry), status=VALUES(status)`,
      [c.name, c.industry, c.email, c.phone, c.status, ADMIN],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM customers WHERE name=?`, [c.name],
    );
    custId[c.name] = r[0].id;
  }

  for (const [name, cid] of Object.entries(custId)) {
    await q(
      `INSERT INTO customer_sites
         (customer_id,name,address,city,geo_lat,geo_lng,contact_name,contact_phone,is_primary)
       VALUES (?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE address=VALUES(address)`,
      [cid, `${name} HQ`, '1 Main Street', 'Nairobi', -1.2921, 36.8219, 'Reception', '0800000000'],
    );
  }

  const siteId: Record<number, number> = {};
  for (const cid of Object.values(custId)) {
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM customer_sites WHERE customer_id=? AND is_primary=1 LIMIT 1`, [cid],
    );
    if (r[0]) siteId[cid] = r[0].id;
  }

  console.log(`   ${custSeeds.length} customers upserted.`);

  // ── 4. CONTRACTS ──────────────────────────────────────────────────────────
  console.log('[4/10] Seeding contracts…');

  const ACME_ID     = custId['Acme Corp (Customer)'];
  const OMEGA_ID    = custId['Omega Logistics'];
  const PINNACLE_ID = custId['Pinnacle Finance'];
  const SUMMIT_ID   = custId['Summit Retail'];
  const LEGACY_ID   = custId['Legacy Systems Ltd'];

  interface ContractSeed {
    no: string; cid: number; start: string; end: string;
    fee: number; bw: number; colour: number; sla: string; status: string;
  }
  const contractSeeds: ContractSeed[] = [
    { no: 'CTR-DRAFT-001',  cid: ACME_ID,     start: daysFromNow(10), end: daysFromNow(375), fee: 1500, bw: 0.012, colour: 0.050, sla: 'BRONZE',   status: 'DRAFT'   },
    { no: 'CTR-ACTIVE-002', cid: OMEGA_ID,    start: daysAgo(100),    end: daysFromNow(265), fee: 2200, bw: 0.010, colour: 0.040, sla: 'SILVER',   status: 'ACTIVE'  },
    { no: 'CTR-ACTIVE-003', cid: PINNACLE_ID, start: daysAgo(200),    end: daysFromNow(60),  fee: 3500, bw: 0.009, colour: 0.038, sla: 'GOLD',     status: 'ACTIVE'  },
    { no: 'CTR-ACTIVE-004', cid: SUMMIT_ID,   start: daysAgo(50),     end: daysFromNow(315), fee: 5000, bw: 0.008, colour: 0.035, sla: 'PLATINUM', status: 'ACTIVE'  },
    { no: 'CTR-EXPIRED-005',cid: LEGACY_ID,   start: daysAgo(400),    end: daysAgo(35),      fee: 800,  bw: 0.015, colour: 0.060, sla: 'BRONZE',   status: 'EXPIRED' },
  ];

  const contractId: Record<string, number> = {};
  for (const c of contractSeeds) {
    await q(
      `INSERT INTO contracts
         (customer_id,contract_no,start_date,end_date,monthly_lease_fee,
          per_click_bw,per_click_colour,sla_tier,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), end_date=VALUES(end_date)`,
      [c.cid, c.no, c.start, c.end, c.fee, c.bw, c.colour, c.sla, c.status, CM],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM contracts WHERE contract_no=?`, [c.no],
    );
    contractId[c.no] = r[0].id;
  }
  for (const c of contractSeeds.filter((x) => x.status === 'ACTIVE')) {
    await q(
      `UPDATE contracts SET activated_at=NOW(), activated_by=?
       WHERE id=? AND activated_at IS NULL`,
      [CM, contractId[c.no]],
    );
  }

  console.log(`   ${contractSeeds.length} contracts upserted.`);

  // ── 5. WAREHOUSES + CONSUMABLES + STOCK + GRN ────────────────────────────
  console.log('[5/10] Seeding warehouses, consumables, stock & GRN…');

  interface WHSeed { code: string; name: string; type: string; city: string; }
  const whSeeds: WHSeed[] = [
    { code: 'WH-CENTRAL', name: 'Central Warehouse', type: 'CENTRAL', city: 'Nairobi' },
    { code: 'WH-WEST',    name: 'Western Depot',      type: 'DEPOT',   city: 'Kisumu'  },
    { code: 'WH-COAST',   name: 'Coast Depot',        type: 'DEPOT',   city: 'Mombasa' },
  ];
  const whId: Record<string, number> = {};
  for (const w of whSeeds) {
    await q(
      `INSERT INTO warehouses (code,name,type,city,created_by) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), type=VALUES(type)`,
      [w.code, w.name, w.type, w.city, WM],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM warehouses WHERE code=?`, [w.code],
    );
    whId[w.code] = r[0].id;
  }
  const WH_C = whId['WH-CENTRAL'];
  const WH_W = whId['WH-WEST'];

  interface ConsSeed { sku: string; name: string; cat: string; unit: string; reorder: number; }
  const consSeeds: ConsSeed[] = [
    { sku: 'TNR-BK-001', name: 'Black Toner Cartridge',   cat: 'TONER',      unit: 'cartridge', reorder: 20 },
    { sku: 'TNR-CY-001', name: 'Cyan Toner Cartridge',    cat: 'TONER',      unit: 'cartridge', reorder: 10 },
    { sku: 'TNR-MA-001', name: 'Magenta Toner Cartridge', cat: 'TONER',      unit: 'cartridge', reorder: 10 },
    { sku: 'TNR-YE-001', name: 'Yellow Toner Cartridge',  cat: 'TONER',      unit: 'cartridge', reorder: 10 },
    { sku: 'SPR-FUS-001',name: 'Fuser Unit',              cat: 'SPARE_PART', unit: 'unit',      reorder: 5  },
    { sku: 'PPR-A4-001', name: 'A4 Copy Paper (500s)',    cat: 'PAPER',      unit: 'ream',      reorder: 50 },
  ];
  const consId: Record<string, number> = {};
  for (const c of consSeeds) {
    await q(
      `INSERT INTO consumables (sku,name,category,unit,reorder_level,created_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), reorder_level=VALUES(reorder_level)`,
      [c.sku, c.name, c.cat, c.unit, c.reorder, WM],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM consumables WHERE sku=?`, [c.sku],
    );
    consId[c.sku] = r[0].id;
  }

  // Central above reorder; West below reorder (triggers low-stock scenarios)
  const stock: Array<[number, number, number]> = [
    [WH_C, consId['TNR-BK-001'], 45], [WH_C, consId['TNR-CY-001'], 25],
    [WH_C, consId['TNR-MA-001'], 22], [WH_C, consId['TNR-YE-001'], 20],
    [WH_C, consId['SPR-FUS-001'],  8],[WH_C, consId['PPR-A4-001'], 120],
    [WH_W, consId['TNR-BK-001'],  5], [WH_W, consId['TNR-CY-001'],  2],
    [WH_W, consId['SPR-FUS-001'],  1],[WH_W, consId['PPR-A4-001'],  15],
  ];
  for (const [w, c, qty] of stock) {
    await q(
      `INSERT INTO consumable_stock (warehouse_id,consumable_id,qty_on_hand)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE qty_on_hand=VALUES(qty_on_hand)`,
      [w, c, qty],
    );
  }

  await q(
    `INSERT INTO goods_receipt_notes
       (grn_no,warehouse_id,supplier_name,supplier_ref,received_at,received_by)
     VALUES ('GRN-2026-001',?,?,?,NOW(),?)
     ON DUPLICATE KEY UPDATE supplier_name=VALUES(supplier_name)`,
    [WH_C, 'Lexmark East Africa', 'PO-2026-001', WM],
  );
  const [grnRow] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM goods_receipt_notes WHERE grn_no='GRN-2026-001'`,
  );
  await q(
    `INSERT IGNORE INTO grn_consumable_lines (grn_id,consumable_id,quantity,unit_cost)
     VALUES (?,?,30,1200.00)`,
    [grnRow[0].id, consId['TNR-BK-001']],
  );

  console.log(`   ${whSeeds.length} warehouses, ${consSeeds.length} consumables, ${stock.length} stock rows.`);

  // ── 6. PRINTERS ───────────────────────────────────────────────────────────
  console.log('[6/10] Seeding printers…');

  const ACT_CTR  = contractId['CTR-ACTIVE-002'];
  const ACT_SITE = siteId[OMEGA_ID];
  const PIN_SITE = siteId[PINNACLE_ID];
  const SUM_SITE = siteId[SUMMIT_ID];

  interface PrinterSeed {
    serial: string; asset: string; brand: string; model: string; status: string;
    wh?: number; ctr?: number; site?: number;
  }
  const printerSeeds: PrinterSeed[] = [
    { serial: 'SN-IN-STOCK-001',    asset: 'AST-001', brand: 'Lexmark', model: 'MX622adhe',        status: 'IN_STOCK',     wh: WH_C                                                              },
    { serial: 'SN-IN-STOCK-002',    asset: 'AST-002', brand: 'HP',      model: 'LaserJet Pro 400', status: 'IN_STOCK',     wh: WH_C                                                              },
    { serial: 'SN-ALLOCATED-001',   asset: 'AST-003', brand: 'Lexmark', model: 'CX625adhe',        status: 'ALLOCATED',    wh: WH_C, ctr: ACT_CTR                                               },
    { serial: 'SN-INSTALLED-001',   asset: 'AST-004', brand: 'Lexmark', model: 'MX622adhe',        status: 'INSTALLED',              ctr: ACT_CTR,                       site: ACT_SITE         },
    { serial: 'SN-INSTALLED-002',   asset: 'AST-005', brand: 'HP',      model: 'Color LaserJet',   status: 'INSTALLED',              ctr: contractId['CTR-ACTIVE-003'], site: PIN_SITE          },
    { serial: 'SN-INSTALLED-003',   asset: 'AST-006', brand: 'Lexmark', model: 'MX622adhe',        status: 'INSTALLED',              ctr: contractId['CTR-ACTIVE-004'], site: SUM_SITE          },
    { serial: 'SN-UNDER-REPAIR-001',asset: 'AST-007', brand: 'Kyocera', model: 'ECOSYS M3145dn',   status: 'UNDER_REPAIR', wh: WH_C                                                              },
    { serial: 'SN-RETIRED-001',     asset: 'AST-008', brand: 'Brother', model: 'HL-L8360CDW',      status: 'RETIRED',      wh: WH_C                                                              },
  ];

  const printerId: Record<string, number> = {};
  for (const p of printerSeeds) {
    await q(
      `INSERT INTO printers
         (serial_no,asset_no,brand,model,status,warehouse_id,current_contract_id,
          current_site_id,print_technology,is_colour,created_by)
       VALUES (?,?,?,?,?,?,?,?,'LASER',0,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), warehouse_id=VALUES(warehouse_id),
         current_contract_id=VALUES(current_contract_id), current_site_id=VALUES(current_site_id)`,
      [p.serial, p.asset, p.brand, p.model, p.status,
       p.wh ?? null, p.ctr ?? null, p.site ?? null, ADMIN],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM printers WHERE serial_no=?`, [p.serial],
    );
    printerId[p.serial] = r[0].id;
  }

  // contract_printers rows for installed units
  for (const { serial, model, contractNo } of [
    { serial: 'SN-INSTALLED-001', model: 'MX622adhe',      contractNo: 'CTR-ACTIVE-002' },
    { serial: 'SN-INSTALLED-002', model: 'Color LaserJet', contractNo: 'CTR-ACTIVE-003' },
    { serial: 'SN-INSTALLED-003', model: 'MX622adhe',      contractNo: 'CTR-ACTIVE-004' },
  ]) {
    const [ex] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM contract_printers WHERE contract_id=? AND serial_no=? LIMIT 1`,
      [contractId[contractNo], serial],
    );
    if (!ex[0]) {
      await q(
        `INSERT INTO contract_printers (contract_id,printer_model,serial_no,quantity) VALUES (?,?,?,1)`,
        [contractId[contractNo], model, serial],
      );
    }
  }

  console.log(`   ${printerSeeds.length} printers upserted.`);

  // ── 7. DISPATCH ORDERS ────────────────────────────────────────────────────
  console.log('[7/10] Seeding dispatch orders…');

  interface DOSeed {
    no: string; ctr: number; site: number; status: string;
    planned: string; printer: number;
  }
  const doSeeds: DOSeed[] = [
    { no: 'DO-2026-001', ctr: ACT_CTR,                          site: ACT_SITE, status: 'PENDING',    planned: daysFromNow(5), printer: printerId['SN-ALLOCATED-001']   },
    { no: 'DO-2026-002', ctr: contractId['CTR-ACTIVE-003'],     site: PIN_SITE, status: 'SCHEDULED',  planned: daysFromNow(2), printer: printerId['SN-IN-STOCK-001']    },
    { no: 'DO-2026-003', ctr: contractId['CTR-ACTIVE-004'],     site: SUM_SITE, status: 'IN_TRANSIT', planned: daysAgo(1),     printer: printerId['SN-IN-STOCK-002']    },
    { no: 'DO-2026-004', ctr: contractId['CTR-ACTIVE-002'],     site: ACT_SITE, status: 'DELIVERED',  planned: daysAgo(30),    printer: printerId['SN-INSTALLED-001']   },
  ];

  for (const d of doSeeds) {
    await q(
      `INSERT INTO dispatch_orders
         (order_no,contract_id,site_id,status,planned_date,courier,notes,created_by)
       VALUES (?,?,?,?,?,'Seed Courier','Seeded order',?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), planned_date=VALUES(planned_date)`,
      [d.no, d.ctr, d.site, d.status, d.planned, DC],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM dispatch_orders WHERE order_no=?`, [d.no],
    );
    const doId: number = r[0].id;
    await q(
      `INSERT IGNORE INTO dispatch_order_items (dispatch_order_id,printer_id) VALUES (?,?)`,
      [doId, d.printer],
    );
    if (d.status === 'IN_TRANSIT') {
      await q(`UPDATE dispatch_orders SET departed_at=NOW() WHERE id=? AND departed_at IS NULL`, [doId]);
    }
    if (d.status === 'DELIVERED') {
      await q(
        `UPDATE dispatch_orders
         SET departed_at=?, delivered_at=?, pod_recipient='Reception'
         WHERE id=? AND delivered_at IS NULL`,
        [daysAgo(30) + ' 08:00:00', daysAgo(30) + ' 14:00:00', doId],
      );
    }
  }

  console.log(`   ${doSeeds.length} dispatch orders upserted.`);

  // ── 8. HELPDESK ───────────────────────────────────────────────────────────
  console.log('[8/10] Seeding helpdesk…');

  const catNames = [
    'Paper Jam', 'Poor Print Quality', 'Network Connectivity',
    'Toner Empty', 'Hardware Failure', 'Meter Reading',
  ];
  const catId: Record<string, number> = {};
  for (const name of catNames) {
    await q(
      `INSERT INTO helpdesk_issue_categories (name) VALUES (?)
       ON DUPLICATE KEY UPDATE name=VALUES(name)`,
      [name],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM helpdesk_issue_categories WHERE name=?`, [name],
    );
    catId[name] = r[0].id;
  }

  let seq = 1;
  const tno = () => `TKT-2026-${String(seq++).padStart(4, '0')}`;

  interface TktSeed {
    status: string; cust: number; site?: number; ctr?: number;
    printer?: number; assignedTo?: number; sla: string; priority: string;
    cat: string; desc: string; dueHrs?: number;
  }
  const P1 = printerId['SN-INSTALLED-001'];
  const P2 = printerId['SN-INSTALLED-002'];
  const P3 = printerId['SN-INSTALLED-003'];

  const tktSeeds: TktSeed[] = [
    { status: 'OPEN',        cust: OMEGA_ID,    site: ACT_SITE, ctr: contractId['CTR-ACTIVE-002'], printer: P1, sla: 'SILVER',   priority: 'MEDIUM',   cat: 'Paper Jam',           desc: 'Frequent paper jams in tray 2.',      dueHrs: 8    },
    { status: 'ASSIGNED',    cust: PINNACLE_ID, site: PIN_SITE, ctr: contractId['CTR-ACTIVE-003'], printer: P2, sla: 'GOLD',     priority: 'HIGH',     cat: 'Poor Print Quality',  desc: 'Faded output on colour prints.',      dueHrs: 4,   assignedTo: TECH  },
    { status: 'IN_PROGRESS', cust: SUMMIT_ID,   site: SUM_SITE, ctr: contractId['CTR-ACTIVE-004'], printer: P3, sla: 'PLATINUM', priority: 'CRITICAL', cat: 'Hardware Failure',     desc: 'Printer not powering on.',            dueHrs: 2,   assignedTo: STECH },
    { status: 'RESOLVED',    cust: OMEGA_ID,    site: ACT_SITE, ctr: contractId['CTR-ACTIVE-002'], printer: P1, sla: 'SILVER',   priority: 'LOW',      cat: 'Network Connectivity', desc: 'Could not connect to print server.',  dueHrs: 0    },
    { status: 'CLOSED',      cust: PINNACLE_ID, site: PIN_SITE, ctr: contractId['CTR-ACTIVE-003'], printer: P2, sla: 'GOLD',     priority: 'MEDIUM',   cat: 'Toner Empty',          desc: 'Black toner replaced.',               dueHrs: 0    },
    // Near-breach (T-minus 30 min)
    { status: 'ASSIGNED',    cust: SUMMIT_ID,   site: SUM_SITE, ctr: contractId['CTR-ACTIVE-004'], printer: P3, sla: 'PLATINUM', priority: 'HIGH',     cat: 'Poor Print Quality',  desc: 'Lines across page — SLA nearly due.', dueHrs: 0.5, assignedTo: STECH },
    // Already breached (2 h ago)
    { status: 'IN_PROGRESS', cust: OMEGA_ID,    site: ACT_SITE, ctr: contractId['CTR-ACTIVE-002'], printer: P1, sla: 'BRONZE',   priority: 'HIGH',     cat: 'Hardware Failure',     desc: 'Fuser failure — SLA breached.',       dueHrs: -2   },
    { status: 'OPEN',        cust: SUMMIT_ID,   site: SUM_SITE, ctr: contractId['CTR-ACTIVE-004'], printer: P3, sla: 'PLATINUM', priority: 'LOW',      cat: 'Meter Reading',        desc: 'Monthly meter reading due.',          dueHrs: 24   },
  ];

  for (const t of tktSeeds) {
    const ticketNo = tno();
    const slaDue   = t.dueHrs != null ? addHours(t.dueHrs) : null;
    await q(
      `INSERT INTO service_tickets
         (ticket_no,visit_type,priority,status,customer_id,site_id,contract_id,
          printer_id,assigned_to,description,source,sla_tier,issue_category_id,
          sla_due_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status)`,
      [ticketNo, 'CORRECTIVE', t.priority, t.status,
       t.cust, t.site ?? null, t.ctr ?? null, t.printer ?? null,
       t.assignedTo ?? null, t.desc, 'PORTAL', t.sla,
       catId[t.cat], slaDue, ADMIN],
    );
    const [r] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM service_tickets WHERE ticket_no=?`, [ticketNo],
    );
    const tid: number = r[0].id;

    if (['RESOLVED', 'CLOSED'].includes(t.status)) {
      await q(
        `UPDATE service_tickets
         SET resolved_at=?, sla_met=1, resolution_notes='Seed resolution'
         WHERE id=? AND resolved_at IS NULL`,
        [daysAgo(1) + ' 10:00:00', tid],
      );
    }
    if (t.status === 'CLOSED') {
      await q(
        `UPDATE service_tickets
         SET closed_at=?, close_method='SIGNATURE', signature_name='John Smith'
         WHERE id=? AND closed_at IS NULL`,
        [daysAgo(1) + ' 11:00:00', tid],
      );
    }
    if (t.dueHrs != null && t.dueHrs >= 0 && t.dueHrs <= 1 && !['RESOLVED', 'CLOSED'].includes(t.status)) {
      await q(
        `INSERT IGNORE INTO service_sla_alerts (ticket_id,alert_type) VALUES (?,'T_MINUS_1H')`,
        [tid],
      );
    }
    if (t.dueHrs != null && t.dueHrs < 0 && !['RESOLVED', 'CLOSED'].includes(t.status)) {
      await q(
        `INSERT IGNORE INTO service_sla_alerts (ticket_id,alert_type) VALUES (?,'BREACH')`,
        [tid],
      );
    }
  }

  console.log(`   ${tktSeeds.length} tickets, ${catNames.length} categories.`);

  // ── 9. TONER LEVELS + ALERTS + SHIPMENT ───────────────────────────────────
  console.log('[9/10] Seeding toner levels, shipments & alerts…');

  const YIELD = 8000;
  for (const { serial, pct, rate } of [
    { serial: 'SN-INSTALLED-001',    pct: 75, rate: 80  }, // OK
    { serial: 'SN-INSTALLED-002',    pct: 30, rate: 100 }, // Warning
    { serial: 'SN-INSTALLED-003',    pct: 20, rate: 120 }, // Alert (LOW_20)
    { serial: 'SN-UNDER-REPAIR-001', pct: 10, rate: 50  }, // Critical (CRITICAL_10)
  ]) {
    const pid = printerId[serial];
    if (!pid) continue;
    const est = rate > 0 ? Math.round((pct / 100) * YIELD / rate) : null;
    await q(
      `INSERT INTO printer_toner_levels
         (printer_id,toner_pct,daily_page_rate,estimated_days_remaining,updated_by)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE toner_pct=VALUES(toner_pct),
         daily_page_rate=VALUES(daily_page_rate),
         estimated_days_remaining=VALUES(estimated_days_remaining)`,
      [pid, pct, rate, est, TONER],
    );
  }

  const ALERT_P = printerId['SN-INSTALLED-003'];
  const CRIT_P  = printerId['SN-UNDER-REPAIR-001'];

  for (const [pid, type, status, pct] of [
    [ALERT_P, 'LOW_20',     'NEW',      20],
    [CRIT_P,  'LOW_20',     'NOTIFIED', 10],
    [CRIT_P,  'CRITICAL_10','NEW',      10],
  ] as Array<[number, string, string, number]>) {
    await q(
      `INSERT INTO toner_alerts (printer_id,alert_type,status,toner_pct)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), toner_pct=VALUES(toner_pct)`,
      [pid, type, status, pct],
    );
  }

  // One active (PENDING) shipment for the warning printer
  const WARN_P = printerId['SN-INSTALLED-002'];
  const [existShip] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT id FROM toner_shipments
     WHERE printer_id=? AND status IN ('PENDING','IN_TRANSIT') LIMIT 1`,
    [WARN_P],
  );
  if (!existShip[0]) {
    await q(
      `INSERT INTO toner_shipments
         (printer_id,consumable_id,status,tracking_ref,notes,created_by)
       VALUES (?,?,'PENDING','TRK-2026-001','Seed shipment for warning printer',?)`,
      [WARN_P, consId['TNR-BK-001'], TONER],
    );
  }

  console.log('   Toner levels, alerts, and shipment seeded.');

  // ── 10. Done ──────────────────────────────────────────────────────────────
  await db.end();

  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log('\n' + '='.repeat(70));
  console.log('SEED COMPLETE');
  console.log('='.repeat(70));
  console.log('\nLogin credentials\n');
  console.log(col('Role', 27) + col('Email', 35) + 'Password');
  console.log('-'.repeat(70));
  for (const { role, email, pw } of [
    { role: 'System Admin (original)', email: 'admin@websol.local',           pw: 'ChangeMe!123' },
    { role: 'CEO',                     email: 'ceo@websol.local',             pw: 'Test@1234'    },
    { role: 'Sales Manager',           email: 'sales.manager@websol.local',   pw: 'Test@1234'    },
    { role: 'Sales Rep',               email: 'sales.rep@websol.local',       pw: 'Test@1234'    },
    { role: 'Contracts Manager',       email: 'contracts.mgr@websol.local',   pw: 'Test@1234'    },
    { role: 'Warehouse Manager',       email: 'warehouse.mgr@websol.local',   pw: 'Test@1234'    },
    { role: 'Warehouse Staff',         email: 'warehouse.staff@websol.local', pw: 'Test@1234'    },
    { role: 'Dispatch Coordinator',    email: 'dispatch@websol.local',        pw: 'Test@1234'    },
    { role: 'Field Technician',        email: 'technician@websol.local',      pw: 'Test@1234'    },
    { role: 'CSR',                     email: 'csr@websol.local',             pw: 'Test@1234'    },
    { role: 'CSR Supervisor',          email: 'csr.super@websol.local',       pw: 'Test@1234'    },
    { role: 'Billing Executive',       email: 'billing@websol.local',         pw: 'Test@1234'    },
    { role: 'Finance Manager',         email: 'finance.mgr@websol.local',     pw: 'Test@1234'    },
    { role: 'Sys Admin (seeded)',       email: 'sysadmin@websol.local',        pw: 'Test@1234'    },
    { role: 'Toner Coordinator',       email: 'toner@websol.local',           pw: 'Test@1234'    },
    { role: 'Senior Technician',       email: 'senior.tech@websol.local',     pw: 'Test@1234'    },
    { role: 'Operations Manager',      email: 'ops.mgr@websol.local',         pw: 'Test@1234'    },
  ]) {
    console.log(col(role, 27) + col(email, 35) + pw);
  }
  console.log(`
Summary:
  Users        17  (original admin + 16 role accounts)
  Leads         6  (NEW / CONTACTED / PROPOSAL_SENT / WON×2 / LOST)
  Customers     5  (ACTIVE×4, INACTIVE×1)
  Contracts     5  (DRAFT / ACTIVE×3 / EXPIRED; all 4 SLA tiers)
  Warehouses    3  (central above reorder, west depot below)
  Consumables   6  + 10 stock rows + 1 GRN
  Printers      8  (IN_STOCK / ALLOCATED / INSTALLED×3 / UNDER_REPAIR / RETIRED)
  Dispatch      4  (PENDING / SCHEDULED / IN_TRANSIT / DELIVERED)
  Tickets       8  (all statuses; near-breach + breached examples)
  Toner levels  4  (OK / Warning / Alert / Critical + 1 active shipment)
`);
}

main().catch((err: unknown) => {
  console.error('\nSeed failed:', err);
  throw err;
});
