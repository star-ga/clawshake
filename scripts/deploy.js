const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const network = hre.network.name;
  let usdcAddress;

  if (network === "baseSepolia") {
    // Circle's official testnet USDC on Base Sepolia
    usdcAddress = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    console.log("Using Circle testnet USDC:", usdcAddress);
  } else {
    // Deploy MockUSDC for local testing
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mockUsdc = await MockUSDC.deploy();
    await mockUsdc.waitForDeployment();
    usdcAddress = await mockUsdc.getAddress();
    console.log("MockUSDC deployed:", usdcAddress);
  }

  // Deploy AgentRegistry
  const AgentRegistry = await hre.ethers.getContractFactory("AgentRegistry");
  const registry = await AgentRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("AgentRegistry deployed:", registryAddr);

  // Deploy ShakeEscrow (treasury = deployer for now)
  const ShakeEscrow = await hre.ethers.getContractFactory("ShakeEscrow");
  const escrow = await ShakeEscrow.deploy(usdcAddress, deployer.address);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("ShakeEscrow deployed:", escrowAddr);

  // Save deployment info
  const deployment = {
    network,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      usdc: usdcAddress,
      agentRegistry: registryAddr,
      shakeEscrow: escrowAddr
    }
  };

  const fs = require("fs");
  const filename = `deployment-${network}.json`;
  fs.writeFileSync(filename, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${filename}`);
  console.log("\n--- Clawshake deployed! Shake on it. ---");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
