package resp

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestEncodeCommand(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, "HINCRBYFLOAT", "lcu:t:w", "12345", "1.25"); err != nil {
		t.Fatal(err)
	}
	want := "*4\r\n$12\r\nHINCRBYFLOAT\r\n$7\r\nlcu:t:w\r\n$5\r\n12345\r\n$4\r\n1.25\r\n"
	if buf.String() != want {
		t.Fatalf("encode mismatch:\n got %q\nwant %q", buf.String(), want)
	}
}

func decode(t *testing.T, s string) *Reply {
	t.Helper()
	r, err := Decode(bufio.NewReader(strings.NewReader(s)))
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return r
}

func TestDecodeSimpleString(t *testing.T) {
	r := decode(t, "+OK\r\n")
	if r.Type != '+' || r.Str != "OK" {
		t.Fatalf("got %+v", r)
	}
	if r.Err() != nil {
		t.Fatal("simple string should not be an error")
	}
}

func TestDecodeError(t *testing.T) {
	r := decode(t, "-WRONGTYPE bad\r\n")
	if r.Type != '-' || r.Err() == nil {
		t.Fatalf("expected error reply, got %+v", r)
	}
}

func TestDecodeInteger(t *testing.T) {
	r := decode(t, ":42\r\n")
	if r.Type != ':' || r.Int != 42 {
		t.Fatalf("got %+v", r)
	}
}

func TestDecodeBulkString(t *testing.T) {
	r := decode(t, "$5\r\nhello\r\n")
	if r.Type != '$' || r.Str != "hello" || r.Null {
		t.Fatalf("got %+v", r)
	}
}

func TestDecodeNullBulk(t *testing.T) {
	r := decode(t, "$-1\r\n")
	if r.Type != '$' || !r.Null {
		t.Fatalf("expected null bulk, got %+v", r)
	}
}

func TestDecodeArrayAndMap(t *testing.T) {
	// HGETALL-shaped reply: two field/value pairs.
	r := decode(t, "*4\r\n$5\r\n12345\r\n$4\r\n1.25\r\n$5\r\n12346\r\n$4\r\n2.50\r\n")
	if r.Type != '*' || len(r.Array) != 4 {
		t.Fatalf("got %+v", r)
	}
	m, err := r.MapStringString()
	if err != nil {
		t.Fatal(err)
	}
	if m["12345"] != "1.25" || m["12346"] != "2.50" {
		t.Fatalf("map mismatch: %+v", m)
	}
}

func TestDecodeBulkWithBinaryCRLF(t *testing.T) {
	// A bulk string whose payload itself contains CRLF must be length-honoured.
	payload := "a\r\nb"
	r := decode(t, "$4\r\n"+payload+"\r\n")
	if r.Str != payload {
		t.Fatalf("binary-safe bulk failed: got %q", r.Str)
	}
}
