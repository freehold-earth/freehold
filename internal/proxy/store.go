package proxy

import (
	"crypto/sha256"
	"sync"

	"github.com/freehold-earth/freehold/internal/terms"
)

// store is a bounded set of terms, keyed by their hash.
// It is safe for concurrent use.
// When it is full, adding terms evicts the terms it has held longest.
type store struct {
	// held maps each hash to its terms.
	held map[[sha256.Size]byte]*terms.Terms

	// limit is the maximum number of terms the store holds.
	limit int

	// mu guards held and order.
	mu sync.Mutex

	// order lists the hashes of the held terms, oldest first.
	order [][sha256.Size]byte
}

// newStore returns an empty store that holds at most limit terms.
func newStore(limit int) *store {
	return &store{held: make(map[[sha256.Size]byte]*terms.Terms), limit: limit}
}

// get returns the terms with the given hash, and whether the store holds them.
func (s *store) get(hash [sha256.Size]byte) (*terms.Terms, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	t, ok := s.held[hash]

	return t, ok
}

// put adds t to the store under its hash.
func (s *store) put(t *terms.Terms) {
	s.mu.Lock()
	defer s.mu.Unlock()

	hash := t.Hash()
	if _, ok := s.held[hash]; ok {
		return
	}
	if len(s.order) >= s.limit {
		delete(s.held, s.order[0])
		s.order = s.order[1:]
	}
	s.held[hash] = t
	s.order = append(s.order, hash)
}
