/**
 * Clawshake Demo: Deep Recursive Hire Chain (5 levels, 7 agents)
 *
 * Demonstrates recursive escrow scaling with a real-world software project:
 *
 * ProjectManager (1000 USDC)
 *   → ArchitectAgent (400 USDC)
 *     → FrontendAgent (150 USDC)
 *       → CSSAgent (50 USDC)
 *         → IconAgent (15 USDC)
 *     → BackendAgent (200 USDC)
 *   → QAAgent (100 USDC)
 *
 * Full lifecycle: create → accept → hire children → deliver bottom-up → release cascading
 */

const { ethers } = require("hardhat");

async function main() {
  console.log("═".repeat(70));
  console.log("  CLAWSHAKE: 5-Level Deep Recursive Hire Chain");
  console.log("═".repeat(70));

  const signers = await ethers.getSigners();
  const [deployer, client, pm, architect, frontend, css, icon, backend, qa] = signers;

  // Deploy contracts
  console.log("\n[Deploy] Deploying contracts...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const registry = await AgentRegistry.deploy();

  const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
  const escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

  await escrow.setRegistry(await registry.getAddress());
  await registry.authorizeCaller(await escrow.getAddress());

  // Fund client and all agents
  const agents = [client, pm, architect, frontend, css, icon, backend, qa];
  for (const agent of agents) {
    await usdc.faucet(agent.address, 10000_000000);
    await usdc.connect(agent).approve(await escrow.getAddress(), ethers.MaxUint256);
  }

  // Register all 7 agents
  console.log("\n[1] Registering 7 agents...");
  const agentDefs = [
    { signer: pm,       name: "ProjectManager-1", skills: ["management", "coordination"] },
    { signer: architect, name: "ArchitectAgent-7", skills: ["system_design", "api_design"] },
    { signer: frontend,  name: "FrontendAgent-3",  skills: ["react", "typescript", "css"] },
    { signer: css,       name: "CSSAgent-12",      skills: ["tailwind", "responsive", "animation"] },
    { signer: icon,      name: "IconDesigner-5",   skills: ["svg", "icon_design", "figma"] },
    { signer: backend,   name: "BackendAgent-8",   skills: ["nodejs", "postgres", "api"] },
    { signer: qa,        name: "QABot-4",          skills: ["testing", "e2e", "load_testing"] },
  ];
  for (const def of agentDefs) {
    await registry.connect(def.signer).register(def.name, def.skills);
    console.log(`    ✓ ${def.name}`);
  }
  console.log(`    Total agents: ${await registry.getAgentCount()}`);

  const gasLog = [];
  function logGas(label, receipt) {
    gasLog.push({ label, gas: receipt.gasUsed.toString() });
    console.log(`    ⛽ ${label}: ${receipt.gasUsed} gas`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Level 0: Client → ProjectManager (1000 USDC)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n[2] Building 5-level hire chain...");
  console.log("    Level 0: Client → ProjectManager-1 (1000 USDC)");

  let tx = await escrow.connect(client).createShake(1000_000000, 86400 * 7, ethers.id("Build full-stack dashboard app"));
  logGas("createShake (root)", await tx.wait());
  const rootId = 0;

  tx = await escrow.connect(pm).acceptShake(rootId);
  logGas("acceptShake (root)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Level 1: PM hires Architect (400) and QA (100)
  // ═══════════════════════════════════════════════════════════════
  console.log("    Level 1: PM → ArchitectAgent-7 (400 USDC)");
  tx = await escrow.connect(pm).createChildShake(rootId, 400_000000, 86400 * 5, ethers.id("Design system architecture"));
  logGas("createChildShake (architect)", await tx.wait());
  const architectId = 1;

  console.log("    Level 1: PM → QABot-4 (100 USDC)");
  tx = await escrow.connect(pm).createChildShake(rootId, 100_000000, 86400 * 5, ethers.id("E2E test suite"));
  logGas("createChildShake (qa)", await tx.wait());
  const qaId = 2;

  tx = await escrow.connect(architect).acceptShake(architectId);
  logGas("acceptShake (architect)", await tx.wait());

  tx = await escrow.connect(qa).acceptShake(qaId);
  logGas("acceptShake (qa)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Level 2: Architect hires Frontend (150) and Backend (200)
  // ═══════════════════════════════════════════════════════════════
  console.log("    Level 2: Architect → FrontendAgent-3 (150 USDC)");
  tx = await escrow.connect(architect).createChildShake(architectId, 150_000000, 86400 * 4, ethers.id("Build React frontend"));
  logGas("createChildShake (frontend)", await tx.wait());
  const frontendId = 3;

  console.log("    Level 2: Architect → BackendAgent-8 (200 USDC)");
  tx = await escrow.connect(architect).createChildShake(architectId, 200_000000, 86400 * 4, ethers.id("Build API backend"));
  logGas("createChildShake (backend)", await tx.wait());
  const backendId = 4;

  tx = await escrow.connect(frontend).acceptShake(frontendId);
  logGas("acceptShake (frontend)", await tx.wait());

  tx = await escrow.connect(backend).acceptShake(backendId);
  logGas("acceptShake (backend)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Level 3: Frontend hires CSS (50)
  // ═══════════════════════════════════════════════════════════════
  console.log("    Level 3: Frontend → CSSAgent-12 (50 USDC)");
  tx = await escrow.connect(frontend).createChildShake(frontendId, 50_000000, 86400 * 3, ethers.id("Responsive CSS + animations"));
  logGas("createChildShake (css)", await tx.wait());
  const cssId = 5;

  tx = await escrow.connect(css).acceptShake(cssId);
  logGas("acceptShake (css)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Level 4: CSS hires Icon (15) — deepest level
  // ═══════════════════════════════════════════════════════════════
  console.log("    Level 4: CSS → IconDesigner-5 (15 USDC)");
  tx = await escrow.connect(css).createChildShake(cssId, 15_000000, 86400 * 2, ethers.id("Design 24 SVG icons"));
  logGas("createChildShake (icon)", await tx.wait());
  const iconId = 6;

  tx = await escrow.connect(icon).acceptShake(iconId);
  logGas("acceptShake (icon)", await tx.wait());

  console.log(`\n    Chain depth: 5 levels, ${await escrow.getShakeCount()} total shakes`);

  // ═══════════════════════════════════════════════════════════════
  // Deliver bottom-up
  // ═══════════════════════════════════════════════════════════════
  console.log("\n[3] Delivering bottom-up...");

  // Level 4: Icon delivers
  console.log("    Level 4: IconDesigner-5 delivers SVG icons");
  tx = await escrow.connect(icon).deliverShake(iconId, ethers.id("ipfs://icons-24-svg"));
  logGas("deliverShake (icon)", await tx.wait());

  // Level 3: CSS delivers
  console.log("    Level 3: CSSAgent-12 delivers responsive CSS");
  tx = await escrow.connect(css).deliverShake(cssId, ethers.id("ipfs://responsive-css"));
  logGas("deliverShake (css)", await tx.wait());

  // Level 2: Frontend and Backend deliver
  console.log("    Level 2: FrontendAgent-3 delivers React app");
  tx = await escrow.connect(frontend).deliverShake(frontendId, ethers.id("ipfs://react-frontend"));
  logGas("deliverShake (frontend)", await tx.wait());

  console.log("    Level 2: BackendAgent-8 delivers API");
  tx = await escrow.connect(backend).deliverShake(backendId, ethers.id("ipfs://api-backend"));
  logGas("deliverShake (backend)", await tx.wait());

  // Level 1: Architect and QA deliver
  console.log("    Level 1: ArchitectAgent-7 delivers system design");
  tx = await escrow.connect(architect).deliverShake(architectId, ethers.id("ipfs://architecture-docs"));
  logGas("deliverShake (architect)", await tx.wait());

  console.log("    Level 1: QABot-4 delivers test suite");
  tx = await escrow.connect(qa).deliverShake(qaId, ethers.id("ipfs://e2e-tests"));
  logGas("deliverShake (qa)", await tx.wait());

  // Level 0: PM delivers
  console.log("    Level 0: ProjectManager-1 delivers final product");
  tx = await escrow.connect(pm).deliverShake(rootId, ethers.id("ipfs://final-dashboard-app"));
  logGas("deliverShake (pm)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Release cascading (bottom-up settlement)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n[4] Cascading settlement (bottom-up)...");

  // Release deepest first
  console.log("    Level 4: CSS releases IconDesigner-5 (15 USDC)");
  tx = await escrow.connect(css).releaseShake(iconId);
  logGas("releaseShake (icon)", await tx.wait());

  console.log("    Level 3: Frontend releases CSSAgent-12 (50 USDC)");
  tx = await escrow.connect(frontend).releaseShake(cssId);
  logGas("releaseShake (css)", await tx.wait());

  console.log("    Level 2: Architect releases FrontendAgent-3 (150 USDC)");
  tx = await escrow.connect(architect).releaseShake(frontendId);
  logGas("releaseShake (frontend)", await tx.wait());

  console.log("    Level 2: Architect releases BackendAgent-8 (200 USDC)");
  tx = await escrow.connect(architect).releaseShake(backendId);
  logGas("releaseShake (backend)", await tx.wait());

  console.log("    Level 1: PM releases ArchitectAgent-7 (400 USDC)");
  tx = await escrow.connect(pm).releaseShake(architectId);
  logGas("releaseShake (architect)", await tx.wait());

  console.log("    Level 1: PM releases QABot-4 (100 USDC)");
  tx = await escrow.connect(pm).releaseShake(qaId);
  logGas("releaseShake (qa)", await tx.wait());

  console.log("    Level 0: Client releases ProjectManager-1 (1000 USDC)");
  tx = await escrow.connect(client).releaseShake(rootId);
  logGas("releaseShake (pm/root)", await tx.wait());

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("  SETTLEMENT COMPLETE");
  console.log("═".repeat(70));

  console.log("\n  Chain Structure:");
  console.log("  ┌─ Client → ProjectManager-1 (1000 USDC)");
  console.log("  │  ├─ ArchitectAgent-7 (400 USDC)");
  console.log("  │  │  ├─ FrontendAgent-3 (150 USDC)");
  console.log("  │  │  │  └─ CSSAgent-12 (50 USDC)");
  console.log("  │  │  │     └─ IconDesigner-5 (15 USDC)");
  console.log("  │  │  └─ BackendAgent-8 (200 USDC)");
  console.log("  │  └─ QABot-4 (100 USDC)");
  console.log("  └─ 7 shakes, 5 levels deep");

  // Gas summary table
  console.log("\n  Gas Costs per Operation:");
  console.log("  ┌────────────────────────────────────┬──────────┐");
  console.log("  │ Operation                          │ Gas      │");
  console.log("  ├────────────────────────────────────┼──────────┤");
  let totalGas = 0n;
  for (const entry of gasLog) {
    const gas = BigInt(entry.gas);
    totalGas += gas;
    const padded = entry.label.padEnd(36);
    console.log(`  │ ${padded}│ ${entry.gas.padStart(8)} │`);
  }
  console.log("  ├────────────────────────────────────┼──────────┤");
  console.log(`  │ TOTAL                              │ ${totalGas.toString().padStart(8)} │`);
  console.log("  └────────────────────────────────────┴──────────┘");

  console.log(`\n  Total shakes: ${await escrow.getShakeCount()}`);
  console.log("  All shakes settled: ✓");
  console.log("\n  Shake on it.\n");
}

main().catch(console.error);
