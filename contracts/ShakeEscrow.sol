// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ShakeEscrow
 * @notice The core primitive of Clawshake — trustless USDC escrow for agent-to-agent commerce.
 *         Agents "shake" on jobs: USDC locks, work happens, settlement cascades.
 * @dev Deployed on Base for sub-cent gas and native USDC.
 */
contract ShakeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public treasury;
    uint256 public protocolFeeBps = 250; // 2.5%
    uint256 public disputeBondBps = 500; // 5% bond for disputes
    uint48 public disputeWindow = 48 hours;

    uint256 public nextShakeId;

    enum ShakeStatus { Pending, Active, Delivered, Released, Disputed, Refunded }

    struct Shake {
        address requester;
        address worker;
        uint256 amount;
        uint256 parentShakeId; // 0 if root shake
        uint48 deadline;
        uint48 deliveredAt;
        ShakeStatus status;
        bytes32 taskHash;     // IPFS hash of task spec
        bytes32 deliveryHash; // IPFS hash of delivery proof
    }

    mapping(uint256 => Shake) public shakes;
    mapping(uint256 => uint256[]) public childShakes; // parent -> children

    // Events
    event ShakeCreated(uint256 indexed shakeId, address indexed requester, uint256 amount, bytes32 taskHash);
    event ShakeAccepted(uint256 indexed shakeId, address indexed worker);
    event ShakeDelivered(uint256 indexed shakeId, bytes32 deliveryHash);
    event ShakeReleased(uint256 indexed shakeId, uint256 workerPayout, uint256 protocolFee);
    event ShakeDisputed(uint256 indexed shakeId, address indexed disputant);
    event ShakeRefunded(uint256 indexed shakeId);
    event ChildShakeCreated(uint256 indexed parentShakeId, uint256 indexed childShakeId);

    constructor(address _usdc, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    /// @notice Create a new shake — locks USDC in escrow
    /// @param amount USDC amount (6 decimals)
    /// @param deadline Seconds from now until auto-refund
    /// @param taskHash IPFS hash of task specification
    function createShake(
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 shakeId) {
        require(amount > 0, "Amount must be > 0");
        require(deadline > 0, "Deadline must be > 0");

        shakeId = nextShakeId++;
        shakes[shakeId] = Shake({
            requester: msg.sender,
            worker: address(0),
            amount: amount,
            parentShakeId: 0,
            deadline: uint48(block.timestamp) + deadline,
            deliveredAt: 0,
            status: ShakeStatus.Pending,
            taskHash: taskHash,
            deliveryHash: bytes32(0)
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit ShakeCreated(shakeId, msg.sender, amount, taskHash);
    }

    /// @notice Accept a shake — the "handshake" that seals the deal
    function acceptShake(uint256 shakeId) external {
        Shake storage s = shakes[shakeId];
        require(s.status == ShakeStatus.Pending, "Not pending");
        require(block.timestamp < s.deadline, "Deadline passed");
        require(s.worker == address(0), "Already accepted");

        s.worker = msg.sender;
        s.status = ShakeStatus.Active;
        emit ShakeAccepted(shakeId, msg.sender);
    }

    /// @notice Worker delivers proof — starts dispute window
    function deliverShake(uint256 shakeId, bytes32 deliveryHash) external {
        Shake storage s = shakes[shakeId];
        require(s.status == ShakeStatus.Active, "Not active");
        require(msg.sender == s.worker, "Not worker");

        s.deliveryHash = deliveryHash;
        s.deliveredAt = uint48(block.timestamp);
        s.status = ShakeStatus.Delivered;
        emit ShakeDelivered(shakeId, deliveryHash);
    }

    /// @notice Release payment after dispute window (or manual accept by requester)
    function releaseShake(uint256 shakeId) external nonReentrant {
        Shake storage s = shakes[shakeId];
        require(s.status == ShakeStatus.Delivered, "Not delivered");

        bool isRequester = msg.sender == s.requester;
        bool windowPassed = block.timestamp >= s.deliveredAt + disputeWindow;
        require(isRequester || windowPassed, "Dispute window active");

        uint256 fee = (s.amount * protocolFeeBps) / 10000;
        uint256 payout = s.amount - fee;

        s.status = ShakeStatus.Released;

        usdc.safeTransfer(s.worker, payout);
        if (fee > 0) usdc.safeTransfer(treasury, fee);

        emit ShakeReleased(shakeId, payout, fee);
    }

    /// @notice Requester disputes during window
    function disputeShake(uint256 shakeId) external {
        Shake storage s = shakes[shakeId];
        require(s.status == ShakeStatus.Delivered, "Not delivered");
        require(msg.sender == s.requester, "Not requester");
        require(block.timestamp < s.deliveredAt + disputeWindow, "Window closed");

        s.status = ShakeStatus.Disputed;
        emit ShakeDisputed(shakeId, msg.sender);
    }

    /// @notice Refund if deadline passes without acceptance or delivery
    function refundShake(uint256 shakeId) external nonReentrant {
        Shake storage s = shakes[shakeId];
        require(
            s.status == ShakeStatus.Pending || s.status == ShakeStatus.Active,
            "Cannot refund"
        );
        require(block.timestamp >= s.deadline, "Deadline not passed");

        s.status = ShakeStatus.Refunded;
        usdc.safeTransfer(s.requester, s.amount);
        emit ShakeRefunded(shakeId);
    }

    // --- Agent Hire Chains ---

    /// @notice Worker creates a child shake — hires a sub-agent from their budget
    function createChildShake(
        uint256 parentShakeId,
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 childId) {
        Shake storage parent = shakes[parentShakeId];
        require(parent.status == ShakeStatus.Active, "Parent not active");
        require(msg.sender == parent.worker, "Not parent worker");
        require(amount <= parent.amount, "Exceeds parent budget");

        childId = nextShakeId++;
        shakes[childId] = Shake({
            requester: msg.sender,
            worker: address(0),
            amount: amount,
            parentShakeId: parentShakeId,
            deadline: uint48(block.timestamp) + deadline,
            deliveredAt: 0,
            status: ShakeStatus.Pending,
            taskHash: taskHash,
            deliveryHash: bytes32(0)
        });

        // Fund from parent escrow (worker's portion)
        // In production: track remaining budget per parent
        childShakes[parentShakeId].push(childId);
        emit ChildShakeCreated(parentShakeId, childId);
        emit ShakeCreated(childId, msg.sender, amount, taskHash);
    }

    // --- View Functions ---

    function getShake(uint256 shakeId) external view returns (Shake memory) {
        return shakes[shakeId];
    }

    function getChildShakes(uint256 parentShakeId) external view returns (uint256[] memory) {
        return childShakes[parentShakeId];
    }

    function getShakeCount() external view returns (uint256) {
        return nextShakeId;
    }
}
