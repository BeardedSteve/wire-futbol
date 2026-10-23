// Package push sends web push notifications: RFC 8291 message encryption, RFC 8292 VAPID authentication,
// and the per-club subscription list.
package push

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
)

const recordSize = 4096

// encrypt builds an aes128gcm body (RFC 8188 framing, RFC 8291 keys) for one recipient.
// uaPublic is the subscription's p256dh key, authSecret its 16-byte auth secret.
// asPrivate and salt are normally random; tests pass fixed values.
func encrypt(plaintext, uaPublic, authSecret []byte, asPrivate *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(authSecret) != 16 {
		return nil, errors.New("auth secret must be 16 bytes")
	}
	if len(salt) != 16 {
		return nil, errors.New("salt must be 16 bytes")
	}
	ua, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("p256dh key: %w", err)
	}
	if asPrivate == nil {
		if asPrivate, err = ecdh.P256().GenerateKey(rand.Reader); err != nil {
			return nil, err
		}
	}
	asPublic := asPrivate.PublicKey().Bytes()
	shared, err := asPrivate.ECDH(ua)
	if err != nil {
		return nil, err
	}

	// RFC 8291 section 3.4: combine the ECDH secret with the auth secret, then derive the content key and nonce.
	keyInfo := "WebPush: info\x00" + string(uaPublic) + string(asPublic)
	prkKey, err := hkdf.Extract(sha256.New, shared, authSecret)
	if err != nil {
		return nil, err
	}
	ikm, err := hkdf.Expand(sha256.New, prkKey, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	// One record: the plaintext followed by the 0x02 last-record delimiter, no padding.
	if len(plaintext)+1+16 > recordSize {
		return nil, errors.New("payload too large for one record")
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	record := gcm.Seal(nil, nonce, append(append([]byte{}, plaintext...), 0x02), nil)

	header := make([]byte, 0, 16+4+1+len(asPublic))
	header = append(header, salt...)
	header = binary.BigEndian.AppendUint32(header, recordSize)
	header = append(header, byte(len(asPublic)))
	header = append(header, asPublic...)
	return append(header, record...), nil
}

// b64 decodes the unpadded URL-safe base64 that browsers use for subscription keys, accepting padding too.
func b64(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}
