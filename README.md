# Multi-Business Billing & Inventory

Windows desktop application with one authoritative PostgreSQL-backed server
and desktop clients. The database is never exposed to client machines; all
business operations are intended to pass through the API.

## Workspace layout

- `apps/server`: Express + TypeScript API, Prisma data model, and database
  bootstrap tooling.
- `apps/desktop`: React + TypeScript + Vite desktop UI, with Tauri 2 packaging
  configuration.
- PostgreSQL is the only authoritative store. Desktop state is not used as
  the source of truth for prices, stock, or invoices.

## Development setup

1. Install Node.js 20+ and PostgreSQL 16+.
2. Copy `.env.example` to `.env` and set a private `DATABASE_URL`. Do not
   commit `.env`.
3. Run `npm install`.
4. Run `npm run db:generate` and `npm run db:migrate`.
5. Create the initial administrator once with
   `npm run bootstrap:admin --workspace @billing/server`. The command prompts
   for the username and reads the password without echoing it; it does not
   store the password in `.env`.
6. Run `npm run dev`.

The bootstrap command refuses to create a second initial administrator and
does not contain a default password. Businesses are created by that one-time
bootstrap operation; the administrator is explicitly assigned to each seeded
business.

## Security and release notes

The initial vertical slice uses Argon2id password hashes, opaque
server-validated bearer sessions, business membership checks, input schemas,
rate-limited login, and API-side product authorization. Sessions are held in
desktop process memory and expire server-side. The API defaults to
`127.0.0.1`; binding it to any other interface requires both `TLS_CERT_PATH`
and `TLS_KEY_PATH`, and starts HTTPS. Use a current certificate whose SAN
matches the hostname/IP clients use and whose chain is trusted by Windows.
For wildcard interface binds, configure `TLS_SERVER_NAME` to that client-facing
hostname/IP. Pairing invitations are short-lived and one-use; the server stores
only their hashes. An authenticated business administrator creates an
invitation, a client requests pairing, and an administrator must approve it
from the server computer or an already approved device. Protected business
APIs require both the existing user session and an approved, non-revoked
business-scoped device credential. Device credentials are stored through the
Tauri Windows Credential Manager integration, not browser storage. Pairing
was not tested end-to-end over a LAN; do not treat this as a production
deployment acceptance. Do not expose the development API to an untrusted
network.

The desktop accepts plain HTTP only for loopback development. For LAN
connections it uses the WebView's normal TLS validation; the server certificate
must be valid for the chosen hostname/IP and chain to a CA trusted by Windows.
No certificate-validation bypass or self-signed-certificate exception is
implemented. A successful readiness check is required before the address is
saved locally; saved addresses are checked again on every application run.
Automatic discovery is not implemented; enter the server address manually.
The administrator must securely convey the short-lived invitation code to the
client; possession of that code alone does not grant business access.

The desktop NSIS installer is client-only. A separate Server installer
candidate can be built with
`npm run build:windows-installer --workspace @billing/server`; it packages the
compiled API, locked production dependencies, Prisma schema/migrations, and a
verified OpenJS-signed Node runtime. It does not install PostgreSQL or modify
a database. A dedicated PostgreSQL instance and protected server
configuration must be prepared first using
`apps/server/scripts/windows/README.md`. The Server installer is not
production-ready until legitimately signed and accepted on a disposable
Windows Server VM.

Business tax rates, GST registrations, invoice identity/address details, and
real product/pricing data are deliberately not seeded. Configure and validate
them with an accountant before production use.

## Implementation status

Implemented foundation and workflows:

- Prisma PostgreSQL schema, the initial migration, and six additive
  versioned migrations. No migration was run during this work; live database
  migration status remains unknown.
- One-time Argon2id administrator bootstrap and four isolated business
  profiles.
- Opaque, expiring, revocable server sessions and membership-checked API
  authorization.
- Business-scoped product search/create/update and price-history auditing.
- Admin stock adjustments with atomic balances, movement history, and audit.
- Business-scoped customer and supplier creation, configurable tax-pricing
  mode, and invoice numbering.
- Server-authoritative decimal invoice calculations, payment validation,
  idempotency, stock deduction, and invoice creation in one transaction.
- Transactional purchase receipts, weighted purchase cost updates, stock
  movements, purchase/sales returns, and authorized invoice cancellation.
- Business-scoped user assignment, role changes, password resets, and
  administrative audit/history/report API endpoints.
- React/Tauri desktop login, product/catalogue management, authorized stock
  adjustment, business settings, customer selection, split payments, purchase
  receipts, user administration, invoice history, and a reusable A4-oriented
  historical invoice document with WebView print/Save-as-PDF and configured
  per-business footer details. Physical print and PDF output remain unverified.
