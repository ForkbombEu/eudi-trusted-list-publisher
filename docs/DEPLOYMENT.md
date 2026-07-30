# Deployment and troubleshooting

Reference deployment: Node app under pm2, listening on `TLP_PORT` (23100),
fronted by Caddy, with DNS at Cloudflare.

## Layers

A request crosses four layers. Debugging means finding the first one that
misbehaves, from the inside out:

```
browser -> Cloudflare edge -> Caddy (:80/:443) -> Node app (:23100)
```

## Health check

The app exposes `GET /healthz`, which returns `{"status":"ok"}` and is never
cached. Every layer can be probed with it.

```sh
# 1. app directly (run on the origin host)
curl -i http://127.0.0.1:23100/healthz

# 2. Caddy on the origin host, bypassing DNS/Cloudflare
curl -i --resolve lote.credimi.io:443:127.0.0.1 https://lote.credimi.io/healthz

# 3. through Cloudflare
curl -i https://lote.credimi.io/healthz
```

The first probe that fails identifies the broken layer. If 1 and 2 succeed but
3 fails, the problem is Cloudflare configuration, not the app.

## Reading logs

The app writes one JSON line per request to stderr, including a `requestId`:

```sh
pm2 logs eudi-trusted-list-publisher --lines 200
pm2 logs eudi-trusted-list-publisher --raw | grep '"status":5'
```

Caddy's own log is separate and is what you need when the app log is empty:

```sh
sudo journalctl -u caddy -f
sudo tail -f /var/log/caddy/lote.credimi.io.log | jq .
```

**An empty pm2 log during a failing request is itself a diagnosis**: the
request never reached the app, so the fault is in Caddy or Cloudflare.

## ERR_TOO_MANY_REDIRECTS / repeated 308s

Symptom: every URL answers `308 Permanent Redirect` with a `Location` equal to
the requested URL, `server: cloudflare`, and pm2 logs stay silent.

Cause: Cloudflare's SSL/TLS encryption mode for the zone is **Flexible**.
Cloudflare then connects to the origin over plain HTTP on port 80. Caddy's
automatic HTTPS issues its standard `308` redirect to `https://` for every
path. Cloudflare passes that redirect back to the browser, which is *already*
on `https://`, so it requests the same URL again — forever.

The redirect status is the tell: `308` is Caddy's automatic-HTTPS redirect.
Cloudflare's own "Always Use HTTPS" feature emits `301`.

This bites a newly added hostname even when every other service on the same
host works, because those hostnames are DNS-only (grey cloud) and never
traverse Cloudflare's edge, so the zone's SSL mode never applied to them.

Fixes, best first:

1. **Turn the proxy off** — set the DNS record for the subdomain to DNS-only
   (grey cloud), matching the other services on this host. Caddy handles TLS
   end-to-end and Cloudflare is out of the request path entirely. This is the
   fix that resolved the original incident: the record had been set to Proxied
   by mistake, and switching it to DNS-only worked immediately.
2. **Set Cloudflare SSL/TLS to "Full (strict)"** (SSL/TLS -> Overview) if the
   record must stay proxied. Caddy already holds a valid Let's Encrypt
   certificate, so this works immediately. If the zone must stay on Flexible for
   legacy reasons, scope the change with a Configuration Rule matching
   `hostname eq "lote.credimi.io"`.
3. Last resort, if the Cloudflare setting is not yours to change: bind the
   Caddy site to `http://` explicitly (Option B in `deploy/Caddyfile.example`)
   so Caddy stops redirecting. This leaves Cloudflare-to-origin traffic
   unencrypted.

Verify the fix without a browser cache confusing matters:

```sh
curl -sSI https://lote.credimi.io/healthz     # expect 200, not 308
```

Note that browsers cache `308` responses aggressively and will keep looping
after the server is fixed. Confirm with `curl` first, then clear the site's
cache or test in a private window.

## Certificate issuance behind Cloudflare

Caddy solves the ACME HTTP-01 challenge on port 80. Cloudflare proxies port 80,
so issuance works with the proxy enabled — but only if Cloudflare's "Always Use
HTTPS" does not intercept `/.well-known/acme-challenge/*`. If issuance fails,
check for a certificate first:

```sh
sudo ls /var/lib/caddy/.local/share/caddy/certificates/*/lote.credimi.io/
echo | openssl s_client -connect 127.0.0.1:443 -servername lote.credimi.io 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## pm2

```sh
pm2 status
pm2 restart eudi-trusted-list-publisher --update-env   # after editing .env
pm2 save                                                # persist across reboot
```

`--update-env` matters: pm2 caches the environment, so a plain `restart` will
not pick up `.env` changes.
