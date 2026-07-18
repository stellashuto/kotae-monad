# KOTAE demo video script

Target length: **2 minutes 20 seconds**. Keep the uploaded video public.

## 0:00–0:20 — Personal problem

Show the KOTAE home page.

> I often need one small finished asset, not hours of prompting or an open-ended freelancer process. Paying before I can judge the result puts all the quality risk on me. KOTAE lets me fund the outcome instead.

## 0:20–0:40 — Explain the mechanism

Scroll through “How it works” and show the settlement split.

> I lock one AUSD budget on Monad Testnet. Creators compete with finished work and a refundable submission bond. Eligibility checks can reject broken or off-brief work, but only I can choose the winner.

## 0:40–1:20 — Create a live contest

Connect the wallet, show Monad Testnet, open “Start a contest,” and use a small 2 AUSD visual brief. Record both the AUSD approval and contest transaction confirmations.

> This is not a success-toast demo. The browser approves Testnet AUSD, calls the deployed escrow, waits for finality, and sends the transaction hash to the Worker. The Worker verifies the signer, contract, event, and terms before the contest appears.

## 1:20–1:50 — Submit finished work

From a second wallet, upload a small finished image and confirm the submission bond transaction.

> The finished file is stored privately. The public API exposes the onchain submission ID, not the storage key or original file. The requester and submitting creator can open the wallet-gated file.

## 1:50–2:10 — Choose and settle

Show the eligible entry, open the private file, and choose the outcome. Confirm the wallet transaction and show the receipt UI.

> The contract pays 85% to the winner, shares 5% with other eligible creators, and sends 10% to KOTAE. The eligibility oracle cannot choose the winner.

## 2:10–2:20 — Proof

Show the public GitHub repository and the contract address in the footer.

> KOTAE is live, public, open source, and deployed on Monad Testnet.