- Configurable API bind address with loopback-only plaintext and TLS required
  for non-loopback binds; separate liveness and database-readiness endpoints.
- Desktop runtime server URL validation, HTTPS enforcement for LAN addresses,
  bounded readiness checks, truthful connection status, and API request
  timeouts.
- Business-scoped paired-device records, hashed expiring pairing invitations,
  one-time redemption with safe identical-request retries, administrator
  approval and revocation, pairing rate limits, and audit events without
  invitation or device secrets.
- Device authorization in addition to session, business membership, and role
  checks on protected business APIs; pairing administration is restricted to
  the server computer or an already approved device.
- Tauri commands that store device credentials in the Windows native
  credential store, plus desktop pairing, approval, and revocation screens.

The migrations have not been applied: no verified project database connection
or backup was supplied. `DATABASE_URL` must point to the intended application
database before an operator reviews and deploys them. No database was reset or
modified. Current tests do not use a real PostgreSQL database and therefore do
not prove transaction behavior against PostgreSQL, cross-business isolation
with persisted records, concurrency, or migration execution.

Pairing integration testing is separate from the default mocked test suite.
Before running `npm run test:integration`, an operator must provision a new,
dedicated disposable PostgreSQL database and restricted login on the local
loopback interface. The integration runner requires
`BILLING_INTEGRATION_DATABASE_URL` to identify exactly the database
`billing_pairing_integration_test` using the role `billing_integration_test`
on loopback port 5432 or 5433 (an omitted port retains PostgreSQL's default
5432), and `BILLING_INTEGRATION_DATABASE_APPROVAL` to be set to
`I_CREATED_A_DEDICATED_DISPOSABLE_LOCAL_DATABASE`. Configure both
values only in the invoking process or a private environment manager; never
commit a URL or password. The runner overwrites `DATABASE_URL` only in its
child environment, invokes the locally installed Prisma and Vitest CLIs
without a shell, applies the ordered migrations to that explicitly approved
target, then runs tests under `apps/server/test/integration`. It refuses
remote hosts, ports other than 5432 and 5433, other database/role names, missing approval, and reuse
of the same local database target as `DATABASE_URL`.

These URL and role-name checks do **not** verify PostgreSQL privileges or
prove that the named database is disposable. The approval value is an
operator attestation, not a technical ACL check. Before setting it, provision
an empty throwaway database and a restricted login, independently verify that
the login cannot connect to or modify any application/production database,
and ensure this URL resolves to that test-only PostgreSQL instance. The runner
does not inspect cluster ACLs and must not be considered ready for use until
those external checks have been completed. The integration suite under
`apps/server/test/integration` exercises invitation expiry, redemption and
retries, concurrent use, transaction rollback, approval, role and membership
checks, business scope, revocation, and stored secret hashes through the real
API and Prisma client. It creates uniquely named business/user fixtures and
deletes only those fixtures. These tests have been written but have not been
run against PostgreSQL; they are not evidence that migrations or database
behavior have passed.

## Catalog seed

After reviewing and applying the additive catalog migration to the intended
database, run `npm run catalog:seed --workspace @billing/server` to import the
manufacturer-sourced entries in `apps/server/prisma/catalog-seed-data.ts`.
The import targets only the existing named businesses, serializes imports per
business, preserves any matching SKU or brand/model/pack record, and records an
audit event for each insertion. It does not create inventory balances and does
not set purchase prices, selling prices, GST rates, barcodes, or stock. Newly
imported items therefore cannot be billed until an administrator configures the
required prices and GST. Paint/oil keys derived from official product names and
pack sizes are internal repeatable catalog identifiers, not manufacturer SKUs.
This is a verified partial catalogue; unsupported model/pack details are not
filled with placeholders.

`npm run bundle --workspace @billing/desktop` currently produces a desktop-UI
NSIS installer only. It does not install or start the API, PostgreSQL, or a
Windows service, so it is not the required production server/client installer.

Still pending: automatic server discovery and end-to-end LAN/certificate
acceptance testing; desktop purchase-return workflow, reports, and audit review;
permissions for discount/price overrides; tax-jurisdiction splits and legally
reviewed invoice templates; verified PDF export; client runtime server
configuration; persistent Server/Client role setup; Windows
service and restricted firewall configuration; automated PostgreSQL setup;
backup/restore; and a unified server/client installer. The HTTPS listener
requires administrator-provisioned certificate/key files and does not itself
establish client identity. Integration and acceptance testing against a
dedicated PostgreSQL database and installed Windows application are also
outstanding. This project does not claim production readiness.

For an installed server, deploy reviewed migrations with
`npm run db:deploy --workspace @billing/server`. The development migration
command (`db:migrate`) is only for local development.
