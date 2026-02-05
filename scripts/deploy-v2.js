const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const REGISTRY_V2 = "0xdF3484cFe3C31FE00293d703f30da1197a16733E";

  // Deploy ShakeEscrow v2
  console.log("\nDeploying ShakeEscrow v2...");
  const ShakeEscrow = await hre.ethers.getContractFactory("ShakeEscrow");
  const escrow = await ShakeEscrow.deploy(USDC, deployer.address);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("ShakeEscrow v2 deployed:", escrowAddr);

  // Wire up: set registry on escrow
  console.log("\nSetting registry on escrow...");
  const tx1 = await escrow.setRegistry(REGISTRY_V2);
  await tx1.wait();
  console.log("Registry set on escrow");

  // Wire up: authorize escrow on registry
  console.log("Authorizing escrow on registry...");
  const registry = await hre.ethers.getContractAt("AgentRegistry", REGISTRY_V2);
  const tx2 = await registry.authorizeCaller(escrowAddr);
  await tx2.wait();
  console.log("Escrow authorized on registry");

  // Save deployment
  const fs = require("fs");
  const deployment = {
    network: "baseSepolia",
    chainId: 84532,
    version: "v2",
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      usdc: USDC,
      agentRegistry: REGISTRY_V2,
      shakeEscrow: escrowAddr
    },
    upgrades: [
      "Custom errors (gas-efficient)",
      "Budget tracking for child shakes",
      "Cascading settlement enforcement",
      "Dispute resolution (resolveDispute)",
      "Registry access control (onlyAuthorized)",
      "Contract integration (auto reputation updates)"
    ]
  };
  fs.writeFileSync("deployment-baseSepolia.json", JSON.stringify(deployment, null, 2));
  console.log("\nDeployment saved to deployment-baseSepolia.json");
  console.log("\n--- Clawshake v2 deployed and wired up on Base Sepolia! ---");
}

main().catch(e => { console.error(e); process.exit(1); });
