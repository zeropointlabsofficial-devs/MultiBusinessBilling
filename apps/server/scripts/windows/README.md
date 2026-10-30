# Windows Server Operations

## Separate Server installer

The Server installer is built separately from the Tauri Client installer:

```powershell
npm run build --workspace @billing/server
npm run build:windows-installer --workspace @billing/server
```

The candidate is written to
`apps/server/target/server-installers/Business Billing Server_0.1.0_x64-setup.exe`.
The build stages only the compiled backend, Prisma schema/migrations, locked
production dependencies, Windows operations scripts, and a Node.js runtime
whose Authenticode signature is verified as OpenJS Foundation. The package
build runs `npm ci` only in a temporary staging directory. Existing client
installer outputs are not read or overwritten.

The installer requires an elevated installation and a pre-created protected
`C:\ProgramData\MultiBusinessBilling\Server\.env`. It does not install
PostgreSQL, create a database, apply migrations, or seed products. Install a
dedicated PostgreSQL 16-18 instance using the official Windows installer
linked from the PostgreSQL download page, verify that installer's publisher
signature, configure it local-only on a separate port, and use
`provision-database.ps1` to create the new empty database and protected
configuration before running the Server installer. The dedicated service must
already be running with Automatic startup. Install the Microsoft Visual C++
2015-2022 Redistributable (x64) from Microsoft's official
[supported downloads](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)
if it is not already present. The installer refuses an existing
backend at the target, validates payload hashes, registers only this
application's backend startup task, and rolls back copied files on setup
failure.

Installer, uninstaller, and scheduled-task commands use Windows PowerShell
5.1 without setting or overriding execution policy. A `RemoteSigned` policy
normally permits extracted local scripts that are not marked as downloaded;
`AllSigned` requires signatures from a trusted publisher, and `Restricted`
blocks script files. If policy blocks execution, setup writes the PowerShell
process output, exit code, and stage to a uniquely named log under `%TEMP%`,
then stops without changing policy. When the diagnostic wrapper is allowed to
run, it captures stdout and stderr separately and redacts connection strings
and credential-like values. If the wrapper itself is blocked, NSIS records the
PowerShell startup output in that same log. Ask the administrator to use the
organization's approved policy or trusted script-signing process; do not
disable or bypass Windows policy.
For a startup task blocked after reboot, inspect the task's Last Run Result
and the host's PowerShell/Task Scheduler event logs; the task is not allowed
to weaken policy or retry under a lower-security setting.

The scripts in the installation execution chain are
`run-server-install.ps1`, `install-server.ps1`, `setup-server.ps1`,
`install-rollback.ps1`, and `tls-security.ps1`; the registered startup task
also executes `start-backend.ps1`, and removal executes `uninstall-server.ps1`.
Under `AllSigned`, each executed or dot-sourced script must carry a valid
Authenticode signature from a publisher trusted by the target machine. The
separate administrator-operated provisioning, backup, restore, and database
scripts also require trusted signatures when run under `AllSigned`.

The release signing process requires the business's legitimate publisher
code-signing certificate with its private key available through an authorized
signing service or protected signing machine, trust distribution for that
publisher on customer machines, and a trusted timestamp service. Sign every
PowerShell script in the execution chain and the final installer/executable,
then verify each signature and timestamp before release. A self-signed or
test certificate does not establish customer trust. Signing does not override
`Restricted`, WDAC, AppLocker, or other application-control rules; where those
controls deny execution, an administrator must approve the corresponding
publisher/file policy through the organization's normal process.

Before setup changes ACLs, it snapshots permissions for each existing path it
will modify and tracks only directories it successfully creates. A failed
attempt restores those ACL snapshots, removes only task/firewall resources
marked as created by that attempt, deletes its copied files, and removes its
new directories only when empty. Rollback failures are written to the
PowerShell warning stream and included alongside the original installation
error. Existing log-directory contents, `.env`, TLS material, PostgreSQL,
database files, backups, and business data are not cleanup targets.

The Server uninstaller removes the app's scheduled task, its exact API firewall
rule if present, and files listed by the signed-by-hash package manifest. It
does not stop or uninstall PostgreSQL and does not remove `.env`, migration
credentials, databases, backups, logs, or business data. Automatic in-place
upgrades are intentionally refused until a separately reviewed upgrade and
rollback procedure exists.

The installer is unsigned unless a legitimate publisher signing process is
configured. A candidate is not a production release until it is signed with
the business's trusted code-signing certificate and passes installation and
recovery acceptance on a disposable Windows Server VM.

## PostgreSQL source and isolation

