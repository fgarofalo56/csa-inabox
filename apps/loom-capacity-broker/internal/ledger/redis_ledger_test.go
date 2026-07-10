package ledger

import "testing"

func TestParseConnRedissURL(t *testing.T) {
	r, err := parseConn("rediss://:mysecret@cache.redis.cache.windows.net:6380")
	if err != nil {
		t.Fatal(err)
	}
	if r.addr != "cache.redis.cache.windows.net:6380" {
		t.Fatalf("addr %q", r.addr)
	}
	if !r.useTLS {
		t.Fatal("rediss must enable TLS")
	}
	if r.password != "mysecret" {
		t.Fatalf("password %q", r.password)
	}
	if r.tlsName != "cache.redis.cache.windows.net" {
		t.Fatalf("tlsName %q", r.tlsName)
	}
}

func TestParseConnStackExchangeStyle(t *testing.T) {
	r, err := parseConn("cache.redis.cache.windows.net:6380,password=abc123,ssl=True,abortConnect=False")
	if err != nil {
		t.Fatal(err)
	}
	if r.addr != "cache.redis.cache.windows.net:6380" || !r.useTLS || r.password != "abc123" {
		t.Fatalf("parsed wrong: %+v", r)
	}
}

func TestParseConnBareHostPortInfersTLSOn6380(t *testing.T) {
	r, err := parseConn("myhost:6380")
	if err != nil {
		t.Fatal(err)
	}
	if !r.useTLS {
		t.Fatal("port 6380 should infer TLS")
	}
	if r.tlsName != "myhost" {
		t.Fatalf("tlsName %q", r.tlsName)
	}
}

func TestParseConnPlain6379NoTLS(t *testing.T) {
	r, err := parseConn("localhost:6379")
	if err != nil {
		t.Fatal(err)
	}
	if r.useTLS {
		t.Fatal("port 6379 should not infer TLS")
	}
	if r.password != "" {
		t.Fatal("no auth expected")
	}
}

func TestParseConnMissingPortErrors(t *testing.T) {
	if _, err := parseConn("hostwithoutport"); err == nil {
		t.Fatal("expected error for missing :port")
	}
}

func TestParseConnRedisURLDefaultPort(t *testing.T) {
	r, err := parseConn("redis://user:pw@host")
	if err != nil {
		t.Fatal(err)
	}
	if r.addr != "host:6379" {
		t.Fatalf("addr %q", r.addr)
	}
	if r.username != "user" || r.password != "pw" {
		t.Fatalf("creds %q/%q", r.username, r.password)
	}
	if r.useTLS {
		t.Fatal("redis:// is not TLS")
	}
}
