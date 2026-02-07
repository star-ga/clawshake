// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title FeeOracle
 * @notice Dynamic protocol fee oracle — replaces static 2.5% fee with depth-adjusted pricing.
 *         Off-chain ODE solver (MindLang Remizov Theorem 6) computes optimal base fee;
 *         on-chain oracle applies depth premium for recursive hire chains.
 *
 * @dev Fee formula: feeBps = baseFee + (depth * depthPremiumBps)
 *      Base fee is updated by treasury after running the MIND solver.
 *      Deeper chains pay higher fees to account for cascading settlement risk.
 */
contract FeeOracle {

    // --- Custom Errors ---
    error NotTreasury();
    error FeeTooHigh();

    // --- State ---
    address public treasury;
    uint256 public baseFeeBps = 250;         // Default 2.5% (matches original static fee)
    uint256 public depthPremiumBps = 25;     // +0.25% per depth level
    uint256 public constant MAX_FEE_BPS = 1000; // Cap at 10%

    // --- Events ---
    event BaseFeeUpdated(uint256 oldFee, uint256 newFee);
    event DepthPremiumUpdated(uint256 oldPremium, uint256 newPremium);

    constructor(address _treasury) {
        treasury = _treasury;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /// @notice Update base fee — called by treasury after off-chain ODE solver runs
    /// @param newFeeBps New base fee in basis points
    function updateFee(uint256 newFeeBps) external onlyTreasury {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 old = baseFeeBps;
        baseFeeBps = newFeeBps;
        emit BaseFeeUpdated(old, newFeeBps);
    }

    /// @notice Update depth premium multiplier
    /// @param newPremiumBps Basis points added per depth level
    function updateDepthPremium(uint256 newPremiumBps) external onlyTreasury {
        uint256 old = depthPremiumBps;
        depthPremiumBps = newPremiumBps;
        emit DepthPremiumUpdated(old, newPremiumBps);
    }

    /// @notice Get the fee for a shake at a given chain depth
    /// @param shakeAmount USDC amount (used for future tiered fees, currently unused)
    /// @param chainDepth How deep in the recursive hire chain (0 = root)
    /// @return feeBps Total fee in basis points
    function getAdjustedFee(uint256 shakeAmount, uint256 chainDepth) external view returns (uint256 feeBps) {
        feeBps = baseFeeBps + (chainDepth * depthPremiumBps);
        if (feeBps > MAX_FEE_BPS) {
            feeBps = MAX_FEE_BPS;
        }
    }
}
