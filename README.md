# KOTAE

KOTAE is an AUSD-funded competition marketplace for finished AI work on Monad.
Requesters fund a brief once, creators submit completed outcomes, automated checks
filter invalid work, and the requester chooses the winner.

The hackathon MVP focuses on funded custom competitions for visuals, short videos,
static pages, and micro tools. The post-hackathon roadmap adds creator storefronts
where finished AI-assisted assets can be sold instantly at fixed AUSD prices.

## Run locally

Requires Node.js 22 or newer. No package installation is required.

```bash
npm run dev
```

Open `http://127.0.0.1:4173`. The local server provides an in-memory API so the
complete create → submit → check → select flow works without credentials.

```bash
npm test
npm run build
```

## Onchain

`contracts/src/KotaeEscrow.sol` defines `KotaeEscrow`, the source of truth for funds and contest
state. It is configured for a six-decimal ERC-20 such as AUSD. Monad Testnet AUSD:
`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (chain ID `10143`).

The contract implements payment locking, zero-submission cancellation, refundable
submission bonds, two replacements, eligibility-only oracle permissions,
requester-only winner selection, 85/5/10 settlement, and timeout settlement.

## Production data

`.openai/hosting.json` requests D1 as `DB` and R2 as `UPLOADS`. The Worker API in
`worker/index.ts` keeps private originals in R2 and contest metadata in D1.
The fixed product rules are in `outputs/kotae-mvp-spec.md`.
