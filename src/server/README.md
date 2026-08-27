# server — the server-only boundary

Everything that touches persistence, sessions or secrets. Modules here import
`server-only` so that accidentally pulling them into a client component fails at
build time rather than leaking at runtime.

- `db/`       — Drizzle schema, migrations, repositories
- `auth/`     — session, roles, ownership guards
- `services/` — use-case orchestration; the only layer allowed to combine db + ai
- `config/`   — validated environment and tunable policy
