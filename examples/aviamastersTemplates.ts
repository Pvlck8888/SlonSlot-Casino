// AviaMasters pre-baked outcome templates.
// 50 deterministic flight scripts: 5 big wins (>10x), 10 small wins (0.5–3x),
// 35 losses with varying crash points.
//
// The server picks one template per round based on the admin win-rate, so each
// outcome is a known scripted animation. Client and server agree on the final
// multiplier because the collectibles' formulas are identical on both sides.

export type AviaCollectibleType = "add" | "multiply" | "rocket";

export interface AviaCollectible {
  x: number; // 0..1 along flight progress
  y: number; // 0..1 vertical placement (canvas height ratio)
  type: AviaCollectibleType;
  value: number;
}

export interface AviaTemplate {
  id: string;
  won: boolean;
  multiplier: number; // final payout multiplier (0 if loss)
  crashPoint: number; // 1.0 for wins; 0..1 fraction for losses
  collectibles: AviaCollectible[];
}

// Tiny seedable PRNG so templates are stable across server restarts.
function seedRand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Compute mult from a list of collectibles, ignoring those past the crash point.
function computeMult(items: AviaCollectible[], crashPoint: number): number {
  let m = 1.0;
  for (const c of items) {
    if (c.x >= crashPoint) break;
    if (c.type === "add") m += c.value * 0.1;
    else if (c.type === "multiply") m *= 1 + c.value * 0.1;
    else if (c.type === "rocket") m *= 0.5;
  }
  return Math.min(250, Math.max(0, m));
}

// Generate a winning template that ends near `target`.
function genWin(seed: number, target: number, missileChance: number, label: string): AviaTemplate {
  const r = seedRand(seed);
  const num = 7 + Math.floor(r() * 7); // 7-13 items
  const items: AviaCollectible[] = [];
  let mult = 1.0;

  const missileSlot = r() < missileChance ? 2 + Math.floor(r() * (num - 4)) : -1;

  for (let i = 0; i < num; i++) {
    const x = 0.1 + (i / num) * 0.82;
    const y = 0.18 + r() * 0.55;
    if (i === missileSlot) {
      items.push({ x, y, type: "rocket", value: 0.5 });
      mult *= 0.5;
      continue;
    }
    const remaining = target / mult;
    // Mix multiplies and adds so visual variety stays high but we converge to target.
    const remainingItems = num - i;
    const isLast = i === num - 1;
    if (remaining > 1.4 && remainingItems > 1) {
      // pick a multiplier orb that brings us closer
      const want = Math.min(5, Math.max(2, Math.round((remaining - 1) * 10 / Math.max(1, remainingItems - 1))));
      const v = Math.min(5, Math.max(2, want));
      items.push({ x, y, type: "multiply", value: v });
      mult *= 1 + v * 0.1;
    } else if (remaining > 1.02 || isLast) {
      // small additive boost to nudge us up
      const want = Math.max(1, Math.min(10, Math.round((remaining - 1) * 10)));
      items.push({ x, y, type: "add", value: want });
      mult += want * 0.1;
    } else {
      // already at/over target — sprinkle a small add for visuals
      const v = 1 + Math.floor(r() * 3);
      items.push({ x, y, type: "add", value: v });
      mult += v * 0.1;
    }
  }
  // Recompute authoritative final mult from items (matches client's formulas)
  const finalMult = computeMult(items, 1.0);
  return {
    id: `${label}_${seed}`,
    won: true,
    multiplier: Math.round(finalMult * 100) / 100,
    crashPoint: 1.0,
    collectibles: items,
  };
}

// Generate a losing template that crashes at `crashAt`. Items beyond crashAt are
// still placed (so the camera scenery looks busy near the crash point).
function genLoss(seed: number, crashAt: number): AviaTemplate {
  const r = seedRand(seed);
  const num = 6 + Math.floor(r() * 8); // 6-13 items
  const items: AviaCollectible[] = [];
  for (let i = 0; i < num; i++) {
    const x = 0.08 + (i / num) * 0.85;
    const y = 0.18 + r() * 0.55;
    const tr = r();
    if (tr < 0.22) {
      items.push({ x, y, type: "rocket", value: 0.5 });
    } else if (tr < 0.55) {
      items.push({ x, y, type: "multiply", value: 2 + Math.floor(r() * 4) });
    } else {
      items.push({ x, y, type: "add", value: 1 + Math.floor(r() * 5) });
    }
  }
  return {
    id: `loss_${seed}`,
    won: false,
    multiplier: 0,
    crashPoint: Math.round(crashAt * 1000) / 1000,
    collectibles: items,
  };
}

