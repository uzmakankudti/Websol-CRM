# Websol CRM

A printer leasing / **Managed Print Services (MPS)** system.

**Stack:** MySQL · Node.js + TypeScript (Azure Functions, serverless) · React +
TypeScript (Azure Static Web Apps) · Flutter (mobile) — all on Microsoft Azure.

## Modules

- **User & Access Management** — secure login, role-based permissions, user
  administration and an audit log. See
  [docs/access-management.md](docs/access-management.md).

## Repository layout

```
Websol-CRM/
├── backend/    Azure Functions (Node + TypeScript) — the serverless API
├── web/        React + TypeScript (Vite) — Azure Static Web App frontend
├── mobile/     Flutter app (generated via the Flutter CLI — see mobile/README.md)
├── database/   MySQL schema migrations
├── .env.example        Template for shared environment variables
└── .prettierrc.json    Shared formatting rules (Prettier)
```

## Prerequisites

| Tool                              | Why                              | Install |
| --------------------------------- | -------------------------------- | ------- |
| Node.js 20+ and npm               | backend + web                    | https://nodejs.org (or `brew install node`) |
| Azure Functions Core Tools v4     | run the backend locally (`func`) | `npm i -g azure-functions-core-tools@4 --unsafe-perm true` (or `brew tap azure/functions && brew install azure-functions-core-tools@4`) |
| MySQL 8                           | database                         | `brew install mysql` then `brew services start mysql` |
| Flutter SDK                       | mobile                           | https://docs.flutter.dev/get-started/install |

> This machine currently has Homebrew but **not** Node — install it first:
> `brew install node`, then re-open your terminal and check `node -v`.

## 1. Configure environment variables

All secrets live in **one** template, `.env.example`. Nothing real is committed
(`.gitignore` blocks `.env` and `local.settings.json`).

```bash
# repo root: a copy for local tooling
cp .env.example .env

# backend: Azure Functions reads its own settings file
cp backend/local.settings.json.example backend/local.settings.json
```

Then edit both with your real DB password and a strong `APP_SECRET`.

## 2. Set up the database

```bash
# create DB + user (see database/README.md for the exact SQL)
mysql -u root -p < /dev/stdin <<'SQL'
CREATE DATABASE IF NOT EXISTS websol_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'websol'@'%' IDENTIFIED BY 'change_me';
GRANT ALL PRIVILEGES ON websol_crm.* TO 'websol'@'%';
FLUSH PRIVILEGES;
SQL

# apply migrations
for f in database/migrations/*.sql; do mysql -u websol -p websol_crm < "$f"; done
```

More detail: [database/README.md](database/README.md).

## 3. Run the backend (Azure Functions)

```bash
cd backend
npm install
npm start          # builds TypeScript, then starts the Functions host on :7071
```

Test the health check:

```bash
curl http://localhost:7071/api/health
# {"status":"OK","database":"up","timestamp":"..."}

# check the function without hitting MySQL:
curl "http://localhost:7071/api/health?db=false"
```

## 4. Run the web app (React)

In a second terminal:

```bash
cd web
npm install
npm run dev        # Vite dev server on http://localhost:5173
```

The dev server proxies `/api/*` to the Functions host on `:7071`, so the page
shows the live backend health status.

## 5. Run the mobile app (Flutter)

See [mobile/README.md](mobile/README.md) — generate the project with
`flutter create` then `flutter run`.

## Code quality: ESLint + Prettier

- **Prettier** (shared, repo root) formats all TS/JS/JSON/CSS:

  ```bash
  npm install            # installs Prettier at the root
  npm run format         # auto-format
  npm run format:check   # CI-friendly check
  ```

- **ESLint** runs per package (different rules for Node vs. browser):

  ```bash
  npm run lint:backend
  npm run lint:web
  # or inside a package: npm run lint  /  npm run lint:fix
  ```

## How the MySQL pool works (and why it matters on serverless)

Serverless functions scale to many short-lived invocations. Opening a new DB
connection per request quickly exhausts MySQL's `max_connections`. Instead:

- [backend/src/shared/db.ts](backend/src/shared/db.ts) creates **one** pool at
  module scope and reuses it across all warm invocations on an instance.
- `DB_CONNECTION_LIMIT` is kept **small** (default `5`) because total
  connections = (warm instances) × (pool size).
- All env reads are centralised in
  [backend/src/shared/config.ts](backend/src/shared/config.ts) — the rest of the
  code never touches `process.env`.
