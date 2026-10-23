package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/store"
)

func must(t *testing.T, s string) []byte {
	t.Helper()
	b, err := b64(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// RFC 8291 section 5 worked example.
func TestEncryptMatchesRFC8291(t *testing.T) {
	asPriv, err := ecdh.P256().NewPrivateKey(must(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := encrypt(
		[]byte("When I grow up, I want to be a watermelon"),
		must(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
		must(t, "BTBZMqHH6r4Tts7J_aSIgg"),
		asPriv,
		must(t, "DGv6ra1nlYgDCS1FRnbzlw"),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if g := base64.RawURLEncoding.EncodeToString(got); g != want {
		t.Fatalf("ciphertext\n got %s\nwant %s", g, want)
	}
}

func TestVAPIDHeader(t *testing.T) {
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	enc := base64.RawURLEncoding
	v, err := NewVAPID(enc.EncodeToString(k.PublicKey().Bytes()), enc.EncodeToString(k.Bytes()), "mailto:test@example.com")
	if err != nil {
		t.Fatal(err)
	}
	h, err := v.header("https://fcm.googleapis.com/fcm/send/abc", time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.SplitN(strings.TrimPrefix(h, "vapid t="), ", k=", 2)
	if len(parts) != 2 || parts[1] != v.Public {
		t.Fatalf("header %q", h)
	}
	seg := strings.Split(parts[0], ".")
	claims, _ := enc.DecodeString(seg[1])
	var c map[string]any
	json.Unmarshal(claims, &c)
	if c["aud"] != "https://fcm.googleapis.com" || c["sub"] != "mailto:test@example.com" || c["exp"].(float64) != 1_800_000_000+12*3600 {
		t.Fatalf("claims %s", claims)
	}
	sig, _ := enc.DecodeString(seg[2])
	if len(sig) != 64 || !v.verify(seg[0]+"."+seg[1], sig) {
		t.Fatal("signature does not verify")
	}
	if _, err := NewVAPID(v.Public, enc.EncodeToString(make([]byte, 31)), ""); err == nil {
		t.Fatal("short private key accepted")
	}
}

func testSub(t *testing.T, endpoint string) Sub {
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	return Sub{Endpoint: endpoint, Keys: Keys{P256dh: base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()), Auth: base64.RawURLEncoding.EncodeToString(auth)}}
}

func TestValidate(t *testing.T) {
	good := testSub(t, "https://fcm.googleapis.com/fcm/send/abc")
	if err := Validate(good); err != nil {
		t.Fatal(err)
	}
	for _, ep := range []string{
		"https://web.push.apple.com/QGx",
		"https://updates.push.services.mozilla.com/wpush/v2/x",
		"https://wns2-db5p.notify.windows.com/w/?token=x",
	} {
		if err := Validate(testSub(t, ep)); err != nil {
			t.Errorf("%s: %v", ep, err)
		}
	}
	bad := []Sub{
		testSub(t, "http://fcm.googleapis.com/x"),
		testSub(t, "https://169.254.169.254/latest/meta-data"),
		testSub(t, "https://fcm.googleapis.com.evil.example/x"),
		testSub(t, "https://evilfcm.googleapis.com.example/x"),
		testSub(t, "https://user@fcm.googleapis.com/x"),
		testSub(t, "https://fcm.googleapis.com:8443/x"),
		{Endpoint: good.Endpoint, Keys: Keys{P256dh: "AAAA", Auth: good.Keys.Auth}},
		{Endpoint: good.Endpoint, Keys: Keys{P256dh: good.Keys.P256dh, Auth: "AAAA"}},
	}
	for _, s := range bad {
		if err := Validate(s); err == nil {
			t.Errorf("accepted %q", s.Endpoint)
		}
	}
}

func TestListNeverEvicts(t *testing.T) {
	ctx := context.Background()
	l := &List{Store: store.Dir(t.TempDir()), Key: "lfc/subs.json", Max: 2}
	a, b, c := testSub(t, "https://fcm.googleapis.com/a"), testSub(t, "https://fcm.googleapis.com/b"), testSub(t, "https://fcm.googleapis.com/c")
	if n, err := l.Add(ctx, a); !n || err != nil {
		t.Fatal(n, err)
	}
	if n, err := l.Add(ctx, b); !n || err != nil {
		t.Fatal(n, err)
	}
	if _, err := l.Add(ctx, c); !errors.Is(err, ErrFull) {
		t.Fatalf("third device: %v", err)
	}
	if n, err := l.Add(ctx, a); n || err != nil { // re-subscribing an existing device still works when full
		t.Fatal(n, err)
	}
	subs, _ := l.Load(ctx)
	if len(subs) != 2 || subs[0].Endpoint != b.Endpoint || subs[1].Endpoint != a.Endpoint {
		t.Fatalf("list %+v", subs)
	}
	if err := l.Remove(ctx, a.Endpoint); err != nil {
		t.Fatal(err)
	}
	if subs, _ = l.Load(ctx); len(subs) != 1 {
		t.Fatalf("after remove %+v", subs)
	}
}
