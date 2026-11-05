// Package live fans out match updates to Server-Sent-Events subscribers.
package live

import "sync"

// Hub keeps subscribers per match.
type Hub struct {
	mu   sync.RWMutex
	subs map[int64]map[chan []byte]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[int64]map[chan []byte]struct{}{}} }

// Subscribe registers a listener for a match; call the returned func to unsubscribe.
func (h *Hub) Subscribe(matchID int64) (<-chan []byte, func()) {
	ch := make(chan []byte, 8)
	h.mu.Lock()
	if h.subs[matchID] == nil {
		h.subs[matchID] = map[chan []byte]struct{}{}
	}
	h.subs[matchID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs[matchID], ch)
		if len(h.subs[matchID]) == 0 {
			delete(h.subs, matchID)
		}
		h.mu.Unlock()
		close(ch)
	}
}

// Publish sends a payload to every subscriber; slow subscribers drop messages.
func (h *Hub) Publish(matchID int64, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[matchID] {
		select {
		case ch <- payload:
		default:
		}
	}
}

// Count returns the number of subscribers of a match.
func (h *Hub) Count(matchID int64) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[matchID])
}
