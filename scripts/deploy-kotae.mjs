import "dotenv/config";
import { network } from "hardhat";
import { getAddress, isAddress, zeroAddress } from "viem";

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value) || getAddress(value) === zeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

if (!process.env.PRIVATE_KEY?.trim()) {
  throw new Error("PRIVATE_KEY is required for Testnet deployment");
}

const ausd = requiredAddress("AUSD_ADDRESS");
const platform = requiredAddress("PLATFORM_RECIPIENT");
const oracle = requiredAddress("ELIGIBILITY_ORACLE");
const { viem } = await network.create({ network: "monadTestnet", chainType: "l1" });
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

if (!deployer) throw new Error("No Monad Testnet deployer account is configured");

const chainId = await publicClient.getChainId();
if (chainId !== 10143) throw new Error(`Refusing to deploy to unexpected chain ${chainId}`);

console.log(`Deploying KotaeEscrow from ${deployer.account.address} on Monad Testnet...`);
const escrow = await viem.deployContract("KotaeEscrow", [ausd, platform, oracle]);

console.log(JSON.stringify({
  chainId,
  contract: escrow.address,
  ausd,
  platform,
  oracle,
}, null, 2));
