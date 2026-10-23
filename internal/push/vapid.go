package push

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"time"
)

// VAPID identifies this server to push services (RFC 8292).
type VAPID struct {
	Public  string // base64url uncompressed P-256 point, as given to browsers
	Subject string // mailto: or https: contact
	key     *ecdsa.PrivateKey
}

// NewVAPID parses the key pair in the format the web-push npm package generates: base64url public point and private scalar.
func NewVAPID(public, private, subject string) (*VAPID, error) {
	pub, err := b64(public)
	if err != nil {
		return nil, fmt.Errorf("VAPID public key: %w", err)
	}
	d, err := b64(private)
	if err != nil || len(d) != 32 {
		return nil, errors.New("VAPID private key must be 32 bytes of base64url")
	}
	ek, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		return nil, fmt.Errorf("VAPID private key: %w", err)
	}
	if string(ek.PublicKey().Bytes()) != string(pub) {
		return nil, errors.New("VAPID public key does not match the private key")
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		return nil, err
	}
	return &VAPID{Public: public, Subject: subject, key: key}, nil
}

// header returns the Authorization header value for a push endpoint.
func (v *VAPID) header(endpoint string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	claims, _ := json.Marshal(map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": v.Subject,
	})
	enc := base64.RawURLEncoding
	unsigned := enc.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + enc.EncodeToString(claims)
	h := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, v.key, h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64) // JWS ES256 wants r and s as fixed 32-byte big-endian values
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + unsigned + "." + enc.EncodeToString(sig) + ", k=" + v.Public, nil
}

// verify checks a JWT this package signed. Used by tests.
func (v *VAPID) verify(jwt string, sig []byte) bool {
	h := sha256.Sum256([]byte(jwt))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(&v.key.PublicKey, h[:], r, s)
}
