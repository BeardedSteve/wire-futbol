package store

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// S3 is a bucket reached over the S3 API, signed with AWS Signature Version 4.
type S3 struct {
	Endpoint      string // e.g. https://t3.storageapi.dev
	Bucket        string
	Region        string
	AccessKey     string
	SecretKey     string
	VirtualHosted bool // bucket in the hostname rather than the path
	Client        *http.Client
	now           func() time.Time
}

const maxObject = 32 << 20

func (s *S3) objectURL(key string) (*url.URL, error) {
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("bad S3_ENDPOINT %q", s.Endpoint)
	}
	if s.VirtualHosted {
		if !strings.HasPrefix(u.Host, s.Bucket+".") {
			u.Host = s.Bucket + "." + u.Host
		}
		u.Path = "/" + key
	} else {
		u.Path = strings.TrimSuffix("/"+s.Bucket+"/"+key, "/") // the bucket itself, for a list, has no trailing slash
	}
	return u, nil
}

func (s *S3) do(ctx context.Context, method, key string, body []byte, contentType string) (*http.Response, error) {
	return s.doQuery(ctx, method, key, nil, body, contentType)
}

func (s *S3) doQuery(ctx context.Context, method, key string, query url.Values, body []byte, contentType string) (*http.Response, error) {
	u, err := s.objectURL(key)
	if err != nil {
		return nil, err
	}
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	now := time.Now
	if s.now != nil {
		now = s.now
	}
	s.sign(req, sha256Hex(body), now().UTC())
	c := s.Client
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	return c.Do(req)
}

func (s *S3) Get(ctx context.Context, key string) ([]byte, error) {
	r, err := s.do(ctx, http.MethodGet, key, nil, "")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if r.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(r.Body, 300))
		return nil, fmt.Errorf("get %s: HTTP %d %s", key, r.StatusCode, msg)
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxObject+1))
	if err == nil && len(b) > maxObject {
		return nil, fmt.Errorf("get %s: object over %d bytes", key, maxObject)
	}
	return b, err
}

func (s *S3) Put(ctx context.Context, key string, body []byte, contentType string) error {
	r, err := s.do(ctx, http.MethodPut, key, body, contentType)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(r.Body, 300))
		return fmt.Errorf("put %s: HTTP %d %s", key, r.StatusCode, msg)
	}
	return nil
}

// Delete removes an object. A missing object is not an error.
func (s *S3) Delete(ctx context.Context, key string) error {
	r, err := s.do(ctx, http.MethodDelete, key, nil, "")
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode/100 != 2 && r.StatusCode != http.StatusNotFound {
		msg, _ := io.ReadAll(io.LimitReader(r.Body, 300))
		return fmt.Errorf("delete %s: HTTP %d %s", key, r.StatusCode, msg)
	}
	return nil
}

// List returns the keys that start with prefix, in key order.
func (s *S3) List(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	q := url.Values{"list-type": {"2"}, "prefix": {prefix}}
	for {
		r, err := s.doQuery(ctx, http.MethodGet, "", q, nil, "")
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, maxObject))
		r.Body.Close()
		if err != nil {
			return nil, err
		}
		if r.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("list %s: HTTP %d %s", prefix, r.StatusCode, clipBytes(b, 300))
		}
		var page struct {
			Contents []struct {
				Key string
			}
			IsTruncated           bool
			NextContinuationToken string
		}
		if err := xml.Unmarshal(b, &page); err != nil {
			return nil, fmt.Errorf("list %s: %w", prefix, err)
		}
		for _, c := range page.Contents {
			keys = append(keys, c.Key)
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return keys, nil
		}
		q.Set("continuation-token", page.NextContinuationToken)
	}
}

func clipBytes(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}

// sign adds SigV4 headers. Every header already on the request is signed, plus host and the x-amz headers.
func (s *S3) sign(req *http.Request, payloadHash string, t time.Time) {
	amzDate := t.Format("20060102T150405Z")
	day := t.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	headers := map[string]string{"host": req.URL.Host}
	for k, v := range req.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ",")
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + strings.TrimSpace(headers[k]) + "\n")
	}
	signed := strings.Join(names, ";")

	canonical := strings.Join([]string{
		req.Method,
		encodePath(req.URL.Path),
		canonicalQuery(req.URL.Query()),
		canonHeaders.String(),
		signed,
		payloadHash,
	}, "\n")
	scope := day + "/" + s.Region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonical))

	k := hmacSHA256([]byte("AWS4"+s.SecretKey), day)
	k = hmacSHA256(k, s.Region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", s.AccessKey, scope, signed, sig))
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// encodePath escapes each segment as S3 expects: everything except unreserved characters, slashes kept.
func encodePath(p string) string {
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = uriEncode(s)
	}
	return strings.Join(segs, "/")
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k)+"="+uriEncode(v))
		}
	}
	return strings.Join(parts, "&")
}

func uriEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
