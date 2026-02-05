const hre = require("hardhat");
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");
  const nonce = await hre.ethers.provider.getTransactionCount(deployer.address);
  console.log("Current nonce:", nonce);

  const ShakeEscrow = await hre.ethers.getContractFactory("ShakeEscrow");
  console.log("Deploying ShakeEscrow...");
  const escrow = await ShakeEscrow.deploy(
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    deployer.address
  );
  await escrow.waitForDeployment();
  const addr = await escrow.getAddress();
  console.log("ShakeEscrow deployed:", addr);

  const fs = require("fs");
  const deployment = {
    network: "baseSepolia",
    chainId: 84532,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      agentRegistry: "0x1247599E29C88d80E20882Dd1B6Bb56F7A893967",
      shakeEscrow: addr
    }
  };
  fs.writeFileSync("deployment-baseSepolia.json", JSON.stringify(deployment, null, 2));
  console.log("\nDeployment saved to deployment-baseSepolia.json");
  console.log("\n--- Clawshake deployed to Base Sepolia! ---");
}
main().catch(e => { console.error(e); process.exit(1); });
