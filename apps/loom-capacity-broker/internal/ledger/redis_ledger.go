package ledger

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"loom-capacity-broker/internal/resp"
)

// Redis is the cross-replica ledger backend over a hand-rolled RESP2 client
// (internal/resp). It stores each ledger key as a Redis hash whose fields are
// 30-second timepoint indices and whose values are accumulated LCU
// (HINCRBYFLOAT), with a 24 h EXPIRE so elapsed debt self-heals. Selected when
// LOOM_BROKER_REDIS / LOOM_CAPACITY_BROKER_REDIS is set (e.g. an Azure Cache for
// Redis Premium instance, rediss:// on 6380 with an access-key password).
type Redis struct {
	addr     string
	username string
	password string
	useTLS   bool
	tlsName  string

	pool chan *conn
}

type conn struct {
	nc net.Conn
	br *bufio.Reader
}

const (
	poolSize     = 8
	dialTimeout  = 5 * time.Second
	ioTimeout    = 5 * time.Second
	ledgerTTLsec = 24*3600 + 60 // 24 h + slack
)

// NewRedis parses a connection string, verifies connectivity with a PING, and
// returns a pooled client. Supported forms:
//
//	rediss://:PASSWORD@host:6380            (TLS URL — the Azure default)
//	redis://user:pass@host:6379             (plain URL)
//	host:6380,password=KEY,ssl=True         (StackExchange.Redis style)
//	host:6379                               (bare host:port, no auth)
func NewRedis(ctx context.Context, connStr string) (*Redis, error) {
	r, err := parseConn(connStr)
	if err != nil {
		return nil, err
	}
	r.pool = make(chan *conn, poolSize)
	// Verify one connection up front so a bad config fails fast (caller falls
	// back to memory and logs).
	c, err := r.dial(ctx)
	if err != nil {
		return nil, err
	}
	if err := r.pingConn(c); err != nil {
		_ = c.nc.Close()
		return nil, err
	}
	r.put(c)
	return r, nil
}

