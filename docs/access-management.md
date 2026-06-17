# User & Access Management

Secure authentication, role-based authorization, user administration and an
immutable audit log for Websol CRM.

## Contents

- [Roles & permissions](#roles--permissions)
- [Business rules](#business-rules)
- [Database](#database)
- [Backend API](#backend-api)
- [Frontend](#frontend)
- [Running it locally](#running-it-locally)
- [Security notes](#security-notes)

## Roles & permissions

Fourteen business roles ship seeded in the database:

CEO · Sales Manager · Sales Rep · Contracts Manager · Warehouse Manager ·
Warehouse Staff · Dispatch Coordinator · Field Technician · CSR · CSR
Supervisor · Billing Executive · Finance Manager · System Administrator · Toner
Coordinator.

Authorization is **permission-based, not role-based**: roles are granted
permission codes (`module.action`) via the `role_permissions` table, and both
the API and the UI check permissions — never hardcoded role names. This keeps
"each role sees only what it should" entirely data-driven, and adding a module
later just means seeding new permissions.

Permissions in this module:

| Permission             | Granted to                  |
| ---------------------- | --------------------------- |
| `users.read`           | System Administrator, CEO   |
| `users.create`         | System Administrator        |
| `users.update`         | System Administrator        |
| `users.deactivate`     | System Administrator        |
| `users.reset_password` | System Administrator        |
| `roles.read`           | System Administrator, CEO   |
| `audit.read`           | System Administrator, CEO   |

All other roles receive no access-management permissions (they get their own
module permissions in later migrations).

## Business rules

- **BR-018 — Users are deactivated, never deleted.** There is no DELETE path
  anywhere. Deactivation toggles `users.is_active` and stamps
  `deactivated_at` / `deactivated_by`; the row is retained forever so audit
  history and foreign keys stay intact. Deactivated users cannot sign in and
  can be reactivated.
- **BR-019 — Only a System Administrator may create or deactivate users.**
  Enforced via the `users.create` / `users.deactivate` permissions, which only
  the System Administrator role holds. The API checks the permission on every
  write; the UI hides the controls when the caller lacks it.

## Database

Migration [`database/migrations/002_access_management.sql`](../database/migrations/002_access_management.sql)
adds:

- `roles` — the 14 roles (seeded).
- `permissions` — capability codes (seeded).
- `role_permissions` — role → permission grants (seeded).
- `users` — never deleted; soft `is_active` state, login throttling fields,
  `must_change_password`, and a self-describing scrypt `password_hash`.
- `password_reset_tokens` — stores only the SHA-256 hash of each reset token.
- `audit_log` — append-only record: actor, entity, action, reason, JSON
  before/after diff, IP and timestamp.

It also seeds a **bootstrap System Administrator** so the system can be logged
into:

- Email: `admin@websol.local`
- Password: `ChangeMe!123` — `must_change_password` is set, so the first login
  forces a password change.

## Backend API

Azure Functions (Node + TypeScript). All routes are under `/api`. Tokens are
JWTs (HS256) signed with `APP_SECRET`; send them as `Authorization: Bearer
<token>`.

### Auth (anonymous)

| Method | Route                       | Body                          | Notes |
| ------ | --------------------------- | ----------------------------- | ----- |
| POST   | `/auth/login`               | `{ email, password }`         | Returns `{ token, user }`. Locks the account for 15 min after 5 failed attempts. |
| POST   | `/auth/logout`              | —                             | Stateless; records the event for audit. |
| GET    | `/auth/me`                  | —                             | Current user + fresh permissions. |
| POST   | `/auth/change-password`     | `{ currentPassword, newPassword }` | Self-service; clears `must_change_password`. |
| POST   | `/auth/forgot-password`     | `{ email }`                   | Always 200 (no account enumeration). Returns `resetToken` in non-production. |
| POST   | `/auth/reset-password`      | `{ token, newPassword }`      | Consumes a one-time token. |

### Users & roles (require permissions)

| Method | Route                          | Permission             |
| ------ | ------------------------------ | ---------------------- |
| GET    | `/users?q=&roleId=&active=`    | `users.read`           |
| GET    | `/users/{id}`                  | `users.read`           |
| POST   | `/users`                       | `users.create`         |
| PATCH  | `/users/{id}`                  | `users.update`         |
| POST   | `/users/{id}/deactivate`       | `users.deactivate` (reason required) |
| POST   | `/users/{id}/reactivate`       | `users.deactivate`     |
| POST   | `/users/{id}/reset-password`   | `users.reset_password` |
| GET    | `/roles`                       | `roles.read`           |

`POST /users` and the admin reset return a one-time `temporaryPassword` for the
admin to relay; the new user must change it at first login.

### Audit (requires `audit.read`)

| Method | Route                                                       |
| ------ | ----------------------------------------------------------- |
| GET    | `/audit?entityType=&entityId=&actorUserId=&action=&limit=&offset=` |

The audit log is append-only — there is no write or delete route. Entries are
created by the operations being audited.

## Frontend

React + TypeScript (Vite). Key files under `web/src`:

- `api/client.ts` — fetch wrapper; stores the JWT, attaches the bearer header,
  and logs out on a 401.
- `auth/AuthContext.tsx` — session state and a `can(permission)` helper.
- `auth/Login.tsx` — sign-in plus forgot / reset password flows.
- `auth/ChangePassword.tsx` — forced (first login) and voluntary changes.
- `pages/UsersPage.tsx` — user list with filters; create / edit / deactivate /
  reactivate / reset-password modals, each gated by permission.
- `pages/AuditPage.tsx` — paginated, filterable audit viewer.
- `App.tsx` — shell; the sidebar only renders nav items the caller's
  permissions allow.

## Running it locally

```bash
# 1. Apply migrations (creates tables + seeds roles and the bootstrap admin)
mysql -u websol -p websol_crm < database/migrations/002_access_management.sql

# 2. Backend
cd backend && npm install && npm start      # http://localhost:7071

# 3. Frontend (second terminal)
cd web && npm install && npm run dev         # http://localhost:5173
```

Sign in with `admin@websol.local` / `ChangeMe!123`, set a new password when
prompted, then create users and assign roles.

## Security notes

- **Passwords**: scrypt with a per-password random salt; the cost parameter is
  stored with the hash (`scrypt$N$salt$hash`) so it can be raised over time.
  Verification is constant-time.
- **Tokens**: HS256 JWTs with an 8-hour expiry, signed with `APP_SECRET` (set a
  long random value in every environment). Verification is constant-time and
  checks expiry.
- **Reset tokens**: random 32-byte values; only their SHA-256 hash is stored,
  single-use, 30-minute expiry.
- **Account protection**: login throttling (lock after 5 failures), generic
  login errors (no account enumeration), and a forced password change after
  admin provisioning or reset.
- **Migrating to Azure AD B2C**: only token verification in
  `backend/src/shared/rbac.ts` (and token issuance at login) needs to change;
  the permission model and audit log are independent of the token source.
```
