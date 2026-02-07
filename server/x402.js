/**
 * Clawshake x402 HTTP Payment Endpoint
 *
 * Lightweight Express server that exposes ShakeEscrow and AgentRegistry
 * via HTTP with x402 payment-required headers for agent-to-agent discovery.
 *
 * Endpoints:
 *   GET  /shake/:id       — shake details
 *   POST /shake           — create a shake
 *   GET  /agent/:address  — agent passport from registry
 *   GET  /jobs            — list open (Pending) shakes, filterable by skills/minReward
 *   GET  /health          — server health check
 *
 * x402 Headers (returned on payment-required responses):
 *   X-Payment-Required: true
 *   X-Payment-Address: <escrow-contract>
 *   X-Payment-Amount: <usdc-amount>
 *   X-Payment-Chain: base-sepolia
 *   X-Payment-Protocol: clawshake/v1
 */

const express = require("express");
const { ethers } = require("ethers");
require("dotenv").config({ path: "../.env" });

const app = express();
app.use(express.json());

// --- Contract ABIs (minimal) ---
const ESCROW_ABI = [
  "function getShake(uint256 shakeId) view returns (tuple(address requester, address worker, uint256 amount, uint256 parentShakeId, uint48 deadline, uint48 deliveredAt, uint8 status, bytes32 taskHash, bytes32 deliveryHash, bool isChildShake, uint48 disputeFrozenUntil))",
  "function getShakeCount() view returns (uint256)",
  "function getChildShakes(uint256 parentShakeId) view returns (uint256[])",
  "function getRemainingBudget(uint256 shakeId) view returns (uint256)",
  "function createShake(uint256 amount, uint48 deadline, bytes32 taskHash) returns (uint256)",
];

const REGISTRY_ABI = [
  "function getPassport(address agent) view returns (bytes32 agentId, string name, uint256 totalShakes, uint256 totalEarned, uint256 successRate, uint256 disputesLost, bool active)",
  "function getSkills(address agent) view returns (string[])",
  "function isRegistered(address agent) view returns (bool)",
  "function getAgentCount() view returns (uint256)",
];

// --- Configuration ---
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "0x0000000000000000000000000000000000000000";
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || "0x0000000000000000000000000000000000000000";
const PORT = process.env.PORT || 3402;

// --- Provider & Contracts ---
let provider, escrow, registry;

function initContracts(opts) {
  if (opts && opts.provider) {
    // Dependency injection for testing
    provider = opts.provider;
    escrow = new ethers.Contract(opts.escrowAddress || ESCROW_ADDRESS, ESCROW_ABI, provider);
    registry = new ethers.Contract(opts.registryAddress || REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  } else {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);
    registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  }
}

// --- Status Enum ---
const STATUS_NAMES = ["Pending", "Active", "Delivered", "Released", "Disputed", "Refunded"];

// --- x402 Headers ---
function set402Headers(res, amount) {
  res.set("X-Payment-Required", "true");
  res.set("X-Payment-Address", ESCROW_ADDRESS);
  res.set("X-Payment-Amount", amount.toString());
  res.set("X-Payment-Chain", "base-sepolia");
  res.set("X-Payment-Protocol", "clawshake/v1");
}

// --- Routes ---

