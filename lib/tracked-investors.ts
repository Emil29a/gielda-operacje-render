import type { Investor } from "./types";

export const TRACKED_USERNAMES = [
  "jianswang",
  "rafaeldfl",
  "jeppekirkbonde",
  "marianopardo",
  "saifsyn",
  "flaten",
  "celesh",
  "oceantan007",
  "nabilsifo",
  "leszekfx",
  "mrmagoon",
  "sir_h_pennywise",
  "trevinayoussef",
  "gauravk_in",
  "thedividendfund",
  "alteneiji80",
  "tonishiii",
  "akatri",
  "bryamdecava",
  "lordhumpe",
  "joanfigueroa47",
  "brightgoldgold",
  "infinity-ai",
  "mrmoire",
  "dhaskey",
  "rockhound83",
  "prodoser",
  // Added from the statistical screen (2yr gain 65-200%, YTD >=20%, risk
  // <=6, high leverage <=10%, copiers >50, >=150 trades/2yr, win ratio
  // >=60%, copiersGain > 0) run against the copiersMin=7 ranking pool.
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
] as const;

export function trackedInvestorPlaceholders(): Investor[] {
  const updatedAt = new Date().toISOString();
  return TRACKED_USERNAMES.map((username, index) => ({
    slot: index + 1,
    username,
    cid: 0,
    fullName: username,
    avatarUrl: null,
    riskScore: null,
    dailyGain: null,
    gainYtd: null,
    gainTwoYears: null,
    copiers: null,
    updatedAt,
    activeSince: null,
    annualizedReturn: null,
    fiveYearGain: null,
    rankPosition: null,
    rankPoolSize: null,
  }));
}

export function hasTrackedUsernames(investors: Investor[]) {
  return (
    investors.length === TRACKED_USERNAMES.length &&
    investors.every(
      (investor, index) =>
        investor.username.toLowerCase() === TRACKED_USERNAMES[index],
    )
  );
}
