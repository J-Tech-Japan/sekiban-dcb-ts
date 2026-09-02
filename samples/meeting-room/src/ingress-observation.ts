/**
 * The application-to-runtime hop is an in-isolate call rather than a network
 * fetch. Preserve the Cloudflare-assigned ingress ray on that synthetic
 * request so trace-only worker observations can join the app response to the
 * commit-path custom-span root. This must not alter the request body, method,
 * application headers, or any public response.
 */
export function runtimeRequestWithIngressRay(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  ingressRay: string | null,
): Request {
  const internal = input instanceof Request ? input : new Request(input, init);
  if (ingressRay === null || ingressRay.length === 0) return internal;
  const headers = new Headers(internal.headers);
  headers.set("cf-ray", ingressRay);
  return new Request(internal, { headers });
}
