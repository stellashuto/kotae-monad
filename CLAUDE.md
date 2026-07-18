# KOTAE - Claude Code review handoff

## Review objective

Perform a final, evidence-based review of the KOTAE Spark hackathon submission. Focus on correctness, security, onchain/UI consistency, deployability, and whether the live product satisfies the stated hackathon requirements. Do not make changes until findings are reported and prioritized.

Review the current `master` HEAD. Commit `c9505c4` is the baseline before the final Claude-review fixes.

## Product summary

KOTAE is a funded competition marketplace for finished AI-assisted work:

1. A requester publishes a concrete brief and locks AUSD.
2. Creators submit finished work with a refundable bond.
3. An independent eligibility Oracle records deterministic file eligibility; it does not judge the creative brief.
4. After the deadline or valid-entry cap, only the requester chooses the creative winner.
5. The Monad Testnet contract settles the prize using the documented 85/5/10 split.

The important product boundary is intentional: the Oracle decides objective eligibility; the requester alone makes the subjective winner choice.

## Production references

- Web app: https://kotae-monad-spark.vercel.app/
- GitHub: https://github.com/stellashuto/kotae-monad
- Network: Monad Testnet, chain ID `10143`
- Escrow: `0x7a8806bfb0292d71081445c48595fdc45dac46cc`
- AUSD: `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`
- AUSD faucet: `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`
- Eligibility Oracle: `0x04f2aBCdE67e5162d1C811d8ac66216c99E34e87`
- Platform recipient: `0xE185cFb28854C66A2Fe7972608B3353cebDd8760`
- Deployment transaction: `0xbc92fab301a66cdca19d87e12b3b75f2d0691963a88aaeced59d51484daf449c`
- Current live contest: `contest_4487bf7d44314ae3a120c7b26027fc73`

## Architecture

- `public/`: dependency-light browser UI bundled by esbuild.
- `api/proxy.js`: Vercel serverless same-origin proxy.
- `worker/`: Sites/Cloudflare Worker API, wallet sessions, receipt verification, D1 records, and R2 private uploads.
- `contracts/src/KotaeEscrow.sol`: Monad escrow and settlement rules.
- `tests/`: application, security, settlement, and contract-boundary tests.
- `config/monad-testnet.json`: public Testnet addresses only.
- `.openai/hosting.json`: logical Sites project/D1/R2 bindings only.

Production uses Vercel for the public app and same-origin API surface. Vercel forwards `/api/*` to the public Sites Worker using `KOTAE_UPSTREAM_URL` and a secret `KOTAE_PROXY_SECRET`. The same secret is configured in the Sites runtime. Never print, commit, rotate, or replace hosted secrets during a read-only review.

## Latest changes to review

The current HEAD includes the following final-review fixes on top of `c9505c4`:

- Early-cap judging records the finalized Oracle transaction block time and uses that same `judgingStartedAt + 48h` window in Worker and UI phase calculations.
- Winner and timeout receipts display the actual Monad transaction hash with an explorer link; only local demo mode is labeled simulated.
- The Worker enforces the 4 MB limit, checks file signatures, rejects duplicate hashes, requires ownership attestation, and validates MP4/WebM duration at 30 seconds or less.
- The Oracle records either `VALID` or `NEEDS_FIX` from those deterministic server checks; it does not claim to review creative brief compliance.
- D1 schema/migration data now stores judging start, content hashes, video duration, and immutable hash history.
- Google Fonts were removed and CSP now permits only self-hosted styles/fonts.
- Static asset version advanced to `v20`.

## Verification already completed

- `npm test`: 28/28 passing.
- `npx hardhat run scripts/test-contract.mjs --no-compile`: 4/4 passing.
- `npm run build`: passing.
- `npm run build:vercel`: passing.
- `npm run readiness:testnet`: `ready: true`.
- Production `/api/health`: HTTP 200, signature wallet writes, chain ID 10143.
- Production `/api/contests`: HTTP 200 with one live contest.
- The previous production browser check on v19 showed the countdown, direct contest refresh, phase-gated winner button, wallet-gated private file, and no console errors. Verify v20 after deployment.
- Mobile browser check at approximately 390 px: no horizontal overflow; menu, Explore, How it works, and Dashboard work.
- Production dependency audit previously reported no production vulnerabilities. The development-only Hardhat tree reported three high advisories through `adm-zip`, with no available direct fix at the time of review.

## Priority review questions

Please report findings by severity (`P0`–`P3`) with file and line references.

1. Does `contestTiming()` in `public/app.js` match the phase constraints enforced by `KotaeEscrow.sol` and the Worker APIs in every status?
2. Can a non-requester, unauthenticated user, stale session, or forged proxy request select a winner or retrieve an R2 original?
3. Are wallet challenge replay protection, EIP-191 signer verification, origin validation, receipt finality, and contract/event validation complete?
4. Is the 4 MB browser cap enforced server-side as well, including replacement submissions and every asset type?
5. Can direct hash navigation, refresh, malformed contest IDs, or stale contests produce inconsistent state or an unsafe action button?
6. Does the CSP allow every production dependency while meaningfully reducing injection and framing risk?
7. Are the 85/5/10 distribution, bond returns, timeout paths, and rounding rules preserved for edge cases?
8. Is any public contest/submission response leaking private R2 keys, originals, secrets, or internal-only metadata?
9. Does the live app contain placeholder data, fake-success UI, dead controls, misleading copy, or hackathon-submission gaps?
10. Are README, demo script, Spark submission copy, public URL, contract address, and implementation mutually consistent?

## Review commands

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run build:vercel
npx.cmd hardhat run scripts/test-contract.mjs --no-compile
npm.cmd run readiness:testnet
git diff c9505c4..HEAD
```

The readiness command contacts Monad Testnet. Do not run deployment, funding, contest creation, submission, settlement, environment-variable, or secret-rotation commands during a read-only review.

## Working-tree note

Two existing files are intentionally untracked and were excluded from commit `c9505c4`:

- `scripts/demo-video-server.mjs`
- `scripts/demo-video.html`

Treat them as user-owned draft tooling. Do not delete, overwrite, stage, or include them in a review fix without explicit approval.

## Expected review output

Return:

1. Findings first, ordered by severity, with exact file/line references and a concrete failure scenario.
2. Any assumptions or items that could not be verified.
3. A short pass/fail checklist for hackathon readiness.
4. Recommended fixes, but no code changes until the user approves them.

If no actionable findings remain, state that explicitly and list residual risks rather than inventing issues.
