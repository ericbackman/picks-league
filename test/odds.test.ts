// Odds math — the scoring engine's foundation, so these pin exact values.

import { describe, expect, it } from "vitest";
import { fairProbs, favoriteSide, fmtMl, fmtPct, impliedProb, payoutFor, type MlGame } from "../src/odds";

function game(overrides: Partial<MlGame> = {}): MlGame {
  return {
    home_ml: -143,
    away_ml: 119,
    draw_ml: null,
    odds: "PIT -143",
    away: "MIA",
    home: "PIT",
    ...overrides,
  };
}

describe("impliedProb", () => {
  it("computes book-implied probabilities", () => {
    expect(impliedProb(100)).toBeCloseTo(0.5);
    expect(impliedProb(-150)).toBeCloseTo(0.6);
    expect(impliedProb(200)).toBeCloseTo(1 / 3);
  });
});

describe("fairProbs", () => {
  it("strips the vig — probabilities sum to 1", () => {
    const probs = fairProbs(game())!;
    expect(probs.home + probs.away).toBeCloseTo(1);
    expect(probs.home).toBeGreaterThan(probs.away);
  });

  it("includes the draw in three-way markets", () => {
    const probs = fairProbs(game({ home_ml: -120, away_ml: 380, draw_ml: 250 }))!;
    expect(probs.home + probs.away + probs.draw).toBeCloseTo(1);
    expect(probs.draw).toBeGreaterThan(probs.away);
  });

  it("falls back to the legacy details string", () => {
    const probs = fairProbs(game({ home_ml: null, away_ml: null, odds: "PIT -149" }))!;
    expect(probs.home).toBeCloseTo(0.5984, 3);
    expect(probs.away).toBeCloseTo(0.4016, 3);
  });

  it("rejects spread-style details and missing odds", () => {
    expect(fairProbs(game({ home_ml: null, away_ml: null, odds: "BOS -3.5" }))).toBeNull();
    expect(fairProbs(game({ home_ml: null, away_ml: null, odds: null }))).toBeNull();
  });
});

describe("payoutFor", () => {
  it("pays the dog more than the favorite", () => {
    const g = game();
    expect(payoutFor("away", g)).toBeGreaterThan(payoutFor("home", g));
    expect(payoutFor("home", g)).toBeGreaterThanOrEqual(1);
  });

  it("defaults to a 2.0 coin flip without a market", () => {
    expect(payoutFor("home", game({ home_ml: null, away_ml: null, odds: null }))).toBe(2.0);
  });

  it("caps moonshot payouts at 10", () => {
    expect(payoutFor("away", game({ home_ml: -5000, away_ml: 2500 }))).toBe(10);
  });

  it("rounds to one decimal (display = score)", () => {
    const value = payoutFor("away", game());
    expect(value).toBe(Math.round(value * 10) / 10);
  });
});

describe("favoriteSide", () => {
  it("rides the chalk", () => {
    expect(favoriteSide(game())).toBe("home");
    expect(favoriteSide(game({ home_ml: 119, away_ml: -143 }))).toBe("away");
  });

  it("abstains without a market", () => {
    expect(favoriteSide(game({ home_ml: null, away_ml: null, odds: null }))).toBeNull();
  });
});

describe("formatting", () => {
  it("formats American odds and percentages", () => {
    expect(fmtMl(119)).toBe("+119");
    expect(fmtMl(-143)).toBe("-143");
    expect(fmtPct(0.598)).toBe("60%");
  });
});
