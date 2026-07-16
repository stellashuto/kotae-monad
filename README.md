# KOTAE

KOTAE is an AUSD-funded competition marketplace for finished AI work on Monad.
Requesters fund a brief once, creators submit completed outcomes, automated checks
filter invalid work, and the requester chooses the winner.

The hackathon MVP focuses on funded custom competitions for visuals, short videos,
static pages, and micro tools. The post-hackathon roadmap adds creator storefronts
where finished AI-assisted assets can be sold instantly at fixed AUSD prices.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The local server provides an in-memory API for the
prototype flow and does not send transactions or persist production data.

```bash
npm test
npm run contract:compile
npm run contract:test
npm run build
```

## Onchain

`contracts/src/KotaeEscrow.sol` defines `KotaeEscrow`, the source of truth for funds and contest
state. It is configured for a six-decimal ERC-20 such as AUSD. The Hardhat configuration targets
Monad Testnet (chain ID `10143`) and compiles for the Prague EVM target required by Monad.
The canonical Monad Testnet AUSD address is
`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`.

The contract implements payment locking, zero-submission cancellation, refundable
submission bonds, two replacements, eligibility-only oracle permissions,
requester-only winner selection, 85/5/10 settlement, and timeout settlement.

`npm run contract:test` deploys the escrow and a mock six-decimal token to an isolated local
chain, then executes cancellation, winner settlement, timeout, bond return, and replacement-limit
checks. Testnet deployment remains unpublished and is intentionally gated on local environment
values. Confirm the current hackathon-provided AUSD address, then set `PRIVATE_KEY`, `AUSD_ADDRESS`,
`PLATFORM_RECIPIENT`, and `ELIGIBILITY_ORACLE` outside Git before running:

```bash
npm run contract:deploy:testnet
```

## Production data

`.openai/hosting.json` requests D1 as `DB` and R2 as `UPLOADS`. The canonical
Worker API in `worker/index.js` keeps private originals in R2 and contest
metadata in D1. The fixed product rules are in `outputs/kotae-mvp-spec.md`.

Production writes use a one-time EIP-191 wallet challenge. Challenges and hashed
HTTP-only sessions are stored in D1; challenge reuse, expired sessions, and
cross-origin writes are rejected. `KOTAE_AUTH_MODE=demo` enables the legacy
`x-wallet-address` header only for local or private testing and must never be set
on a published deployment.

Every state-changing marketplace API also verifies a finalized Monad Testnet
receipt, its signer, the configured escrow address, and the expected contract
event before updating D1. Configure `MONAD_RPC_URL` and `KOTAE_ESCROW_ADDRESS`
through the runtime environment, and expose the deployed token through
`AUSD_ADDRESS`. A transaction hash can be recorded only once. In signature mode,
the browser's contest creation flow approves AUSD, calls `createContest`, waits
for Monad finality, and only then asks the API to record the matching event.
Eligibility updates additionally require `KOTAE_EVALUATOR_SECRET` with at least
32 characters and a matching onchain `EligibilityRecorded` event.

Apply `db/migrations/0002_wallet_auth_and_chain.sql` before running this Worker
against an existing database. The values expected for local configuration are
listed in `.env.example`; it intentionally contains no credentials.
