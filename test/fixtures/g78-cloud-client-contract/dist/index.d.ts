import type { SekibanCloudTransportOptions, SerializedDcbTransport } from "@sekiban/dcb-client";

export type { SekibanCloudTransportOptions, SerializedDcbTransport } from "@sekiban/dcb-client";

/** Contract-only declaration; no downstream runtime or publication is implied. */
export declare function createSekibanCloudTransport(
  options: SekibanCloudTransportOptions,
): SerializedDcbTransport;
