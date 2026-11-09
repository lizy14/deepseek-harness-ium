import { createPolicyAudit } from './ium-audit.mjs';

// Explicit --import completes before Host entry dependencies evaluate.
// This local-only initialization preserves Node's environment-proxy dispatcher.
await (await globalThis.fetch('data:,ium-policy-initialize')).arrayBuffer();
const { createPolicyOwner, installNodePolicy } = await import(new URL('./ium-network-policy.js', import.meta.url).href);
const networkPolicy = createPolicyOwner({ audit: createPolicyAudit(process.env.DSH_HOME) });
installNodePolicy(networkPolicy);
