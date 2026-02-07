const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gas Benchmarks", function () {
  let usdc, escrow, registry;
  let deployer, requester, worker1, worker2, worker3;
  let signers;
  const AMOUNT = ethers.parseUnits("1000", 6);
  const CHILD1 = ethers.parseUnits("200", 6);
  const CHILD2 = ethers.parseUnits("100", 6);
  const TASK = ethers.keccak256(ethers.toUtf8Bytes("Build dashboard"));
  const TASK2 = ethers.keccak256(ethers.toUtf8Bytes("Scrape data"));
  const TASK3 = ethers.keccak256(ethers.toUtf8Bytes("Build charts"));
  const PROOF = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmProof"));
  const PROOF2 = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmData"));
  const PROOF3 = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmCharts"));
  const PROOF4 = ethers.keccak256(ethers.toUtf8Bytes("ipfs://QmFinal"));
  const DEADLINE = 86400; // 1 day in seconds (uint48 relative)

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [deployer, requester, worker1, worker2, worker3] = signers;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    await escrow.setRegistry(await registry.getAddress());
    await registry.authorizeCaller(await escrow.getAddress());

    // Register agents
    await registry.connect(worker1).register("Worker1", ["coding"]);
    await registry.connect(worker2).register("Worker2", ["scraping"]);
    await registry.connect(worker3).register("Worker3", ["charts"]);

    // Fund and approve
    for (let i = 0; i < Math.min(signers.length, 15); i++) {
      await usdc.faucet(signers[i].address, ethers.parseUnits("100000", 6));
      await usdc.connect(signers[i]).approve(await escrow.getAddress(), ethers.MaxUint256);
    }
  });

  // Helper: create a chain of given depth, returns array of shake IDs
  async function buildChain(depth) {
    const ids = [];
    // Root shake
    let tx = await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await tx.wait();
    ids.push(0);

    // First worker accepts root
    tx = await escrow.connect(worker1).acceptShake(0);
    await tx.wait();

    // Build chain down to requested depth
    let parentWorker = worker1;
    for (let d = 1; d <= depth; d++) {
      const childWorker = signers[3 + d]; // worker2, worker3, signers[6]...
      if (!childWorker) break;

      // Register if not yet registered
      try {
        await registry.connect(childWorker).register(`Worker-D${d}`, ["task"]);
      } catch (e) { /* already registered */ }

      const parentId = ids[ids.length - 1];
      const childAmount = ethers.parseUnits(String(Math.max(10, 100 - d * 15)), 6);

      tx = await escrow.connect(parentWorker).createChildShake(parentId, childAmount, DEADLINE, ethers.id(`task-d${d}`));
      const receipt = await tx.wait();
      const childId = Number(await escrow.getShakeCount()) - 1;
      ids.push(childId);

      tx = await escrow.connect(childWorker).acceptShake(childId);
      await tx.wait();

      parentWorker = childWorker;
    }
    return ids;
  }

  it("Gas: createShake (root)", async function () {
    const tx = await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    const receipt = await tx.wait();
    console.log(`    createShake:       ${receipt.gasUsed} gas`);
  });

  it("Gas: acceptShake", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    const tx = await escrow.connect(worker1).acceptShake(0);
    const receipt = await tx.wait();
    console.log(`    acceptShake:       ${receipt.gasUsed} gas`);
  });

  it("Gas: createChildShake at depth 1-5", async function () {
    const results = [];

    // Build root
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);

    let parentWorker = worker1;
    let parentId = 0;

    for (let depth = 1; depth <= 5; depth++) {
      const childWorker = signers[3 + depth];
      try {
        await registry.connect(childWorker).register(`Worker-D${depth}`, ["task"]);
      } catch (e) { /* already registered */ }

      const childAmount = ethers.parseUnits("50", 6);
      const tx = await escrow.connect(parentWorker).createChildShake(parentId, childAmount, DEADLINE, ethers.id(`d${depth}`));
      const receipt = await tx.wait();
      results.push({ depth, gas: receipt.gasUsed.toString() });

      const childId = Number(await escrow.getShakeCount()) - 1;
      await escrow.connect(childWorker).acceptShake(childId);

      parentWorker = childWorker;
      parentId = childId;
    }

    console.log("\n    | Depth | createChildShake Gas |");
    console.log("    |-------|---------------------|");
    for (const r of results) {
      console.log(`    | ${r.depth}     | ${r.gas.padStart(19)} |`);
    }
  });

  it("Gas: deliverShake", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);

    const tx = await escrow.connect(worker1).deliverShake(0, PROOF);
    const receipt = await tx.wait();
    console.log(`    deliverShake:      ${receipt.gasUsed} gas`);
  });

  it("Gas: releaseShake with 0, 1, 2, 5 children", async function () {
    const results = [];

    for (const numChildren of [0, 1, 2, 5]) {
      // Fresh state via new shake
      const shakeId = Number(await escrow.getShakeCount());
      await escrow.connect(requester).createShake(AMOUNT, DEADLINE, ethers.id(`test-${numChildren}`));
      await escrow.connect(worker1).acceptShake(shakeId);

      // Create and settle children
      for (let c = 0; c < numChildren; c++) {
        const childWorker = signers[4 + c];
        try {
          await registry.connect(childWorker).register(`CW-${numChildren}-${c}`, ["t"]);
        } catch (e) { /* already registered */ }

        const childAmount = ethers.parseUnits("10", 6);
        await escrow.connect(worker1).createChildShake(shakeId, childAmount, DEADLINE, ethers.id(`c-${c}`));
        const childId = Number(await escrow.getShakeCount()) - 1;
        await escrow.connect(childWorker).acceptShake(childId);
        await escrow.connect(childWorker).deliverShake(childId, ethers.id(`proof-${c}`));
        await escrow.connect(worker1).releaseShake(childId);
      }

      // Deliver and release parent
      await escrow.connect(worker1).deliverShake(shakeId, PROOF);
      const tx = await escrow.connect(requester).releaseShake(shakeId);
      const receipt = await tx.wait();
      results.push({ children: numChildren, gas: receipt.gasUsed.toString() });
    }

    console.log("\n    | Children | releaseShake Gas |");
    console.log("    |----------|-----------------|");
    for (const r of results) {
      console.log(`    | ${String(r.children).padStart(8)} | ${r.gas.padStart(15)} |`);
    }
  });

  it("Gas: disputeShake + resolveDispute", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);
    await escrow.connect(worker1).deliverShake(0, PROOF);

    const tx1 = await escrow.connect(requester).disputeShake(0);
    const r1 = await tx1.wait();
    console.log(`    disputeShake:      ${r1.gasUsed} gas`);

    const tx2 = await escrow.connect(deployer).resolveDispute(0, true);
    const r2 = await tx2.wait();
    console.log(`    resolveDispute:    ${r2.gasUsed} gas`);
  });

  it("Gas: full 2-child hire chain (cascading settlement)", async function () {
    let tx = await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    let r = await tx.wait();
    console.log(`    createShake (root):     ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).acceptShake(0);
    r = await tx.wait();
    console.log(`    acceptShake (root):     ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).createChildShake(0, CHILD1, DEADLINE, TASK2);
    r = await tx.wait();
    console.log(`    createChildShake #1:    ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).createChildShake(0, CHILD2, DEADLINE, TASK3);
    r = await tx.wait();
    console.log(`    createChildShake #2:    ${r.gasUsed} gas`);

    tx = await escrow.connect(worker2).acceptShake(1);
    r = await tx.wait();
    console.log(`    acceptShake (child1):   ${r.gasUsed} gas`);

    tx = await escrow.connect(worker3).acceptShake(2);
    r = await tx.wait();
    console.log(`    acceptShake (child2):   ${r.gasUsed} gas`);

    tx = await escrow.connect(worker2).deliverShake(1, PROOF2);
    r = await tx.wait();
    console.log(`    deliverShake (child1):  ${r.gasUsed} gas`);

    tx = await escrow.connect(worker3).deliverShake(2, PROOF3);
    r = await tx.wait();
    console.log(`    deliverShake (child2):  ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).deliverShake(0, PROOF4);
    r = await tx.wait();
    console.log(`    deliverShake (parent):  ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).releaseShake(1);
    r = await tx.wait();
    console.log(`    releaseShake (child1):  ${r.gasUsed} gas`);

    tx = await escrow.connect(worker1).releaseShake(2);
    r = await tx.wait();
    console.log(`    releaseShake (child2):  ${r.gasUsed} gas`);

    tx = await escrow.connect(requester).releaseShake(0);
    r = await tx.wait();
    console.log(`    releaseShake (parent):  ${r.gasUsed} gas`);

    console.log(`\n    === TOTAL CHAIN: 12 transactions ===`);
  });

  it("Gas: full 3-level chain benchmark", async function () {
    const ids = await buildChain(2);
    let totalGas = 0n;

    // Deliver bottom-up
    for (let i = ids.length - 1; i >= 0; i--) {
      const w = i === 0 ? worker1 : signers[3 + i];
      const tx = await escrow.connect(w).deliverShake(ids[i], ethers.id(`proof-${i}`));
      const r = await tx.wait();
      totalGas += r.gasUsed;
    }

    // Release bottom-up
    for (let i = ids.length - 1; i >= 0; i--) {
      const releaser = i === 0 ? requester : (i === 1 ? worker1 : signers[3 + i - 1]);
      const tx = await escrow.connect(releaser).releaseShake(ids[i]);
      const r = await tx.wait();
      totalGas += r.gasUsed;
    }

    console.log(`    3-level chain settle: ${totalGas} gas (deliver + release)`);
  });

  it("Gas: full 5-level chain benchmark", async function () {
    const ids = await buildChain(4);
    let totalGas = 0n;

    // Deliver bottom-up
    for (let i = ids.length - 1; i >= 0; i--) {
      const w = i === 0 ? worker1 : signers[3 + i];
      const tx = await escrow.connect(w).deliverShake(ids[i], ethers.id(`proof-${i}`));
      const r = await tx.wait();
      totalGas += r.gasUsed;
    }

    // Release bottom-up
    for (let i = ids.length - 1; i >= 0; i--) {
      const releaser = i === 0 ? requester : (i === 1 ? worker1 : signers[3 + i - 1]);
      const tx = await escrow.connect(releaser).releaseShake(ids[i]);
      const r = await tx.wait();
      totalGas += r.gasUsed;
    }

    console.log(`    5-level chain settle: ${totalGas} gas (deliver + release)`);
  });
});
