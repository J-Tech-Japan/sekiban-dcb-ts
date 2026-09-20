# @sekiban/dcb-cloudflare

Optional helper for callers who already have a Worker and want Sekiban storage beside it.

This package is not an application, not a matched-set member, and not a hosted service. The caller keeps their routes, authentication, wrangler config, and Worker name. Pass that config to `dcb-cloudflare migrate` and `dcb-cloudflare deploy`.

`composeFetch` publishes runtime HTTP routes only when the caller supplies `authorize`. The default forward list is the five serialized paths. `queue` and `scheduled` from the runtime and the caller both run, runtime first.

It is not published yet. Inside this repository the sample depends on it as a workspace package. Other applications install it only after an operator publishes it.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
