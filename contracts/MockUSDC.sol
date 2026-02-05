// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Test USDC for local development. On Base Sepolia we use the real Circle testnet USDC.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 10**6); // 1M USDC
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Faucet — mint test USDC to any address
    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
