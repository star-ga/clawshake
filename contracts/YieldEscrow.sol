// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IERC4626
 * @notice Minimal ERC-4626 vault interface for yield-bearing deposits
 */
interface IERC4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
}

/**
 * @title YieldEscrow
 * @notice Deposits idle escrowed USDC into an ERC-4626 vault to earn yield while locked.
 *
 * Yield distribution:
 *   80% → worker (reward for delivery)
 *   15% → requester (reward for locking capital)
 *    5% → protocol treasury
 */
contract YieldEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Errors ---
    error AmountZero();
    error VaultNotSet();
    error DepositNotFound();
    error AlreadyWithdrawn();
    error NotAuthorized();
    error NotTreasury();

    // --- Constants ---
    uint256 public constant WORKER_YIELD_BPS = 8000;    // 80%
    uint256 public constant REQUESTER_YIELD_BPS = 1500;  // 15%
    uint256 public constant PROTOCOL_YIELD_BPS = 500;    // 5%

    // --- State ---
    IERC20 public immutable usdc;
    IERC4626 public vault;
    address public treasury;

    struct YieldDeposit {
        address depositor;       // requester who funded the shake
        uint256 principal;       // original USDC deposited
        uint256 shares;          // ERC-4626 vault shares received
        uint48 depositedAt;
        bool withdrawn;
    }

    uint256 public nextDepositId;
    mapping(uint256 => YieldDeposit) public deposits;

    // --- Events ---
    event Deposited(uint256 indexed depositId, address indexed depositor, uint256 principal, uint256 shares);
    event Withdrawn(uint256 indexed depositId, uint256 principal, uint256 workerYield, uint256 requesterYield, uint256 protocolYield);
    event VaultUpdated(address indexed newVault);

    constructor(address _usdc, address _vault, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
        if (_vault != address(0)) {
            vault = IERC4626(_vault);
        }
    }

    // --- Admin ---

    function setVault(address _vault) external {
        if (msg.sender != treasury) revert NotTreasury();
        vault = IERC4626(_vault);
        emit VaultUpdated(_vault);
    }

    // --- Core ---

    /**
     * @notice Deposit USDC into the yield vault
     * @param amount USDC to deposit (6 decimals)
     * @return depositId Identifier for this yield deposit
     */
    function depositToVault(uint256 amount) external nonReentrant returns (uint256 depositId) {
        if (amount == 0) revert AmountZero();
        if (address(vault) == address(0)) revert VaultNotSet();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        usdc.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, address(this));

        depositId = nextDepositId++;
        deposits[depositId] = YieldDeposit({
            depositor: msg.sender,
            principal: amount,
            shares: shares,
            depositedAt: uint48(block.timestamp),
            withdrawn: false
        });

        emit Deposited(depositId, msg.sender, amount, shares);
    }

    /**
     * @notice Withdraw principal + yield from the vault
     * @dev Yield is split: 80% worker, 15% requester, 5% treasury
     * @param depositId The deposit to withdraw
     * @param worker Address of the worker to receive principal + worker yield
     */
    function withdrawFromVault(uint256 depositId, address worker) external nonReentrant {
        YieldDeposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert DepositNotFound();
        if (d.withdrawn) revert AlreadyWithdrawn();
        if (msg.sender != d.depositor && msg.sender != treasury) revert NotAuthorized();

        d.withdrawn = true;

        // Redeem all shares
        uint256 totalAssets = vault.redeem(d.shares, address(this), address(this));

        // Calculate yield (handle vault losses gracefully)
        uint256 yieldEarned = 0;
        if (totalAssets > d.principal) {
            yieldEarned = totalAssets - d.principal;
        }

        // Split yield 80/15/5
        uint256 workerYield = (yieldEarned * WORKER_YIELD_BPS) / 10000;
        uint256 requesterYield = (yieldEarned * REQUESTER_YIELD_BPS) / 10000;
        uint256 protocolYield = yieldEarned - workerYield - requesterYield; // remainder to treasury

        // Transfer: worker gets principal + 80% yield
        uint256 workerAmount = d.principal + workerYield;
        if (workerAmount > 0) {
            usdc.safeTransfer(worker, workerAmount);
        }

        // Requester gets 15% yield
        if (requesterYield > 0) {
            usdc.safeTransfer(d.depositor, requesterYield);
        }

        // Treasury gets 5% yield
        if (protocolYield > 0) {
            usdc.safeTransfer(treasury, protocolYield);
        }

        emit Withdrawn(depositId, d.principal, workerYield, requesterYield, protocolYield);
    }

    // --- View Functions ---

    /**
     * @notice Get accrued yield for a deposit
     */
    function getAccruedYield(uint256 depositId) external view returns (uint256) {
        YieldDeposit storage d = deposits[depositId];
        if (d.depositor == address(0)) revert DepositNotFound();
        if (d.withdrawn) return 0;

        uint256 currentValue = vault.convertToAssets(d.shares);
        return currentValue > d.principal ? currentValue - d.principal : 0;
    }

    function getDeposit(uint256 depositId) external view returns (YieldDeposit memory) {
        return deposits[depositId];
    }
}