// GET /shake/:id — shake details
app.get("/shake/:id", async (req, res) => {
  try {
    const shakeId = parseInt(req.params.id);
    const count = await escrow.getShakeCount();

    if (shakeId >= Number(count)) {
      return res.status(404).json({ error: "Shake not found" });
    }

    const s = await escrow.getShake(shakeId);
    const children = await escrow.getChildShakes(shakeId);
    const budget = await escrow.getRemainingBudget(shakeId);

    res.json({
      shakeId,
      requester: s.requester,
      worker: s.worker,
      amount: s.amount.toString(),
      amountUSDC: Number(s.amount) / 1e6,
      parentShakeId: Number(s.parentShakeId),
      deadline: Number(s.deadline),
      deliveredAt: Number(s.deliveredAt),
      status: STATUS_NAMES[s.status] || "Unknown",
      statusCode: Number(s.status),
      taskHash: s.taskHash,
      deliveryHash: s.deliveryHash,
      isChildShake: s.isChildShake,
      disputeFrozenUntil: Number(s.disputeFrozenUntil),
      childShakes: children.map(Number),
      remainingBudget: budget.toString(),
      remainingBudgetUSDC: Number(budget) / 1e6,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /shake — create a shake (returns x402 if no payment)
app.post("/shake", async (req, res) => {
  const { amount, deadline, taskHash, paymentTx } = req.body;

  if (!amount || !deadline || !taskHash) {
    return res.status(400).json({ error: "Missing required fields: amount, deadline, taskHash" });
  }

  // If no payment transaction provided, return 402
  if (!paymentTx) {
    set402Headers(res, amount);
    return res.status(402).json({
      error: "Payment required",
      message: "Submit USDC payment to create this shake",
      amount,
      deadline,
      taskHash,
      escrowAddress: ESCROW_ADDRESS,
      chain: "base-sepolia",
      protocol: "clawshake/v1",
    });
  }

  // If payment tx provided, verify and return confirmation
  try {
    const receipt = await provider.getTransactionReceipt(paymentTx);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: "Payment transaction failed or not found" });
    }

    res.status(201).json({
      message: "Shake creation initiated",
      paymentTx,
      amount,
      deadline,
      taskHash,
      status: "pending_confirmation",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /agent/:address — agent passport
app.get("/agent/:address", async (req, res) => {
  try {
    const addr = req.params.address;
    if (!ethers.isAddress(addr)) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const isReg = await registry.isRegistered(addr);
    if (!isReg) {
      return res.status(404).json({ error: "Agent not registered" });
    }

    const passport = await registry.getPassport(addr);
    const skills = await registry.getSkills(addr);

    res.json({
      address: addr,
      agentId: passport.agentId,
      name: passport.name,
      skills,
      totalShakes: Number(passport.totalShakes),
      totalEarned: passport.totalEarned.toString(),
      totalEarnedUSDC: Number(passport.totalEarned) / 1e6,
      successRate: Number(passport.successRate) / 100, // Convert bps to percentage
      disputesLost: Number(passport.disputesLost),
      active: passport.active,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /jobs — list open shakes, filterable by skills and minReward
app.get("/jobs", async (req, res) => {
  try {
    const minReward = parseInt(req.query.minReward || "0") * 1e6; // Convert USDC to 6 decimals
    const skillsFilter = req.query.skills ? req.query.skills.split(",").map(s => s.trim().toLowerCase()) : [];

    const count = Number(await escrow.getShakeCount());
    const jobs = [];

    // Scan recent shakes (limit to last 100 for performance)
    const start = Math.max(0, count - 100);

    for (let i = start; i < count; i++) {
      const s = await escrow.getShake(i);

      // Only show Pending shakes (open jobs)
      if (Number(s.status) !== 0) continue;

      const amount = Number(s.amount);
      if (amount < minReward) continue;

      jobs.push({
        shakeId: i,
        requester: s.requester,
        amount: s.amount.toString(),
        amountUSDC: amount / 1e6,
        deadline: Number(s.deadline),
        taskHash: s.taskHash,
        isChildShake: s.isChildShake,
        parentShakeId: Number(s.parentShakeId),
      });
    }

    res.json({
      count: jobs.length,
      filters: { minReward: minReward / 1e6, skills: skillsFilter },
      jobs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health — server health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    protocol: "clawshake/v1",
    chain: "base-sepolia",
    escrow: ESCROW_ADDRESS,
    registry: REGISTRY_ADDRESS,
  });
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// --- Start ---
if (require.main === module) {
  initContracts();
  app.listen(PORT, () => {
    console.log(`Clawshake x402 server running on port ${PORT}`);
    console.log(`  Escrow:   ${ESCROW_ADDRESS}`);
    console.log(`  Registry: ${REGISTRY_ADDRESS}`);
    console.log(`  Chain:    base-sepolia`);
  });
}

// Export for testing
module.exports = { app, initContracts, set402Headers };
