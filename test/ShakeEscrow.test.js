const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ShakeEscrow", function () {
  let escrow, usdc, registry;
  let deployer, requester, worker, subWorker, outsider;
  const AMOUNT = 500_000000; // 500 USDC

  beforeEach(async function () {
    [deployer, requester, worker, subWorker, outsider] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    // Link registry to escrow
    await escrow.setRegistry(await registry.getAddress());
    await registry.authorizeCaller(await escrow.getAddress());

    // Fund requester and worker with test USDC
    await usdc.faucet(requester.address, 10000_000000);
    await usdc.faucet(worker.address, 5000_000000);

    // Approve escrow
    await usdc.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);
    await usdc.connect(worker).approve(await escrow.getAddress(), ethers.MaxUint256);
    await usdc.connect(subWorker).approve(await escrow.getAddress(), ethers.MaxUint256);

    // Register agents
    await registry.connect(worker).register("DataParser-9", ["web_scraping", "etl"]);
    await registry.connect(subWorker).register("ChartAgent-2", ["visualization"]);
  });

  describe("Basic Shake Flow", function () {
    it("should create a shake and lock USDC", async function () {
      const taskHash = ethers.id("Scrape 50k listings");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);

      const shake = await escrow.getShake(0);
      expect(shake.requester).to.equal(requester.address);
      expect(shake.amount).to.equal(AMOUNT);
      expect(shake.status).to.equal(0); // Pending

      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
    });

    it("should allow worker to accept (the handshake)", async function () {
      const taskHash = ethers.id("Build dashboard");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);
      await escrow.connect(worker).acceptShake(0);

      const shake = await escrow.getShake(0);
      expect(shake.worker).to.equal(worker.address);
      expect(shake.status).to.equal(1); // Active
    });

    it("should handle full shake lifecycle: create -> accept -> deliver -> release", async function () {
      const taskHash = ethers.id("Research report");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);
      await escrow.connect(worker).acceptShake(0);

      const deliveryHash = ethers.id("ipfs://QmDeliveryProof");
      await escrow.connect(worker).deliverShake(0, deliveryHash);

      // Requester manually releases (or wait 48h)
      const workerBefore = await usdc.balanceOf(worker.address);
      await escrow.connect(requester).releaseShake(0);

      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(3); // Released

      // Worker gets 97.5% (2.5% protocol fee)
      const amt = BigInt(AMOUNT);
      const expectedPayout = amt - (amt * 250n / 10000n);
      const workerAfter = await usdc.balanceOf(worker.address);
      expect(workerAfter - workerBefore).to.equal(expectedPayout);
    });

    it("should auto-release after 48h dispute window", async function () {
      const taskHash = ethers.id("Auto release task");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);
      await escrow.connect(worker).acceptShake(0);
      await escrow.connect(worker).deliverShake(0, ethers.id("proof"));

      // Fast forward 48 hours
      await ethers.provider.send("evm_increaseTime", [48 * 3600 + 1]);
      await ethers.provider.send("evm_mine");

      // Anyone can trigger release after window
      await escrow.connect(outsider).releaseShake(0);
      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(3); // Released
    });

    it("should refund if deadline passes", async function () {
      const taskHash = ethers.id("Urgent task");
      await escrow.connect(requester).createShake(AMOUNT, 1, taskHash); // 1 second deadline

      // Wait for deadline
      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine");

      const balBefore = await usdc.balanceOf(requester.address);
      await escrow.connect(requester).refundShake(0);
      const balAfter = await usdc.balanceOf(requester.address);

      expect(balAfter - balBefore).to.equal(AMOUNT);
    });

    it("should revert on zero amount", async function () {
      await expect(
        escrow.connect(requester).createShake(0, 86400, ethers.id("task"))
      ).to.be.revertedWithCustomError(escrow, "AmountZero");
    });

    it("should revert on zero deadline", async function () {
      await expect(
        escrow.connect(requester).createShake(AMOUNT, 0, ethers.id("task"))
      ).to.be.revertedWithCustomError(escrow, "DeadlineZero");
    });
  });

  describe("Dispute Resolution", function () {
    beforeEach(async function () {
      const taskHash = ethers.id("Disputed task");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);
      await escrow.connect(worker).acceptShake(0);
      await escrow.connect(worker).deliverShake(0, ethers.id("bad proof"));
    });

    it("should allow requester to dispute during window", async function () {
      await escrow.connect(requester).disputeShake(0);
      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(4); // Disputed
    });

    it("should not allow dispute after window closes", async function () {
      await ethers.provider.send("evm_increaseTime", [48 * 3600 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        escrow.connect(requester).disputeShake(0)
      ).to.be.revertedWithCustomError(escrow, "DisputeWindowClosed");
    });

    it("should resolve dispute in favor of worker", async function () {
      await escrow.connect(requester).disputeShake(0);

      const workerBefore = await usdc.balanceOf(worker.address);
      await escrow.connect(deployer).resolveDispute(0, true); // deployer = treasury

      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(3); // Released

      const workerAfter = await usdc.balanceOf(worker.address);
      expect(workerAfter).to.be.greaterThan(workerBefore);
    });

    it("should resolve dispute in favor of requester (refund)", async function () {
      await escrow.connect(requester).disputeShake(0);

      const reqBefore = await usdc.balanceOf(requester.address);
      await escrow.connect(deployer).resolveDispute(0, false);

      const shake = await escrow.getShake(0);
      expect(shake.status).to.equal(5); // Refunded

      const reqAfter = await usdc.balanceOf(requester.address);
      expect(reqAfter).to.be.greaterThan(reqBefore);
    });

    it("should only allow treasury to resolve disputes", async function () {
      await escrow.connect(requester).disputeShake(0);
      await expect(
        escrow.connect(outsider).resolveDispute(0, true)
      ).to.be.revertedWithCustomError(escrow, "NotTreasury");
    });

    it("should update reputation on release", async function () {
      await escrow.connect(requester).disputeShake(0);
      await escrow.connect(deployer).resolveDispute(0, true);

      const passport = await registry.getPassport(worker.address);
      expect(passport.totalShakes).to.equal(1);
      expect(passport.totalEarned).to.be.greaterThan(0);
    });

    it("should record failed reputation on dispute loss", async function () {
      await escrow.connect(requester).disputeShake(0);
      await escrow.connect(deployer).resolveDispute(0, false);

      const passport = await registry.getPassport(worker.address);
      expect(passport.totalShakes).to.equal(1);
      expect(passport.disputesLost).to.equal(1);
      expect(passport.successRate).to.equal(0); // 0% after 1 loss
    });
  });

  describe("Agent Hire Chains", function () {
    it("should create child shakes (agent hiring agent)", async function () {
      const taskHash = ethers.id("Build dashboard");
      await escrow.connect(requester).createShake(AMOUNT, 86400, taskHash);
      await escrow.connect(worker).acceptShake(0);

      // Worker hires sub-agent
      const subTaskHash = ethers.id("Scrape data for dashboard");
      await escrow.connect(worker).createChildShake(0, 100_000000, 86400, subTaskHash);

      const children = await escrow.getChildShakes(0);
      expect(children.length).to.equal(1);

      const child = await escrow.getShake(children[0]);
      expect(child.requester).to.equal(worker.address);
      expect(child.amount).to.equal(100_000000);
      expect(child.parentShakeId).to.equal(0);
      expect(child.isChildShake).to.equal(true);
    });

    it("should track remaining budget after child hires", async function () {
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("task"));
      await escrow.connect(worker).acceptShake(0);

      expect(await escrow.getRemainingBudget(0)).to.equal(AMOUNT);

      await escrow.connect(worker).createChildShake(0, 100_000000, 86400, ethers.id("sub1"));
      expect(await escrow.getRemainingBudget(0)).to.equal(AMOUNT - 100_000000);

      await escrow.connect(worker).createChildShake(0, 200_000000, 86400, ethers.id("sub2"));
      expect(await escrow.getRemainingBudget(0)).to.equal(AMOUNT - 300_000000);
    });

    it("should reject child shake exceeding budget", async function () {
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("task"));
      await escrow.connect(worker).acceptShake(0);

      await expect(
        escrow.connect(worker).createChildShake(0, AMOUNT + 1, 86400, ethers.id("too much"))
      ).to.be.revertedWithCustomError(escrow, "ExceedsParentBudget");
    });

    it("should enforce cascading settlement (children before parent)", async function () {
      // Create parent shake
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("parent task"));
      await escrow.connect(worker).acceptShake(0);

      // Worker hires sub-agent
      await escrow.connect(worker).createChildShake(0, 100_000000, 86400, ethers.id("child task"));

      // Worker delivers parent
      await escrow.connect(worker).deliverShake(0, ethers.id("parent delivery"));

      // Should fail — child shake not settled yet
      await expect(
        escrow.connect(requester).releaseShake(0)
      ).to.be.revertedWithCustomError(escrow, "ChildrenNotSettled");

      // Sub-worker accepts and delivers child
      await escrow.connect(subWorker).acceptShake(1);
      await escrow.connect(subWorker).deliverShake(1, ethers.id("child delivery"));
      await escrow.connect(worker).releaseShake(1); // Worker (requester of child) releases

      // Now parent can be released
      await escrow.connect(requester).releaseShake(0);

      expect((await escrow.getShake(0)).status).to.equal(3); // Released
      expect((await escrow.getShake(1)).status).to.equal(3); // Released
    });

    it("should handle multi-agent hire chain (3 levels)", async function () {
      // Fund sub-worker
      await usdc.faucet(subWorker.address, 5000_000000);

      // Root: requester -> worker (500 USDC)
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("build app"));
      await escrow.connect(worker).acceptShake(0);

      // Worker hires sub-worker (200 USDC)
      await escrow.connect(worker).createChildShake(0, 200_000000, 86400, ethers.id("scrape data"));
      await escrow.connect(subWorker).acceptShake(1);

      // Verify hierarchy
      const children = await escrow.getChildShakes(0);
      expect(children.length).to.equal(1);
      expect(children[0]).to.equal(1n);

      // Complete from bottom up
      await escrow.connect(subWorker).deliverShake(1, ethers.id("data scraped"));
      await escrow.connect(worker).releaseShake(1); // Worker releases child

      await escrow.connect(worker).deliverShake(0, ethers.id("app built"));
      await escrow.connect(requester).releaseShake(0); // Requester releases parent

      // Check final states
      expect((await escrow.getShake(0)).status).to.equal(3);
      expect((await escrow.getShake(1)).status).to.equal(3);

      // Check allChildrenSettled
      expect(await escrow.allChildrenSettled(0)).to.equal(true);
    });

    it("should only allow parent worker to create child shakes", async function () {
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("task"));
      await escrow.connect(worker).acceptShake(0);

      await expect(
        escrow.connect(outsider).createChildShake(0, 100_000000, 86400, ethers.id("hack"))
      ).to.be.revertedWithCustomError(escrow, "NotParentWorker");
    });
  });

  describe("AgentRegistry", function () {
    it("should register agents with SBT passports", async function () {
      const passport = await registry.getPassport(worker.address);
      expect(passport.name).to.equal("DataParser-9");
      expect(passport.active).to.equal(true);
      expect(passport.successRate).to.equal(10000); // 100%
    });

    it("should prevent duplicate registration (SBT)", async function () {
      await expect(
        registry.connect(worker).register("Agent-2", ["skill"])
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("should only allow authorized callers to record shakes", async function () {
      await expect(
        registry.connect(outsider).recordShake(worker.address, 500_000000, true)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("should track shake history via escrow integration", async function () {
      // Full lifecycle through escrow
      await escrow.connect(requester).createShake(AMOUNT, 86400, ethers.id("task"));
      await escrow.connect(worker).acceptShake(0);
      await escrow.connect(worker).deliverShake(0, ethers.id("proof"));
      await escrow.connect(requester).releaseShake(0);

      const passport = await registry.getPassport(worker.address);
      expect(passport.totalShakes).to.equal(1);
      expect(passport.totalEarned).to.be.greaterThan(0);
      expect(passport.successRate).to.equal(10000); // 100%
    });

    it("should check isRegistered", async function () {
      expect(await registry.isRegistered(worker.address)).to.equal(true);
      expect(await registry.isRegistered(outsider.address)).to.equal(false);
    });
  });
});
