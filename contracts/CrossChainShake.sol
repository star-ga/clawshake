// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ITokenMessenger
 * @notice Circle CCTP v2 TokenMessenger interface for cross-chain USDC transfers
 */
interface ITokenMessenger {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

/**
 * @title IMessageTransmitter
 * @notice Circle CCTP v2 MessageTransmitter interface for receiving cross-chain messages
 */
interface IMessageTransmitter {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}

/**
 * @title IShakeEscrow
 * @notice Minimal interface to create shakes on the destination chain
 */
interface IShakeEscrow {
    function createShake(uint256 amount, uint48 deadline, bytes32 taskHash) external returns (uint256 shakeId);
}

/**
 * @title CrossChainShake
 * @notice Enables agents on any CCTP-supported chain to create shakes on Base.
 *
 * Flow:
 *   Source chain: Agent calls initiateShake() → USDC burned via CCTP, shake params stored
 *   Destination chain (Base): After CCTP attestation, agent calls fulfillShake()
 *     → USDC minted to this contract → createShake() on ShakeEscrow
 *
 * Supported CCTP domains:
 *   0 = Ethereum, 1 = Avalanche, 2 = Optimism, 3 = Arbitrum, 6 = Base, 7 = Polygon
 */
contract CrossChainShake is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Errors ---
    error InvalidDomain();
    error AmountZero();
    error DeadlineZero();
    error RequestNotFound();
    error RequestAlreadyFulfilled();
    error NotInitiator();

    // --- State ---
    IERC20 public immutable usdc;
    ITokenMessenger public immutable tokenMessenger;
    IShakeEscrow public immutable escrow;
    uint32 public immutable localDomain;

    struct CrossChainRequest {
        address initiator;       // agent who initiated on source chain
        uint256 amount;
        uint48 deadline;
        bytes32 taskHash;
        uint32 sourceDomain;
        uint64 cctpNonce;
        bool fulfilled;
    }

    uint256 public nextRequestId;
    mapping(uint256 => CrossChainRequest) public requests;
    mapping(bytes32 => uint256) public nonceToRequest; // CCTP nonce hash → requestId

    // --- Events ---
    event CrossChainInitiated(
        uint256 indexed requestId,
        address indexed initiator,
        uint256 amount,
        uint32 sourceDomain,
        uint32 destinationDomain,
        uint64 cctpNonce
    );
    event CrossChainFulfilled(uint256 indexed requestId, uint256 indexed shakeId);

    constructor(
        address _usdc,
        address _tokenMessenger,
        address _escrow,
        uint32 _localDomain
    ) {
        usdc = IERC20(_usdc);
        tokenMessenger = ITokenMessenger(_tokenMessenger);
        escrow = IShakeEscrow(_escrow);
        localDomain = _localDomain;
    }

    /**
     * @notice Initiate a cross-chain shake — burns USDC via CCTP
     * @param amount USDC amount (6 decimals)
     * @param deadline Seconds for the shake deadline
     * @param taskHash IPFS hash of task specification
     * @param destinationDomain CCTP domain of the target chain (6 = Base)
     * @param mintRecipient Address on destination chain to receive minted USDC (this contract)
     * @return requestId The cross-chain request identifier
     */
    function initiateShake(
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash,
        uint32 destinationDomain,
        bytes32 mintRecipient
    ) external nonReentrant returns (uint256 requestId) {
        if (amount == 0) revert AmountZero();
        if (deadline == 0) revert DeadlineZero();

        // Pull USDC from initiator
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Approve CCTP TokenMessenger to burn
        usdc.approve(address(tokenMessenger), amount);

        // Burn USDC via CCTP — mints on destination chain
        uint64 nonce = tokenMessenger.depositForBurn(
            amount,
            destinationDomain,
            mintRecipient,
            address(usdc)
        );

        requestId = nextRequestId++;
        requests[requestId] = CrossChainRequest({
            initiator: msg.sender,
            amount: amount,
            deadline: deadline,
            taskHash: taskHash,
            sourceDomain: localDomain,
            cctpNonce: nonce,
            fulfilled: false
        });

        bytes32 nonceKey = keccak256(abi.encodePacked(localDomain, nonce));
        nonceToRequest[nonceKey] = requestId;

        emit CrossChainInitiated(requestId, msg.sender, amount, localDomain, destinationDomain, nonce);
    }

    /**
     * @notice Fulfill a cross-chain shake on the destination chain
     * @dev Called after CCTP attestation completes and USDC is minted to this contract.
     *      Creates a shake on the local ShakeEscrow using the minted USDC.
     * @param requestId The cross-chain request to fulfill
     * @return shakeId The created shake ID on ShakeEscrow
     */
    function fulfillShake(uint256 requestId) external nonReentrant returns (uint256 shakeId) {
        CrossChainRequest storage req = requests[requestId];
        if (req.initiator == address(0)) revert RequestNotFound();
        if (req.fulfilled) revert RequestAlreadyFulfilled();

        req.fulfilled = true;

        // Approve escrow to pull USDC (minted by CCTP)
        usdc.approve(address(escrow), req.amount);

        // Create shake on local escrow
        shakeId = escrow.createShake(req.amount, req.deadline, req.taskHash);

        emit CrossChainFulfilled(requestId, shakeId);
    }

    // --- View Functions ---

    function getRequest(uint256 requestId) external view returns (CrossChainRequest memory) {
        return requests[requestId];
    }

    function getRequestByNonce(uint32 sourceDomain, uint64 nonce) external view returns (uint256) {
        bytes32 nonceKey = keccak256(abi.encodePacked(sourceDomain, nonce));
        return nonceToRequest[nonceKey];
    }
}
