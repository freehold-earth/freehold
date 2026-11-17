package proxy

import (
	"crypto/sha256"
	"sync"

	"github.com/freehold-earth/freehold/internal/terms"
)

// store holds the terms the proxy has been sent, by their hash, up to a fixed number of them. It is safe for use by
// several goroutines at once.
//
// When it is full, the terms it has held longest make way. An agent whose terms have gone is asked for them again.
type store struct {
	// held are the terms, by hash.
	held map[[sha256.Size]byte]*terms.Terms

	// limit is the most terms the store holds.
	limit int

	// mu guards held and order.
	mu sync.Mutex

	// order are the hashes of the terms held, oldest first.
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

// put holds t under its hash.
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
