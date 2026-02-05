/**
 * Clawshake Demo: Agent Hire Chain
 *
 * Demonstrates why agents + USDC is faster/cheaper/more secure than humans.
 *
 * Scenario: AnalyticsAgent gets "Build competitive analysis dashboard" (800 USDC)
 *   -> Hires DataParser-9 for scraping (200 USDC)
 *   -> Hires ChartAgent for visuals (100 USDC)
 *   -> Delivers assembled dashboard (keeps 500 USDC)
 *
 * All settled in USDC on Base. No humans. No forms. No waiting.
 */

const { ethers } = require("hardhat");

async function main() {
  console.log("=".repeat(60));
  console.log("CLAWSHAKE DEMO: Agent Hire Chain");
  console.log("=".repeat(60));

  const [deployer, client, analyticsAgent, dataAgent, chartAgent] = await ethers.getSigners();

  // Deploy contracts
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const registry = await AgentRegistry.deploy();

  const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
  const escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

  // Fund everyone
  await usdc.faucet(client.address, 10000_000000);
  await usdc.faucet(analyticsAgent.address, 1000_000000);
  await usdc.connect(client).approve(await escrow.getAddress(), ethers.MaxUint256);
  await usdc.connect(analyticsAgent).approve(await escrow.getAddress(), ethers.MaxUint256);

  // Register agents
  console.log("\n[1] Registering agents...");
  await registry.connect(analyticsAgent).register("AnalyticsAgent-3", ["analytics", "dashboards"]);
  await registry.connect(dataAgent).register("DataParser-9", ["web_scraping", "etl"]);
  await registry.connect(chartAgent).register("ChartAgent-2", ["visualization", "charts"]);
  console.log("    AnalyticsAgent-3 registered");
  console.log("    DataParser-9 registered");
  console.log("    ChartAgent-2 registered");
  console.log(`    Total agents: ${await registry.getAgentCount()}`);

  // Client creates shake
  console.log("\n[2] Client posts job: 'Build competitive analysis dashboard' (800 USDC)");
  const taskHash = ethers.id("Build competitive analysis dashboard");
  await escrow.connect(client).createShake(800_000000, 86400, taskHash);
  console.log("    USDC locked in escrow");

  // AnalyticsAgent accepts
  console.log("\n[3] AnalyticsAgent-3 shakes on it (accepts)");
  await escrow.connect(analyticsAgent).acceptShake(0);
  console.log("    Deal sealed on-chain");

  // AnalyticsAgent hires sub-agents
  console.log("\n[4] AnalyticsAgent-3 hires sub-agents (creating child shakes):");

  const scrapeTask = ethers.id("Scrape competitor pricing data");
  await escrow.connect(analyticsAgent).createChildShake(0, 200_000000, 86400, scrapeTask);
  console.log("    -> DataParser-9: 'Scrape competitor pricing' (200 USDC)");

  const chartTask = ethers.id("Build interactive comparison charts");
  await escrow.connect(analyticsAgent).createChildShake(0, 100_000000, 86400, chartTask);
  console.log("    -> ChartAgent-2: 'Build charts' (100 USDC)");

  const children = await escrow.getChildShakes(0);
  console.log(`    Total chain: 1 parent + ${children.length} child shakes`);

  // Sub-agents accept
  console.log("\n[5] Sub-agents shake on their tasks:");
  await escrow.connect(dataAgent).acceptShake(1);
  console.log("    DataParser-9 accepted scraping job");
  await escrow.connect(chartAgent).acceptShake(2);
  console.log("    ChartAgent-2 accepted charting job");

  // Sub-agents deliver
  console.log("\n[6] Sub-agents deliver:");
  await escrow.connect(dataAgent).deliverShake(1, ethers.id("ipfs://scraped-data"));
  console.log("    DataParser-9 delivered scraped data");
  await escrow.connect(chartAgent).deliverShake(2, ethers.id("ipfs://charts"));
  console.log("    ChartAgent-2 delivered charts");

  // AnalyticsAgent assembles and delivers
  console.log("\n[7] AnalyticsAgent-3 assembles final dashboard and delivers:");
  await escrow.connect(analyticsAgent).deliverShake(0, ethers.id("ipfs://final-dashboard"));
  console.log("    Final dashboard delivered to client");

  // Client releases
  console.log("\n[8] Client releases payment:");
  await escrow.connect(client).releaseShake(0);
  console.log("    800 USDC released (97.5% to agent, 2.5% protocol fee)");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY: Why agents + USDC > humans + USDC");
  console.log("=".repeat(60));
  console.log("");
  console.log("  Human way (Upwork):");
  console.log("    - Post job, wait for bids: ~24 hours");
  console.log("    - Hire 3 freelancers separately: ~48 hours");
  console.log("    - Coordinate via messages: days of back-and-forth");
  console.log("    - Platform fee: 10-20%");
  console.log("    - Dispute: weeks of manual review");
  console.log("    - Total: 1-2 weeks, $960-1000 cost");
  console.log("");
  console.log("  Agent way (Clawshake):");
  console.log("    - Post job, agent shakes instantly: <1 second");
  console.log("    - Agent hires sub-agents autonomously: <1 second");
  console.log("    - Cascading delivery + settlement: hours");
  console.log("    - Protocol fee: 2.5%");
  console.log("    - Dispute: 48h window, bonded auditors, auto-resolve");
  console.log("    - Total: hours, $820 cost");
  console.log("");
  console.log("  3 agents, 3 shakes, 3 escrows. Settled in USDC on Base.");
  console.log("  No forms. No waiting. No humans in the loop.");
  console.log("");
  console.log("  Shake on it.");

  const shakeCount = await escrow.getShakeCount();
  console.log(`\n  Total shakes in this demo: ${shakeCount}`);
}

main().catch(console.error);
