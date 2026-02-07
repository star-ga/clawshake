// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockVault
 * @notice Minimal ERC-4626 vault mock for testing YieldEscrow.
 *         Simulates yield accrual via an admin function that adds USDC to the vault.
 *         Shares are 1:1 with assets at deposit time; yield increases asset-per-share ratio.
 */
contract MockVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    uint256 private _totalAssets;

    constructor(address _underlying) ERC20("Mock Vault USDC", "mvUSDC") {
        underlying = IERC20(_underlying);
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    function totalAssets() public view returns (uint256) {
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        return (assets * supply) / _totalAssets;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return shares;
        return (shares * _totalAssets) / supply;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        if (totalSupply() == 0) shares = assets; // 1:1 for first deposit

        underlying.safeTransferFrom(msg.sender, address(this), assets);
        _totalAssets += assets;
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares) {
        shares = convertToShares(assets);
        _burn(owner_, shares);
        _totalAssets -= assets;
        underlying.safeTransfer(receiver, assets);
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        _burn(owner_, shares);
        _totalAssets -= assets;
        underlying.safeTransfer(receiver, assets);
    }

    /**
     * @notice Simulate yield accrual — admin adds USDC to vault (increases asset/share ratio)
     * @param amount USDC to add as simulated yield
     */
    function simulateYield(uint256 amount) external {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        _totalAssets += amount;
    }
}
