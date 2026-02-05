const hre = require("hardhat");
async function main() {
  const registry = await hre.ethers.getContractAt("AgentRegistry", "0xdF3484cFe3C31FE00293d703f30da1197a16733E");
  console.log("Authorizing escrow on registry...");
  const tx = await registry.authorizeCaller("0xa33F9fA90389465413FFb880FD41e914b7790C61");
  await tx.wait();
  console.log("Done! TX:", tx.hash);
}
main().catch(e => { console.error(e); process.exit(1); });
