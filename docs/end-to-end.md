# End-to-end sample proof

The meeting-room public-surface end-to-end witnesses are intentionally
separate from unit and conformance tests. SDT-G66 uses `npm run e2e:g66` for a
cold-first, paced, single-session proof over the real command and read routes.
The witness records response/admission, unsafe and safe visibility, tag-state,
query, and per-tick coverage/frontier observations. It persists accepted
command rows before polling and treats an absent or late clock as censored.

The G66 production configuration proof is kept in `docs/SDT-G66-evidence.md`.
No end-to-end result is a product pass unless the corresponding raw receipt
and the fail-closed guard result are present.
