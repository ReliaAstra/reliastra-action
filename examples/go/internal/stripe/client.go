// Package stripe is a minimal Stripe client.
//
// It deliberately does not decide whether Stripe is at fault when a call
// fails. It reports the status code and the latency it measured. Reliastra
// observes the same dependency independently, so a disagreement between this
// client and that observation is itself information.
package stripe

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

const (
	// DefaultAPI is the Stripe API root.
	DefaultAPI = "https://api.stripe.com/v1"

	// LatencyBudgetMS is the p95 budget for a charge request, in milliseconds.
	// The CI workflow greps this value so the gate and the code cannot drift.
	LatencyBudgetMS = 900

	// Timeout bounds every request.
	Timeout = 5 * time.Second
)

// Client is a thin Stripe client.
type Client struct {
	APIKey     string
	HTTPClient *http.Client
}

// New returns a Client with sane defaults.
func New(apiKey string) *Client {
	return &Client{
		APIKey:     apiKey,
		HTTPClient: &http.Client{Timeout: Timeout},
	}
}

// ChargeResult is what actually happened. It carries measurements, not verdicts.
type ChargeResult struct {
	StatusCode int
	Latency    time.Duration
	// ReachedTarget distinguishes "Stripe answered 503" from "we never got a
	// response", which are different failures with different owners.
	ReachedTarget bool
}

// Charge submits a charge and returns what was observed.
func (c *Client) Charge(ctx context.Context, amountCents int) (*ChargeResult, error) {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.APIKey, nil,
	)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.SetBasicAuth(c.APIKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	start := time.Now()
	resp, err := c.HTTPClient.Do(req)
	latency := time.Since(start)
	if err != nil {
		// ReachedTarget is false: nobody answered. This is not a Stripe outage.
		return &ChargeResult{StatusCode: 0, Latency: latency, ReachedTarget: false}, err
	}
	defer resp.Body.Close()

	return &ChargeResult{
		StatusCode:    resp.StatusCode,
		Latency:       latency,
		ReachedTarget: true,
	}, nil
}

// OverBudget reports whether the measurement exceeded the declared budget.
// It is a statement about latency, not about health.
func (r *ChargeResult) OverBudget() bool {
	return r.Latency.Milliseconds() >= LatencyBudgetMS
}