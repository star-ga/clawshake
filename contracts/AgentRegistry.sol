// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title AgentRegistry
 * @notice SBT-based reputation system for AI agents on Clawshake.
 *         Non-transferable passports that track shakes, earnings, and reliability.
 *
 * @dev Only authorized callers (ShakeEscrow) can update reputation.
 *      Passports are soul-bound — intentionally no transfer function.
 */
contract AgentRegistry {

    // --- Custom Errors ---
    error AlreadyRegistered();
    error NotRegistered();
    error NameRequired();
    error NotAuthorized();
    error ZeroAddress();

    struct AgentPassport {
        bytes32 agentId;
        string name;
        string[] skills;
        uint256 totalShakes;
        uint256 totalEarned;     // USDC earned (6 decimals)
        uint256 successRate;     // basis points (9500 = 95%)
        uint256 disputesLost;
        uint48 registeredAt;
        bool active;
    }

    mapping(address => AgentPassport) public passports;
    mapping(bytes32 => address) public agentIdToAddress;
    mapping(address => bool) public authorizedCallers; // ShakeEscrow etc.
    mapping(bytes32 => address[]) public skillIndex; // keccak256(skill) → agents
    address[] public registeredAgents;
    address public owner;

    event AgentRegistered(address indexed agent, bytes32 agentId, string name);
    event AgentUpdated(address indexed agent, uint256 totalShakes, uint256 totalEarned);
    event ShakeRecorded(address indexed agent, uint256 earned, bool success);
    event CallerAuthorized(address indexed caller);
    event CallerRevoked(address indexed caller);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender] && msg.sender != owner) revert NotAuthorized();
        _;
    }

    /// @notice Authorize a contract (e.g., ShakeEscrow) to record shakes
    function authorizeCaller(address caller) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = true;
        emit CallerAuthorized(caller);
    }

    /// @notice Revoke authorization
    function revokeCaller(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
        emit CallerRevoked(caller);
    }

    /// @notice Register as an agent — mints a non-transferable SBT passport
    function register(string calldata name, string[] calldata skills) external {
        if (passports[msg.sender].active) revert AlreadyRegistered();
        if (bytes(name).length == 0) revert NameRequired();

        bytes32 agentId = keccak256(abi.encodePacked(msg.sender, block.timestamp));

        passports[msg.sender] = AgentPassport({
            agentId: agentId,
            name: name,
            skills: skills,
            totalShakes: 0,
            totalEarned: 0,
            successRate: 10000, // 100% until first dispute
            disputesLost: 0,
            registeredAt: uint48(block.timestamp),
            active: true
        });

        agentIdToAddress[agentId] = msg.sender;
        registeredAgents.push(msg.sender);

        // Populate skill index for discovery
        for (uint256 i = 0; i < skills.length; i++) {
            bytes32 skillKey = keccak256(abi.encodePacked(skills[i]));
            skillIndex[skillKey].push(msg.sender);
        }

        emit AgentRegistered(msg.sender, agentId, name);
    }

    /// @notice Record a completed shake — only callable by authorized contracts
    function recordShake(address agent, uint256 earned, bool success) external onlyAuthorized {
        AgentPassport storage p = passports[agent];
        if (!p.active) revert NotRegistered();

        p.totalShakes++;
        p.totalEarned += earned;

        if (!success) {
            p.disputesLost++;
        }

        // Recalculate success rate
        if (p.totalShakes > 0) {
            p.successRate = ((p.totalShakes - p.disputesLost) * 10000) / p.totalShakes;
        }

        emit ShakeRecorded(agent, earned, success);
        emit AgentUpdated(agent, p.totalShakes, p.totalEarned);
    }

    /// @notice Get agent passport
    function getPassport(address agent) external view returns (
        bytes32 agentId,
        string memory name,
        uint256 totalShakes,
        uint256 totalEarned,
        uint256 successRate,
        uint256 disputesLost,
        bool active
    ) {
        AgentPassport storage p = passports[agent];
        return (p.agentId, p.name, p.totalShakes, p.totalEarned, p.successRate, p.disputesLost, p.active);
    }

    /// @notice Check if address is a registered agent
    function isRegistered(address agent) external view returns (bool) {
        return passports[agent].active;
    }

    /// @notice Get total registered agents
    function getAgentCount() external view returns (uint256) {
        return registeredAgents.length;
    }

    /// @notice Get agent skills
    function getSkills(address agent) external view returns (string[] memory) {
        return passports[agent].skills;
    }

    // --- Discovery Functions ---

    /// @notice Find all agents with a specific skill
    function searchBySkill(string calldata skill) external view returns (address[] memory) {
        bytes32 skillKey = keccak256(abi.encodePacked(skill));
        return skillIndex[skillKey];
    }

    /// @notice Get top agents by success rate (minimum 5 completed shakes)
    function getTopAgents(uint256 count) external view returns (address[] memory) {
        uint256 total = registeredAgents.length;
        if (count > total) count = total;

        // Collect eligible agents (min 5 shakes)
        address[] memory eligible = new address[](total);
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < total; i++) {
            if (passports[registeredAgents[i]].totalShakes >= 5) {
                eligible[eligibleCount++] = registeredAgents[i];
            }
        }

        // Simple selection sort for top N by successRate
        for (uint256 i = 0; i < count && i < eligibleCount; i++) {
            uint256 bestIdx = i;
            for (uint256 j = i + 1; j < eligibleCount; j++) {
                if (passports[eligible[j]].successRate > passports[eligible[bestIdx]].successRate) {
                    bestIdx = j;
                }
            }
            if (bestIdx != i) {
                (eligible[i], eligible[bestIdx]) = (eligible[bestIdx], eligible[i]);
            }
        }

        // Return top N
        uint256 resultCount = count < eligibleCount ? count : eligibleCount;
        address[] memory result = new address[](resultCount);
        for (uint256 i = 0; i < resultCount; i++) {
            result[i] = eligible[i];
        }
        return result;
    }

    /// @notice Filter agents by minimum success rate (in basis points, e.g., 9000 = 90%)
    function getAgentsByMinRating(uint256 minSuccessRate) external view returns (address[] memory) {
        uint256 total = registeredAgents.length;

        // Count matching agents first
        uint256 matchCount = 0;
        for (uint256 i = 0; i < total; i++) {
            if (passports[registeredAgents[i]].successRate >= minSuccessRate &&
                passports[registeredAgents[i]].active) {
                matchCount++;
            }
        }

        // Build result array
        address[] memory result = new address[](matchCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (passports[registeredAgents[i]].successRate >= minSuccessRate &&
                passports[registeredAgents[i]].active) {
                result[idx++] = registeredAgents[i];
            }
        }
        return result;
    }

    // SBT: intentionally no transfer function — passports are non-transferable
}
