package fetch

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRetriesTransientFailures(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) < 3 {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer srv.Close()
	c := &Client{Backoff: []time.Duration{time.Millisecond, time.Millisecond}}
	b, err := c.Get(context.Background(), srv.URL, "", time.Second)
	if err != nil || string(b) != "ok" || n.Load() != 3 {
		t.Fatalf("got %q %v after %d tries", b, err, n.Load())
	}
}

func TestDoesNotRetryClientErrors(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { n.Add(1); w.WriteHeader(404) }))
	defer srv.Close()
	c := &Client{Backoff: []time.Duration{time.Millisecond}}
	_, err := c.Get(context.Background(), srv.URL, "", time.Second)
	var se *StatusError
	if !errors.As(err, &se) || se.Code != 404 || n.Load() != 1 {
		t.Fatalf("err %v after %d tries", err, n.Load())
	}
}

func TestTimeoutAndSizeCap(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer slow.Close()
	c := &Client{Backoff: []time.Duration{}}
	start := time.Now()
	if _, err := c.Get(context.Background(), slow.URL, "", 50*time.Millisecond); err == nil || time.Since(start) > time.Second {
		t.Fatalf("timeout not applied: %v", err)
	}
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(strings.Repeat("x", 2000))) }))
	defer big.Close()
	c = &Client{MaxBytes: 1000, Backoff: []time.Duration{}}
	if _, err := c.Get(context.Background(), big.URL, "", time.Second); err == nil {
		t.Fatal("oversized body accepted")
	}
}
