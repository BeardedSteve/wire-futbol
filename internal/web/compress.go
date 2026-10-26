package web

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

func acceptsGzip(r *http.Request) bool {
	for _, p := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.TrimSpace(strings.SplitN(p, ";", 2)[0]) == "gzip" && !strings.Contains(p, "q=0") {
			return true
		}
	}
	return false
}

func gzipped(b []byte) []byte {
	var buf bytes.Buffer
	z, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	z.Write(b)
	z.Close()
	return buf.Bytes()
}

var gzPool = sync.Pool{New: func() any { z, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed); return z }}

// compress gzips HTML, CSS, JavaScript and JSON responses for clients that accept it. Static assets arrive already
// compressed, so they pass through.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		g := &gzWriter{ResponseWriter: w}
		defer g.close()
		next.ServeHTTP(g, r)
	})
}

type gzWriter struct {
	http.ResponseWriter
	z       *gzip.Writer
	decided bool
}

func (g *gzWriter) decide() {
	if g.decided {
		return
	}
	g.decided = true
	h := g.Header()
	ct := h.Get("Content-Type")
	if h.Get("Content-Encoding") != "" || !(strings.HasPrefix(ct, "text/") || strings.HasPrefix(ct, "application/json") || strings.HasPrefix(ct, "application/manifest+json")) {
		return
	}
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	g.z = gzPool.Get().(*gzip.Writer)
	g.z.Reset(g.ResponseWriter)
}

func (g *gzWriter) WriteHeader(code int) {
	if code != http.StatusNoContent && code != http.StatusNotModified && code >= 200 {
		g.decide()
	}
	g.decided = true
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzWriter) Write(b []byte) (int, error) {
	g.decide()
	if g.z != nil {
		return g.z.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzWriter) close() {
	if g.z != nil {
		g.z.Close()
		gzPool.Put(g.z)
	}
}
