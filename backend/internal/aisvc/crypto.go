package aisvc

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

// sealer encrypts provider API keys at rest.
type sealer struct{ aead cipher.AEAD }

func newSealer(master string) (*sealer, error) {
	if len(master) < 16 {
		return nil, errors.New("AI_MASTER_KEY must be at least 16 characters")
	}
	key := sha256.Sum256([]byte(master))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead}, nil
}

func (s *sealer) seal(plain string) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

func (s *sealer) open(box []byte) (string, error) {
	n := s.aead.NonceSize()
	if len(box) < n {
		return "", errors.New("ciphertext too short")
	}
	out, err := s.aead.Open(nil, box[:n], box[n:], nil)
	if err != nil {
		return "", errors.New("API kalitni ochib bo‘lmadi: AI_MASTER_KEY o‘zgarganmi?")
	}
	return string(out), nil
}

// maskKey keeps a recognisable prefix and the last 4 characters.
func maskKey(k string) string {
	if len(k) <= 8 {
		return "••••"
	}
	prefix := ""
	for _, p := range []string{"sk-proj-", "sk-", "AIza"} {
		if len(k) > len(p)+4 && k[:len(p)] == p {
			prefix = p
			break
		}
	}
	return prefix + "••••••••••••" + k[len(k)-4:]
}
