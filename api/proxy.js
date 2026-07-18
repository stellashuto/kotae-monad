const upstreamBase = process.env.KOTAE_UPSTREAM_URL;
const proxySecret = process.env.KOTAE_PROXY_SECRET;

export default {
  async fetch(request) {
    if (!upstreamBase || !proxySecret) return Response.json({ error: "KOTAE proxy is not configured" }, { status: 503 });

    const incoming = new URL(request.url);
    const path = incoming.searchParams.get("path") || "";
    incoming.searchParams.delete("path");
    const upstream = new URL(`/api/${path}${incoming.search}`, upstreamBase);
    const headers = new Headers(request.headers);
    const publicOrigin = incoming.origin;
    headers.delete("host");
    headers.delete("content-length");
    headers.set("origin", publicOrigin);
    headers.set("x-kotae-public-origin", publicOrigin);
    headers.set("x-kotae-proxy-secret", proxySecret);

    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      duplex: "half",
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    responseHeaders.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  },
};
