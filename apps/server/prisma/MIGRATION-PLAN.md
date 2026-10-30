# Production Migration Plan

No migration command has been run for this plan. The live database URL, migration table, schema drift, database version, backups, and privileges have not been inspected. Repository files alone cannot identify which migrations are pending on a particular database.

## Ordered migration inventory

1. `20261018124500_initial`: creates the initial PostgreSQL schema, business and user membership tables, inventory, invoices, purchases, audit, and supporting indexes/constraints. Intended for a new empty database.
2. `20261018131500_purchase_idempotency`: adds purchase idempotency, purchase dates and purchase counters; backfills legacy purchase keys; adds purchase-line discounts.
3. `20261018133500_idempotency_request_hashes`: backfills legacy request hashes and adds idempotency metadata/unique indexes for invoices, purchases, sales returns, and purchase returns.
4. `20261018134500_controlled_returns_and_cancellations`: adds controlled invoice cancellation and refund fields; adds `PurchaseReturn.businessId`, backfills it from the related purchase, makes it required, and adds business-scoped constraints. Check for orphaned purchase returns before deployment.
5. `20261018135500_paired_devices`: creates pairing invitations, paired devices, status enum, indexes, and foreign keys.
6. `20261027120000_optional_catalog_commercial_values`: permits unknown Product GST and price values, adds product specifications/pack/source metadata, and permits nullable price-history endpoints. Existing values are not rewritten.
7. `20261027123000_professional_invoice_fields`: adds customer state code, invoice-line HSN and default-zero discount snapshots, and optional per-business invoice print settings. Existing invoice totals and line values are not recalculated.

Prisma applies migrations in this order based on the directory names. Do not select or apply individual migrations out of order.

## Required deployment checks

1. Obtain explicit owner approval, maintenance window, target database name, PostgreSQL version, and migration operator. Keep connection strings and credentials in the operator's private environment; do not paste them into logs or tickets.
2. Independently confirm the target is the intended production database and that the operator role is not pointed at a test or unrelated database. Confirm sufficient disk space and PostgreSQL backup/restore access.
3. Take a timestamped custom-format `pg_dump` backup. Verify its SHA-256 and `pg_restore --list` output. Restore it to a separate disposable database and verify application-critical business, invoice, purchase, return, and inventory records before proceeding.
4. Review the migration SQL in order. Specifically verify the legacy backfills in migrations 2-4, that every purchase return joins to a purchase for migration 4, and that defaults/nullable changes in migrations 6-7 match the intended application version.
5. With approval, load the `billing_migrator` URL from the administrator-only migration environment file into the invoking process without echoing it, then run `npm run db:deploy --workspace @billing/server` against the explicitly verified target. The regular server `.env` uses the restricted `billing_app` role and must not be used for DDL. Do not use `db:migrate` in production. Capture the migration tool's sanitized result and confirm each expected migration is recorded in `_prisma_migrations`.
6. Run read-only readiness checks and an approved smoke test. Do not run catalog import until business owners approve the product rows and seed scope.

The Windows backup/restore scripts are safety tooling only. Their sandbox plan tests do not establish that a real database backup or restore succeeded. Restore always requires an explicit typed confirmation, a verified archive/checksum, a local target, and a database name that does not already exist. A failed restore preserves the partial new database for operator review; the script never drops it.
