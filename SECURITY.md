# Security policy

## Scope

Regulatory Radar is a coding-challenge project. There are no production systems behind it, no real user data and no credentials in the repository; the seed data is synthetic.

## Known limits

- No authentication or TLS: run it on a trusted network or behind a reverse proxy.
- API keys belong in `.env` (git-ignored); `.env.example` lists the variables without values.
- The agents' SQL tool uses a SELECT-only database role in a read-only transaction with a 5 s timeout; `fetch_url` only opens public pages.

## Reporting a vulnerability

Report suspected issues (for example a committed secret) privately to the repository owner, not in a public issue. Include a short description, steps to reproduce and the affected files.
