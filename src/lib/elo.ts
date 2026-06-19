const K_FACTOR = 25;

export type Tier = "bronze" | "silver" | "gold" | "platinum" | "diamond" | "master";

export interface EloResult {
  newRatingA: number;
  newRatingB: number;
  deltaA: number;
  deltaB: number;
}

export function calcElo(ratingA: number, ratingB: number, winner: "A" | "B"): EloResult {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;

  const scoreA = winner === "A" ? 1 : 0;
  const scoreB = winner === "B" ? 1 : 0;

  const deltaA = Math.round(K_FACTOR * (scoreA - expectedA));
  const deltaB = Math.round(K_FACTOR * (scoreB - expectedB));

  return {
    newRatingA: ratingA + deltaA,
    newRatingB: ratingB + deltaB,
    deltaA,
    deltaB,
  };
}

export function ratingToTier(rating: number): { tier: Tier; division: number } {
  if (rating >= 2200) return { tier: "master", division: 1 };
  if (rating >= 2000) return { tier: "diamond", division: Math.min(4, Math.floor((rating - 2000) / 50) + 1) };
  if (rating >= 1700) return { tier: "platinum", division: Math.min(4, Math.floor((rating - 1700) / 75) + 1) };
  if (rating >= 1500) return { tier: "gold", division: Math.min(4, Math.floor((rating - 1500) / 50) + 1) };
  if (rating >= 1300) return { tier: "silver", division: Math.min(4, Math.floor((rating - 1300) / 50) + 1) };
  return { tier: "bronze", division: Math.min(4, Math.floor((rating - 1000) / 75) + 1) };
}
