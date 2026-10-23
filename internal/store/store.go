// Package store reads and writes whole objects: a Railway bucket over the S3 API, or a local directory.
package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotFound means the object does not exist. Any other error means the store could not be read.
var ErrNotFound = errors.New("not found")

// Store holds named objects.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Put(ctx context.Context, key string, body []byte, contentType string) error
}

// FromEnv returns a bucket store when S3_BUCKET and S3_ACCESS_KEY_ID are set, otherwise a directory store at dir.
func FromEnv(getenv func(string) string, dir string) Store {
	if getenv("S3_BUCKET") != "" && getenv("S3_ACCESS_KEY_ID") != "" {
		region := getenv("S3_REGION")
		if region == "" {
			region = "auto"
		}
		return &S3{
			Endpoint:      strings.TrimSuffix(getenv("S3_ENDPOINT"), "/"),
			Bucket:        getenv("S3_BUCKET"),
			Region:        region,
			AccessKey:     getenv("S3_ACCESS_KEY_ID"),
			SecretKey:     getenv("S3_SECRET_ACCESS_KEY"),
			VirtualHosted: getenv("S3_VIRTUAL_HOSTED") == "true",
		}
	}
	return Dir(dir)
}

// Dir stores objects as files under a directory.
type Dir string

func (d Dir) path(key string) (string, error) {
	clean := filepath.Clean("/" + key)
	if clean == "/" {
		return "", errors.New("empty key")
	}
	return filepath.Join(string(d), clean), nil
}

func (d Dir) Get(_ context.Context, key string) ([]byte, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

func (d Dir) Put(_ context.Context, key string, body []byte, _ string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Retry runs fn up to four times, waiting 1, 4 and 12 seconds between attempts. A missing object is not retried.
func Retry[T any](ctx context.Context, fn func() (T, error)) (T, error) {
	waits := []time.Duration{time.Second, 4 * time.Second, 12 * time.Second}
	for i := 0; ; i++ {
		v, err := fn()
		if err == nil || errors.Is(err, ErrNotFound) || i == len(waits) {
			return v, err
		}
		select {
		case <-ctx.Done():
			return v, err
		case <-time.After(waits[i]):
		}
	}
}

// CopyIfAbsent copies from to to when to doesn't exist yet and from does. It never overwrites or deletes, so the
// source stays usable by whatever wrote it.
func CopyIfAbsent(ctx context.Context, s Store, from, to, contentType string) (bool, error) {
	if _, err := s.Get(ctx, to); !errors.Is(err, ErrNotFound) {
		return false, err
	}
	b, err := s.Get(ctx, from)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, s.Put(ctx, to, b, contentType)
}
