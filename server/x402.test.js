/**
 * x402 Server Endpoint Tests
 *
 * Tests the HTTP API endpoints using the Express app directly
 * (no actual server needed — uses supertest-style request handling).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const http = require("http");

describe("x402 HTTP Server", function () {
  let usdc, escrow, registry;
  let deployer, requester, worker;
  let app, server;

  before(async function () {
    [deployer, requester, worker] = await ethers.getSigners();

    // Deploy contracts
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy();

    const ShakeEscrow = await ethers.getContractFactory("ShakeEscrow");
    escrow = await ShakeEscrow.deploy(await usdc.getAddress(), deployer.address);

    await escrow.setRegistry(await registry.getAddress());
    await registry.authorizeCaller(await escrow.getAddress());

    // Fund and create test data
    await usdc.faucet(requester.address, 10000_000000);
    await usdc.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);
    await registry.connect(worker).register("TestWorker-1", ["coding", "scraping"]);

    // Create test shakes
    await escrow.connect(requester).createShake(500_000000, 86400, ethers.id("Test task 1"));
    await escrow.connect(requester).createShake(1000_000000, 86400, ethers.id("Test task 2"));
    await escrow.connect(worker).acceptShake(1);

    // Set up Express app with hardhat provider
    const escrowAddr = await escrow.getAddress();
    const registryAddr = await registry.getAddress();

    // Create server from x402.js app, injecting hardhat provider
    const x402 = require("./x402.js");
    x402.initContracts({
      provider: ethers.provider,
      escrowAddress: escrowAddr,
      registryAddress: registryAddr,
    });
    app = x402.app;

    // Start test server on random port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
  });

  after(function () {
    if (server) server.close();
  });

  function request(method, path, body) {
    const port = server.address().port;
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "localhost",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, body: data });
          }
        });
      });

      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it("GET /health — returns server status", async function () {
    const res = await request("GET", "/health");
    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal("ok");
    expect(res.body.protocol).to.equal("clawshake/v1");
    expect(res.body.chain).to.equal("base-sepolia");
  });

  it("GET /shake/:id — returns shake details", async function () {
    const res = await request("GET", "/shake/0");
    if (res.status !== 200) console.log("    /shake/0 error:", JSON.stringify(res.body));
    expect(res.status).to.equal(200);
    expect(res.body.shakeId).to.equal(0);
    expect(res.body.amountUSDC).to.equal(500);
    expect(res.body.status).to.equal("Pending");
    expect(res.body.requester).to.equal(requester.address);
  });

  it("GET /shake/:id — returns 404 for nonexistent shake", async function () {
    const res = await request("GET", "/shake/999");
    expect(res.status).to.equal(404);
    expect(res.body.error).to.equal("Shake not found");
  });

  it("POST /shake — returns 402 with payment headers when no payment", async function () {
    const res = await request("POST", "/shake", {
      amount: 500_000000,
      deadline: 86400,
      taskHash: ethers.id("New task"),
    });

    expect(res.status).to.equal(402);
    expect(res.headers["x-payment-required"]).to.equal("true");
    expect(res.headers["x-payment-chain"]).to.equal("base-sepolia");
    expect(res.headers["x-payment-protocol"]).to.equal("clawshake/v1");
    expect(res.body.error).to.equal("Payment required");
  });

  it("POST /shake — returns 400 for missing fields", async function () {
    const res = await request("POST", "/shake", { amount: 500 });
    expect(res.status).to.equal(400);
  });

  it("GET /agent/:address — returns agent passport", async function () {
    const res = await request("GET", `/agent/${worker.address}`);
    expect(res.status).to.equal(200);
    expect(res.body.name).to.equal("TestWorker-1");
    expect(res.body.skills).to.deep.equal(["coding", "scraping"]);
    expect(res.body.active).to.equal(true);
  });

  it("GET /agent/:address — returns 404 for unregistered agent", async function () {
    const res = await request("GET", `/agent/${deployer.address}`);
    expect(res.status).to.equal(404);
  });

  it("GET /jobs — lists open (Pending) shakes", async function () {
    const res = await request("GET", "/jobs");
    expect(res.status).to.equal(200);
    expect(res.body.count).to.be.greaterThanOrEqual(1);
    // shake 0 is Pending, shake 1 is Active
    const pendingJobs = res.body.jobs.filter(j => j.shakeId === 0);
    expect(pendingJobs.length).to.equal(1);
    expect(pendingJobs[0].amountUSDC).to.equal(500);
  });

  it("GET /jobs?minReward=800 — filters by minimum reward", async function () {
    const res = await request("GET", "/jobs?minReward=800");
    expect(res.status).to.equal(200);
    // Only shake 0 (500 USDC) is pending, so filtered out
    expect(res.body.count).to.equal(0);
  });
});