func parseConn(s string) (*Redis, error) {
	s = strings.TrimSpace(s)
	r := &Redis{}
	switch {
	case strings.HasPrefix(s, "redis://") || strings.HasPrefix(s, "rediss://"):
		u, err := url.Parse(s)
		if err != nil {
			return nil, err
		}
		r.addr = u.Host
		if u.Port() == "" {
			if u.Scheme == "rediss" {
				r.addr = u.Hostname() + ":6380"
			} else {
				r.addr = u.Hostname() + ":6379"
			}
		}
		r.useTLS = u.Scheme == "rediss"
		r.tlsName = u.Hostname()
		if u.User != nil {
			r.username = u.User.Username()
			r.password, _ = u.User.Password()
		}
	case strings.Contains(s, ","):
		// StackExchange.Redis style: host:port,key=value,...
		parts := strings.Split(s, ",")
		r.addr = strings.TrimSpace(parts[0])
		for _, p := range parts[1:] {
			kv := strings.SplitN(p, "=", 2)
			if len(kv) != 2 {
				continue
			}
			key := strings.ToLower(strings.TrimSpace(kv[0]))
			val := strings.TrimSpace(kv[1])
			switch key {
			case "password":
				r.password = val
			case "user", "username":
				r.username = val
			case "ssl":
				r.useTLS = strings.EqualFold(val, "true")
			}
		}
		r.tlsName = hostOnly(r.addr)
	default:
		r.addr = s
		r.tlsName = hostOnly(s)
	}
	if !strings.Contains(r.addr, ":") {
		return nil, fmt.Errorf("ledger: redis address %q missing :port", r.addr)
	}
	// Azure Cache for Redis SSL port heuristic.
	if !r.useTLS && strings.HasSuffix(r.addr, ":6380") {
		r.useTLS = true
	}
	return r, nil
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

func (r *Redis) dial(ctx context.Context) (*conn, error) {
	d := net.Dialer{Timeout: dialTimeout}
	var nc net.Conn
	var err error
	if r.useTLS {
		td := &tls.Dialer{NetDialer: &d, Config: &tls.Config{ServerName: r.tlsName, MinVersion: tls.VersionTLS12}}
		nc, err = td.DialContext(ctx, "tcp", r.addr)
	} else {
		nc, err = d.DialContext(ctx, "tcp", r.addr)
	}
	if err != nil {
		return nil, err
	}
	c := &conn{nc: nc, br: bufio.NewReader(nc)}
	if r.password != "" {
		var args []string
		if r.username != "" {
			args = []string{"AUTH", r.username, r.password}
		} else {
			args = []string{"AUTH", r.password}
		}
		if _, err := r.exec(c, args...); err != nil {
			_ = nc.Close()
			return nil, err
		}
	}
	return c, nil
}

// get returns a pooled connection or dials a fresh one.
func (r *Redis) get(ctx context.Context) (*conn, error) {
	select {
	case c := <-r.pool:
		return c, nil
	default:
		return r.dial(ctx)
	}
}

func (r *Redis) put(c *conn) {
	if c == nil {
		return
	}
	select {
	case r.pool <- c:
	default:
		_ = c.nc.Close()
	}
}

// exec runs one command on a specific connection and returns the reply.
func (r *Redis) exec(c *conn, args ...string) (*resp.Reply, error) {
	_ = c.nc.SetDeadline(time.Now().Add(ioTimeout))
	if err := resp.Encode(c.nc, args...); err != nil {
		return nil, err
	}
	reply, err := resp.Decode(c.br)
	if err != nil {
		return nil, err
	}
	if err := reply.Err(); err != nil {
		return nil, err
	}
	return reply, nil
}

func (r *Redis) pingConn(c *conn) error {
	reply, err := r.exec(c, "PING")
	if err != nil {
		return err
	}
	if reply.Type == '+' && strings.EqualFold(reply.Str, "PONG") {
		return nil
	}
	return nil // any non-error reply means the server is talking
}

// Backend implements Ledger.
func (r *Redis) Backend() string { return "redis" }

// AddSpread pipelines N HINCRBYFLOAT commands + one EXPIRE in a single flush so
// an admit is one network round trip regardless of window size.
func (r *Redis) AddSpread(ctx context.Context, key string, startTimepoint int64, perTimepoint float64, n int) error {
	if perTimepoint == 0 || n <= 0 {
		return nil
	}
	c, err := r.get(ctx)
	if err != nil {
		return err
	}
	_ = c.nc.SetDeadline(time.Now().Add(ioTimeout))
	inc := strconv.FormatFloat(perTimepoint, 'f', -1, 64)
	// Pipeline: write all commands, then read all replies.
	for i := 0; i < n; i++ {
		field := strconv.FormatInt(startTimepoint+int64(i), 10)
		if err := resp.Encode(c.nc, "HINCRBYFLOAT", key, field, inc); err != nil {
			_ = c.nc.Close()
			return err
		}
	}
	if err := resp.Encode(c.nc, "EXPIRE", key, strconv.Itoa(ledgerTTLsec)); err != nil {
		_ = c.nc.Close()
		return err
	}
	for i := 0; i < n+1; i++ {
		reply, err := resp.Decode(c.br)
		if err != nil {
			_ = c.nc.Close()
			return err
		}
		if err := reply.Err(); err != nil {
			_ = c.nc.Close()
			return err
		}
	}
	r.put(c)
	return nil
}

// hgetall fetches the whole hash once and returns field→lcu.
func (r *Redis) hgetall(ctx context.Context, key string) (map[string]float64, error) {
	c, err := r.get(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := r.exec(c, "HGETALL", key)
	if err != nil {
		_ = c.nc.Close()
		return nil, err
	}
	r.put(c)
	raw, err := reply.MapStringString()
	if err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(raw))
	for k, v := range raw {
		f, ferr := strconv.ParseFloat(v, 64)
		if ferr != nil {
			continue
		}
		out[k] = f
	}
	return out, nil
}

// Future implements Ledger.
func (r *Redis) Future(ctx context.Context, key string, startTimepoint int64, horizon int) ([]float64, error) {
	buckets, err := r.hgetall(ctx, key)
	if err != nil {
		return nil, err
	}
	out := make([]float64, horizon)
	for i := 0; i < horizon; i++ {
		out[i] = buckets[strconv.FormatInt(startTimepoint+int64(i), 10)]
	}
	return out, nil
}

// LastHourLcu implements Ledger.
func (r *Redis) LastHourLcu(ctx context.Context, key string, startTimepoint int64) (float64, error) {
	buckets, err := r.hgetall(ctx, key)
	if err != nil {
		return 0, err
	}
	var sum float64
	for i := 0; i < hourTimepoints; i++ {
		sum += buckets[strconv.FormatInt(startTimepoint-int64(i), 10)]
	}
	return sum, nil
}

// Ping implements Ledger.
func (r *Redis) Ping(ctx context.Context) error {
	c, err := r.get(ctx)
	if err != nil {
		return err
	}
	if err := r.pingConn(c); err != nil {
		_ = c.nc.Close()
		return err
	}
	r.put(c)
	return nil
}

// Close drains and closes pooled connections.
func (r *Redis) Close() error {
	for {
		select {
		case c := <-r.pool:
			_ = c.nc.Close()
		default:
			return nil
		}
	}
}
