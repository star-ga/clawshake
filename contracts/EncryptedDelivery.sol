// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title EncryptedDelivery
 * @notice Extension for encrypted delivery proofs — only the requester can decrypt.
 *
 * Problem: Standard deliveryHash on ShakeEscrow is a public IPFS hash. Anyone can
 *          read the delivery before payment is released. This creates a "grab and run"
 *          risk where the requester views the work, then disputes to get a refund.
 *
 * Solution: Worker encrypts the delivery payload with the requester's public key.
 *           The encrypted blob is stored on-chain. Only the requester's private key
 *           can decrypt. The decryption key for the full deliverable is revealed
 *           only after the shake is Released.
 *
 * Encryption scheme: ECIES (Elliptic Curve Integrated Encryption Scheme)
 *   - Worker generates ephemeral keypair
 *   - Derives shared secret via ECDH with requester's public key
 *   - Encrypts delivery content with AES-256-GCM using derived key
 *   - Stores: ephemeralPubKey + nonce + ciphertext + tag
 *
 * The deliveryHash on ShakeEscrow still stores keccak256(plaintext) for verification.
 * This contract stores the encrypted version for access control.
 */
contract EncryptedDelivery {

    // --- Errors ---
    error DeliveryNotFound();
    error DeliveryAlreadyStored();
    error NotWorker();
    error EmptyPayload();

    struct EncryptedProof {
        bytes32 shakeId;
        address worker;
        bytes ephemeralPubKey;   // 65 bytes (uncompressed secp256k1)
        bytes12 nonce;           // AES-GCM nonce
        bytes ciphertext;        // Encrypted delivery payload
        bytes16 authTag;         // AES-GCM authentication tag
        uint48 storedAt;
    }

    mapping(uint256 => EncryptedProof) public proofs;
    mapping(address => bytes) public requesterPubKeys; // Requester's ECIES public key

    // --- Events ---
    event PubKeyRegistered(address indexed requester, bytes pubKey);
    event EncryptedDeliveryStored(uint256 indexed shakeId, address indexed worker, uint48 storedAt);

    /**
     * @notice Register a public key for receiving encrypted deliveries
     * @param pubKey Uncompressed secp256k1 public key (65 bytes) or compressed (33 bytes)
     */
    function registerPubKey(bytes calldata pubKey) external {
        requesterPubKeys[msg.sender] = pubKey;
        emit PubKeyRegistered(msg.sender, pubKey);
    }

    /**
     * @notice Store an encrypted delivery proof for a shake
     * @param shakeId The shake ID this delivery corresponds to
     * @param ephemeralPubKey Worker's ephemeral public key for ECDH
     * @param nonce AES-GCM nonce (12 bytes)
     * @param ciphertext Encrypted delivery payload
     * @param authTag AES-GCM authentication tag (16 bytes)
     */
    function storeEncryptedDelivery(
        uint256 shakeId,
        bytes calldata ephemeralPubKey,
        bytes12 nonce,
        bytes calldata ciphertext,
        bytes16 authTag
    ) external {
        if (proofs[shakeId].storedAt != 0) revert DeliveryAlreadyStored();
        if (ciphertext.length == 0) revert EmptyPayload();

        proofs[shakeId] = EncryptedProof({
            shakeId: bytes32(shakeId),
            worker: msg.sender,
            ephemeralPubKey: ephemeralPubKey,
            nonce: nonce,
            ciphertext: ciphertext,
            authTag: authTag,
            storedAt: uint48(block.timestamp)
        });

        emit EncryptedDeliveryStored(shakeId, msg.sender, uint48(block.timestamp));
    }

    /**
     * @notice Retrieve encrypted delivery proof
     * @param shakeId The shake ID to look up
     * @return proof The encrypted delivery data
     */
    function getEncryptedDelivery(uint256 shakeId) external view returns (EncryptedProof memory proof) {
        proof = proofs[shakeId];
        if (proof.storedAt == 0) revert DeliveryNotFound();
    }

    /**
     * @notice Get a requester's registered public key
     * @param requester The requester's address
     * @return pubKey The registered public key (empty if not registered)
     */
    function getRequesterPubKey(address requester) external view returns (bytes memory) {
        return requesterPubKeys[requester];
    }

    /**
     * @notice Check if an encrypted delivery exists for a shake
     */
    function hasEncryptedDelivery(uint256 shakeId) external view returns (bool) {
        return proofs[shakeId].storedAt != 0;
    }
}
