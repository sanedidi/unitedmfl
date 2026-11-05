package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// webNotifier tells the Next.js site to drop its cached API data after any
// change made through the admin. Notifications are coalesced: a burst of
// edits (e.g. a protocol import) results in a single request.
type webNotifier struct {
	url, secret string
	kick        chan struct{}
	client      *http.Client
}

func newWebNotifier(url, secret string) *webNotifier {
	if url == "" || secret == "" {
		return nil
	}
	n := &webNotifier{url: url, secret: secret, kick: make(chan struct{}, 1), client: &http.Client{Timeout: 5 * time.Second}}
	go n.loop()
	return n
}

func (n *webNotifier) notify() {
	if n == nil {
		return
	}
	select {
	case n.kick <- struct{}{}:
	default: // one is already pending
	}
}

func (n *webNotifier) loop() {
	for range n.kick {
		time.Sleep(300 * time.Millisecond) // coalesce bursts
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, n.url, strings.NewReader(""))
		req.Header.Set("Authorization", "Bearer "+n.secret)
		res, err := n.client.Do(req)
		if err != nil {
			slog.Warn("web revalidate failed", "err", err)
		} else {
			res.Body.Close()
			if res.StatusCode >= 300 {
				slog.Warn("web revalidate failed", "status", res.StatusCode)
			}
		}
		cancel()
	}
}
