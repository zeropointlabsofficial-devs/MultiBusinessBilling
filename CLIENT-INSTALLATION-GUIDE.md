# Client Installation Guide — Preliminary, Not Release-Approved

**This is not a client-ready deployment procedure.** No production server,
database, website repository, trusted signing certificate, or fresh-install
acceptance environment has been provided. Do not install these candidates on a
client machine or point them at production until the release gates below pass.

## Current package boundaries

- The Desktop NSIS package installs only the Tauri desktop application. It
  does not install or start the backend or PostgreSQL.
- The Server NSIS package installs the API payload and can register a
  Windows startup task for the backend. It does not install PostgreSQL, create
  a database, or apply Prisma migrations.
- Backend startup is configured to run as `NT AUTHORITY\LOCAL SERVICE` through
  Task Scheduler. Setup requires an administrator and a separately installed,
  dedicated PostgreSQL service that is already running with Automatic startup.
- The desktop currently requires the server address to be entered and checked
  in the application. LAN addresses require HTTPS with a certificate trusted
  by Windows. Device pairing and administrator approval are separate steps.

## Required server-operator preparation

Use the reviewed Windows operations procedure in
[apps/server/scripts/windows/README.md](./apps/server/scripts/windows/README.md)
and [apps/server/prisma/MIGRATION-PLAN.md](./apps/server/prisma/MIGRATION-PLAN.md).
An authorized administrator must:

1. Select and verify a supported PostgreSQL installer and publisher. Install a
   **new dedicated instance** with its own data directory and a non-conflicting
   loopback-only port. Do not reuse, reconfigure, stop, or migrate an existing
   PostgreSQL instance.
2. Privately create the protected server configuration and least-privilege
   application/migration roles using the provisioning procedure. Never place
   credentials in this guide, installer command lines, screenshots, or logs.
3. Back up and independently verify the intended database before any
   migration. Review the ordered migration plan and obtain explicit database
   owner approval. Apply migrations with the dedicated migration credential;
   the Server installer intentionally does not migrate.
4. Provide administrator-managed TLS certificate/key files for LAN use, verify
   their hostname and trust chain, and keep the private key ACL restricted.
5. Install the Server package elevated only after the environment is prepared.
   The installer refuses in-place upgrades; do not uninstall or replace an
   existing installation as an upgrade workaround.
6. Verify backend readiness, scheduled-task startup/recovery, logs, database
   backup, and restore on a disposable Windows Server acceptance machine before
   authorizing production use.

The scripts do not bypass PowerShell policy or alter Windows security policy.
If organizational policy blocks an unsigned installer/script, stop and use
the organization's approved signing and application-control process.

## Client configuration

After an approved server deployment, install the Desktop package and enter
the administrator-provided HTTPS server address in the app. A business
administrator must issue a short-lived pairing invitation and approve the
client device. Do not convey credentials or invitation codes through this
guide. Automatic server discovery and an installer-configured server address
are not implemented.

While the desktop is on the billing, products, or purchases view, it refreshes
the authenticated, business-scoped product list every 15 seconds and when its
window becomes visible. This only reflects changes made to the same backend;
website-to-desktop synchronization remains unverified because the website
source and its deployment/database configuration are unavailable.

## Release gates still outstanding

- Locate and verify the actual website product-management source and intended
  shared database/API. This workspace has no website application.
- Test website product creation/update/deactivation, business isolation, and
  desktop visibility against the same approved disposable deployment.
- Validate PostgreSQL provisioning, migrations, automatic startup/recovery,
  backup/restore, upgrades, and uninstall on a disposable Windows Server.
- Verify client installation, server addressing, pairing, billing, and invoice
  persistence on a fresh Windows client.
- Sign the final installers with the organization's trusted publisher
  certificate and verify signatures and timestamps.

Until these gates pass, these files are development/release candidates, not an
approved client release.
