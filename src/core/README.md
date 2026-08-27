# core — the reasoning domain

Pure, framework-free domain logic. **No** Next.js, React, database, network or AI
imports are permitted here; the boundary is enforced by ESLint, not convention.

Everything in this layer is a deterministic function over plain data, which means
the reasoning-diff logic, the confidence policy and the transfer verdict rules can
all be unit-tested with no API key and no database.

- `reasoning/` — reasoning trace types, step alignment, divergence detection
- `taxonomy/`  — misconception registry, loading and validation
- `diagnosis/` — confidence policy and disposition gating
- `transfer/`  — transfer verdict rules

Subject-independence lives here: this layer knows about *reasoning*, not about
integer subtraction. Topic knowledge belongs in `content/`.
