# Websol CRM

A CRM for printer leasing / Managed Print Services (MPS). Tracks users, leads,
opportunities, customers, contracts, and (next) leased printer assets.

## Tech stack

- **Database:** MySQL
- **Backend:** Azure Functions — Node + TypeScript (serverless)
- **Web:** React + TypeScript
- **Mobile:** Flutter
- **Hosting:** Azure

Layout: `backend/` (Functions app), `web/` (React), `mobile/` (Flutter),
`database/migrations/` (SQL), `docs/` (per-module specs).

## Conventions (already established — follow them)

- **RBAC:** permission-based, in `backend/src/shared/rbac.ts`. Gate endpoints on
  permissions, not roles.
- **Audit logging:** `backend/src/shared/audit.ts` — log state-changing actions.
- **Auth:** scrypt password hashing + JWT, in `backend/src/shared/auth.ts`.
- **Migrations:** numbered SQL in `database/migrations/` (e.g. `004_*.sql`).
- **Tests:** Vitest, in `backend/test/`.
- **FK rule:** every foreign-key column referencing `users.id` must be
  `BIGINT UNSIGNED`.

Other shared modules: `db.ts`, `http.ts`, `config.ts`, `users-repo.ts`.

## Modules

- ✅ 0 — Project Setup
- ✅ 1 — User & Access Management
- ✅ 2 — Lead & Opportunity Management
- ✅ 3 — Customer & Contract Management
- ✅ 4 — Asset / Printer Management
- ✅ 5 — Inventory / Warehouse Management
- ✅ 6 — Dispatch & Delivery Management
- ✅ 7 — Field Service Management (+ Flutter technician app)

## Build rhythm

build → write tests → `npm run check` → smoke test → commit

`npm run check` runs lint + tests. See `docs/` for per-module details.
