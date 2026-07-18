# KOTAE

**Buy the answer. Not the attempts.**

KOTAE is an AUSD-funded competition marketplace for finished AI-assisted work on Monad Testnet. A requester locks one budget, creators submit completed outcomes, deterministic preflight rejects broken files, and an onchain oracle records brief compliance before the requester chooses the winner.

- **Live app:** https://outcome-ausd-spark.shuto-kajita.chatgpt.site
- **Public repository:** https://github.com/stellashuto/kotae-monad
- **Network:** Monad Testnet (`10143`)
- **Contract:** [`0xa85De5e792A04B8449D1616415114aAF8eD7Ab54`](https://testnet.monadvision.com/address/0xa85De5e792A04B8449D1616415114aAF8eD7Ab54)

## Spark submission summary

**Name:** KOTAE

**Description:** An onchain marketplace where buyers fund a result and creators compete with finished work.

**Problem:** When I need a small poster, landing page, short video, or micro-tool, I either pay one person before seeing the result or sort through speculative AI attempts. The buyer carries the quality risk, while serious creators compete with spam and unclear payment promises.

**Solution:** KOTAE locks the requester's AUSD before work begins. Creators submit finished files with an onchain bond. Deterministic checks verify file integrity, format, size, and duplicate hashes; the configured oracle records objective brief compliance onchain. It cannot choose the winner. The requester keeps the creative decision, and the contract settles every AUSD according to fixed rules.

**Category:** Monad Testnet

## What is real

- Browser wallets authenticate with a one-time EIP-191 signature.
- Contest funding approves and locks real Testnet AUSD in `KotaeEscrow`.
- Contest creation, submissions, cancellation, slot packs, winner selection, and timeout settlement use wallet-signed Monad Testnet transactions.
- The Worker accepts a state change only after verifying the finalized receipt, signer, escrow address, expected event, and non-reused transaction hash.
- Contest state and wallet sessions persist in D1. Finished files stay private in R2 and are served only to the requester or submitting creator.
- The public app displays live D1 records. An empty database produces an honest empty state, not placeholder contests or fake balances.

## Settlement rules

- **85%** to the selected winner.
- **5%** shared by other eligible creators.
- **10%** to the platform.
- A requester can cancel for a full refund before the first submission.
- After the judging timeout, eligible creators are paid without requiring the requester; if no valid work exists, 90% returns to the requester.

## Three-minute judge path

1. Open the live app and connect a browser wallet on Monad Testnet.
2. Use **Get Testnet AUSD** if the wallet needs demo funds.
3. Open **Start a contest**, enter a brief, and fund it.
4. Confirm the AUSD approval and contest transaction in the wallet.
5. See the contest appear from the live API with its onchain contest ID.
6. From a creator wallet, submit a finished file and its bond.
7. From the oracle wallet, open the private file and record objective eligibility onchain.
8. From the requester wallet, choose the outcome after eligibility is recorded.

## Architecture

```text
Browser wallet
    | EIP-191 session + signed Testnet transactions
    v
KOTAE Worker --------> D1 (contests, sessions, verified tx hashes)
    |                 R2 (private finished files)
    | finalized receipt verification
    v
KotaeEscrow on Monad Testnet <----> AUSD
```

The eligibility oracle can record rule compliance but cannot select a winner or redirect funds. Creative choice remains with the requester.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. Local development uses an in-memory API and does not send transactions unless explicitly configured.

## Validate

```bash
npm test
npm run contract:compile
npm run contract:test
npm run readiness:testnet
npm run build
```

`npm run contract:test` deploys an isolated escrow and mock six-decimal token, then exercises cancellation, 85/5/10 payout, timeout settlement, bond return, and replacement limits. `npm run readiness:testnet` checks the deployed Testnet bytecode, token, roles, and storage declarations without requiring a signing key.

## Deployment

- Escrow: `0xa85De5e792A04B8449D1616415114aAF8eD7Ab54`
- Deployment transaction: `0xf3af3ece9f1fa15961becc0ae66de6aa4581fd78f12160caebfca8da15089f35`
- AUSD: `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`
- AUSD faucet: `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`
- Platform recipient and eligibility oracle: `0xE185cFb28854C66A2Fe7972608B3353cebDd8760`

Never commit a funded private key. Hosted secrets are managed outside the repository.

## Hackathon provenance

Spark runs from July 13 to July 19, 2026. KOTAE's first commit is dated July 16, 2026, and the repository preserves the implementation history rather than presenting a single final dump.

The ready-to-paste submission fields, demo recording plan, and social post copy are in [`docs/spark-submission.md`](docs/spark-submission.md), [`docs/demo-video-script.md`](docs/demo-video-script.md), and [`docs/social-post.md`](docs/social-post.md).