Use the Windows installer linked from the official [PostgreSQL Windows download page](https://www.postgresql.org/download/windows/), which currently directs users to the EnterpriseDB-hosted installer. Verify the installer publisher/signature and version before installation. PostgreSQL 16 or newer is required by the project; the installed local PostgreSQL 18 binary examined during this work was not Authenticode-signed, so its publisher could not be verified and it was not used for provisioning tests.

Create a dedicated PostgreSQL instance named `MultiBusinessBillingPostgreSQL` with its own data directory and a non-conflicting local port (the application URL and instance port must match). Configure `listen_addresses` and `pg_hba.conf` for loopback only. Do not reuse, reconfigure, stop, or open a firewall port for an unrelated PostgreSQL service. The setup script refuses any other service name and checks that the dedicated instance is local-only.

For a dedicated instance, select a separate port such as `55432`; the provisioning script refuses the shared default port `5432`. The current machine's pre-existing PostgreSQL 18 service is not the required dedicated service and is never changed by these scripts.

After installing/configuring the dedicated instance and compiling the backend, preview role/database creation:

```powershell
.\apps\server\scripts\windows\provision-database.ps1 -ServerRoot C:\ProgramData\MultiBusinessBilling\Server -PostgresBinDirectory 'C:\Program Files\PostgreSQL\18\bin' -DatabaseName billing -PlanOnly
```

For actual creation, supply `BILLING_PROVISION_ADMIN_DATABASE_URL` through a private environment manager in an elevated PowerShell process, then run the same command without `-PlanOnly`. The URL must point to the dedicated local instance on port 55432. The script refuses existing database/role names and existing environment files. It writes the `billing_app` runtime URL to the server `.env` and the separate `billing_migrator` URL to an administrator-only file under ProgramData. The application role receives DML/default privileges only; it is not the database owner. The script creates an empty database only, does not migrate or seed it, and does not print passwords.

## Backend startup setup

Build the backend first. Prepare the server root `.env` privately with the application database URL, `HOST`, `PORT`, and, for LAN use, administrator-provisioned absolute `TLS_CERT_PATH` and `TLS_KEY_PATH` values. `TLS_SERVER_NAME` may be set to the DNS name or IP address clients will use; if omitted, the configured `HOST` is checked. Do not put credentials in the command line or source control. The app URL must target the dedicated local PostgreSQL instance. TLS files must be present before configuring a non-loopback host.

Preview without system changes:

```powershell
.\apps\server\scripts\windows\setup-server.ps1 -ServerRoot C:\ProgramData\MultiBusinessBilling\Server -PlanOnly
```

Actual setup requires an elevated PowerShell session, an existing dedicated PostgreSQL Windows service already running with Automatic startup, the compiled `apps\server\dist\src\index.js`, and a `.env` in the server root. Before changing permissions, setup verifies the TLS certificate validity period, SAN identity, and private-key match. It inspects the full private-key ACL and fails closed on unresolved identities, deny rules, or any allow principal other than `BUILTIN\Administrators` and `NT AUTHORITY\LOCAL SERVICE`. Administrators must already have read access; Local Service receives read-only access only when missing. Existing permissions are not removed. If a later setup step fails after that permission change, the exact prior ACL is restored using the installation rollback state. It registers a LocalService scheduled task to launch Node at startup with retry-on-failure settings. For LAN binding it adds only an HTTPS API firewall rule limited to `LocalSubnet`; PostgreSQL remains local-only. It does not install PostgreSQL, apply Prisma migrations, bootstrap an administrator, or verify public certificate trust/chain configuration. No actual task/service registration was run as part of this project work.

The desktop application is client-only: it does not install PostgreSQL or the backend. It uses manual HTTPS server configuration, readiness checks, device pairing, authentication, and Windows Credential Manager storage. There is no selectable Server/Client setup wizard or unified installer.

## Backups

Supply `DATABASE_URL` through the invoking process or a private environment manager, then run:

```powershell
.\apps\server\scripts\windows\backup-database.ps1 -BackupDirectory C:\ProgramData\MultiBusinessBilling\backups -PostgresBinDirectory 'C:\Program Files\PostgreSQL\18\bin'
```

The script only accepts loopback PostgreSQL, writes a timestamped custom-format archive and SHA-256 sidecar without overwriting existing files, checks the archive with `pg_restore --list`, and stores credentials temporarily in a restricted password file. Do not send database URLs or credentials through chat, logs, or command-line arguments.

## Restore

Set `BILLING_RESTORE_ADMIN_DATABASE_URL` privately to a local restore administrator, then run:

```powershell
.\apps\server\scripts\windows\restore-database.ps1 -BackupFile C:\ProgramData\MultiBusinessBilling\backups\billing-20261027-120000000.dump -TargetDatabaseName billing_restore_check -PostgresBinDirectory 'C:\Program Files\PostgreSQL\18\bin'
```

The script verifies the sidecar checksum and PostgreSQL archive listing, restricts restore to loopback, asks the operator to type `CREATE NEW DATABASE <name>`, and refuses any existing target. It creates a new database; it never drops, truncates, cleans, or overwrites. If restore fails after database creation, the partial database is retained for manual review.

## Remaining deployment gates

Migrations and initial administrator setup are operator-controlled steps described in `apps/server/prisma/MIGRATION-PLAN.md`. Provisioning scripts were only exercised in plan/sandbox modes; live service startup, PostgreSQL installation, backup integrity against a real database, restore, LAN/TLS, and failure recovery remain unverified. Do not treat this workflow as client-ready until those checks pass on a dedicated test server.
