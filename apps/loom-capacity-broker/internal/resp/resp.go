// Package resp is a tiny, dependency-free RESP2 (Redis serialization protocol)
// client — enough for the Loom Capacity Broker's ledger: AUTH, PING,
// HINCRBYFLOAT, HGETALL, EXPIRE, DEL. It exists so the whole service builds and
// tests OFFLINE with only the Go standard library (no go-redis download), and so
// the /admit hot path carries no heavyweight driver.
//
// The encode/decode logic is pure over io.Reader/io.Writer and is unit-tested
// with bytes.Buffer (no live Redis needed). Connection/TLS/pool concerns live in
// the ledger package's redis backend.
package resp

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// ErrProtocol is returned for a malformed server reply.
var ErrProtocol = errors.New("resp: protocol error")

// Encode writes a command as a RESP2 array of bulk strings:
//
//	*<n>\r\n  ($<len>\r\n<arg>\r\n)...
//
// This is the "inline unified request" every modern Redis accepts.
func Encode(w io.Writer, args ...string) error {
	bw := bufio.NewWriter(w)
	if _, err := fmt.Fprintf(bw, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, a := range args {
		if _, err := fmt.Fprintf(bw, "$%d\r\n%s\r\n", len(a), a); err != nil {
			return err
		}
	}
	return bw.Flush()
}

// Reply is a decoded RESP2 value. Exactly one of the typed accessors is valid,
// keyed by Type.
type Reply struct {
	// Type is one of '+' simple string, '-' error, ':' integer, '$' bulk string,
	// '*' array.
	Type  byte
	Str   string   // for '+', '-', '$'
	Int   int64    // for ':'
	Array []*Reply // for '*'
	Null  bool     // for a null bulk string ($-1) or null array (*-1)
}

// Decode reads one RESP2 reply from r.
func Decode(r *bufio.Reader) (*Reply, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	line, err := readLine(r)
	if err != nil {
		return nil, err
	}
	switch prefix {
	case '+':
		return &Reply{Type: '+', Str: line}, nil
	case '-':
		return &Reply{Type: '-', Str: line}, nil
	case ':':
		n, err := strconv.ParseInt(line, 10, 64)
		if err != nil {
			return nil, ErrProtocol
		}
		return &Reply{Type: ':', Int: n}, nil
	case '$':
		n, err := strconv.Atoi(line)
		if err != nil {
			return nil, ErrProtocol
		}
		if n < 0 {
			return &Reply{Type: '$', Null: true}, nil
		}
		buf := make([]byte, n+2) // payload + trailing CRLF
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return &Reply{Type: '$', Str: string(buf[:n])}, nil
	case '*':
		n, err := strconv.Atoi(line)
		if err != nil {
			return nil, ErrProtocol
		}
		if n < 0 {
			return &Reply{Type: '*', Null: true}, nil
		}
		arr := make([]*Reply, n)
		for i := 0; i < n; i++ {
			el, err := Decode(r)
			if err != nil {
				return nil, err
			}
			arr[i] = el
		}
		return &Reply{Type: '*', Array: arr}, nil
	default:
		return nil, ErrProtocol
	}
}

// readLine reads up to and consuming a trailing CRLF, returning the line without it.
func readLine(r *bufio.Reader) (string, error) {
	s, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	// Strip trailing \r\n (or a lone \n defensively).
	s = trimCRLF(s)
	return s, nil
}

func trimCRLF(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

// Err returns a non-nil error if the reply is a RESP error (-...).
func (r *Reply) Err() error {
	if r != nil && r.Type == '-' {
		return fmt.Errorf("resp: server error: %s", r.Str)
	}
	return nil
}

// MapStringString interprets an HGETALL array reply as a field→value map.
func (r *Reply) MapStringString() (map[string]string, error) {
	if r == nil || r.Type != '*' {
		if r != nil && r.Null {
			return map[string]string{}, nil
		}
		return nil, ErrProtocol
	}
	if len(r.Array)%2 != 0 {
		return nil, ErrProtocol
	}
	m := make(map[string]string, len(r.Array)/2)
	for i := 0; i+1 < len(r.Array); i += 2 {
		m[r.Array[i].Str] = r.Array[i+1].Str
	}
	return m, nil
}
