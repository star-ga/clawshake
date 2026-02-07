const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.error("No ETH balance — cannot deploy");
    process.exit(1);
  }

  // Existing addresses
  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const ESCROW = "0xa33F9fA90389465413FFb880FD41e914b7790C61";
  const CCTP_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

  const addresses = {};

  // 1. FeeOracle
  console.log("\n--- Deploying FeeOracle ---");
  const FeeOracle = await hre.ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy(deployer.address);
  await feeOracle.waitForDeployment();
  addresses.feeOracle = await feeOracle.getAddress();
  console.log("FeeOracle:", addresses.feeOracle);

  // 2. AgentDelegate (Session Keys)
  console.log("\n--- Deploying AgentDelegate ---");
  const AgentDelegate = await hre.ethers.getContractFactory("AgentDelegate");
  const delegate = await AgentDelegate.deploy(ESCROW);
  await delegate.waitForDeployment();
  addresses.agentDelegate = await delegate.getAddress();
  console.log("AgentDelegate:", addresses.agentDelegate);

  // 3. CrossChainShake
  console.log("\n--- Deploying CrossChainShake ---");
  const CrossChainShake = await hre.ethers.getContractFactory("CrossChainShake");
  const crossChain = await CrossChainShake.deploy(
    USDC,
    CCTP_MESSENGER,
    ESCROW,
    6 // Base Sepolia domain
  );
  await crossChain.waitForDeployment();
  addresses.crossChainShake = await crossChain.getAddress();
  console.log("CrossChainShake:", addresses.crossChainShake);

  // 4. YieldEscrow
  console.log("\n--- Deploying YieldEscrow ---");
  // No real ERC-4626 vault on Base Sepolia, deploy with a placeholder
  // In production, this would point to an actual yield vault
  const YieldEscrow = await hre.ethers.getContractFactory("YieldEscrow");
  const yieldEscrow = await YieldEscrow.deploy(
    USDC,
    deployer.address, // placeholder vault — swap for real ERC-4626 in production
    deployer.address  // treasury
  );
  await yieldEscrow.waitForDeployment();
  addresses.yieldEscrow = await yieldEscrow.getAddress();
  console.log("YieldEscrow:", addresses.yieldEscrow);

  // 5. EncryptedDelivery
  console.log("\n--- Deploying EncryptedDelivery ---");
  const EncryptedDelivery = await hre.ethers.getContractFactory("EncryptedDelivery");
  const encrypted = await EncryptedDelivery.deploy();
  await encrypted.waitForDeployment();
  addresses.encryptedDelivery = await encrypted.getAddress();
  console.log("EncryptedDelivery:", addresses.encryptedDelivery);

  // Summary
  console.log("\n=== ALL DEPLOYED ===");
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name}: ${addr}`);
  }

  // Save
  const fs = require("fs");
  const deployment = {
    network: hre.network.name,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: addresses
  };
  fs.writeFileSync("deployment-remaining.json", JSON.stringify(deployment, null, 2));
  console.log("\nSaved to deployment-remaining.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