// Build a guaranteed-big win by stacking N multiplier orbs (each ×1.5) and a few
// adds for visual variety. 8 multiplies → ~25.6x, 10 → ~57.6x.
function genBigWin(seed: number, orbCount: number): AviaTemplate {
  const r = seedRand(seed);
  const items: AviaCollectible[] = [];
  // Stretch the orbs evenly along the flight, leave the last 12% for the runway.
  for (let i = 0; i < orbCount; i++) {
    const x = 0.08 + ((i + 0.5) / orbCount) * 0.78;
    const y = 0.18 + r() * 0.55;
    items.push({ x, y, type: "multiply", value: 5 });
  }
  // Sprinkle 2 small adds in random gaps for variety.
  for (let k = 0; k < 2; k++) {
    items.push({
      x: 0.12 + r() * 0.74,
      y: 0.18 + r() * 0.55,
      type: "add",
      value: 2 + Math.floor(r() * 4),
    });
  }
  items.sort((a, b) => a.x - b.x);
  const finalMult = computeMult(items, 1.0);
  return {
    id: `winBig_${seed}`,
    won: true,
    multiplier: Math.round(finalMult * 100) / 100,
    crashPoint: 1.0,
    collectibles: items,
  };
}

// 5 big wins: orb counts produce ~17x, 25x, 38x, 57x, 86x → all >10x guaranteed.
const BIG_WINS: AviaTemplate[] = [
  genBigWin(1001, 7),
  genBigWin(1002, 8),
  genBigWin(1003, 9),
  genBigWin(1004, 10),
  genBigWin(1005, 11),
];

// Sanity: all big wins must exceed 10x.
if (!BIG_WINS.every((t) => t.multiplier > 10)) {
  throw new Error(
    `[aviamastersTemplates] big-win multipliers below 10x: ${BIG_WINS.map((t) => t.multiplier).join(", ")}`,
  );
}

// 10 small wins: 0.5x – 3.0x, ~50% include a missile penalty
const SMALL_WINS: AviaTemplate[] = [
  genWin(2001, 0.6, 0.9, "winSmall"),
  genWin(2002, 0.9, 0.9, "winSmall"),
  genWin(2003, 1.1, 0.5, "winSmall"),
  genWin(2004, 1.3, 0.5, "winSmall"),
  genWin(2005, 1.5, 0.4, "winSmall"),
  genWin(2006, 1.8, 0.3, "winSmall"),
  genWin(2007, 2.1, 0.3, "winSmall"),
  genWin(2008, 2.4, 0.2, "winSmall"),
  genWin(2009, 2.7, 0.2, "winSmall"),
  genWin(2010, 2.95, 0.1, "winSmall"),
];

// 35 losses spread across the flight (15% – 85%)
const LOSSES: AviaTemplate[] = Array.from({ length: 35 }, (_, i) =>
  genLoss(3000 + i, 0.15 + ((i * 7) % 35) / 50) // pseudo-random crash points 0.15..~0.85
);

export const AVIA_TEMPLATES = {
  bigWins: BIG_WINS,
  smallWins: SMALL_WINS,
  losses: LOSSES,
  allWins: [...BIG_WINS, ...SMALL_WINS],
};

// Pick a random win/loss template based on the admin-driven win-rate decision.
export function pickAviaTemplate(playerShouldWin: boolean): AviaTemplate {
  if (playerShouldWin) {
    // 1 in 3 chance of a "big" win when winning, otherwise small
    const pool = Math.random() < 0.33 ? AVIA_TEMPLATES.bigWins : AVIA_TEMPLATES.smallWins;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return AVIA_TEMPLATES.losses[Math.floor(Math.random() * AVIA_TEMPLATES.losses.length)];
}
