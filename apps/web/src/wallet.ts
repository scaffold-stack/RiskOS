import type { WalletTransactionRequest } from "../../../packages/domain/src/index.js";

interface ConnectedWallet { address: string; publicKey: string; label: string; }
interface TestWallet {
  connect(): Promise<ConnectedWallet>;
  signMessage(message: string, challengeId: string): Promise<{ publicKey: string; signature: string }>;
  callContract(params: NonNullable<WalletTransactionRequest["params"]>): Promise<{ txid: string }>;
}

declare global { interface Window { __RISKOS_TEST_WALLET__?: TestWallet; } }

export async function connectRiskOSWallet(): Promise<ConnectedWallet> {
  if (window.__RISKOS_TEST_WALLET__) return window.__RISKOS_TEST_WALLET__.connect();
  const { connect } = await import("@stacks/connect");
  const result = await connect({ network: "mainnet" });
  const entry = result.addresses.find((candidate) => /^(SP|SM|ST|SN)/.test(candidate.address));
  if (!entry) throw new Error("The wallet did not return a Stacks address");
  return { address: entry.address, publicKey: entry.publicKey, label: entry.symbol ?? "Stacks wallet" };
}

export async function signOwnershipMessage(message: string, challengeId: string) {
  if (window.__RISKOS_TEST_WALLET__) return window.__RISKOS_TEST_WALLET__.signMessage(message, challengeId);
  const { request } = await import("@stacks/connect");
  const signed = await request("stx_signMessage", { message });
  return { publicKey: signed.publicKey, signature: signed.signature };
}

export async function sendWalletRequest(walletRequest: WalletTransactionRequest): Promise<{ txid: string }> {
  if (!walletRequest.params) throw new Error("This action is shadow-only and cannot be broadcast");
  if (window.__RISKOS_TEST_WALLET__) return window.__RISKOS_TEST_WALLET__.callContract(walletRequest.params);
  const { request } = await import("@stacks/connect");
  // The API payload is the JSON-safe equivalent of Connect's template-literal contract type.
  const result = await request("stx_callContract", walletRequest.params as never);
  if (!result.txid) throw new Error("The wallet did not return a transaction ID");
  return { txid: result.txid };
}

export async function disconnectRiskOSWallet() { const { disconnect } = await import("@stacks/connect"); disconnect(); }
