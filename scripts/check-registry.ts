/**
 * One-off: confirm the AccountRegistry id that pairs with the relayer's live
 * packageId. Run when the deployment rotates and /api/health reports a mismatch.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/check-registry.ts <registryId>");
  process.exit(1);
}
// Narrowed into a const so the type survives into the async closure.
const registryId: string = arg;

async function main() {
  const serverUrl = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz";
  const config = (await (await fetch(`${serverUrl}/config`)).json()) as { packageId?: string };
  if (!config.packageId) throw new Error(`${serverUrl}/config did not report a packageId`);
  const client = new SuiGrpcClient({ baseUrl: "https://mysten-rpc.mainnet.sui.io", network: "mainnet" });

  const res = await client.core.getObject({ objectId: registryId });
  const type = res.object?.type ?? "(not found)";
  console.log("relayer packageId:", config.packageId);
  console.log("registry type:    ", type);
  console.log("struct:           ", type.split("::").pop());
  console.log(
    "matches:          ",
    type.startsWith(`${config.packageId}::`) ? "YES" : "NO — this registry belongs to a different package",
  );
}

void main();
