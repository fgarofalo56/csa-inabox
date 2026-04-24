#!/usr/bin/env python3
"""Re-probe with full browser headers; classify real-vs-anti-bot blocks."""
from __future__ import annotations

import concurrent.futures
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
}

ctx = ssl.create_default_context()


def probe(url: str) -> tuple[str, int, str]:
    # Reject any scheme other than http(s) before opening (mitigates bandit B310).
    scheme = urllib.parse.urlparse(url).scheme.lower()
    if scheme not in ("http", "https"):
        return (url, -3, f"unsupported scheme: {scheme}")
    try:
        req = urllib.request.Request(url, method="GET", headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:  # nosec B310 — scheme validated above
            return (url, resp.getcode(), resp.geturl() if resp.geturl() != url else "")
    except urllib.error.HTTPError as e:
        return (url, e.code, str(e.reason)[:60])
    except urllib.error.URLError as e:
        return (url, -1, str(e.reason)[:60])
    except TimeoutError:
        return (url, -2, "timeout")
    except Exception as e:
        return (url, -3, f"{type(e).__name__}: {str(e)[:50]}")


def main() -> int:
    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(probe, urls))
    for u, c, n in results:
        marker = "OK" if 200 <= c < 400 else "FAIL"
        print(f"  {marker} [{c:>4}] {u}  {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
