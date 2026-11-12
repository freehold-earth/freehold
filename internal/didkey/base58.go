package didkey

import (
	"math/big"
	"slices"
	"strings"
)

// base58Alphabet is the Bitcoin base58 alphabet, the one did:key uses.
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58Radix is the number of digits in the alphabet, as the big integer the arithmetic needs.
var base58Radix = big.NewInt(int64(len(base58Alphabet)))

// base58Decode returns the bytes text encodes, and false if a character is outside the alphabet.
func base58Decode(text string) ([]byte, bool) {
	value := new(big.Int)
	for _, char := range text {
		digit := strings.IndexRune(base58Alphabet, char)
		if digit < 0 {
			return nil, false
		}
		value.Mul(value, base58Radix)
		value.Add(value, big.NewInt(int64(digit)))
	}

	// Each leading zero digit stands for one leading zero byte, which the integer cannot hold.
	zeros := len(text) - len(strings.TrimLeft(text, base58Alphabet[:1]))

	return append(make([]byte, zeros), value.Bytes()...), true
}

// base58Encode returns data in base58.
func base58Encode(data []byte) string {
	// Each leading zero byte is written as one leading zero digit, which the integer cannot hold.
	zeros := 0
	for zeros < len(data) && data[zeros] == 0 {
		zeros++
	}

	// Digits come out least significant first.
	var digits []byte
	value := new(big.Int).SetBytes(data)
	remainder := new(big.Int)
	for value.Sign() > 0 {
		value.DivMod(value, base58Radix, remainder)
		digits = append(digits, base58Alphabet[remainder.Int64()])
	}

	var out strings.Builder
	out.WriteString(strings.Repeat(base58Alphabet[:1], zeros))
	for _, digit := range slices.Backward(digits) {
		out.WriteByte(digit)
	}

	return out.String()
}
