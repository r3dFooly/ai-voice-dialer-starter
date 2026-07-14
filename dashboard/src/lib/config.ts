// Runtime branding + label config. Every value has a neutral default and can be
// overridden with a NEXT_PUBLIC_* env var so the same build drops into any
// deployment without code edits. Safe to import from client components (only
// NEXT_PUBLIC_* vars are read).

/** Product / app name. Used in metadata + chrome. */
export const APP_NAME: string = process.env.NEXT_PUBLIC_APP_NAME || "Voice Dialer";

/** Human name for the voice agent/persona referenced in copy. */
export const AGENT_NAME: string = process.env.NEXT_PUBLIC_AGENT_NAME || "the voice dialer";

/** Parse "CODE:Label,CODE2:Label2" into a lookup map. Empty/malformed -> {}. */
function parseAgentNames(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [code, ...rest] = pair.split(":");
    const key = code?.trim();
    const label = rest.join(":").trim();
    if (key && label) out[key] = label;
  }
  return out;
}

/** Agent-code -> display-name map. Default {} (raw codes shown as-is). */
export const AGENT_NAMES: Record<string, string> = parseAgentNames(
  process.env.NEXT_PUBLIC_AGENT_NAMES,
);

/** Resolve an agent code to a display name, falling back to the raw code. */
export function agentDisplayName(code: string | null | undefined): string {
  if (!code) return "—";
  return AGENT_NAMES[code] ?? code;
}

/** Tier labels, indexed by tier 1..4 (index 0 unused / "Other" is index 3). */
export const TIER_LABELS: [string, string, string, string] = (() => {
  const raw = process.env.NEXT_PUBLIC_TIER_LABELS;
  const defaults: [string, string, string, string] = ["Tier 1", "Tier 2", "Tier 3", "Other"];
  if (!raw) return defaults;
  const parts = raw.split(",").map((s) => s.trim());
  return [
    parts[0] || defaults[0],
    parts[1] || defaults[1],
    parts[2] || defaults[2],
    parts[3] || defaults[3],
  ];
})();

/** Label for the DialerTier value 1..4. */
export function tierLabel(tier: number): string {
  return TIER_LABELS[tier - 1] ?? TIER_LABELS[3];
}

/** Column header for the lead-segment field. */
export const SEGMENT_LABEL: string = process.env.NEXT_PUBLIC_SEGMENT_LABEL || "Segment";
