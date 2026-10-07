# @sekiban/dcb-cloudflare

Optional helper for callers who already have a Worker and want Sekiban storage beside it.

This package is not an application, not a matched-set member, and not a hosted service. The caller keeps their routes, authentication, wrangler config, and Worker name. Pass that config to `dcb-cloudflare migrate` and `dcb-cloudflare deploy`.

The default backend is Wrangler. `dcb-cloudflare migrate --config <path> --cli cf`
is an opt-in remote D1 migration path: it applies each config entry by its real
UUID `database_id`, honors `migrations_dir` and `migrations_table`, and runs cf
from the directory containing the config. It does not support `--local`,
`--env`, extra arguments, or deployment; `--cli cf` is refused for `deploy`.
The helper passes the caller's environment through, so cf uses its normal
credential order, including `CLOUDFLARE_API_TOKEN` before OAuth profiles.
The caller must have cf 1.0.0-beta.5 or a compatible beta installed separately
and Node 22 or newer. cf is intentionally not a dependency of this package.

`composeFetch` publishes runtime HTTP routes only when the caller supplies `authorize`. The default forward list is the five serialized paths. `queue` and `scheduled` from the runtime and the caller both run, runtime first.

If `npm view @sekiban/dcb-cloudflare` reports E404, the package has not been published yet; use the repository-checkout alternative. The helper requires `@sekiban/dcb-runtime` 0.2.x, and the generated starter pins 0.2.0.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
