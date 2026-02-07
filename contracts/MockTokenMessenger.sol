// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockTokenMessenger
 * @notice Mock of Circle CCTP v2 TokenMessenger for local testing.
 *         Simulates depositForBurn by holding USDC (instead of burning).
 *         In production, this burns USDC on the source chain and mints on the destination.
 */
contract MockTokenMessenger {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint64 public nextNonce;

    struct BurnRecord {
        address sender;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        uint64 nonce;
    }

    mapping(uint64 => BurnRecord) public burns;

    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain
    );

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    /**
     * @notice Simulate CCTP depositForBurn — holds USDC locally (mock burn)
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce) {
        require(burnToken == address(usdc), "MockCCTP: wrong token");

        nonce = nextNonce++;
        burns[nonce] = BurnRecord({
            sender: msg.sender,
            amount: amount,
            destinationDomain: destinationDomain,
            mintRecipient: mintRecipient,
            nonce: nonce
        });

        // Pull USDC from sender (simulating burn)
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit DepositForBurn(nonce, burnToken, amount, msg.sender, mintRecipient, destinationDomain);
    }

    /**
     * @notice Simulate CCTP mint on destination — transfers held USDC to recipient
     * @dev In production, CCTP mints new USDC. Here we just release held funds.
     */
    function simulateMint(uint64 nonce, address recipient) external {
        BurnRecord storage burn = burns[nonce];
        require(burn.amount > 0, "MockCCTP: no burn record");
        usdc.safeTransfer(recipient, burn.amount);
    }
}
