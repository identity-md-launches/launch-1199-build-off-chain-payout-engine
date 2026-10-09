// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Independent executable specification for off-chain integer accounting.
/// The production service is TypeScript; npm test exercises its actual implementation.
contract MoneyBackRulesTest {
    uint256 constant Q96 = 1 << 96;

    function loss(uint256 cost, uint256 tokens, uint256 close) internal pure returns (uint256) {
        if (tokens == 0) return 0;
        uint256 entry = cost * Q96 / tokens;
        return entry > close ? (entry - close) * tokens / Q96 : 0;
    }

    function cap(uint256 currentLoss, uint256 paid, uint256 reserved) internal pure returns (uint256) {
        uint256 used = paid + reserved;
        if (used >= currentLoss) return 0;
        uint256 remaining = currentLoss - used;
        return currentLoss / 3 < remaining ? currentLoss / 3 : remaining;
    }

    function testCurrentLossAndMadeWhole() public pure {
        require(loss(1050, 100, Q96) == 950, "all-fee basis");
        require(cap(950, 0, 0) == 316, "one third");
        require(cap(950, 940, 0) == 10, "made whole");
        require(cap(950, 940, 10) == 0, "failed leg reserve");
        require(cap(1100, 950, 0) == 150, "new loss");
        require(loss(100, 100, 2 * Q96) == 0, "profitable holder");
    }

    function testFixtureFirstDropAndIntegerDust() public pure {
        uint256 aliceLoss = loss(1050, 100, Q96);
        uint256 bobLoss = loss(550, 100, Q96);
        uint256 pot = 425 + 100 / 4;
        uint256 alice = pot * aliceLoss / (aliceLoss + bobLoss);
        uint256 bob = pot * bobLoss / (aliceLoss + bobLoss);
        require(alice == 305 && bob == 144, "fixture pro rata amounts");
        require(alice <= cap(aliceLoss, 0, 0) && bob <= cap(bobLoss, 0, 0), "caps");
        require(pot - alice - bob == 1, "rollover dust");
    }

    function testMinimumPayoutRollover() public pure {
        uint256 pot = 150 + 1;
        uint256 alice = pot * 950 / 1400;
        uint256 bob = pot * 450 / 1400;
        require(alice == 102 && bob == 48, "weighted amounts");
        uint256 minimum = 50;
        if (alice < minimum) alice = 0;
        if (bob < minimum) bob = 0;
        require(pot - alice - bob == 49, "skipped legs roll");
        require(loss(1600, 200, Q96) == 1400, "additional buy VWAP");
    }

    function testTreasurySplitSkimReserve() public pure {
        uint256 distributor = 100;
        uint256 hook = 425;
        uint256 pouch = hook + distributor / 4;
        uint256 team = distributor - distributor / 4;
        uint256 ops = pouch / 10;
        uint256 reserve = 100;
        uint256 pot = pouch - ops - reserve;
        require(team == 75 && ops == 45 && pot == 305, "locked revenue rules");
        require(pot + team + ops + reserve == hook + distributor, "conservation");
    }

    function testEpochAndChunkIds() public pure {
        uint256 launchTs = 1000;
        require((1900 - launchTs) / 900 == 1, "fixed grid");
        uint256 recipients = 401;
        require((recipients + 199) / 200 == 3, "chunk limit");
        require(12 * 1000 + 2 == 12002, "round ID");
        require(12 * 1000 + 999 < 13 * 1000, "disjoint IDs");
    }

    function testFuzzCapsNeverOverpay(uint128 currentLoss, uint128 alreadyPaid, uint128 reserved) public pure {
        uint256 amount = cap(currentLoss, alreadyPaid, reserved);
        require(amount <= uint256(currentLoss) / 3, "round cap");
        uint256 used = uint256(alreadyPaid) + reserved;
        if (used >= currentLoss) require(amount == 0, "fully covered");
        else require(amount + used <= currentLoss, "cumulative cap");
    }

    function testFuzzSplitConservesEveryWei(uint128 receipt) public pure {
        uint256 pouch = uint256(receipt) / 4;
        uint256 team = uint256(receipt) - pouch;
        require(pouch + team == receipt, "receipt conserved");
        require(pouch * 4 <= receipt && team >= pouch * 3, "round dust to team");
    }

    function testFuzzWeightSplitNeverExceedsPot(uint96 pot, uint64 firstLoss, uint64 secondLoss) public pure {
        uint256 weight = uint256(firstLoss) + secondLoss;
        if (weight == 0) return;
        uint256 first = uint256(pot) * firstLoss / weight;
        uint256 second = uint256(pot) * secondLoss / weight;
        require(first + second <= pot, "pot conserved");
        require(uint256(pot) - first - second < 2, "at most one rounding wei");
    }
}
