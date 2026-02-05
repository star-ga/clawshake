const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ShakeEscrow", function () {
  let escrow, usdc, registry;
  let deployer, requester, worker, subWorker;
  const AMOUNT = 500_000000; // 500 USDC

  beforeEach(async function () {
    [deployer, requester, worker, subWorker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    // Fund requester and worker with test USDC
    await usdc.faucet(requester.address, 10000_000000);
    await usdc.faucet(worker.address, 5000_000000);

    // Approve escrow
    await usdc.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);
    await usdc.connect(worker).approve(await escrow.getAddress(), ethers.MaxUint256);
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
    });
  });

  describe("AgentRegistry", function () {
    it("should register agents with SBT passports", async function () {
      await registry.connect(worker).register("DataParser-9", ["web_scraping", "etl"]);

      const passport = await registry.getPassport(worker.address);
      expect(passport.name).to.equal("DataParser-9");
      expect(passport.active).to.equal(true);
      expect(passport.successRate).to.equal(10000); // 100%
    });

    it("should track shake history", async function () {
      await registry.connect(worker).register("CodeBot-Alpha", ["coding"]);

      await registry.recordShake(worker.address, 500_000000, true);
      await registry.recordShake(worker.address, 200_000000, true);
      await registry.recordShake(worker.address, 100_000000, false);

      const passport = await registry.getPassport(worker.address);
      expect(passport.totalShakes).to.equal(3);
      expect(passport.totalEarned).to.equal(800_000000);
      expect(passport.disputesLost).to.equal(1);
      // 2/3 success = 6666 bps = 66.66%
      expect(passport.successRate).to.equal(6666);
    });

    it("should prevent duplicate registration (SBT)", async function () {
      await registry.connect(worker).register("Agent-1", ["skill"]);
      await expect(
        registry.connect(worker).register("Agent-2", ["skill"])
      ).to.be.revertedWith("Already registered");
    });
  });
});
