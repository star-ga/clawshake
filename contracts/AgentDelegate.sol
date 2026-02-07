// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IShakeEscrow {
    function createShake(uint256 amount, uint48 deadline, bytes32 taskHash) external returns (uint256);
    function usdc() external view returns (IERC20);
}

/**
 * @title AgentDelegate
 * @notice Session key delegation for Clawshake — allows agents to act on behalf of wallet owners
 *         with spend limits and time-bounded sessions.
 *
 * @dev Delegates can create shakes from the owner's USDC balance without full wallet access.
 *      Sessions are bounded by maxSpend and expiresAt. Owners retain full control.
 */
contract AgentDelegate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Custom Errors ---
    error NotSessionOwner();
    error SessionExpired();
    error SessionNotActive();
    error SessionInactive();
    error ExceedsSessionBudget();
    error NotDelegate();
    error ZeroAddress();
    error ZeroDuration();
    error ZeroMaxSpend();

    // --- State ---
    IShakeEscrow public immutable escrow;
    IERC20 public immutable usdc;

    uint256 public nextSessionId;

    struct DelegateSession {
        address owner;
        address delegate;
        uint256 maxSpend;
        uint256 spent;
        uint48 expiresAt;
        bool active;
    }

    mapping(uint256 => DelegateSession) public sessions;

    // --- Events ---
    event SessionCreated(uint256 indexed sessionId, address indexed owner, address indexed delegate, uint256 maxSpend, uint48 expiresAt);
    event SessionRevoked(uint256 indexed sessionId, address indexed owner);
    event DelegateShakeCreated(uint256 indexed sessionId, uint256 indexed shakeId, uint256 amount);

    constructor(address _escrow) {
        escrow = IShakeEscrow(_escrow);
        usdc = escrow.usdc();
    }

    /// @notice Create a new delegation session
    /// @param delegate Address authorized to act on behalf of msg.sender
    /// @param maxSpend Maximum USDC this delegate can commit (6 decimals)
    /// @param duration Session duration in seconds
    function createSession(
        address delegate,
        uint256 maxSpend,
        uint48 duration
    ) external returns (uint256 sessionId) {
        if (delegate == address(0)) revert ZeroAddress();
        if (duration == 0) revert ZeroDuration();
        if (maxSpend == 0) revert ZeroMaxSpend();

        sessionId = nextSessionId++;
        sessions[sessionId] = DelegateSession({
            owner: msg.sender,
            delegate: delegate,
            maxSpend: maxSpend,
            spent: 0,
            expiresAt: uint48(block.timestamp) + duration,
            active: true
        });

        emit SessionCreated(sessionId, msg.sender, delegate, maxSpend, uint48(block.timestamp) + duration);
    }

    /// @notice Revoke a delegation session — owner only
    function revokeSession(uint256 sessionId) external {
        DelegateSession storage s = sessions[sessionId];
        if (msg.sender != s.owner) revert NotSessionOwner();
        s.active = false;
        emit SessionRevoked(sessionId, msg.sender);
    }

    /// @notice Create a shake on behalf of the session owner
    /// @dev Pulls USDC from owner's approved balance, creates shake via escrow
    function createShakeAsDelegate(
        uint256 sessionId,
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 shakeId) {
        DelegateSession storage s = sessions[sessionId];

        if (msg.sender != s.delegate) revert NotDelegate();
        if (!s.active) revert SessionNotActive();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();
        if (s.spent + amount > s.maxSpend) revert ExceedsSessionBudget();

        s.spent += amount;

        // Pull USDC from owner to this contract
        usdc.safeTransferFrom(s.owner, address(this), amount);

        // Approve escrow to spend
        usdc.approve(address(escrow), amount);

        // Create shake — this contract becomes the requester
        shakeId = escrow.createShake(amount, deadline, taskHash);

        emit DelegateShakeCreated(sessionId, shakeId, amount);
    }

    /// @notice Get session details
    function getSession(uint256 sessionId) external view returns (DelegateSession memory) {
        return sessions[sessionId];
    }

    /// @notice Check if session is currently valid
    function isSessionValid(uint256 sessionId) external view returns (bool) {
        DelegateSession storage s = sessions[sessionId];
        return s.active && block.timestamp < s.expiresAt;
    }
}
