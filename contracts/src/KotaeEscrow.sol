// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title KotaeEscrow
/// @notice AUSD-funded creative competitions on Monad. AI/oracles can only mark
/// eligibility; requesters retain the exclusive right to select a winner.
contract KotaeEscrow {
    error Unauthorized();
    error InvalidState();
    error InvalidTerms();
    error TransferFailed();
    error Reentrancy();

    enum AssetType { PhotoVisual, StaticPage, MicroTool, ShortVideo }
    enum ContestStatus { Open, Cancelled, Settled, TimeoutSettled, RefundedNoValid }
    enum Eligibility { Checking, Valid, NeedsFix }

    struct Contest {
        address requester;
        AssetType assetType;
        ContestStatus status;
        uint40 submissionDeadline;
        uint40 judgingStartedAt;
        uint16 validCap;
        uint16 validCount;
        uint16 submissionCount;
        uint8 slotPacks;
        uint128 baseBudget;
        uint128 slotFees;
        bytes32 briefHash;
        uint256 winningSubmissionId;
    }

    struct Submission {
        uint256 contestId;
        address creator;
        uint40 submittedAt;
        uint8 version;
        Eligibility eligibility;
        uint128 bond;
        bytes32 contentHash;
    }

    IERC20 public immutable ausd;
    address public platformRecipient;
    address public eligibilityOracle;
    uint256 public nextContestId = 1;
    uint256 public nextSubmissionId = 1;
    uint256 private unlocked = 1;

    mapping(uint256 => Contest) public contests;
    mapping(uint256 => Submission) public submissions;
    mapping(uint256 => uint256[]) private contestSubmissions;
    mapping(uint256 => mapping(address => uint256)) public creatorSubmission;

    event ContestCreated(uint256 indexed contestId, address indexed requester, AssetType assetType, uint256 budget, uint256 deadline, bytes32 briefHash);
    event SlotsAdded(uint256 indexed contestId, uint16 newValidCap, uint256 fee);
    event ContestCancelled(uint256 indexed contestId, uint256 refund);
    event WorkSubmitted(uint256 indexed contestId, uint256 indexed submissionId, address indexed creator, uint8 version, bytes32 contentHash);
    event EligibilityRecorded(uint256 indexed contestId, uint256 indexed submissionId, Eligibility eligibility, bytes32 reasonHash);
    event ContestSettled(uint256 indexed contestId, uint256 indexed winnerSubmissionId, uint256 winnerAmount, uint256 participationPool, uint256 platformAmount);
    event TimeoutSettlement(uint256 indexed contestId, uint16 validCount, uint256 creatorPool, uint256 requesterRefund, uint256 platformAmount);
    event OracleUpdated(address indexed oracle);

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address ausdToken, address platform, address oracle) {
        if (ausdToken == address(0) || platform == address(0) || oracle == address(0)) revert InvalidTerms();
        ausd = IERC20(ausdToken);
        platformRecipient = platform;
        eligibilityOracle = oracle;
    }

    function createContest(
        AssetType assetType,
        uint128 baseBudget,
        uint40 submissionDeadline,
        uint16 validCap,
        bytes32 briefHash
    ) external nonReentrant returns (uint256 contestId) {
        uint256 minBudget = assetType == AssetType.PhotoVisual ? 2e6 : assetType == AssetType.ShortVideo ? 8e6 : assetType == AssetType.StaticPage ? 10e6 : 20e6;
        uint256 duration = submissionDeadline > block.timestamp ? submissionDeadline - block.timestamp : 0;
        uint16 defaultCap = assetType == AssetType.PhotoVisual ? 10 : 5;
        if (baseBudget < minBudget || duration < 1 hours || duration > 14 days || validCap != defaultCap || briefHash == bytes32(0)) revert InvalidTerms();
        _pull(msg.sender, baseBudget);
        contestId = nextContestId++;
        contests[contestId] = Contest({
            requester: msg.sender,
            assetType: assetType,
            status: ContestStatus.Open,
            submissionDeadline: submissionDeadline,
            judgingStartedAt: 0,
            validCap: validCap,
            validCount: 0,
            submissionCount: 0,
            slotPacks: 0,
            baseBudget: baseBudget,
            slotFees: 0,
            briefHash: briefHash,
            winningSubmissionId: 0
        });
        emit ContestCreated(contestId, msg.sender, assetType, baseBudget, submissionDeadline, briefHash);
    }

    function addSlotPack(uint256 contestId) external nonReentrant {
        Contest storage contest = contests[contestId];
        if (msg.sender != contest.requester) revert Unauthorized();
        if (contest.status != ContestStatus.Open || contest.slotPacks >= 3 || block.timestamp >= contest.submissionDeadline) revert InvalidState();
        uint256 fee = uint256(contest.baseBudget) / 10;
        _pull(msg.sender, fee);
        contest.slotPacks += 1;
        contest.validCap += 5;
        contest.slotFees += uint128(fee);
        emit SlotsAdded(contestId, contest.validCap, fee);
    }

    function cancelBeforeFirstSubmission(uint256 contestId) external nonReentrant {
        Contest storage contest = contests[contestId];
        if (msg.sender != contest.requester) revert Unauthorized();
        if (contest.status != ContestStatus.Open || contest.submissionCount != 0) revert InvalidState();
        contest.status = ContestStatus.Cancelled;
        uint256 refund = uint256(contest.baseBudget) + uint256(contest.slotFees);
        _push(contest.requester, refund);
        emit ContestCancelled(contestId, refund);
    }

    function submitWork(uint256 contestId, bytes32 contentHash) external nonReentrant returns (uint256 submissionId) {
        Contest storage contest = contests[contestId];
        if (contest.status != ContestStatus.Open || block.timestamp >= contest.submissionDeadline || msg.sender == contest.requester || contentHash == bytes32(0)) revert InvalidState();
        uint256 existingId = creatorSubmission[contestId][msg.sender];
        if (existingId != 0) {
            Submission storage existing = submissions[existingId];
            if (existing.version >= 3) revert InvalidState();
            if (existing.eligibility == Eligibility.Valid) contest.validCount -= 1;
            existing.version += 1;
            existing.contentHash = contentHash;
            existing.submittedAt = uint40(block.timestamp);
            existing.eligibility = Eligibility.Checking;
            emit WorkSubmitted(contestId, existingId, msg.sender, existing.version, contentHash);
            return existingId;
        }
        if (contest.submissionCount >= contest.validCap * 2) revert InvalidState();
        uint128 bond = contest.assetType == AssetType.PhotoVisual ? 5e5 : contest.assetType == AssetType.ShortVideo || contest.assetType == AssetType.StaticPage ? 1e6 : 2e6;
        _pull(msg.sender, bond);
        submissionId = nextSubmissionId++;
        submissions[submissionId] = Submission(contestId, msg.sender, uint40(block.timestamp), 1, Eligibility.Checking, bond, contentHash);
        creatorSubmission[contestId][msg.sender] = submissionId;
        contestSubmissions[contestId].push(submissionId);
        contest.submissionCount += 1;
        emit WorkSubmitted(contestId, submissionId, msg.sender, 1, contentHash);
    }

    function recordEligibility(uint256 submissionId, Eligibility eligibility, bytes32 reasonHash) external {
        if (msg.sender != eligibilityOracle) revert Unauthorized();
        if (eligibility == Eligibility.Checking) revert InvalidTerms();
        Submission storage submission = submissions[submissionId];
        Contest storage contest = contests[submission.contestId];
        if (contest.status != ContestStatus.Open || submission.creator == address(0)) revert InvalidState();
        if (submission.eligibility == Eligibility.Valid) contest.validCount -= 1;
        submission.eligibility = eligibility;
        if (eligibility == Eligibility.Valid) {
            if (contest.validCount >= contest.validCap) revert InvalidState();
            contest.validCount += 1;
            if (contest.validCount == contest.validCap && contest.judgingStartedAt == 0) contest.judgingStartedAt = uint40(block.timestamp);
        }
        emit EligibilityRecorded(submission.contestId, submissionId, eligibility, reasonHash);
    }

    function chooseWinner(uint256 contestId, uint256 winnerSubmissionId) external nonReentrant {
        Contest storage contest = contests[contestId];
        Submission storage winner = submissions[winnerSubmissionId];
        if (msg.sender != contest.requester) revert Unauthorized();
        if (!_judgingOpen(contest) || block.timestamp > _judgingDeadline(contest)) revert InvalidState();
        if (winner.contestId != contestId || winner.eligibility != Eligibility.Valid) revert InvalidTerms();
        contest.status = ContestStatus.Settled;
        contest.winningSubmissionId = winnerSubmissionId;

        uint256 baseWinner = uint256(contest.baseBudget) * 85 / 100;
        uint256 baseParticipation = uint256(contest.baseBudget) * 5 / 100;
        uint256 basePlatform = uint256(contest.baseBudget) - baseWinner - baseParticipation;
        uint256 addParticipation = uint256(contest.slotFees) / 2;
        uint256 platformAmount = basePlatform + uint256(contest.slotFees) - addParticipation;
        uint256 participationPool = baseParticipation + addParticipation;
        uint256 winnerAmount = baseWinner;

        if (contest.validCount <= 1) {
            winnerAmount += participationPool;
            participationPool = 0;
        } else {
            uint256 share = participationPool / (contest.validCount - 1);
            uint256 paid;
            uint256[] storage ids = contestSubmissions[contestId];
            for (uint256 i; i < ids.length; ++i) {
                Submission storage item = submissions[ids[i]];
                if (item.eligibility == Eligibility.Valid && ids[i] != winnerSubmissionId) {
                    _push(item.creator, share);
                    paid += share;
                }
            }
            winnerAmount += participationPool - paid;
        }
        _push(winner.creator, winnerAmount);
        _push(platformRecipient, platformAmount);
        _returnBonds(contestId);
        emit ContestSettled(contestId, winnerSubmissionId, winnerAmount, participationPool, platformAmount);
    }

    function settleAfterTimeout(uint256 contestId) external nonReentrant {
        Contest storage contest = contests[contestId];
        if (contest.status != ContestStatus.Open || block.timestamp <= _judgingDeadline(contest)) revert InvalidState();
        uint256 baseCreators = uint256(contest.baseBudget) * 90 / 100;
        uint256 basePlatform = uint256(contest.baseBudget) - baseCreators;
        uint256 addCreators = uint256(contest.slotFees) / 2;
        uint256 platformAmount = basePlatform + uint256(contest.slotFees) - addCreators;
        uint256 creatorPool = baseCreators + addCreators;
        uint256 refund;

        if (contest.validCount == 0) {
            contest.status = ContestStatus.RefundedNoValid;
            refund = creatorPool;
            _push(contest.requester, refund);
        } else {
            contest.status = ContestStatus.TimeoutSettled;
            uint256 share = creatorPool / contest.validCount;
            uint256 paid;
            uint256[] storage ids = contestSubmissions[contestId];
            for (uint256 i; i < ids.length; ++i) {
                Submission storage item = submissions[ids[i]];
                if (item.eligibility == Eligibility.Valid) { _push(item.creator, share); paid += share; }
            }
            platformAmount += creatorPool - paid;
        }
        _push(platformRecipient, platformAmount);
        _returnBonds(contestId);
        emit TimeoutSettlement(contestId, contest.validCount, creatorPool, refund, platformAmount);
    }

    function submissionIds(uint256 contestId) external view returns (uint256[] memory) { return contestSubmissions[contestId]; }

    function _judgingOpen(Contest storage contest) internal view returns (bool) {
        return contest.status == ContestStatus.Open && (block.timestamp >= contest.submissionDeadline || contest.validCount == contest.validCap);
    }

    function _judgingDeadline(Contest storage contest) internal view returns (uint256) {
        uint256 start = contest.judgingStartedAt == 0 ? contest.submissionDeadline : contest.judgingStartedAt;
        return start + 48 hours;
    }

    function _returnBonds(uint256 contestId) internal {
        uint256[] storage ids = contestSubmissions[contestId];
        for (uint256 i; i < ids.length; ++i) {
            Submission storage item = submissions[ids[i]];
            uint256 amount = item.bond;
            if (amount != 0) { item.bond = 0; _push(item.creator, amount); }
        }
    }

    function _pull(address from, uint256 amount) internal { if (!ausd.transferFrom(from, address(this), amount)) revert TransferFailed(); }
    function _push(address to, uint256 amount) internal { if (amount != 0 && !ausd.transfer(to, amount)) revert TransferFailed(); }
}
