package store

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// AWS's published example: "GET Object" from the S3 Signature Version 4 documentation
// (examplebucket, test.txt, Range bytes=0-9, 24 May 2013).
func TestSignMatchesAWSExample(t *testing.T) {
	s := &S3{Region: "us-east-1", AccessKey: "AKIAIOSFODNN7EXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
	req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	s.sign(req, sha256Hex(nil), time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization\n got %s\nwant %s", got, want)
	}
}

func TestS3GetPutAgainstFakeBucket(t *testing.T) {
	objects := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
			w.WriteHeader(403)
			return
		}
		switch r.Method {
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = string(b)
		case "GET":
			v, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(404)
				return
			}
			io.WriteString(w, v)
		}
	}))
	defer srv.Close()
	s := &S3{Endpoint: srv.URL, Bucket: "b", Region: "auto", AccessKey: "key", SecretKey: "secret"}
	ctx := context.Background()
	if _, err := s.Get(ctx, "lfc/state.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing object: %v", err)
	}
	if err := s.Put(ctx, "lfc/state.json", []byte(`{"items":[]}`), "application/json"); err != nil {
		t.Fatal(err)
	}
	if _, ok := objects["/b/lfc/state.json"]; !ok {
		t.Fatalf("path-style key not used: %v", objects)
	}
	b, err := s.Get(ctx, "lfc/state.json")
	if err != nil || string(b) != `{"items":[]}` {
		t.Fatalf("get = %q, %v", b, err)
	}
}

func TestVirtualHostedURL(t *testing.T) {
	s := &S3{Endpoint: "https://t3.storageapi.dev", Bucket: "wire-store-abc", VirtualHosted: true}
	u, _ := s.objectURL("lfc/state.json")
	if u.String() != "https://wire-store-abc.t3.storageapi.dev/lfc/state.json" {
		t.Fatal(u)
	}
}

func TestDirRejectsEscapes(t *testing.T) {
	d := Dir(t.TempDir())
	ctx := context.Background()
	if err := d.Put(ctx, "../../escape.json", []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	b, err := d.Get(ctx, "escape.json") // cleaned to the root of the directory
	if err != nil || string(b) != "x" {
		t.Fatalf("got %q %v", b, err)
	}
	if _, err := d.Get(ctx, "nope.json"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestCopyIfAbsent(t *testing.T) {
	ctx := context.Background()
	s := Dir(t.TempDir())
	if ok, err := CopyIfAbsent(ctx, s, "state.json", "lfc/state.json", "application/json"); ok || err != nil {
		t.Fatalf("missing source: %v %v", ok, err)
	}
	s.Put(ctx, "state.json", []byte("old"), "application/json")
	if ok, err := CopyIfAbsent(ctx, s, "state.json", "lfc/state.json", "application/json"); !ok || err != nil {
		t.Fatalf("copy: %v %v", ok, err)
	}
	s.Put(ctx, "state.json", []byte("newer"), "application/json")
	if ok, _ := CopyIfAbsent(ctx, s, "state.json", "lfc/state.json", "application/json"); ok {
		t.Fatal("overwrote an existing copy")
	}
	if b, _ := s.Get(ctx, "lfc/state.json"); string(b) != "old" {
		t.Fatalf("lfc/state.json = %q", b)
	}
	if b, _ := s.Get(ctx, "state.json"); string(b) != "newer" {
		t.Fatal("source changed")
	}
}

func TestRetry(t *testing.T) {
	defer func(w []time.Duration) { retryWaits = w }(retryWaits)
	retryWaits = []time.Duration{0, 0, 0, 0}
	ctx := context.Background()
	calls := 0
	b, err := Retry(ctx, func() (string, error) {
		calls++
		if calls < 5 {
			return "", errors.New("HTTP 408")
		}
		return "ok", nil
	})
	if err != nil || b != "ok" || calls != 5 {
		t.Fatalf("got %q %v after %d calls", b, err, calls)
	}
	calls = 0
	if _, err := Retry(ctx, func() (string, error) { calls++; return "", ErrNotFound }); !errors.Is(err, ErrNotFound) || calls != 1 {
		t.Fatalf("not found: %v after %d calls", err, calls)
	}
	calls = 0
	if _, err := Retry(ctx, func() (string, error) { calls++; return "", errors.New("down") }); err == nil || calls != 5 {
		t.Fatalf("persistent failure: %v after %d calls", err, calls)
	}
}
