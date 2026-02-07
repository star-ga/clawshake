const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const ESCROW = "0xa33F9fA90389465413FFb880FD41e914b7790C61";
  const CCTP_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

  // 3. CrossChainShake
  console.log("\n--- Deploying CrossChainShake ---");
  const CrossChainShake = await hre.ethers.getContractFactory("CrossChainShake");
  const crossChain = await CrossChainShake.deploy(USDC, CCTP_MESSENGER, ESCROW, 6);
  await crossChain.waitForDeployment();
  console.log("CrossChainShake:", await crossChain.getAddress());

  // Wait for next block
  await new Promise(r => setTimeout(r, 5000));

  // 4. YieldEscrow
  console.log("\n--- Deploying YieldEscrow ---");
  const YieldEscrow = await hre.ethers.getContractFactory("YieldEscrow");
  const yieldEscrow = await YieldEscrow.deploy(USDC, deployer.address, deployer.address);
  await yieldEscrow.waitForDeployment();
  console.log("YieldEscrow:", await yieldEscrow.getAddress());

  await new Promise(r => setTimeout(r, 5000));

  // 5. EncryptedDelivery
  console.log("\n--- Deploying EncryptedDelivery ---");
  const EncryptedDelivery = await hre.ethers.getContractFactory("EncryptedDelivery");
  const encrypted = await EncryptedDelivery.deploy();
  await encrypted.waitForDeployment();
  console.log("EncryptedDelivery:", await encrypted.getAddress());

  console.log("\n=== DONE ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
