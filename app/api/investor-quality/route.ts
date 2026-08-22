import { ensureSchema, listInvestors } from "../../../lib/store";

export const dynamic = "force-dynamic";

export type InvestorQualityResult = {
  username: string;
  meetsCriteria: boolean;
  reasons: string[];
};

export type InvestorQualityPayload = {
  computedAt: string;
  results: InvestorQualityResult[];
};

// Every live approach tried here (a per-investor sweep, a ranking-pool scan,
// both together) kept tripping eToro's shared rate-limit cooldown badly
// enough to leave the "who qualifies" list empty or wrong for long stretches
// — and that list matters more than it staying minute-to-minute fresh. This
// is the fixed result of the statistical screen run against the ranking
// pool (2yr gain 65-200%, YTD >=20%, risk <=6, high leverage <=10%, copiers
// >50, >=150 trades/2yr, win ratio >=60%, copiersGain > 0): a static list,
// no eToro requests, no loading state, no way for it to go stale mid-visit.
// Re-run the screen manually and edit this list if it needs updating —
// don't wire it back to a live fetch without a real fix for the rate-limit
// problem above.
const QUALIFYING_USERNAMES = new Set([
  "jianswang",
  "trevinayoussef",
  "marianopardo",
  "alteneiji80",
  "gmenez128",
  "smudliczek",
  "veronikaklauzova",
  "rammiyatharshan",
  "jfkinvestor",
  "fabiocm",
  "choose3395",
  "wesselv",
  "b--art",
  "aguero1010",
  "sylviafarre",
  "rudolfdeleeuw",
].map((username) => username.toLowerCase()));

export async function GET() {
  await ensureSchema();
  const investors = await listInvestors();
  const results: InvestorQualityResult[] = investors.map((investor) => {
    const meetsCriteria = QUALIFYING_USERNAMES.has(investor.username.toLowerCase());
    return {
      username: investor.username,
      meetsCriteria,
      reasons: meetsCriteria ? [] : ["Poza listą spełniających wymagania (wg statystycznego przesiewu)"],
    };
  });
  const payload: InvestorQualityPayload = { computedAt: new Date().toISOString(), results };
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
