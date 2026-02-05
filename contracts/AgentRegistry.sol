// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentRegistry
 * @notice SBT-based reputation system for AI agents on Clawshake.
 *         Non-transferable passports that track shakes, earnings, and reliability.
 */
contract AgentRegistry {

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
    address[] public registeredAgents;

    event AgentRegistered(address indexed agent, bytes32 agentId, string name);
    event AgentUpdated(address indexed agent, uint256 totalShakes, uint256 totalEarned);
    event ShakeRecorded(address indexed agent, uint256 earned, bool success);

    /// @notice Register as an agent — mints a non-transferable SBT passport
    function register(string calldata name, string[] calldata skills) external {
        require(!passports[msg.sender].active, "Already registered");
        require(bytes(name).length > 0, "Name required");

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
        emit AgentRegistered(msg.sender, agentId, name);
    }

    /// @notice Record a completed shake (called by ShakeEscrow)
    function recordShake(address agent, uint256 earned, bool success) external {
        AgentPassport storage p = passports[agent];
        require(p.active, "Not registered");

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

    /// @notice Get total registered agents
    function getAgentCount() external view returns (uint256) {
        return registeredAgents.length;
    }

    /// @notice Get agent skills
    function getSkills(address agent) external view returns (string[] memory) {
        return passports[agent].skills;
    }

    // SBT: intentionally no transfer function — passports are non-transferable
}
