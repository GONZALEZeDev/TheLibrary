# `src/services` — use cases

A service implements the use cases of one area (settings, synchronisation, matches, hero names and the match detail archive today; analysis in a later milestone). It orchestrates the pure logic of `core/` and the side effects behind `ports/`.

## Rules

- May import `core/` and `ports/` only (enforced by ESLint) — never an adapter: adapters are injected through the constructor.
- Validate everything read from a port before returning it: domain data with the schemas of `core/`, stored rows and cached payloads with the schema declared next to the code that reads them.
- Wrap failures of ports in `AppError` with the right `kind`; log meaningful events through the `Logger` port.
- One service per file, named `<name>.service.ts`, tested with the `adapters/dev` implementations.
- A repository, `<name>.repository.ts`, holds the SQL of one table: both databases run it, it validates the rows it reads and wraps database failures in `AppError` of kind `storage`.
- `app-services.ts` lists the services exposed to the UI; `create-app-services.ts` builds them from the adapters, for the composition root and the tests alike.
