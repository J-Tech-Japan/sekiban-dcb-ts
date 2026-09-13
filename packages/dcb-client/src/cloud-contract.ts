/**
 * Shared options shape for the separately-owned SekibanCloud transport.
 *
 * This is intentionally type-only in @sekiban/dcb-client.  The runtime
 * createSekibanCloudTransport implementation is owned by
 * @sekiban/cloud-client.
 */
export interface SekibanCloudTransportOptions {
  readonly BaseUrl: string;
  readonly ServiceId: string;
  readonly CredentialId: string;
  readonly CredentialSecret: string;
  readonly fetch?: typeof fetch;
}
