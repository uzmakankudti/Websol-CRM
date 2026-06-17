# Database

SQL migrations for Websol CRM (MySQL 8).

## Conventions

- One file per migration, named `NNN_description.sql` (e.g. `001_init.sql`).
- Files are applied in ascending numeric order.
- Each migration records itself in the `schema_migrations` table so it is only
  applied once.

## Create the database and a user (one-time, local)

```sql
CREATE DATABASE IF NOT EXISTS websol_crm
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'websol'@'%' IDENTIFIED BY 'change_me';
GRANT ALL PRIVILEGES ON websol_crm.* TO 'websol'@'%';
FLUSH PRIVILEGES;
```

## Apply migrations (local)

Run each file in order against the database:

```bash
mysql -u websol -p websol_crm < database/migrations/001_init.sql
```

To apply every migration in order:

```bash
for f in database/migrations/*.sql; do
  echo "Applying $f";
  mysql -u websol -p websol_crm < "$f";
done
```

> In a later iteration you can swap this for a migration tool
> (e.g. `node-migrate`, `dbmate`, or Flyway). The `schema_migrations` table is
> already compatible with that approach.
