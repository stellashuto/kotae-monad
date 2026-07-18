$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech

$outputPath = Join-Path $PSScriptRoot '..\public\kotae-demo-voice.wav'
$narration = @'
Some people know the result they need, but cannot get A I to produce it. Others can create great A I assisted work, but have no brief or buyer. KOTAE matches them around one funded outcome, so requesters pay for the answer, not the attempts.

KOTAE is an onchain competition marketplace for finished AI-assisted work. A requester locks one A U S D budget on Monad Testnet. Creators submit completed outcomes with a refundable bond, and the requester chooses the result they actually want.

Quality control and taste are deliberately separate. Deterministic checks verify the uploaded file, and an independently controlled eligibility Oracle records objective compliance onchain. The Oracle cannot select a winner or redirect funds.

This live brief has three A U S D locked in the deployed escrow. A separate creator wallet submitted a finished twelve-hundred by twelve-hundred image. The public app now shows one onchain submission and one valid entry, backed by finalized Monad Testnet transactions.

The original file stays private and is wallet-gated to the requester and submitting creator. When judging opens, only the requester can select the winner. The contract pays eighty-five percent to the winner, shares five percent with eligible runners-up, and sends ten percent to KOTAE.

KOTAE is live, open source, and deployed on Monad Testnet. It buys the answer, not the attempts.
'@

$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    try {
        $culture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
        $speaker.SelectVoiceByHints(
            [System.Speech.Synthesis.VoiceGender]::NotSet,
            [System.Speech.Synthesis.VoiceAge]::NotSet,
            0,
            $culture
        )
    }
    catch { }
    $speaker.Rate = 0
    $speaker.Volume = 100
    $speaker.SetOutputToWaveFile($outputPath)
    $speaker.Speak($narration)
}
finally {
    $speaker.Dispose()
}

Write-Output $outputPath
