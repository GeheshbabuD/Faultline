# ai — provider-agnostic model layer

One module per AI call, each declaring its own output schema, prompt version and
retry policy. Nothing in this layer returns unvalidated data to the domain: every
task resolves to a schema-parsed, typed result or an explicit failure.

- `provider/` — `AnthropicProvider` and `FakeProvider` (fixture-backed, for tests)
- `tasks/`    — reasoning-diff, misconception-classify, counterexample,
                transfer-generate, transfer-verify
- `runtime/`  — parse, validate, repair, retry, log

May depend on `core`. May not depend on `server`, `ui`, `features` or React.
