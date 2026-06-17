# Customer & Contract Management

Company profiles (sites, contacts, billing) and the lease contracts that link a
customer to one or more printers — with duration, monthly lease fee, per-click
rates, an SLA tier, a signed-document workflow, and a full status lifecycle.

## Contents

- [Roles & permissions](#roles--permissions)
- [Business rules](#business-rules)
- [Database](#database)
- [Backend API](#backend-api)
- [Frontend](#frontend)
- [Pricing & money handling](#pricing--money-handling)

## Roles & permissions

Authorization is **permission-based** (see
[access-management.md](access-management.md)). This module adds:

| Permission             | Granted to                                       |
| ---------------------- | ------------------------------------------------ |
| `customers.read`       | Sales Manager, Sales Rep, CEO, System Admin      |
| `customers.create`     | Sales Manager, Sales Rep, System Admin           |
| `customers.update`     | Sales Manager, Sales Rep, System Admin           |
| `contracts.read`       | Sales Manager, Sales Rep, CEO, System Admin      |
| `contracts.create`     | Sales Manager, Sales Rep, System Admin           |
| `contracts.update`     | Sales Manager, Sales Rep, System Admin           |
| `contracts.activate`   | Sales Manager, System Admin                      |
| `contracts.terminate`  | Sales Manager, System Admin                      |

Sales Reps can build customers and draft contracts but **cannot activate or
terminate** — those lifecycle moves are reserved for Sales Managers.

## Business rules

| Rule       | Enforcement                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------- |
| **BR-007** | A contract cannot be **activated** without at least one signed document attached.                   |
| **BR-008** | A contract's **end date must be ≥ 1 month after** its start date (month-length overflow handled).   |
| **BR-009** | **Monthly lease fee > 0**; per-click rates (B/W and colour) **≥ 0**.                                 |
| **BR-010** | A contract **cannot be deleted once activated** — only DRAFT contracts are deletable; otherwise terminate. |

Every rule is enforced **server-side** in the handlers, and the database adds
defence-in-depth `CHECK` constraints for BR-009 and basic date ordering. The UI
mirrors each rule for fast, specific feedback but is never the source of truth.

### Contract status lifecycle

```
DRAFT ──activate (BR-007)──▶ ACTIVE ──end_date passes──▶ EXPIRED
  │                             │                            │
  └── delete (DRAFT only)       └────── terminate ───────────┘
                                          (BR-010)         ▼
                                                       TERMINATED
```

- **DRAFT** — editable, deletable; terms not yet binding.
- **ACTIVE** — live lease; can no longer be deleted or edited, only terminated.
- **EXPIRED** — set automatically on read once `end_date` is in the past.
- **TERMINATED** — closed early with a recorded reason; preserved for history.

Contracts within **90 days** of their end date are surfaced as *expiring soon*
both on the Contracts dashboard banner and via a dedicated endpoint.

## Database

Migration [`004_customers_contracts.sql`](../database/migrations/004_customers_contracts.sql):

- **`customers`** — extends the bootstrap table (001) with company profile
  (`registration_no`, `vat_no`, `industry`, `website`), billing fields
  (`billing_address/email/phone`), `status`, `notes`, `created_by`. New columns
  are nullable so lead→customer conversion (Module 2) keeps working unchanged.
- **`customer_sites`** — physical locations where printers are placed.
- **`customer_contacts`** — people at the customer (one optional primary each).
- **`contracts`** — lease terms: `start_date`, `end_date`,
  `monthly_lease_fee DECIMAL(10,2)`, `per_click_bw/colour DECIMAL(8,5)`,
  `sla_tier ENUM(PLATINUM|GOLD|SILVER|BRONZE)`,
  `status ENUM(DRAFT|ACTIVE|EXPIRED|TERMINATED)`, plus activation/termination
  audit columns and a unique `contract_no` (e.g. `CT-2026-00001`).
- **`contract_printers`** — the one-or-more printers a contract covers.
- **`contract_documents`** — signed documents (base64 `content`); existence of a
  row is what BR-007 checks. In production, swap `content` for a blob-store URL.

## Backend API

Customers — [`backend/src/functions/customers.ts`](../backend/src/functions/customers.ts):

| Method & route                                  | Permission         | Purpose                          |
| ----------------------------------------------- | ------------------ | -------------------------------- |
| `GET /api/customers`                            | `customers.read`   | List (filter `q`, `status`)      |
| `GET /api/customers/{id}`                       | `customers.read`   | Profile + sites + contacts + contracts |
| `POST /api/customers`                           | `customers.create` | Create profile                   |
| `PATCH /api/customers/{id}`                     | `customers.update` | Edit profile                     |
| `POST/PATCH/DELETE /api/customers/{id}/sites/…` | `customers.update` | Manage sites                     |
| `POST/PATCH/DELETE /api/customers/{id}/contacts/…` | `customers.update` | Manage contacts               |

Contracts — [`backend/src/functions/contracts.ts`](../backend/src/functions/contracts.ts):

| Method & route                                   | Permission            | Purpose                       |
| ------------------------------------------------ | --------------------- | ----------------------------- |
| `GET /api/contracts`                             | `contracts.read`      | List (filter `status`, `customerId`, `expiring`, `q`) |
| `GET /api/contracts/expiring?days=90`            | `contracts.read`      | Contracts expiring in a window |
| `GET /api/contracts/{id}`                        | `contracts.read`      | Terms + printers + documents  |
| `POST /api/customers/{id}/contracts`             | `contracts.create`    | Create DRAFT (BR-008/009)     |
| `PATCH /api/contracts/{id}`                      | `contracts.update`    | Edit DRAFT only               |
| `DELETE /api/contracts/{id}`                     | `contracts.update`    | Delete DRAFT only (BR-010)    |
| `POST /api/contracts/{id}/documents`             | `contracts.update`    | Attach signed document        |
| `GET /api/contracts/{id}/documents/{docId}`      | `contracts.read`      | Download a document           |
| `POST /api/contracts/{id}/activate`              | `contracts.activate`  | DRAFT → ACTIVE (BR-007)       |
| `POST /api/contracts/{id}/terminate`             | `contracts.terminate` | → TERMINATED (reason required) |

All state changes are written to the immutable `audit_log` (create, update,
activate, terminate, upload, delete) with the acting user and a before/after
diff.

## Frontend

- **Customers** screen
  ([`web/src/pages/CustomersPage.tsx`](../web/src/pages/CustomersPage.tsx)) —
  searchable list and a drill-down profile with sites, contacts and the
  customer's contracts; create/edit modals throughout.
- **Contracts** screen
  ([`web/src/pages/ContractsPage.tsx`](../web/src/pages/ContractsPage.tsx)) —
  portfolio view across all customers with status filters and an **expiring
  ≤ 90 days** banner and quick filter.
- **Contract detail**
  ([`web/src/pages/ContractDetailView.tsx`](../web/src/pages/ContractDetailView.tsx))
  — terms, printers, documents, and every lifecycle action gated by permission
  **and** status, with the signed-document upload/download flow.

Nav items appear only for users holding `customers.read` / `contracts.read`.

## Pricing & money handling

Money is handled carefully end-to-end:

- Stored as **`DECIMAL`**, never `FLOAT` — `DECIMAL(10,2)` for the monthly fee
  and `DECIMAL(8,5)` for per-click rates (sub-cent click pricing is common in
  MPS).
- The API validates types strictly (no string coercion), enforces
  **fee > 0 / rates ≥ 0**, and passes numbers straight through to parameterised
  queries — no arithmetic that could introduce float error.
- The database backs this with `CHECK` constraints, so a bad price cannot be
  persisted even if a caller bypassed the API.
- The UI formats money as ZAR currency and rates to 5 decimal places, and
  mirrors the same validation before submit.
