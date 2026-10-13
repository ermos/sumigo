package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
)

func newGCM(secret string) (cipher.AEAD, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *Store) encrypt(plain string) ([]byte, error) {
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.gcm.Seal(nonce, nonce, []byte(plain), nil), nil
}

func (s *Store) decrypt(enc []byte) (string, error) {
	n := s.gcm.NonceSize()
	if len(enc) < n {
		return "", errors.New("invalid ciphertext")
	}
	plain, err := s.gcm.Open(nil, enc[:n], enc[n:], nil)
	return string(plain), err
}
