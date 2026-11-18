import { createClient, VERSION } from "@unsandbox/core";

const client = createClient({ baseUrl: "https://api.example.com/v1/", timeoutMs: 5_000 });
const resolved = client.resolve("widgets/42");

console.log(`@unsandbox/core v${VERSION}`);
console.log(`base: ${client.baseUrl} (timeout ${client.timeoutMs}ms)`);
console.log(resolved.ok ? `resolved: ${resolved.value}` : `failed: ${resolved.error.message}`);
