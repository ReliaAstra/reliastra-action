"""A FastAPI service that calls Stripe.

The only thing worth noting is that this code knows nothing about Reliastra.
Reliastra observes the dependency from the outside; this service does its own
work. That separation is deliberate: if the service's own health check and
Reliastra's observation agree, you have two independent records. If they
disagree, that disagreement is the signal.

The latency budget below is the one CI gates on.
"""

from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="charge-service", version="1.0.0")

STRIPE_API = os.environ.get("STRIPE_API", "https://api.stripe.com/v1")

# p95 latency budget for a charge request, in milliseconds.
# This exact number is the gate in ../reliastra.yml.
LATENCY_BUDGET_MS = 1200

TIMEOUT_SECONDS = 5.0


class Charge(BaseModel):
    amount_cents: int
    currency: str = "usd"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/charge")
async def charge(body: Charge) -> dict[str, object]:
    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="STRIPE_SECRET_KEY is not configured")

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{STRIPE_API}/charges",
            data={"amount": body.amount_cents, "currency": body.currency},
            headers={"Authorization": f"Bearer {key}"},
        )

    # Note what this code does NOT do: it does not retry, and it does not
    # interpret a 503 as a Stripe outage. It reports what it saw. Deciding
    # whether the vendor was at fault is what Reliastra does, independently.
    if response.status_code >= 500:
        raise HTTPException(status_code=502, detail="upstream returned an error")

    return {"status": "created", "latency_budget_ms": LATENCY_BUDGET_MS}