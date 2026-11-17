# quartz-admin

An internal operations tool for viewing and controlling Quartz Scheduler clusters spread across multiple databases (Oracle, PostgreSQL, MySQL, MariaDB) from a single screen.

Services that run Quartz in JDBC JobStore cluster mode keep their state only in `QRTZ_` tables in their own databases. Pausing a batch or changing a cron schedule means redeploying the service or running SQL directly against the production database, and misfires or node outages are noticed late. quartz-admin connects to these tables directly, controls them by Quartz's own rules without a SQL console or a redeploy, and alerts on anomalies.

## Features

**Connections and auto-detection**

- When you register a target database connection, it finds the Quartz tables, table prefix, `SCHED_NAME`s, schema version differences, and boolean storage format, and offers them as scheduler candidates.
- When a connection test fails, it tells you the cause (network, authentication, permission, timeout).
- Accounts without write permission become read-only connections, limited to viewing and alerts.
- Database passwords are stored encrypted with AES-256-GCM and never exposed in plain text in the UI, API, or logs.

**Viewing**

- Dashboard: status of every scheduler (healthy, warning, failing, unreachable), active node count, trigger counts by state, running job count, open alert count. Filter by environment label, tag, and name.
- Scheduler detail: cluster nodes with check-in status, paused groups.
- Job, trigger, and running job lists: search, filters, pagination. Execution records from instances that are not active nodes are shown separately.
- If one target database is unreachable, the other schedulers can still be viewed as usual.

**Control**

- Pause and resume triggers, jobs, groups, or a whole scheduler. You can also select several items and act on them at once.
- Run now, edit cron and SIMPLE schedules (with a preview of the next 5 fire times), delete triggers and jobs.
- Safeguards: changes are made inside a transaction that holds `QRTZ_LOCKS`, the same way Quartz does; state is re-read just before execution and the action stops if it differs from what was on screen. Before execution you confirm the target, environment, and number of affected triggers.

**Alerts**

- Alerts within 5 minutes of the condition for misfires and late fires, ERROR triggers, long-lasting BLOCKED triggers, cluster nodes dropping out, and monitoring failures.
- Channels: in-app alert center, Slack, email (SMTP). Raised → acknowledged → resolved lifecycle, duplicate and flood suppression, muting during maintenance.

**Audit log and users**

- Every control attempt (success or failure), settings change, and login is recorded with before and after values, and cannot be edited or deleted through the UI or API. Supports filtered search and CSV export.
- Local account login, user management by administrators, session expiry, and lockout after repeated failed logins.

## Supported versions

| Target     | Version                                           |
| ---------- | ------------------------------------------------- |
| Oracle     | 12.1 or later (no Instant Client needed)          |
| PostgreSQL | 11 or later                                       |
| MySQL      | 5.7 or later                                      |
| MariaDB    | 10.3 or later                                     |
| Quartz     | 2.x standard schema (tested with 2.3.2 and 2.5.2) |
| Browser    | Latest Chrome, Edge, Safari                       |

Out of scope: job execution history and job exception detection, creating new jobs and editing JobDataMap, SSO and role separation, arbitrary SQL execution, multi-instance HA. See [PRD](docs/PRD.md) §2 and §9 for details.

## Deployment

Runs as a single Docker Compose service on one host, with metadata (SQLite) stored in one volume. For installation, upgrades, backup and restore, key rotation, and incident response, see the [operations runbook](docs/operations.md).

## Documents

The documents below are written in Korean.

| Document                                           | Contents                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Operations runbook](docs/operations.md)           | Installation, reverse proxy, deployment security, upgrades, backup and restore, incident response    |
| [DB accounts](docs/db-accounts.md)                 | Creating read-only and write accounts on the 4 target databases, registering connections             |
| [Legacy Oracle check](docs/oracle-legacy-check.md) | Check image and checklist for in-house Oracle 12c and 19c                                            |
| [Pilot guide](docs/pilot.md)                       | In-house scheduler inventory, selecting, registering, and stopping pilots, measuring success metrics |
| [PRD](docs/PRD.md)                                 | Users, scope, functional and non-functional requirements, success metrics                            |
| [TRD](docs/TRD.md)                                 | Architecture, store schema, control and monitoring design, testing, environment variables            |
| [BACKLOG](docs/BACKLOG.md)                         | Milestones and tasks (B-xx), workflow rules, requirement tracing                                     |
| [DESIGN](docs/DESIGN.md)                           | Design system: themes, tokens, status display, components, lint rules                                |

