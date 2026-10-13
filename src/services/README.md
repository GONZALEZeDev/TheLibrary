# `src/services` — use cases

A service implements the use cases of one area (settings today; sync, matches and analysis in later milestones). It orchestrates the pure logic of `core/` and the side effects behind `ports/`.

## Rules

- May import `core/` and `ports/` only (enforced by ESLint) — never an adapter: adapters are injected through the constructor.
- Validate everything read from a port with `core/` schemas before returning it.
- Wrap failures of ports in `AppError` with the right `kind`; log meaningful events through the `Logger` port.
- One service per file, named `<name>.service.ts`, tested with the `adapters/dev` implementations.
- `app-services.ts` lists the services exposed to the UI; the composition root builds it.
