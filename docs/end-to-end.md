# End-to-end sample proof

The meeting-room public-surface end-to-end witnesses are intentionally
separate from unit and conformance tests. The Cloudflare harness uses
`npm run e2e:cloudflare` for a cold-first, paced, single-session proof over the
real command and read routes.
The witness records response/admission, unsafe and safe visibility, tag-state,
query, and per-tick coverage/frontier observations. It persists accepted
command rows before polling and treats an absent or late clock as censored.

The current tree retains the executable witness and its fail-closed guard.
No end-to-end result is a product pass unless the corresponding raw receipt
and guard result are present.
