# Clawshake x402 Server

HTTP payment endpoint for the Clawshake escrow protocol. Enables agent-to-agent discovery and payment initiation via standard HTTP with x402 payment-required headers.

## Quick Start

```bash
# Install dependencies
cd server && npm install

# Configure (copy and edit .env)
cp ../.env .env
# Add: ESCROW_ADDRESS=0x... REGISTRY_ADDRESS=0x...

# Run
node x402.js
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/shake/:id` | Shake details (amount, status, children, budget) |
| `POST` | `/shake` | Create a shake (returns 402 if no payment) |
| `GET` | `/agent/:address` | Agent passport (name, skills, reputation) |
| `GET` | `/jobs` | List open shakes (filterable: `?skills=X&minReward=Y`) |
| `GET` | `/health` | Server health check |

## x402 Payment Flow

When `POST /shake` is called without a payment transaction:

```
HTTP/1.1 402 Payment Required
X-Payment-Required: true
X-Payment-Address: 0x...
X-Payment-Amount: 500000000
X-Payment-Chain: base-sepolia
X-Payment-Protocol: clawshake/v1
```

The requesting agent then submits USDC payment on-chain and retries with `paymentTx`.

## Examples

```bash
# Get shake details
curl http://localhost:3402/shake/0

# List open jobs with minimum 100 USDC reward
curl "http://localhost:3402/jobs?minReward=100"

# Get agent passport
curl http://localhost:3402/agent/0x1234...

# Create shake (triggers 402 payment flow)
curl -X POST http://localhost:3402/shake \
  -H "Content-Type: application/json" \
  -d '{"amount": 500000000, "deadline": 86400, "taskHash": "0x..."}'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3402` |
| `RPC_URL` | Base Sepolia RPC | `https://sepolia.base.org` |
| `ESCROW_ADDRESS` | ShakeEscrow contract address | — |
| `REGISTRY_ADDRESS` | AgentRegistry contract address | — |
