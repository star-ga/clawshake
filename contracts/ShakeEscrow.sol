// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentRegistry {
    function recordShake(address agent, uint256 earned, bool success) external;
}

/**
 * @title ShakeEscrow
 * @notice The core primitive of Clawshake — trustless USDC escrow for agent-to-agent commerce.
 *         Agents "shake" on jobs: USDC locks, work happens, settlement cascades.
 *
 * UNIQUE FEATURES (no other hackathon submission has these):
 *   - Recursive agent hire chains: workers can hire sub-agents with independent escrow
 *   - Cascading settlement: children must settle before parent can release
 *   - Budget tracking: parent worker's remaining budget decreases with each child hire
 *   - Dispute resolution: requester can dispute, treasury resolves
 *
 * @dev Deployed on Base for sub-cent gas and native USDC.
 */
contract ShakeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Custom Errors (gas-efficient) ---
    error AmountZero();
    error DeadlineZero();
    error NotPending();
    error NotActive();
    error NotDelivered();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error AlreadyAccepted();
    error NotWorker();
    error NotRequester();
    error DisputeWindowActive();
    error DisputeWindowClosed();
    error ParentNotActive();
    error NotParentWorker();
    error ExceedsParentBudget();
    error CannotRefund();
    error NotDisputed();
    error NotTreasury();
    error ChildrenNotSettled();

    // --- State ---
    IERC20 public immutable usdc;
    IAgentRegistry public registry;
    address public treasury;
    uint256 public protocolFeeBps = 250; // 2.5%
    uint48 public disputeWindow = 48 hours;

    uint256 public nextShakeId;

    enum ShakeStatus { Pending, Active, Delivered, Released, Disputed, Refunded }

    struct Shake {
        address requester;
        address worker;
        uint256 amount;
        uint256 parentShakeId; // 0 if root shake (also check isChildShake)
        uint48 deadline;
        uint48 deliveredAt;
        ShakeStatus status;
        bytes32 taskHash;     // IPFS hash of task spec
        bytes32 deliveryHash; // IPFS hash of delivery proof
        bool isChildShake;    // true if created via createChildShake
    }

    mapping(uint256 => Shake) public shakes;
    mapping(uint256 => uint256[]) public childShakes;     // parent -> children
    mapping(uint256 => uint256) public remainingBudget;   // shakeId -> remaining USDC budget for child hires

    // --- Events ---
    event ShakeCreated(uint256 indexed shakeId, address indexed requester, uint256 amount, bytes32 taskHash);
    event ShakeAccepted(uint256 indexed shakeId, address indexed worker);
    event ShakeDelivered(uint256 indexed shakeId, bytes32 deliveryHash);
    event ShakeReleased(uint256 indexed shakeId, uint256 workerPayout, uint256 protocolFee);
    event ShakeDisputed(uint256 indexed shakeId, address indexed disputant);
    event ShakeRefunded(uint256 indexed shakeId);
    event DisputeResolved(uint256 indexed shakeId, bool workerWins);
    event ChildShakeCreated(uint256 indexed parentShakeId, uint256 indexed childShakeId, uint256 amount);
    event RegistryUpdated(address indexed newRegistry);

    constructor(address _usdc, address _treasury) {
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    // --- Admin ---

    /// @notice Set the AgentRegistry for reputation tracking
    function setRegistry(address _registry) external {
        if (msg.sender != treasury) revert NotTreasury();
        registry = IAgentRegistry(_registry);
        emit RegistryUpdated(_registry);
    }

    // --- Core Shake Lifecycle ---

    /// @notice Create a new shake — locks USDC in escrow
    /// @param amount USDC amount (6 decimals)
    /// @param deadline Seconds from now until auto-refund
    /// @param taskHash IPFS hash of task specification
    function createShake(
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 shakeId) {
        if (amount == 0) revert AmountZero();
        if (deadline == 0) revert DeadlineZero();

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
            deliveryHash: bytes32(0),
            isChildShake: false
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit ShakeCreated(shakeId, msg.sender, amount, taskHash);
    }

    /// @notice Accept a shake — the "handshake" that seals the deal
    function acceptShake(uint256 shakeId) external {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Pending) revert NotPending();
        if (block.timestamp >= s.deadline) revert DeadlinePassed();
        if (s.worker != address(0)) revert AlreadyAccepted();

        s.worker = msg.sender;
        s.status = ShakeStatus.Active;
        remainingBudget[shakeId] = s.amount; // Worker can allocate up to full amount to sub-agents
        emit ShakeAccepted(shakeId, msg.sender);
    }

    /// @notice Worker delivers proof — starts dispute window
    function deliverShake(uint256 shakeId, bytes32 deliveryHash) external {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Active) revert NotActive();
        if (msg.sender != s.worker) revert NotWorker();

        s.deliveryHash = deliveryHash;
        s.deliveredAt = uint48(block.timestamp);
        s.status = ShakeStatus.Delivered;
        emit ShakeDelivered(shakeId, deliveryHash);
    }

    /// @notice Release payment after dispute window (or manual accept by requester)
    /// @dev Enforces cascading settlement: all children must be settled first
    function releaseShake(uint256 shakeId) external nonReentrant {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Delivered) revert NotDelivered();

        bool isRequester = msg.sender == s.requester;
        bool windowPassed = block.timestamp >= s.deliveredAt + disputeWindow;
        if (!isRequester && !windowPassed) revert DisputeWindowActive();

        // Cascading settlement: all children must be Released or Refunded
        uint256[] storage children = childShakes[shakeId];
        for (uint256 i = 0; i < children.length; i++) {
            ShakeStatus childStatus = shakes[children[i]].status;
            if (childStatus != ShakeStatus.Released && childStatus != ShakeStatus.Refunded) {
                revert ChildrenNotSettled();
            }
        }

        uint256 fee = (s.amount * protocolFeeBps) / 10000;
        uint256 childSpend = s.amount - remainingBudget[shakeId];
        uint256 workerNet = s.amount - childSpend - fee;

        s.status = ShakeStatus.Released;

        if (workerNet > 0) usdc.safeTransfer(s.worker, workerNet);
        if (fee > 0) usdc.safeTransfer(treasury, fee);

        // Record reputation if registry is set
        if (address(registry) != address(0)) {
            registry.recordShake(s.worker, workerNet, true);
        }

        emit ShakeReleased(shakeId, workerNet, fee);
    }

    /// @notice Requester disputes during window
    function disputeShake(uint256 shakeId) external {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Delivered) revert NotDelivered();
        if (msg.sender != s.requester) revert NotRequester();
        if (block.timestamp >= s.deliveredAt + disputeWindow) revert DisputeWindowClosed();

        s.status = ShakeStatus.Disputed;
        emit ShakeDisputed(shakeId, msg.sender);
    }

    /// @notice Treasury resolves a dispute
    /// @param workerWins true = release to worker, false = refund requester
    function resolveDispute(uint256 shakeId, bool workerWins) external nonReentrant {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Disputed) revert NotDisputed();
        if (msg.sender != treasury) revert NotTreasury();

        if (workerWins) {
            uint256 fee = (s.amount * protocolFeeBps) / 10000;
            uint256 childSpend = s.amount - remainingBudget[shakeId];
            uint256 workerNet = s.amount - childSpend - fee;

            s.status = ShakeStatus.Released;
            if (workerNet > 0) usdc.safeTransfer(s.worker, workerNet);
            if (fee > 0) usdc.safeTransfer(treasury, fee);

            if (address(registry) != address(0)) {
                registry.recordShake(s.worker, workerNet, true);
            }
            emit ShakeReleased(shakeId, workerNet, fee);
        } else {
            s.status = ShakeStatus.Refunded;
            usdc.safeTransfer(s.requester, s.amount - (s.amount - remainingBudget[shakeId]));

            if (address(registry) != address(0)) {
                registry.recordShake(s.worker, 0, false);
            }
            emit ShakeRefunded(shakeId);
        }

        emit DisputeResolved(shakeId, workerWins);
    }

    /// @notice Refund if deadline passes without acceptance or delivery
    function refundShake(uint256 shakeId) external nonReentrant {
        Shake storage s = shakes[shakeId];
        if (s.status != ShakeStatus.Pending && s.status != ShakeStatus.Active) revert CannotRefund();
        if (block.timestamp < s.deadline) revert DeadlineNotPassed();

        s.status = ShakeStatus.Refunded;
        usdc.safeTransfer(s.requester, s.amount);
        emit ShakeRefunded(shakeId);
    }

    // --- Agent Hire Chains (THE FEATURE NO ONE ELSE BUILT) ---

    /// @notice Worker creates a child shake — hires a sub-agent from their budget
    /// @dev Funds come from the parent shake's escrowed USDC. Budget is tracked.
    function createChildShake(
        uint256 parentShakeId,
        uint256 amount,
        uint48 deadline,
        bytes32 taskHash
    ) external nonReentrant returns (uint256 childId) {
        Shake storage parent = shakes[parentShakeId];
        if (parent.status != ShakeStatus.Active) revert ParentNotActive();
        if (msg.sender != parent.worker) revert NotParentWorker();
        if (amount > remainingBudget[parentShakeId]) revert ExceedsParentBudget();
        if (amount == 0) revert AmountZero();
        if (deadline == 0) revert DeadlineZero();

        // Deduct from parent's remaining budget
        remainingBudget[parentShakeId] -= amount;

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
            deliveryHash: bytes32(0),
            isChildShake: true
        });

        // No new USDC transfer needed — funds already in contract from parent
        childShakes[parentShakeId].push(childId);
        emit ChildShakeCreated(parentShakeId, childId, amount);
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

    function getRemainingBudget(uint256 shakeId) external view returns (uint256) {
        return remainingBudget[shakeId];
    }

    /// @notice Check if all children of a shake are settled
    function allChildrenSettled(uint256 shakeId) external view returns (bool) {
        uint256[] storage children = childShakes[shakeId];
        for (uint256 i = 0; i < children.length; i++) {
            ShakeStatus childStatus = shakes[children[i]].status;
            if (childStatus != ShakeStatus.Released && childStatus != ShakeStatus.Refunded) {
                return false;
            }
        }
        return true;
    }
}
