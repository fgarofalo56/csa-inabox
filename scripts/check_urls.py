#!/usr/bin/env python3
"""Probe a list of URLs and report status. Designed for the use-cases sweep."""
from __future__ import annotations

import concurrent.futures
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

ctx = ssl.create_default_context()


def probe(url: str) -> tuple[str, int, str]:
    """Return (url, http_status, note). status=-1 on connection error, -2 on timeout."""
    # Reject any scheme other than http(s) before opening (mitigates bandit B310).
    scheme = urllib.parse.urlparse(url).scheme.lower()
    if scheme not in ("http", "https"):
        return (url, -3, f"unsupported scheme: {scheme}")
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:  # nosec B310 — scheme validated above
                code = resp.getcode()
                final = resp.geturl()
                note = f"-> {final}" if final != url else ""
                # If HEAD says 405/403 try GET
                if method == "HEAD" and code in (403, 405):
                    continue
                return (url, code, note)
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 405, 400):
                continue
            return (url, e.code, str(e.reason)[:80])
        except urllib.error.URLError as e:
            return (url, -1, str(e.reason)[:80])
        except TimeoutError:
            return (url, -2, "timeout")
        except Exception as e:
            return (url, -3, f"{type(e).__name__}: {str(e)[:60]}")
    return (url, -4, "all methods failed")


def main() -> int:
    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip()]
    print(f"Probing {len(urls)} URLs...", file=sys.stderr)
    results: list[tuple[str, int, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        for i, r in enumerate(ex.map(probe, urls), 1):
            results.append(r)
            if i % 25 == 0:
                print(f"  {i}/{len(urls)}", file=sys.stderr)

    # Buckets
    ok, redirected, forbidden, notfound, gone, server_err, dns, timeouts, other = (
        [], [], [], [], [], [], [], [], []
    )
    for u, code, note in results:
        if 200 <= code < 300:
            (redirected if note else ok).append((u, code, note))
        elif 300 <= code < 400:
            redirected.append((u, code, note))
        elif code == 403:
            forbidden.append((u, code, note))
        elif code == 404:
            notfound.append((u, code, note))
        elif code == 410:
            gone.append((u, code, note))
        elif 400 <= code < 500:
            other.append((u, code, note))
        elif 500 <= code < 600:
            server_err.append((u, code, note))
        elif code == -1:
            dns.append((u, code, note))
        elif code == -2:
            timeouts.append((u, code, note))
        else:
            other.append((u, code, note))

    def dump(name: str, bucket: list) -> None:
        if not bucket:
            return
        print(f"\n## {name} ({len(bucket)})")
        for u, c, n in sorted(bucket):
            print(f"  [{c:>4}] {u}  {n}")

    print(f"\n=== SUMMARY: total={len(results)} ===")
    print(f"OK 2xx:        {len(ok)}")
    print(f"Redirected:    {len(redirected)}")
    print(f"403 Forbidden: {len(forbidden)}")
    print(f"404 Not Found: {len(notfound)}")
    print(f"410 Gone:      {len(gone)}")
    print(f"4xx other:     {len([r for r in other if 400 <= r[1] < 500])}")
    print(f"5xx server:    {len(server_err)}")
    print(f"DNS / connect: {len(dns)}")
    print(f"Timeouts:      {len(timeouts)}")
    print(f"Other:         {len([r for r in other if not (400 <= r[1] < 500)])}")

    dump("404 NOT FOUND", notfound)
    dump("410 GONE", gone)
    dump("403 FORBIDDEN", forbidden)
    dump("4xx OTHER", [r for r in other if 400 <= r[1] < 500])
    dump("5xx SERVER ERROR", server_err)
    dump("DNS / CONNECT FAIL", dns)
    dump("TIMEOUT", timeouts)
    dump("OTHER", [r for r in other if not (400 <= r[1] < 500)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
