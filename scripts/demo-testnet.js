/**
 * Clawshake Testnet Demo — Base Sepolia
 *
 * Generates real transactions demonstrating:
 * 1. Agent registration (SBT passports)
 * 2. Full hire chain (parent + 2 children)
 * 3. Cascading delivery and settlement
 * 4. Dispute resolution flow
 *
 * All tx hashes are logged for README/submission proof.
 */

const hre = require("hardhat");

const ESCROW = "0xa33F9fA90389465413FFb880FD41e914b7790C61";
const REGISTRY = "0xdF3484cFe3C31FE00293d703f30da1197a16733E";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(contractCall, label) {
  const tx = await contractCall;
  const receipt = await tx.wait(2);
  await sleep(2000);
  console.log(`  ${label}: ${receipt.hash}`);
  return receipt;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const escrow = await hre.ethers.getContractAt("ShakeEscrow", ESCROW);
  const registry = await hre.ethers.getContractAt("AgentRegistry", REGISTRY);
  const usdc = await hre.ethers.getContractAt("MockUSDC", USDC);

  const bal = await usdc.balanceOf(deployer.address);
  console.log("USDC Balance:", hre.ethers.formatUnits(bal, 6));

  const txs = {};

  // ─── 1. Approve USDC ───
  console.log("\n[1] Approving USDC for escrow...");
  const allowance = await usdc.allowance(deployer.address, ESCROW);
  if (allowance < 100_000000n) {
    const r = await send(usdc.approve(ESCROW, hre.ethers.MaxUint256), "approve");
    txs.approve = r.hash;
  } else {
    console.log("  Already approved");
  }

  // ─── 2. Create parent shake (5 USDC) ───
  console.log("\n[2] Creating parent shake: 'Build dashboard' (5 USDC)...");
  const taskHash = hre.ethers.id("Build competitive analysis dashboard - demo v2");
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  let r = await send(escrow.createShake(5_000000, deadline, taskHash), "createShake");
  txs.createShake = r.hash;
  const parentId = (await escrow.getShakeCount()) - 1n;
  console.log("  Parent shake ID:", parentId.toString());

  // ─── 3. Accept parent ───
  console.log("\n[3] Accepting parent shake...");
  r = await send(escrow.acceptShake(parentId), "acceptShake");
  txs.acceptShake = r.hash;

  // ─── 4. Create child 1 (2 USDC) ───
  console.log("\n[4] Creating child shake 1: 'Scrape data' (2 USDC)...");
  r = await send(escrow.createChildShake(parentId, 2_000000, deadline, hre.ethers.id("Scrape competitor data - demo")), "createChildShake");
  txs.createChild1 = r.hash;
  const child1Id = (await escrow.getShakeCount()) - 1n;
  console.log("  Child 1 ID:", child1Id.toString());

  // ─── 5. Create child 2 (1 USDC) ───
  console.log("\n[5] Creating child shake 2: 'Build charts' (1 USDC)...");
  r = await send(escrow.createChildShake(parentId, 1_000000, deadline, hre.ethers.id("Build charts - demo")), "createChildShake");
  txs.createChild2 = r.hash;
  const child2Id = (await escrow.getShakeCount()) - 1n;
  console.log("  Child 2 ID:", child2Id.toString());

  // ─── 6. Accept children ───
  console.log("\n[6] Accepting child shakes...");
  r = await send(escrow.acceptShake(child1Id), "acceptShake(child1)");
  txs.acceptChild1 = r.hash;
  r = await send(escrow.acceptShake(child2Id), "acceptShake(child2)");
  txs.acceptChild2 = r.hash;

  // ─── 7. Deliver children ───
  console.log("\n[7] Delivering child shakes...");
  r = await send(escrow.deliverShake(child1Id, hre.ethers.id("ipfs://QmScrapedData")), "deliverShake(child1)");
  txs.deliverChild1 = r.hash;
  r = await send(escrow.deliverShake(child2Id, hre.ethers.id("ipfs://QmCharts")), "deliverShake(child2)");
  txs.deliverChild2 = r.hash;

  // ─── 8. Release children ───
  console.log("\n[8] Releasing child shakes...");
  r = await send(escrow.releaseShake(child1Id), "releaseShake(child1)");
  txs.releaseChild1 = r.hash;
  r = await send(escrow.releaseShake(child2Id), "releaseShake(child2)");
  txs.releaseChild2 = r.hash;

  // ─── 9. Deliver parent ───
  console.log("\n[9] Delivering parent (assembled dashboard)...");
  r = await send(escrow.deliverShake(parentId, hre.ethers.id("ipfs://QmFinalDashboard")), "deliverShake(parent)");
  txs.deliverParent = r.hash;

  // ─── 10. Release parent (cascading check) ───
  console.log("\n[10] Releasing parent (cascading settlement)...");
  r = await send(escrow.releaseShake(parentId), "releaseShake(parent)");
  txs.releaseParent = r.hash;

  // ─── 11. Dispute flow ───
  console.log("\n[11] Creating dispute demo (2 USDC)...");
  r = await send(escrow.createShake(2_000000, deadline, hre.ethers.id("Dispute demo task")), "createShake(dispute)");
  txs.createDispute = r.hash;
  const disputeId = (await escrow.getShakeCount()) - 1n;

  console.log("\n[12] Accept + deliver dispute shake...");
  r = await send(escrow.acceptShake(disputeId), "acceptShake(dispute)");
  txs.acceptDispute = r.hash;
  r = await send(escrow.deliverShake(disputeId, hre.ethers.id("ipfs://QmDisputeWork")), "deliverShake(dispute)");
  txs.deliverDispute = r.hash;

  console.log("\n[13] Filing dispute...");
  r = await send(escrow.disputeShake(disputeId), "disputeShake");
  txs.disputeShake = r.hash;

  console.log("\n[14] Resolving dispute (worker wins)...");
  r = await send(escrow.resolveDispute(disputeId, true), "resolveDispute");
  txs.resolveDispute = r.hash;

  // ─── Summary ───
  const BASE = "https://sepolia.basescan.org/tx/";
  console.log("\n" + "=".repeat(70));
  console.log("DEMO COMPLETE — Transaction Links");
  console.log("=".repeat(70));
  console.log("\nHire Chain (parent + 2 children, cascading settlement):");
  console.log(`  createShake (parent):    ${BASE}${txs.createShake}`);
  console.log(`  acceptShake (parent):    ${BASE}${txs.acceptShake}`);
  console.log(`  createChildShake #1:     ${BASE}${txs.createChild1}`);
  console.log(`  createChildShake #2:     ${BASE}${txs.createChild2}`);
  console.log(`  acceptShake (child 1):   ${BASE}${txs.acceptChild1}`);
  console.log(`  acceptShake (child 2):   ${BASE}${txs.acceptChild2}`);
  console.log(`  deliverShake (child 1):  ${BASE}${txs.deliverChild1}`);
  console.log(`  deliverShake (child 2):  ${BASE}${txs.deliverChild2}`);
  console.log(`  releaseShake (child 1):  ${BASE}${txs.releaseChild1}`);
  console.log(`  releaseShake (child 2):  ${BASE}${txs.releaseChild2}`);
  console.log(`  deliverShake (parent):   ${BASE}${txs.deliverParent}`);
  console.log(`  releaseShake (parent):   ${BASE}${txs.releaseParent}`);
  console.log("\nDispute Resolution:");
  console.log(`  createShake:             ${BASE}${txs.createDispute}`);
  console.log(`  acceptShake:             ${BASE}${txs.acceptDispute}`);
  console.log(`  deliverShake:            ${BASE}${txs.deliverDispute}`);
  console.log(`  disputeShake:            ${BASE}${txs.disputeShake}`);
  console.log(`  resolveDispute:          ${BASE}${txs.resolveDispute}`);

  const finalBal = await usdc.balanceOf(deployer.address);
  console.log(`\nUSDC spent: ${hre.ethers.formatUnits(bal - finalBal, 6)}`);
  console.log(`Total shakes: ${(await escrow.getShakeCount()).toString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
