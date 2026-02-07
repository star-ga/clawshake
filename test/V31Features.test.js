const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("v3.1 Features", function () {
  let usdc, escrow, registry;
  let deployer, requester, worker1, worker2, worker3;
  const AMOUNT = ethers.parseUnits("1000", 6);
  const CHILD_AMOUNT = ethers.parseUnits("200", 6);
  const TASK = ethers.keccak256(ethers.toUtf8Bytes("Build dashboard"));
  const PROOF = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmProof"));
  const DEADLINE = 86400;

  beforeEach(async function () {
    [deployer, requester, worker1, worker2, worker3] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    await escrow.setRegistry(await registry.getAddress());
    await registry.authorizeCaller(await escrow.getAddress());

    // Fund accounts
    for (const signer of [deployer, requester, worker1, worker2, worker3]) {
      await usdc.faucet(signer.address, ethers.parseUnits("100000", 6));
      await usdc.connect(signer).approve(await escrow.getAddress(), ethers.MaxUint256);
    }

    // Register agents with different skills
    await registry.connect(worker1).register("Architect", ["coding", "architecture"]);
    await registry.connect(worker2).register("Scraper", ["scraping", "data"]);
    await registry.connect(worker3).register("Designer", ["design", "css"]);
  });

  // =============================================================
  // 1. CCTP Cross-Chain Settlement
  // =============================================================
  describe("CCTP Cross-Chain Settlement", function () {
    let cctp, crossChain;

    beforeEach(async function () {
      const MockTokenMessenger = await ethers.getContractFactory("MockTokenMessenger");
      cctp = await MockTokenMessenger.deploy(await usdc.getAddress());

      const CrossChainShake = await ethers.getContractFactory("CrossChainShake");
      crossChain = await CrossChainShake.deploy(
        await usdc.getAddress(),
        await cctp.getAddress(),
        await escrow.getAddress(),
        6 // Base Sepolia domain
      );

      // Approve CrossChainShake to spend USDC
      await usdc.connect(requester).approve(await crossChain.getAddress(), ethers.MaxUint256);
    });

    it("creates cross-chain shake and burns USDC via CCTP", async function () {
      const mintRecipient = ethers.zeroPadValue(await crossChain.getAddress(), 32);
      const balBefore = await usdc.balanceOf(requester.address);

      const tx = await crossChain.connect(requester).initiateShake(
        AMOUNT, DEADLINE, TASK,
        0, // Ethereum domain
        mintRecipient
      );

      const receipt = await tx.wait();
      const balAfter = await usdc.balanceOf(requester.address);
      expect(balBefore - balAfter).to.equal(AMOUNT);

      // Request stored
      const req = await crossChain.getRequest(0);
      expect(req.initiator).to.equal(requester.address);
      expect(req.amount).to.equal(AMOUNT);
      expect(req.sourceDomain).to.equal(6);
      expect(req.fulfilled).to.equal(false);
    });

    it("confirms cross-chain shake after CCTP mint", async function () {
      const mintRecipient = ethers.zeroPadValue(await crossChain.getAddress(), 32);

      // Initiate
      await crossChain.connect(requester).initiateShake(
        AMOUNT, DEADLINE, TASK, 0, mintRecipient
      );

      // Simulate CCTP mint (in production this happens via attestation)
      await cctp.simulateMint(0, await crossChain.getAddress());

      // Approve escrow from crossChain contract (funds now in crossChain)
      // fulfillShake handles the approval internally
      const tx = await crossChain.fulfillShake(0);
      await tx.wait();

      const req = await crossChain.getRequest(0);
      expect(req.fulfilled).to.equal(true);

      // Shake created on escrow
      const shake = await escrow.getShake(0);
      expect(shake.amount).to.equal(AMOUNT);
      expect(shake.status).to.equal(0); // Pending
    });

    it("prevents double fulfillment", async function () {
      const mintRecipient = ethers.zeroPadValue(await crossChain.getAddress(), 32);
      await crossChain.connect(requester).initiateShake(AMOUNT, DEADLINE, TASK, 0, mintRecipient);
      await cctp.simulateMint(0, await crossChain.getAddress());
      await crossChain.fulfillShake(0);

      await expect(crossChain.fulfillShake(0))
        .to.be.revertedWithCustomError(crossChain, "RequestAlreadyFulfilled");
    });

    it("maps CCTP nonce to request ID", async function () {
      const mintRecipient = ethers.zeroPadValue(await crossChain.getAddress(), 32);
      await crossChain.connect(requester).initiateShake(AMOUNT, DEADLINE, TASK, 0, mintRecipient);

      const requestId = await crossChain.getRequestByNonce(6, 0);
      expect(requestId).to.equal(0);
    });
  });

  // =============================================================
  // 2. ERC-4626 Vault Yield on Idle Escrow
  // =============================================================
  describe("ERC-4626 Vault Yield", function () {
    let vault, yieldEscrow;

    beforeEach(async function () {
      const MockVault = await ethers.getContractFactory("MockVault");
      vault = await MockVault.deploy(await usdc.getAddress());

      const YieldEscrow = await ethers.getContractFactory("YieldEscrow");
      yieldEscrow = await YieldEscrow.deploy(
        await usdc.getAddress(),
        await vault.getAddress(),
        deployer.address
      );

      await usdc.connect(requester).approve(await yieldEscrow.getAddress(), ethers.MaxUint256);
    });

    it("deposits escrowed USDC into vault", async function () {
      const depositAmount = ethers.parseUnits("500", 6);
      await yieldEscrow.connect(requester).depositToVault(depositAmount, 0);

      const deposit = await yieldEscrow.getDeposit(0);
      expect(deposit.depositor).to.equal(requester.address);
      expect(deposit.principal).to.equal(depositAmount);
      expect(deposit.shares).to.equal(depositAmount); // 1:1 for first deposit
      expect(deposit.withdrawn).to.equal(false);
    });

    it("accrues yield over time", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await yieldEscrow.connect(requester).depositToVault(depositAmount, 0);

      // Simulate 50 USDC yield (5%)
      const yieldAmount = ethers.parseUnits("50", 6);
      await usdc.faucet(deployer.address, yieldAmount);
      await usdc.connect(deployer).approve(await vault.getAddress(), yieldAmount);
      await vault.simulateYield(yieldAmount);

      const accrued = await yieldEscrow.getAccruedYield(0);
      expect(accrued).to.equal(yieldAmount);
    });

    it("distributes yield correctly on release: 80/15/5", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await yieldEscrow.connect(requester).depositToVault(depositAmount, 0);

      // Simulate 100 USDC yield (10%)
      const yieldAmount = ethers.parseUnits("100", 6);
      await usdc.faucet(deployer.address, yieldAmount);
      await usdc.connect(deployer).approve(await vault.getAddress(), yieldAmount);
      await vault.simulateYield(yieldAmount);

      // Track balances before
      const workerBefore = await usdc.balanceOf(worker1.address);
      const requesterBefore = await usdc.balanceOf(requester.address);
      const treasuryBefore = await usdc.balanceOf(deployer.address);

      // Withdraw: worker gets principal + 80% yield
      await yieldEscrow.connect(requester).withdrawFromVault(0, worker1.address, 0);

      const workerAfter = await usdc.balanceOf(worker1.address);
      const requesterAfter = await usdc.balanceOf(requester.address);
      const treasuryAfter = await usdc.balanceOf(deployer.address);

      // Worker: 1000 principal + 80 yield = 1080
      expect(workerAfter - workerBefore).to.equal(ethers.parseUnits("1080", 6));
      // Requester: 15% of 100 = 15
      expect(requesterAfter - requesterBefore).to.equal(ethers.parseUnits("15", 6));
      // Treasury: 5% of 100 = 5
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseUnits("5", 6));
    });

    it("handles vault with zero yield gracefully", async function () {
      const depositAmount = ethers.parseUnits("500", 6);
      await yieldEscrow.connect(requester).depositToVault(depositAmount, 0);

      const workerBefore = await usdc.balanceOf(worker1.address);
      await yieldEscrow.connect(requester).withdrawFromVault(0, worker1.address, 0);
      const workerAfter = await usdc.balanceOf(worker1.address);

      // Worker gets exact principal back
      expect(workerAfter - workerBefore).to.equal(depositAmount);
    });

    it("reverts on double withdrawal", async function () {
      await yieldEscrow.connect(requester).depositToVault(ethers.parseUnits("100", 6), 0);
      await yieldEscrow.connect(requester).withdrawFromVault(0, worker1.address, 0);

      await expect(yieldEscrow.connect(requester).withdrawFromVault(0, worker1.address, 0))
        .to.be.revertedWithCustomError(yieldEscrow, "AlreadyWithdrawn");
    });
  });

  // =============================================================
  // 3. Encrypted Deliverables
  // =============================================================
  describe("Encrypted Deliverables", function () {
    const PUB_KEY_HASH = ethers.keccak256(ethers.toUtf8Bytes("requester-x25519-pubkey"));
    const ENCRYPTED_KEY = ethers.keccak256(ethers.toUtf8Bytes("encrypted-symmetric-key"));
    const ENCRYPTED_DELIVERY = ethers.keccak256(ethers.toUtf8Bytes("encrypted-ipfs-cid"));

    it("creates encrypted shake with pubkey hash", async function () {
      await escrow.connect(requester).createShakeEncrypted(
        AMOUNT, DEADLINE, TASK, PUB_KEY_HASH
      );

      const shake = await escrow.getShake(0);
      expect(shake.requesterPubKeyHash).to.equal(PUB_KEY_HASH);
      expect(shake.amount).to.equal(AMOUNT);
      expect(shake.status).to.equal(0); // Pending
    });

    it("delivers with encrypted delivery key", async function () {
      await escrow.connect(requester).createShakeEncrypted(
        AMOUNT, DEADLINE, TASK, PUB_KEY_HASH
      );
      await escrow.connect(worker1).acceptShake(0);
      await escrow.connect(worker1).deliverShakeEncrypted(0, ENCRYPTED_DELIVERY, ENCRYPTED_KEY);

      const shake = await escrow.getShake(0);
      expect(shake.deliveryHash).to.equal(ENCRYPTED_DELIVERY);
      expect(shake.encryptedDeliveryKey).to.equal(ENCRYPTED_KEY);
      expect(shake.status).to.equal(2); // Delivered
    });

    it("encrypted delivery key accessible after release", async function () {
      await escrow.connect(requester).createShakeEncrypted(
        AMOUNT, DEADLINE, TASK, PUB_KEY_HASH
      );
      await escrow.connect(worker1).acceptShake(0);
      await escrow.connect(worker1).deliverShakeEncrypted(0, ENCRYPTED_DELIVERY, ENCRYPTED_KEY);
      await escrow.connect(requester).releaseShake(0);

      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(3); // Released
      // Key is on-chain and readable — requester decrypts with their private key
      expect(shake.encryptedDeliveryKey).to.equal(ENCRYPTED_KEY);
    });

    it("backward compatible — unencrypted shakes still work", async function () {
      // Standard createShake (no encryption)
      await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
      const shake = await escrow.getShake(0);
      expect(shake.requesterPubKeyHash).to.equal(ethers.ZeroHash);
      expect(shake.encryptedDeliveryKey).to.equal(ethers.ZeroHash);

      // Standard deliver still works
      await escrow.connect(worker1).acceptShake(0);
      await escrow.connect(worker1).deliverShake(0, PROOF);
      const delivered = await escrow.getShake(0);
      expect(delivered.status).to.equal(2); // Delivered
      expect(delivered.deliveryHash).to.equal(PROOF);
    });
  });

  // =============================================================
  // 4. Agent Discovery / Search
  // =============================================================
  describe("Agent Discovery", function () {
    it("finds agents by skill", async function () {
      const coders = await registry.searchBySkill("coding");
      expect(coders.length).to.equal(1);
      expect(coders[0]).to.equal(worker1.address);

      const scrapers = await registry.searchBySkill("scraping");
      expect(scrapers.length).to.equal(1);
      expect(scrapers[0]).to.equal(worker2.address);

      const designers = await registry.searchBySkill("design");
      expect(designers.length).to.equal(1);
      expect(designers[0]).to.equal(worker3.address);
    });

    it("returns empty array for unknown skill", async function () {
      const result = await registry.searchBySkill("quantum-computing");
      expect(result.length).to.equal(0);
    });

    it("filters by minimum rating", async function () {
      // All agents start at 10000 (100%)
      const highRating = await registry.getAgentsByMinRating(9500);
      expect(highRating.length).to.equal(3);

      // No one above 10000
      const perfect = await registry.getAgentsByMinRating(10001);
      expect(perfect.length).to.equal(0);
    });

    it("skill index updates on registration", async function () {
      const signers = await ethers.getSigners();
      const newAgent = signers[5];
      await registry.connect(newAgent).register("FullStack", ["coding", "design"]);

      // Both coding and design now have 2 agents
      const coders = await registry.searchBySkill("coding");
      expect(coders.length).to.equal(2); // worker1 + newAgent

      const designers = await registry.searchBySkill("design");
      expect(designers.length).to.equal(2); // worker3 + newAgent
    });

    it("getTopAgents returns empty when no one has 5+ shakes", async function () {
      const top = await registry.getTopAgents(3);
      expect(top.length).to.equal(0);
    });
  });
});
