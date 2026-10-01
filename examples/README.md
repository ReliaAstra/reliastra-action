# Examples

Runnable, not illustrative. Each one is a complete workflow you can copy into
`.github/workflows/` in a repository with no Reliastra account, because every
example here uses the public incident feed and needs no secret.

| Example | What it demonstrates |
|---|---|
| [`basic/`](basic) | The smallest useful setup: one step, no credentials |
| [`stripe/`](stripe) | Gate a deploy on a vendor incident, and archive the machine-readable record |
| [`openai/`](openai) | One gate across several vendors with a matrix |
| [`auth0/`](auth0) | Branch on outputs instead of relying on the exit code alone |
| [`cloudflare/`](cloudflare) | Consume the observation series to chart it yourself |
| [`fastapi/`](fastapi) | A FastAPI service whose CI verifies its own upstream dependency |
| [`go/`](go) | A Go service, same thing in Go |
| [`node/`](node) | A Node service, same thing in Node |

## The credentialed version

Every example above works with no account. Once you have a token, authenticated mode is a
one-line change and gives you a real observation instead of a public incident feed:

```yaml
      - uses: ReliaAstra/reliastra-action@v1
        with:
          dependency: <your dependency uuid>
          token: ${{ secrets.RELIASTRA_TOKEN }}
          fail-on: degraded,down
```

Create the token in the dashboard at [reliastra.com](https://reliastra.com) and store it as
a repository secret named `RELIASTRA_TOKEN`.

## Before you copy

Read [Two modes, two vocabularies](../README.md#two-modes-two-vocabularies). The exit codes
differ by mode and it is worth knowing which one you are relying on.