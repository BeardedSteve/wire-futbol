// Package fetch is the outbound HTTP client for sources: per-request timeouts, retries with backoff on
// transient failures, and a cap on response size. Everything it returns is untrusted.
package fetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"time"
)

// BrowserUA is sent to news sites, some of which refuse unknown clients.
const BrowserUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

// StatusError is a non-2xx response.
type StatusError struct{ Code int }

func (e *StatusError) Error() string { return fmt.Sprintf("HTTP %d", e.Code) }

// Client fetches URLs.
type Client struct {
	HTTP     *http.Client
	UA       string
	Backoff  []time.Duration // waits before each retry; nil means 1s then 3s
	MaxBytes int64           // response cap; zero means 8 MB
	Timeout  time.Duration   // per attempt when the caller passes zero
	// Record, when set, receives every successful body. Used to save real responses as test fixtures.
	Record func(url string, body []byte)
}

func (c *Client) backoff() []time.Duration {
	if c.Backoff != nil {
		return c.Backoff
	}
	return []time.Duration{time.Second, 3 * time.Second}
}

// Get fetches url, retrying network errors, 429 and 5xx. timeout bounds each attempt.
func (c *Client) Get(ctx context.Context, url, accept string, timeout time.Duration) ([]byte, error) {
	if timeout == 0 {
		timeout = c.Timeout
	}
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	waits := c.backoff()
	for i := 0; ; i++ {
		b, err := c.once(ctx, url, accept, timeout)
		if err == nil {
			if c.Record != nil {
				c.Record(url, b)
			}
			return b, nil
		}
		if i >= len(waits) || !retryable(err) || ctx.Err() != nil {
			return nil, err
		}
		var jitter time.Duration
		if q := int64(waits[i]) / 4; q > 0 {
			jitter = time.Duration(rand.Int64N(q))
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(waits[i] + jitter):
		}
	}
}

var errTooLarge = errors.New("response too large")

func retryable(err error) bool {
	if errors.Is(err, errTooLarge) {
		return false
	}
	var se *StatusError
	if errors.As(err, &se) {
		return se.Code == http.StatusTooManyRequests || se.Code >= 500
	}
	return true // network errors and timeouts
}

func (c *Client) once(ctx context.Context, url, accept string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	ua := c.UA
	if ua == "" {
		ua = BrowserUA
	}
	req.Header.Set("User-Agent", ua)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	r, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode/100 != 2 {
		io.Copy(io.Discard, io.LimitReader(r.Body, 64<<10))
		return nil, &StatusError{Code: r.StatusCode}
	}
	max := c.MaxBytes
	if max == 0 {
		max = 8 << 20
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%w: over %d bytes", errTooLarge, max)
	}
	return b, nil
}

// Accept headers.
const (
	AcceptFeed = "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8"
	AcceptJSON = "application/json"
)