## Development

- Node.js 24 (`.nvmrc`)
- pnpm 10 (with `corepack enable`, the version in the `packageManager` field is used automatically)

```bash
pnpm install
pnpm build       # full build (turbo)
pnpm test        # unit tests
pnpm test:integration  # integration tests (requires Docker; Oracle Free 23 + quartz-testbed)
pnpm e2e        # E2E (Playwright, Chrome, Edge, WebKit). Run pnpm build first; requires Docker
pnpm --filter @qa/store testbed:up  # Oracle + 2-node Quartz cluster for manual checks (requires Docker; connection info: packages/store/.testbed.json)
pnpm lint        # ESLint (type-aware rules, plus @shadcn/lint design rules for web screens)
pnpm typecheck   # TypeScript check
pnpm format      # apply Prettier
```

The API needs `apps/api/.env` before its first run. An encryption key is required.

```bash
cp apps/api/.env.example apps/api/.env
pnpm --filter @qa/api build
pnpm --filter @qa/api cli gen-key   # put the output into QA_ENCRYPTION_KEYS in .env
```

The full list of environment variables is in [TRD §11.2](docs/TRD.md). If a value is invalid, it prints which variable is wrong and why, and does not start.

Running each app:

```bash
pnpm --filter @qa/api dev   # NestJS, http://localhost:3000/api/v1 (data: apps/api/data/)
pnpm --filter @qa/web dev   # Next.js dev server http://localhost:3001. See the design system at /design
```

- During development, open `http://localhost:3001` in the browser. The web dev server forwards `/api` requests to the API (`QA_API_URL`, default `http://localhost:3000`), so the UI and API behave as if they share an origin. In this setup, set the API's `QA_PUBLIC_URL` to `http://localhost:3001` (CSRF Origin check).
- `pnpm build` copies the web static output (`apps/web/out`) into `apps/api/public`. The built API (`pnpm --filter @qa/api start`) serves the UI and API together on one port. If the web app has not been built, only the API is served.

Developing with one process on one port (HMR):

```bash
pnpm dev:hmr   # UI and API together at http://localhost:3000. UI edits apply instantly (HMR); API edits restart the process
```

- A Next dev server is attached inside the API and receives requests other than `/api` and the health check (`QA_WEB_DEV=1`). The same-origin setup used in production serving is kept during development.
- `QA_PUBLIC_URL` is set to `http://localhost:<PORT>` (default 3000) regardless of `.env`. To use a different address, set it in the shell.
- Next runs only one dev server per directory, so this cannot be used at the same time as `pnpm --filter @qa/web dev`.
- UI responses do not get the helmet CSP (HMR uses eval and inline scripts). This is development only; the production image has no web source, so it cannot be turned on there.

After changing the metadata schema, generate a migration and commit it. Migrations are applied automatically at startup.

```bash
pnpm --filter @qa/api db:generate --name <change-name>   # generated in apps/api/drizzle/
```

On Windows without the Visual Studio C++ build tools, `pnpm install` fails at better-sqlite3's `node-gyp` step. better-sqlite3 ships prebuilt Windows binaries, so install with `pnpm install --ignore-scripts`.

## Structure

```
apps/
  api/        NestJS API. Serves the web static output when built
  web/        Next.js admin UI (output: 'export')
packages/
  shared/     API DTOs, zod request schemas, error codes, shared constants (@qa/shared)
  core/       Quartz logic without I/O: cron port, trigger calculation (@qa/core)
  store/      Target database access: QuartzDialect, auto-detection, queries and commands (@qa/store)
              test/support: Testcontainers integration test helpers
tools/
  quartz-testbed/  Java Quartz test node, cron vector generator (see its README)
docker/       Dockerfile, compose.yaml, container smoke test, Oracle check image
e2e/          Playwright E2E
docs/         PRD, TRD, BACKLOG, DESIGN, operations documents
```

Dependencies flow `api → store → core`, `api → shared`, `store → shared`, `web → shared`.

## Contributing

Work follows the rules in [BACKLOG](docs/BACKLOG.md) §1. One task is one `feat/B-xx-<slug>` branch and one PR. Before pushing, run `pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test` locally. On a PR, CI runs the checks, integration tests against the latest version of each database (4 combinations), and the container smoke test; after merging to main, it runs the full integration matrix of 4 databases × minimum and latest versions × Quartz 2.3.2/2.5.2 (16 combinations).

## License

MIT. For notices on code taken from other projects, see [NOTICE](NOTICE).
