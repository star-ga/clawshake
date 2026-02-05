const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gas Benchmarks", function () {
  let usdc, escrow, registry;
  let deployer, requester, worker1, worker2, worker3;
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
    [deployer, requester, worker1, worker2, worker3] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    await escrow.setRegistry(await registry.getAddress());
    await registry.authorizeCaller(await escrow.getAddress());

    // Register agents (correct function: register, not registerAgent)
    await registry.connect(worker1).register("Worker1", ["coding"]);
    await registry.connect(worker2).register("Worker2", ["scraping"]);
    await registry.connect(worker3).register("Worker3", ["charts"]);

    // Fund requester (faucet takes address + amount)
    await usdc.faucet(requester.address, ethers.parseUnits("10000", 6));
    await usdc.connect(requester).approve(await escrow.getAddress(), ethers.parseUnits("10000", 6));
  });

  it("Gas: createShake (root)", async function () {
    const tx = await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    const receipt = await tx.wait();
    console.log(`    createShake:       ${receipt.gasUsed} gas`);
  });

  it("Gas: acceptShake", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    // shakeId starts at 0
    const tx = await escrow.connect(worker1).acceptShake(0);
    const receipt = await tx.wait();
    console.log(`    acceptShake:       ${receipt.gasUsed} gas`);
  });

  it("Gas: createChildShake", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);

    const tx = await escrow.connect(worker1).createChildShake(0, CHILD1, DEADLINE, TASK2);
    const receipt = await tx.wait();
    console.log(`    createChildShake:  ${receipt.gasUsed} gas`);
  });

  it("Gas: deliverShake", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);

    const tx = await escrow.connect(worker1).deliverShake(0, PROOF);
    const receipt = await tx.wait();
    console.log(`    deliverShake:      ${receipt.gasUsed} gas`);
  });

  it("Gas: releaseShake (no children)", async function () {
    await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    await escrow.connect(worker1).acceptShake(0);
    await escrow.connect(worker1).deliverShake(0, PROOF);

    // requester can release immediately (skips dispute window)
    const tx = await escrow.connect(requester).releaseShake(0);
    const receipt = await tx.wait();
    console.log(`    releaseShake (flat): ${receipt.gasUsed} gas`);
  });

  it("Gas: full 2-child hire chain (cascading settlement)", async function () {
    // 1. Create root shake
    let tx = await escrow.connect(requester).createShake(AMOUNT, DEADLINE, TASK);
    let r = await tx.wait();
    console.log(`    createShake (root):     ${r.gasUsed} gas`);

    // 2. Worker1 accepts root (shakeId=0)
    tx = await escrow.connect(worker1).acceptShake(0);
    r = await tx.wait();
    console.log(`    acceptShake (root):     ${r.gasUsed} gas`);

    // 3. Worker1 hires Worker2 (child shakeId=1)
    tx = await escrow.connect(worker1).createChildShake(0, CHILD1, DEADLINE, TASK2);
    r = await tx.wait();
    console.log(`    createChildShake #1:    ${r.gasUsed} gas`);

    // 4. Worker1 hires Worker3 (child shakeId=2)
    tx = await escrow.connect(worker1).createChildShake(0, CHILD2, DEADLINE, TASK3);
    r = await tx.wait();
    console.log(`    createChildShake #2:    ${r.gasUsed} gas`);

    // 5. Worker2 accepts child 1 (shakeId=1)
    tx = await escrow.connect(worker2).acceptShake(1);
    r = await tx.wait();
    console.log(`    acceptShake (child1):   ${r.gasUsed} gas`);

    // 6. Worker3 accepts child 2 (shakeId=2)
    tx = await escrow.connect(worker3).acceptShake(2);
    r = await tx.wait();
    console.log(`    acceptShake (child2):   ${r.gasUsed} gas`);

    // 7. Worker2 delivers child 1
    tx = await escrow.connect(worker2).deliverShake(1, PROOF2);
    r = await tx.wait();
    console.log(`    deliverShake (child1):  ${r.gasUsed} gas`);

    // 8. Worker3 delivers child 2
    tx = await escrow.connect(worker3).deliverShake(2, PROOF3);
    r = await tx.wait();
    console.log(`    deliverShake (child2):  ${r.gasUsed} gas`);

    // 9. Worker1 delivers parent
    tx = await escrow.connect(worker1).deliverShake(0, PROOF4);
    r = await tx.wait();
    console.log(`    deliverShake (parent):  ${r.gasUsed} gas`);

    // 10. Release child 1 (must settle children first)
    tx = await escrow.connect(worker1).releaseShake(1);
    r = await tx.wait();
    console.log(`    releaseShake (child1):  ${r.gasUsed} gas`);

    // 11. Release child 2
    tx = await escrow.connect(worker1).releaseShake(2);
    r = await tx.wait();
    console.log(`    releaseShake (child2):  ${r.gasUsed} gas`);

    // 12. Release parent (cascading check — children already settled)
    tx = await escrow.connect(requester).releaseShake(0);
    r = await tx.wait();
    console.log(`    releaseShake (parent):  ${r.gasUsed} gas`);

    console.log(`\n    === TOTAL CHAIN: 12 transactions ===`);
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
});
