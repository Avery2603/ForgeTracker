import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Check, X, Plus, Trash2, ChevronRight, ChevronDown, Dumbbell, UtensilsCrossed, ClipboardList, DollarSign, RotateCcw, Loader2, Flame, Info, BookOpen, Bell, ShoppingCart, Search, SlidersHorizontal, Clock, Trophy, TrendingUp, AlertTriangle } from "lucide-react";

// ---------------------------------------------------------------------------
// Storage — localStorage-backed persistence.
//
// Production-safe: localStorage works in any standard browser (no backend
// needed), is scoped to this origin, and is disk-backed — data survives a
// page refresh AND a full browser close/reopen, unlike the previous
// `window.storage` API this replaced, which only exists inside the Claude
// Artifacts preview environment and silently failed everywhere else
// (every save/load was throwing and getting swallowed by an empty catch).
//
// Backwards-compat: if this code is ever running somewhere `window.storage`
// still exists (e.g. re-opened inside an Artifacts preview) and a key isn't
// in localStorage yet, we read it from the legacy API once and copy it into
// localStorage — so no existing data is lost when moving to this version.
//
// Failure handling: `save` never throws — it returns { ok, reason } so the
// UI can show the user a real error (private/incognito mode blocking
// storage, quota exceeded, etc.) instead of failing silently.
// ---------------------------------------------------------------------------
const STORAGE_PREFIX = "forge:";

function detectLocalStorage() {
  try {
    const testKey = "__forge_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}
const LOCAL_STORAGE_AVAILABLE = typeof window !== "undefined" && detectLocalStorage();

const load = async (key, fallback) => {
  const fullKey = STORAGE_PREFIX + key;

  if (LOCAL_STORAGE_AVAILABLE) {
    try {
      const raw = window.localStorage.getItem(fullKey);
      if (raw !== null) return JSON.parse(raw);
    } catch (e) {
      console.error("[FORGE storage] localStorage read failed for", key, e);
      // fall through to legacy source / fallback below
    }
  }

  // Legacy migration path — only relevant if window.storage happens to
  // exist (Artifacts preview) AND localStorage didn't already have this key.
  if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") {
    try {
      const r = await window.storage.get(key);
      if (r && r.value != null) {
        const value = JSON.parse(r.value);
        if (LOCAL_STORAGE_AVAILABLE) {
          try { window.localStorage.setItem(fullKey, JSON.stringify(value)); } catch (e) { console.error("[FORGE storage] migration write failed for", key, e); }
        }
        return value;
      }
    } catch {
      // legacy API not usable here — ignore and fall through
    }
  }

  return fallback;
};

const save = async (key, value) => {
  if (!LOCAL_STORAGE_AVAILABLE) {
    return { ok: false, reason: "Your browser is blocking local storage (private/incognito mode, or storage disabled in settings)." };
  }
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return { ok: true };
  } catch (e) {
    console.error("[FORGE storage] save failed for", key, e);
    const isQuota = e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
    return {
      ok: false,
      reason: isQuota
        ? "Storage is full, so this change wasn't saved. Try clearing old data."
        : "Your browser blocked saving this change (private/incognito mode, or storage disabled in settings).",
    };
  }
};

const uid = () => Math.random().toString(36).slice(2, 10);
const todayStr = () => new Date().toISOString().slice(0, 10);
const round25 = (n) => Math.round(n / 2.5) * 2.5;

// ---------------------------------------------------------------------------
// Design system — locked macro color trio (borrowed from the MyFitnessPal
// pattern of giving protein/carbs/fat a consistent color everywhere they
// appear, rather than everything being the same brand orange) plus a couple
// of shared visual primitives: a circular progress ring for the day's
// calories (the "completing the circle" motif) and a small macro progress
// bar. Orange stays reserved for the FORGE brand accent and primary CTAs;
// teal/red stay reserved for "on track" / "over" signal color, matching how
// they're already used for cost budget throughout the app.
// ---------------------------------------------------------------------------
const MACRO_COLORS = {
  protein: { text: "text-sky-400", bg: "bg-sky-400", ring: "#38bdf8", dim: "text-sky-400/60" },
  carbs: { text: "text-amber-400", bg: "bg-amber-400", ring: "#fbbf24", dim: "text-amber-400/60" },
  fat: { text: "text-violet-400", bg: "bg-violet-400", ring: "#a78bfa", dim: "text-violet-400/60" },
};

// Compact inline macro readout — "180P · 220C · 60F" but each number in its
// locked macro color, used anywhere a meal/recipe/food-log-entry macro
// summary is shown so the same numbers always read the same way at a glance.
function MacroInline({ protein, carbs, fat, size = "text-xs" }) {
  return (
    <span className={`${size} inline-flex items-center gap-1.5`}>
      <span className={MACRO_COLORS.protein.text}>{Math.round(protein || 0)}P</span>
      <span className="text-zinc-700">·</span>
      <span className={MACRO_COLORS.carbs.text}>{Math.round(carbs || 0)}C</span>
      <span className="text-zinc-700">·</span>
      <span className={MACRO_COLORS.fat.text}>{Math.round(fat || 0)}F</span>
    </span>
  );
}

// A single labeled macro progress bar (value vs target), colored per the
// locked trio above. Used in Logbook and anywhere else showing progress
// toward a macro target.
function MacroBar({ label, color, val, tgt, unit = "g" }) {
  const pct = tgt > 0 ? Math.min(100, Math.round((val / tgt) * 100)) : 0;
  const over = tgt > 0 && val > tgt;
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400 mb-1">
        <span className={color.text}>{label}</span>
        <span className={over ? "text-red-500 font-medium" : "text-zinc-400"}>
          {Math.round(val)}{unit} / {tgt}{unit}
        </span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${over ? "bg-red-500" : color.bg}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Circular calorie progress ring — the "completing the circle" motif from
// MyFitnessPal's Today screen: a big glanceable ring with the number in the
// center, color-flipping to red if you've gone over target.
function CalorieRing({ value, target, size = 132, stroke = 11 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = target > 0 ? Math.min(1, value / target) : 0;
  const over = target > 0 && value > target;
  const color = over ? "#ef4444" : "#f97316"; // red-500 / orange-500
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#27272a" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-2xl font-black leading-none" style={{ color }}>{Math.round(value)}</div>
        <div className="text-[10px] text-zinc-500 mt-1">{target > 0 ? `of ${target} kcal` : "kcal"}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grocery price estimation — local price-per-unit reference table.
// This is NOT a live web lookup (artifacts can't browse arbitrary grocery
// sites). It's a best-effort estimate from common US grocery pricing that the
// user can override per ingredient.
// ---------------------------------------------------------------------------
const PRICE_TABLE = [
  { match: /chicken breast/i, unit: "lb", price: 2.57, continuous: true }, // verified Walmart.com, Jul 2026
  { match: /chicken thigh/i, unit: "lb", price: 2.49, continuous: true },
  { match: /ground beef|beef 90|beef 93/i, unit: "lb", price: 5.49, continuous: true },
  { match: /steak|sirloin|ribeye/i, unit: "lb", price: 8.99, continuous: true },
  { match: /tilapia|white fish|cod/i, unit: "lb", price: 6.99, continuous: true },
  { match: /salmon/i, unit: "lb", price: 9.99, continuous: true },
  { match: /egg white/i, unit: "carton (16oz)", price: 3.99 },
  { match: /egg/i, unit: "dozen", price: 1.47 }, // verified Walmart.com Great Value, Jul 2026
  { match: /rice/i, unit: "lb", price: 0.89, continuous: true },
  { match: /oats?|oatmeal/i, unit: "lb", price: 1.29, continuous: true },
  { match: /sweet potato/i, unit: "lb", price: 1.19, continuous: true },
  { match: /potato/i, unit: "lb", price: 0.79, continuous: true },
  { match: /pasta|noodle/i, unit: "lb", price: 1.39, continuous: true },
  { match: /bread/i, unit: "loaf", price: 2.99 },
  { match: /fairlife/i, unit: "52oz jug", price: 5.99 },
  { match: /coconut milk/i, unit: "13.5oz can", price: 2.29 }, // moved above /milk/i — was silently matching the generic milk (gal) entry, pricing coconut milk as a full gallon of dairy milk ($3.79) instead of a 13.5oz can ($2.29). Same substring-collision bug class as the West Virginia/Virginia regex fix.
  { match: /milk/i, unit: "gal", price: 3.79,
    packOptions: [
      { label: "half gallon", size: 0.5, price: 2.49 },
      { label: "gallon", size: 1, price: 3.79 },
    ] },
  { match: /greek yogurt|yogurt/i, unit: "32oz tub", price: 4.99 },
  { match: /cottage cheese/i, unit: "16oz tub", price: 3.49 },
  { match: /whey|protein powder/i, unit: "2lb tub", price: 29.99 },
  { match: /broccoli/i, unit: "lb", price: 1.99, continuous: true },
  { match: /spinach/i, unit: "5oz bag", price: 2.99 },
  { match: /mixed veg|frozen veg/i, unit: "12oz bag", price: 1.79 },
  { match: /banana/i, unit: "lb", price: 0.59, continuous: true },
  { match: /apple/i, unit: "lb", price: 1.49, continuous: true },
  { match: /berries|blueberr|strawberr/i, unit: "12oz", price: 3.49 },
  { match: /olive oil/i, unit: "16.9oz", price: 8.49 },
  { match: /peanut butter|almond butter/i, unit: "16oz jar", price: 4.49 },
  { match: /almond|walnut|cashew|nuts/i, unit: "lb", price: 7.99, continuous: true },
  { match: /avocado/i, unit: "each", price: 1.29 },
  { match: /tortilla/i, unit: "pack", price: 3.29 },
  { match: /shrimp|prawn/i, unit: "lb", price: 8.99, continuous: true },
  { match: /pork chop|pork loin|pork tenderloin/i, unit: "lb", price: 4.29, continuous: true },
  { match: /ground turkey|turkey breast/i, unit: "lb", price: 4.79, continuous: true },
  { match: /tofu/i, unit: "14oz block", price: 2.29 },
  { match: /chickpea|garbanzo/i, unit: "15oz can", price: 1.09 },
  { match: /black bean/i, unit: "15oz can", price: 0.99 },
  { match: /quinoa/i, unit: "lb", price: 3.99, continuous: true },
  { match: /bell pepper/i, unit: "each", price: 1.29 },
  { match: /onion/i, unit: "lb", price: 0.99, continuous: true },
  { match: /tomato/i, unit: "lb", price: 1.99, continuous: true },
  { match: /cucumber/i, unit: "each", price: 0.79 },
  { match: /pineapple/i, unit: "each", price: 2.99 },
  { match: /curry paste/i, unit: "4oz jar", price: 3.49 },
  { match: /feta/i, unit: "8oz", price: 3.99 },
  { match: /pita/i, unit: "pack", price: 2.79 },
  { match: /hummus/i, unit: "10oz tub", price: 3.99 },
  { match: /tzatziki/i, unit: "8oz tub", price: 3.99 },
  { match: /kimchi/i, unit: "16oz jar", price: 5.99 },
  { match: /salsa/i, unit: "16oz jar", price: 3.29 },
  { match: /soy sauce|tamari/i, unit: "10oz", price: 3.29 },
  { match: /sesame oil/i, unit: "5oz", price: 5.49 },
  { match: /cheese/i, unit: "8oz", price: 3.29 },
  { match: /honey/i, unit: "12oz", price: 5.49 },
];
function estimatePrice(name, location = "") {
  const hit = PRICE_TABLE.find((p) => p.match.test(name));
  const base = hit || { unit: "unit", price: 2.5, guessed: true };
  const mult = regionMultiplier(location);
  return { ...base, price: Math.round(base.price * mult * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Package-aware purchase estimator — estimatePrice() above gives a per-unit
// price, but you can't actually buy "0.25 dozen eggs" or "0.31 gal milk" at
// a store. This rounds a needed quantity up to what you'd actually have to
// buy:
//   - "continuous" items (chicken breast, rice, produce sold by weight,
//     etc.) are treated as buyable in the exact weight needed — real
//     grocery/deli pricing is already per-lb, so no rounding is applied.
//   - Everything else is sold in a fixed package (a dozen, a loaf, a jar, a
//     tub, "each" for produce like avocados) — quantity gets rounded UP to
//     the next whole package, since you can't buy a fraction of one.
//   - Items with multiple real package sizes (currently just milk: half
//     gallon vs. gallon) pick whichever size — or combination bias toward
//     the cheapest per-unit option — actually covers the needed amount for
//     the lowest total cost.
// Returns the same shape as estimatePrice() (unit/price/guessed) plus
// purchase-specific fields: packagesToBuy, packageLabel, totalQtyBought,
// and cost (the real dollar amount for what you'd have to buy).
// ---------------------------------------------------------------------------
function estimatePurchase(name, qtyNeeded, location = "") {
  const hit = PRICE_TABLE.find((p) => p.match.test(name));
  const mult = regionMultiplier(location);
  const round2 = (n) => Math.round(n * 100) / 100;

  if (!hit) {
    // No table match — fall back to the same flat guess estimatePrice()
    // uses, treated as continuous since we don't know real package sizes.
    const price = round2(2.5 * mult);
    return { unit: "unit", price, guessed: true, packagesToBuy: 1, packageLabel: "unit", totalQtyBought: qtyNeeded, cost: round2(qtyNeeded * price) };
  }

  if (hit.continuous) {
    const price = round2(hit.price * mult);
    return { unit: hit.unit, price, guessed: false, packagesToBuy: 1, packageLabel: hit.unit, totalQtyBought: qtyNeeded, cost: round2(qtyNeeded * price) };
  }

  if (hit.packOptions) {
    // Pick whichever available package size covers the need for the
    // lowest total cost (e.g. one gallon vs. two half-gallons).
    let best = null;
    for (const opt of hit.packOptions) {
      const price = round2(opt.price * mult);
      const count = Math.max(1, Math.ceil(qtyNeeded / opt.size - 1e-9));
      const cost = round2(count * price);
      const candidate = { unit: hit.unit, price, guessed: false, packagesToBuy: count, packageLabel: opt.label, totalQtyBought: round2(count * opt.size), cost };
      if (!best || candidate.cost < best.cost) best = candidate;
    }
    return best;
  }

  // Standard single fixed-size package (dozen, loaf, jar, tub, "each", etc.)
  const price = round2(hit.price * mult);
  const count = Math.max(1, Math.ceil(qtyNeeded - 1e-9));
  return { unit: hit.unit, price, guessed: false, packagesToBuy: count, packageLabel: hit.unit, totalQtyBought: count, cost: round2(count * price) };
}

// ---------------------------------------------------------------------------
// MACRO_TABLE — mirrors PRICE_TABLE (same match patterns, same units) so
// mealMacros() looks up macros the same way estimatePrice() looks up cost.
// Values are per the SAME unit PRICE_TABLE uses for that ingredient (per lb,
// per dozen, per loaf, per jar, etc.), using RAW/DRY weight to match how
// PRICE_TABLE prices groceries (uncooked, as purchased) — cooked chicken
// breast is ~40% more protein-dense per 100g than raw by weight, so mixing
// raw-priced/cooked-macro data would silently misreport every protein
// number in the app.
//
// Source: USDA FoodData Central standard reference values (raw/dry state
// unless noted). Spot-verified against live USDA-sourced chicken breast data
// as a calibration check (~120 cal, ~22.5g protein, ~2.6g fat per 100g raw).
// Self-consistency verified via Atwater check (protein*4 + carbs*4 + fat*9
// ≈ stated calories) across all entries — caught and fixed one real error
// (fairlife fat content) before this shipped. Remaining Atwater "flags" on
// high-fiber produce (broccoli, spinach, berries, etc.) are expected: labels
// state TOTAL carbs including fiber, which doesn't convert to calories at
// 4 cal/g — not a data error, a known limitation of the simple check.
//
// Phase-0-quality: built from well-established standard nutrition data, not
// individually pulled FDC IDs per ingredient. Worth a follow-up pass with
// exact FDC IDs before treating as fully final.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// MACRO_TABLE — mirrors PRICE_TABLE exactly (same match patterns, same
// units) so mealMacros() can look up macros the same way estimatePrice()
// looks up cost. Values are per the SAME unit PRICE_TABLE uses for that
// ingredient (per lb, per dozen, per loaf, per jar, etc.), using RAW/DRY
// weight to match how PRICE_TABLE prices groceries (uncooked, as purchased) —
// this matters: cooked chicken breast is ~40% more protein-dense per 100g
// than raw by weight, so mixing raw-priced/cooked-macro data would silently
// misreport every protein number in the app.
//
// Source: USDA FoodData Central standard reference values (raw/dry state
// unless noted). Spot-verified chicken breast against live USDA-sourced data
// (~120 cal, ~22.5g protein, ~2.6g fat per 100g raw) as a calibration check.
// Values are Phase-0-quality: built from well-established standard nutrition
// data, not individually pulled from FDC IDs. Recommend a follow-up pass
// pulling exact FDC IDs per ingredient before treating this as final —
// flagged explicitly, not silently assumed correct.
//
// Fields: calories, protein (g), carbs (g), fat (g) — TOTAL for the unit
// PRICE_TABLE prices (e.g. "lb" entries are per pound, "dozen" is for all
// 12 eggs, "jar" is for the whole jar) so mealMacros() can multiply
// directly by the same qty used in mealCost().
// ---------------------------------------------------------------------------
const MACRO_TABLE = [
  { match: /chicken breast/i, unit: "lb", calories: 544, protein: 102, carbs: 0, fat: 12 },
  { match: /chicken thigh/i, unit: "lb", calories: 540, protein: 91, carbs: 0, fat: 20 },
  { match: /ground beef|beef 90|beef 93/i, unit: "lb", calories: 798, protein: 91, carbs: 0, fat: 45 },
  { match: /steak|sirloin|ribeye/i, unit: "lb", calories: 680, protein: 100, carbs: 0, fat: 27 },
  { match: /tilapia|white fish|cod/i, unit: "lb", calories: 408, protein: 86, carbs: 0, fat: 4.5 },
  { match: /salmon/i, unit: "lb", calories: 943, protein: 91, carbs: 0, fat: 59 },
  { match: /egg white/i, unit: "carton (16oz)", calories: 236, protein: 50, carbs: 3, fat: 1 },
  { match: /egg/i, unit: "dozen", calories: 864, protein: 76, carbs: 5, fat: 60 },
  { match: /rice/i, unit: "lb", calories: 1656, protein: 32, carbs: 363, fat: 3.2 },
  { match: /oats?|oatmeal/i, unit: "lb", calories: 1764, protein: 77, carbs: 299, fat: 31 },
  { match: /sweet potato/i, unit: "lb", calories: 390, protein: 7.3, carbs: 91, fat: 0.5 },
  { match: /potato/i, unit: "lb", calories: 349, protein: 9, carbs: 77, fat: 0.5 },
  { match: /pasta|noodle/i, unit: "lb", calories: 1683, protein: 59, carbs: 340, fat: 6.8 },
  { match: /bread/i, unit: "loaf", calories: 1500, protein: 60, carbs: 260, fat: 20 },
  { match: /fairlife/i, unit: "52oz jug", calories: 975, protein: 84.5, carbs: 39, fat: 52 }, // whole ultra-filtered: 150cal/13g protein/6g carb/8g fat per 8oz serving x6.5
  { match: /milk/i, unit: "gal", calories: 2309, protein: 121, carbs: 182, fat: 125,
    packOptions: [
      { label: "half gallon", calories: 1155, protein: 60.5, carbs: 91, fat: 62.5 },
      { label: "gallon", calories: 2309, protein: 121, carbs: 182, fat: 125 },
    ] },
  { match: /greek yogurt|yogurt/i, unit: "32oz tub", calories: 535, protein: 91, carbs: 33, fat: 3.6 },
  { match: /cottage cheese/i, unit: "16oz tub", calories: 381, protein: 50, carbs: 15, fat: 11 },
  { match: /whey|protein powder/i, unit: "2lb tub", calories: 3600, protein: 750, carbs: 60, fat: 30 },
  { match: /broccoli/i, unit: "lb", calories: 154, protein: 12.7, carbs: 32, fat: 1.8 },
  { match: /spinach/i, unit: "5oz bag", calories: 33, protein: 4.1, carbs: 5.1, fat: 0.6 },
  { match: /mixed veg|frozen veg/i, unit: "12oz bag", calories: 221, protein: 8.5, carbs: 44, fat: 1 },
  { match: /banana/i, unit: "lb", calories: 404, protein: 5, carbs: 104, fat: 1.4 },
  { match: /apple/i, unit: "lb", calories: 236, protein: 1.4, carbs: 63, fat: 0.9 },
  { match: /berries|blueberr|strawberr/i, unit: "12oz", calories: 153, protein: 2.4, carbs: 39, fat: 1 },
  { match: /olive oil/i, unit: "16.9oz", calories: 4066, protein: 0, carbs: 0, fat: 460 },
  { match: /peanut butter|almond butter/i, unit: "16oz jar", calories: 2670, protein: 113, carbs: 91, fat: 227 },
  { match: /almond|walnut|cashew|nuts/i, unit: "lb", calories: 2626, protein: 95, carbs: 100, fat: 227 },
  { match: /avocado/i, unit: "each", calories: 240, protein: 3, carbs: 13, fat: 22 },
  { match: /tortilla/i, unit: "pack", calories: 1400, protein: 40, carbs: 240, fat: 35 },
  { match: /shrimp|prawn/i, unit: "lb", calories: 386, protein: 91, carbs: 0, fat: 2.3 },
  { match: /pork chop|pork loin|pork tenderloin/i, unit: "lb", calories: 649, protein: 95, carbs: 0, fat: 27 },
  { match: /ground turkey|turkey breast/i, unit: "lb", calories: 680, protein: 86, carbs: 0, fat: 36 },
  { match: /tofu/i, unit: "14oz block", calories: 572, protein: 62, carbs: 15.5, fat: 35 },
  { match: /chickpea|garbanzo/i, unit: "15oz can", calories: 334, protein: 17.5, carbs: 54, fat: 5 },
  { match: /black bean/i, unit: "15oz can", calories: 218, protein: 14.4, carbs: 38, fat: 1 },
  { match: /quinoa/i, unit: "lb", calories: 1670, protein: 64, carbs: 290, fat: 27 },
  { match: /bell pepper/i, unit: "each", calories: 37, protein: 1.2, carbs: 7.2, fat: 0.4 },
  { match: /onion/i, unit: "lb", calories: 181, protein: 5, carbs: 42, fat: 0.5 },
  { match: /tomato/i, unit: "lb", calories: 82, protein: 4.1, carbs: 18, fat: 0.9 },
  { match: /cucumber/i, unit: "each", calories: 45, protein: 2, carbs: 11, fat: 0.3 },
  { match: /pineapple/i, unit: "each", calories: 300, protein: 3, carbs: 78, fat: 0.6 },
  { match: /coconut milk/i, unit: "13.5oz can", calories: 920, protein: 9.2, carbs: 13.2, fat: 96 },
  { match: /curry paste/i, unit: "4oz jar", calories: 102, protein: 2.3, carbs: 13.6, fat: 4.5 },
  { match: /feta/i, unit: "8oz", calories: 599, protein: 32, carbs: 9, fat: 48 },
  { match: /pita/i, unit: "pack", calories: 990, protein: 33, carbs: 198, fat: 4.2 },
  { match: /hummus/i, unit: "10oz tub", calories: 470, protein: 22, carbs: 40, fat: 27 },
  { match: /tzatziki/i, unit: "8oz tub", calories: 204, protein: 9, carbs: 9, fat: 13.6 },
  { match: /kimchi/i, unit: "16oz jar", calories: 68, protein: 5, carbs: 11, fat: 2.3 },
  { match: /salsa/i, unit: "16oz jar", calories: 163, protein: 6.8, carbs: 36, fat: 0.9 },
  { match: /soy sauce|tamari/i, unit: "10oz", calories: 172, protein: 30, carbs: 16, fat: 0 },
  { match: /sesame oil/i, unit: "5oz", calories: 1238, protein: 0, carbs: 0, fat: 140 },
  { match: /cheese/i, unit: "8oz", calories: 915, protein: 57, carbs: 3, fat: 75 },
  { match: /honey/i, unit: "12oz", calories: 1034, protein: 1, carbs: 279, fat: 0 },
];

// mealMacros(meal) — same shape/pattern as mealCost(): sums qty * per-unit
// macros across meal.ingredients. If an ingredient has no PRICE_TABLE-unit
// match, it's flagged as "guessed" the same way estimatePrice() flags an
// unmatched price, rather than silently contributing zero macros.
function mealMacros(ingredients) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  const unmatched = [];
  for (const ing of ingredients) {
    const hit = MACRO_TABLE.find((m) => m.match.test(ing.name));
    if (!hit) {
      unmatched.push(ing.name);
      continue;
    }
    const qty = ing.qty || 0;
    calories += qty * hit.calories;
    protein += qty * hit.protein;
    carbs += qty * hit.carbs;
    fat += qty * hit.fat;
  }
  return {
    calories: Math.round(calories),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    unmatched, // non-empty means at least one ingredient had no macro data
  };
}

// ---------------------------------------------------------------------------
// Regional grocery cost adjustment — PRICE_TABLE above is a US national
// average. This scales it toward what groceries actually run in a given
// state/metro using rough relative cost-of-living indices (not a live feed,
// just far better than treating every location the same). Matches on
// whatever text the user typed into the location field in Prep; falls back
// to 1.0 (no adjustment) if nothing matches or the field's empty.
// ---------------------------------------------------------------------------
const REGION_COST_INDEX = [
  { match: /hawaii|honolulu/i, mult: 1.45 },
  { match: /manhattan|new york city|nyc|brooklyn/i, mult: 1.38 },
  { match: /san francisco|bay area|silicon valley|palo alto|oakland/i, mult: 1.42 },
  { match: /california|\bca\b|los angeles|san diego|sacramento/i, mult: 1.25 },
  { match: /new york|\bny\b/i, mult: 1.22 },
  { match: /massachusetts|\bma\b|boston/i, mult: 1.20 },
  { match: /washington state|\bwa\b|seattle/i, mult: 1.18 },
  { match: /alaska/i, mult: 1.28 },
  { match: /connecticut|\bct\b/i, mult: 1.14 },
  { match: /new jersey|\bnj\b/i, mult: 1.13 },
  { match: /oregon|\bor\b|portland/i, mult: 1.12 },
  { match: /colorado|\bco\b|denver/i, mult: 1.08 },
  { match: /illinois|\bil\b|chicago/i, mult: 1.06 },
  { match: /maryland|\bmd\b/i, mult: 1.10 },
  { match: /west virginia|\bwv\b/i, mult: 0.89 },
  { match: /virginia|\bva\b/i, mult: 1.02 },
  { match: /florida|\bfl\b|miami|orlando|tampa/i, mult: 1.02 },
  { match: /texas|\btx\b|austin|dallas|houston/i, mult: 0.98 },
  { match: /north carolina|\bnc\b/i, mult: 0.96 },
  { match: /georgia|\bga\b|atlanta/i, mult: 0.97 },
  { match: /michigan|\bmi\b/i, mult: 0.94 },
  { match: /ohio|\boh\b/i, mult: 0.93 },
  { match: /indiana|\bin\b/i, mult: 0.92 },
  { match: /tennessee|\btn\b/i, mult: 0.93 },
  { match: /missouri|\bmo\b/i, mult: 0.91 },
  { match: /arkansas|\bar\b/i, mult: 0.89 }, // moved above /kansas/i — "arkansas" contains "kansas" as a substring, so it was silently matching Kansas's multiplier (0.91) instead of its own (0.89). Same collision class as the West Virginia/Virginia fix.
  { match: /kansas|\bks\b/i, mult: 0.91 },
  { match: /oklahoma|\bok\b/i, mult: 0.90 },
  { match: /kentucky|\bky\b/i, mult: 0.91 },
  { match: /mississippi|\bms\b/i, mult: 0.87 },
  { match: /alabama|\bal\b/i, mult: 0.90 },
  { match: /iowa|\bia\b/i, mult: 0.91 },
];
function regionMultiplier(location) {
  if (!location || !location.trim()) return 1;
  const hit = REGION_COST_INDEX.find((r) => r.match.test(location));
  return hit ? hit.mult : 1;
}

// ---------------------------------------------------------------------------
// Shelf-life reference table — general USDA/FoodSafety.gov-style guidance for
// how long a food keeps once purchased/cooked. Raw meat/fish are given as
// "raw, uncooked" windows; assume cooked leftovers of any protein are good
// ~3-4 days in the fridge regardless of which protein it is. This is general
// food-safety guidance, not a guarantee — when in doubt, smell/look before
// eating, and freeze anything you won't use within the fridge window.
// ---------------------------------------------------------------------------
const SHELF_LIFE_TABLE = [
  { match: /chicken breast|chicken thigh/i, fridge: "1-2 days raw", freezer: "9 months", note: "Cook or freeze within 2 days of buying." },
  { match: /ground beef|beef 90|beef 93/i, fridge: "1-2 days raw", freezer: "3-4 months", note: "Ground meat spoils faster than whole cuts — use quickly." },
  { match: /steak|sirloin|ribeye/i, fridge: "3-5 days raw", freezer: "6-12 months", note: "Whole cuts keep longer raw than ground meat." },
  { match: /tilapia|white fish|cod/i, fridge: "1-2 days raw", freezer: "6 months", note: "Fish is the most perishable protein here — cook within 1-2 days." },
  { match: /salmon/i, fridge: "1-2 days raw", freezer: "6-9 months", note: "Cook within 1-2 days or freeze immediately." },
  { match: /egg white/i, fridge: "3-4 days opened", freezer: "12 months", note: "Keep refrigerated; discard if smell changes." },
  { match: /egg/i, fridge: "3-5 weeks", freezer: "not recommended in shell", note: "Whole eggs keep well — store in the carton, not the door." },
  { match: /rice/i, fridge: "4-6 days cooked", freezer: "6 months cooked", note: "Cool cooked rice fast and refrigerate within 1 hour — it's a common food-poisoning culprit if left at room temp." },
  { match: /oats?|oatmeal/i, fridge: "4-6 days cooked, pantry dry", freezer: "not needed", note: "Dry oats keep for months in a sealed container; cooked oats last under a week." },
  { match: /sweet potato/i, fridge: "3-5 days cooked, 2 weeks pantry raw", freezer: "10-12 months cooked", note: "Store raw ones in a cool, dark, dry spot rather than the fridge." },
  { match: /potato/i, fridge: "3-5 days cooked, 3-5 weeks pantry raw", freezer: "10-12 months cooked", note: "Raw potatoes prefer a cool dark pantry over the fridge." },
  { match: /pasta|noodle/i, fridge: "3-5 days cooked, pantry dry", freezer: "2-3 months cooked", note: "Dry pasta keeps a very long time in the pantry unopened." },
  { match: /bread/i, fridge: "not needed (shortens shelf life)", freezer: "3 months", note: "Best at room temp in a sealed bag; freeze what you won't use in ~5 days." },
  { match: /fairlife/i, fridge: "2 weeks after opening (ultra-filtered)", freezer: "not recommended", note: "Lasts longer than regular milk thanks to the filtration process." },
  { match: /milk/i, fridge: "5-7 days after opening", freezer: "3 months (texture changes)", note: "Trust your nose — sour smell means toss it." },
  { match: /greek yogurt|yogurt/i, fridge: "1-2 weeks after opening", freezer: "1-2 months (texture changes)", note: "Check the printed date; unopened often lasts past it if sealed." },
  { match: /cottage cheese/i, fridge: "5-7 days after opening", freezer: "not recommended (texture changes)", note: "Goes watery/sour when it turns — trust your nose." },
  { match: /whey|protein powder/i, fridge: "not needed", freezer: "not needed", note: "Pantry-stable for ~1-2 years sealed; keep the scoop dry to avoid clumping." },
  { match: /broccoli/i, fridge: "3-5 days raw", freezer: "10-12 months blanched", note: "Store unwashed in a loose bag in the crisper." },
  { match: /spinach/i, fridge: "5-7 days raw", freezer: "10-12 months blanched", note: "Wilts fast once wet — keep it dry until you use it." },
  { match: /mixed veg|frozen veg/i, fridge: "n/a (buy frozen)", freezer: "8-12 months", note: "Keep frozen until ready to cook; don't refreeze after thawing." },
  { match: /banana/i, fridge: "counter 2-7 days, fridge extends slightly", freezer: "2-3 months (for smoothies)", note: "Fridge darkens the peel but slows ripening once they're at the stage you want." },
  { match: /apple/i, fridge: "3-4 weeks", freezer: "8 months (cooked/sliced)", note: "Keeps far longer refrigerated than on the counter." },
  { match: /berries|blueberr|strawberr/i, fridge: "3-7 days", freezer: "10-12 months", note: "Rinse just before eating, not before storing — moisture speeds mold." },
  { match: /olive oil/i, fridge: "not needed", freezer: "not needed", note: "Pantry, away from light/heat — good for ~18-24 months unopened." },
  { match: /peanut butter|almond butter/i, fridge: "2-3 months after opening (optional)", freezer: "not needed", note: "Shelf-stable; refrigerating natural PB just slows oil separation." },
  { match: /almond|walnut|cashew|nuts/i, fridge: "4-6 months", freezer: "12 months", note: "Fridge/freezer slows the fats from going rancid vs. pantry storage." },
  { match: /avocado/i, fridge: "3-4 days once ripe (cut: 1 day)", freezer: "not recommended whole", note: "Doesn't hold up to batch prep — cut fresh each time, as the recipes note." },
  { match: /tortilla/i, fridge: "1 week after opening", freezer: "2-3 months", note: "Keep sealed to prevent drying out." },
  { match: /shrimp|prawn/i, fridge: "1-2 days raw", freezer: "6 months", note: "Very perishable — cook same day if possible." },
  { match: /pork chop|pork loin|pork tenderloin/i, fridge: "3-5 days raw", freezer: "4-6 months", note: "Whole pork cuts hold up well raw for several days." },
  { match: /ground turkey|turkey breast/i, fridge: "1-2 days raw", freezer: "3-4 months", note: "Treat like other ground/poultry meats — use quickly." },
  { match: /tofu/i, fridge: "3-5 days opened (in water, changed daily)", freezer: "5 months (texture changes)", note: "Keep submerged in fresh water once opened." },
  { match: /chickpea|garbanzo|black bean/i, fridge: "4-5 days cooked, pantry canned", freezer: "6 months cooked", note: "Canned keeps a very long time unopened." },
  { match: /quinoa/i, fridge: "5-7 days cooked, pantry dry", freezer: "8 months cooked", note: "Cooked quinoa holds up very well — great for batch prep." },
  { match: /bell pepper|onion|cucumber/i, fridge: "1-2 weeks raw", freezer: "8-12 months (blanched)", note: "Keep in the crisper; onions actually prefer a cool pantry over the fridge." },
  { match: /tomato/i, fridge: "5-7 days raw", freezer: "2 months (cooked/sauce)", note: "Store whole tomatoes at room temp until ripe, then fridge." },
  { match: /pineapple/i, fridge: "5-7 days cut", freezer: "10-12 months cut", note: "Once cut, refrigerate in an airtight container." },
  { match: /coconut milk/i, fridge: "4-6 days after opening", freezer: "2 months (separates, whisk when thawed)", note: "Unopened cans are pantry-stable." },
  { match: /curry paste|soy sauce|tamari|hummus|tzatziki|kimchi|salsa/i, fridge: "2-6 months after opening (varies)", freezer: "not typically recommended", note: "Condiments/ferments keep well refrigerated once opened." },
  { match: /feta|pita/i, fridge: "1-2 weeks opened", freezer: "2-3 months", note: "Standard dairy/bread guidance." },
  { match: /sesame oil/i, fridge: "not needed", freezer: "not needed", note: "Pantry, away from light/heat." },
  { match: /cheese/i, fridge: "1-2 weeks after opening (shredded/sliced)", freezer: "2-3 months (texture changes)", note: "Hard cheeses last longer than soft/shredded." },
  { match: /honey/i, fridge: "not needed", freezer: "not needed", note: "Essentially shelf-stable indefinitely — crystallizing is normal, not spoilage." },
];
function estimateShelfLife(name) {
  const hit = SHELF_LIFE_TABLE.find((s) => s.match.test(name));
  if (hit) return hit;
  return { fridge: "3-4 days cooked (general rule)", freezer: "2-3 months", note: "No specific data for this item — general cooked-leftover guidance shown." };
}

// ---------------------------------------------------------------------------
// Cooked-meal shelf life — unlike the raw-ingredient table above, this is for
// judging "if I batch-cook this whole recipe today, how many days will it
// stay good?" Presets are ranked most-restrictive first; a recipe's overall
// window is set by whichever ingredient in it spoils fastest (fish before
// poultry/beef, before egg/dairy, before plain veg/grain).
// ---------------------------------------------------------------------------
const COOKED_SHELF_PRESETS = [
  { match: /salmon|tilapia|fish|shrimp|cod/i, fridgeDays: 2, freezer: "1-2 months", note: "Fish-based dishes spoil fastest — eat within 2 days or freeze the rest." },
  { match: /chicken|beef|turkey|pork|steak|sausage/i, fridgeDays: 4, freezer: "2-3 months", note: "Standard cooked-meat guidance — cool within 2 hours of cooking, then refrigerate." },
  { match: /egg|greek yogurt|cottage cheese|dairy/i, fridgeDays: 4, freezer: "not recommended (texture changes)", note: "Egg/dairy-based dishes hold well for about 4 days." },
];
const COOKED_SHELF_DEFAULT = { fridgeDays: 5, freezer: "2-3 months", note: "Grain/veg-based dish — general cooked-food guidance." };

function cookedShelfLife(ingredientNames) {
  let best = null;
  ingredientNames.forEach((name) => {
    const hit = COOKED_SHELF_PRESETS.find((p) => p.match.test(name));
    if (hit && (!best || hit.fridgeDays < best.fridgeDays)) best = hit;
  });
  return best || COOKED_SHELF_DEFAULT;
}

// ---------------------------------------------------------------------------
// FOOD DATABASE — for the Logbook tab (free-form food logging, MyFitnessPal-
// style). Macros are per the listed standard serving; costPerServing is
// derived from the same price table used everywhere else in the app so
// numbers stay consistent. Not a lab-verified nutrition database — standard
// approximations for common bodybuilding-diet foods, editable per-entry when
// logging (weight/qty can be scaled at log time).
// ---------------------------------------------------------------------------
const FOOD_DATABASE = [
  // Proteins
  { name: "Chicken Breast, cooked", category: "Protein", serving: "4 oz", calories: 187, protein: 35, carbs: 0, fat: 4 },
  { name: "Chicken Thigh, cooked", category: "Protein", serving: "4 oz", calories: 250, protein: 26, carbs: 0, fat: 16 },
  { name: "93/7 Ground Beef, cooked", category: "Protein", serving: "4 oz", calories: 200, protein: 26, carbs: 0, fat: 10 },
  { name: "Sirloin Steak, cooked", category: "Protein", serving: "4 oz", calories: 230, protein: 33, carbs: 0, fat: 10 },
  { name: "Salmon, cooked", category: "Protein", serving: "4 oz", calories: 233, protein: 25, carbs: 0, fat: 14 },
  { name: "Tilapia, cooked", category: "Protein", serving: "4 oz", calories: 145, protein: 30, carbs: 0, fat: 2 },
  { name: "Whole Egg, large", category: "Protein", serving: "1 egg", calories: 72, protein: 6, carbs: 0.4, fat: 5 },
  { name: "Egg Whites, liquid", category: "Protein", serving: "1/2 cup (4oz)", calories: 65, protein: 13, carbs: 1, fat: 0 },
  { name: "Whey Protein Powder", category: "Protein", serving: "1 scoop (30g)", calories: 120, protein: 24, carbs: 3, fat: 1.5 },
  { name: "Greek Yogurt, non-fat", category: "Protein", serving: "1 cup", calories: 150, protein: 25, carbs: 9, fat: 0.5 },
  { name: "Cottage Cheese, low-fat", category: "Protein", serving: "1 cup", calories: 180, protein: 26, carbs: 8, fat: 4 },
  { name: "Fairlife Milk, 2%", category: "Protein", serving: "1 cup", calories: 120, protein: 13, carbs: 6, fat: 5 },
  // Carbs
  { name: "Jasmine Rice, cooked", category: "Carb", serving: "1 cup", calories: 205, protein: 4, carbs: 45, fat: 0.4 },
  { name: "Rolled Oats, dry", category: "Carb", serving: "1/2 cup", calories: 150, protein: 5, carbs: 27, fat: 3 },
  { name: "Sweet Potato, baked", category: "Carb", serving: "1 medium (5oz)", calories: 130, protein: 2, carbs: 30, fat: 0.2 },
  { name: "White Potato, roasted", category: "Carb", serving: "1 medium (5oz)", calories: 130, protein: 3, carbs: 30, fat: 0.1 },
  { name: "Whole Wheat Bread", category: "Carb", serving: "1 slice", calories: 80, protein: 4, carbs: 14, fat: 1 },
  { name: "Pasta, cooked", category: "Carb", serving: "1 cup", calories: 220, protein: 8, carbs: 43, fat: 1.3 },
  { name: "Corn Tortilla", category: "Carb", serving: "1 tortilla", calories: 52, protein: 1.4, carbs: 11, fat: 0.7 },
  { name: "Banana", category: "Carb", serving: "1 medium", calories: 105, protein: 1.3, carbs: 27, fat: 0.4 },
  { name: "Apple", category: "Carb", serving: "1 medium", calories: 95, protein: 0.5, carbs: 25, fat: 0.3 },
  { name: "Mixed Berries", category: "Carb", serving: "1 cup", calories: 65, protein: 1, carbs: 15, fat: 0.5 },
  { name: "Honey", category: "Carb", serving: "1 tbsp", calories: 64, protein: 0, carbs: 17, fat: 0 },
  // Fats
  { name: "Avocado", category: "Fat", serving: "1/2 fruit", calories: 160, protein: 2, carbs: 9, fat: 15 },
  { name: "Peanut Butter", category: "Fat", serving: "2 tbsp", calories: 190, protein: 8, carbs: 7, fat: 16 },
  { name: "Almonds", category: "Fat", serving: "1 oz (~23)", calories: 165, protein: 6, carbs: 6, fat: 14 },
  { name: "Olive Oil", category: "Fat", serving: "1 tbsp", calories: 120, protein: 0, carbs: 0, fat: 14 },
  { name: "Cheddar Cheese", category: "Fat", serving: "1 oz", calories: 115, protein: 7, carbs: 0.5, fat: 9 },
  // Vegetables
  { name: "Broccoli, steamed", category: "Vegetable", serving: "1 cup", calories: 55, protein: 4, carbs: 11, fat: 0.6 },
  { name: "Spinach, raw", category: "Vegetable", serving: "2 cups", calories: 14, protein: 1.8, carbs: 2.2, fat: 0.2 },
  { name: "Mixed Frozen Vegetables", category: "Vegetable", serving: "1 cup", calories: 60, protein: 2.5, carbs: 12, fat: 0.5 },
  // Common combo/misc
  { name: "Salsa", category: "Misc", serving: "2 tbsp", calories: 10, protein: 0.4, carbs: 2, fat: 0 },
  { name: "Butter Chicken Sauce, jarred", category: "Misc", serving: "1/3 cup", calories: 90, protein: 2, carbs: 8, fat: 6 },
  { name: "Spicy Brown Mustard", category: "Misc", serving: "1 tsp", calories: 5, protein: 0.3, carbs: 0.5, fat: 0.2 },
  { name: "Hot Sauce", category: "Misc", serving: "1 tsp", calories: 1, protein: 0, carbs: 0.2, fat: 0 },
];

// ---------------------------------------------------------------------------
// Workout program presets
// each exercise: { name, sets, reps (target), rir (target), note }
// programs with % based work (Smolov) use "pct" instead of fixed weight
// ---------------------------------------------------------------------------
const PROGRAMS = {
  mentzer: {
    label: "Mike Mentzer — Heavy Duty",
    style: "1 top set to failure per exercise, low volume, high intensity",
    durationWeeks: null,
    weeklySchedule: null, // individualized frequency, not calendar-fixed — see structureNotes
    pairingLogic: "Exercises are grouped by body region purely to keep sessions brief — there's no antagonist-superset logic here. Each muscle gets one all-out set and the session is over.",
    structureNotes: "Not a fixed-length block. Frequency is individualized — Mentzer had clients train a given muscle every 4–10 days, sometimes longer — and you run it indefinitely, cutting frequency/volume further if progress stalls.",
    days: [
      { day: "Chest / Back", exercises: [
        { name: "Incline Press", sets: 1, reps: 8, rir: 0 },
        { name: "Flat Flye", sets: 1, reps: 10, rir: 0 },
        { name: "Weighted Pull-up", sets: 1, reps: 6, rir: 0 },
        { name: "Cable Row", sets: 1, reps: 8, rir: 0 },
      ]},
      { day: "Legs", exercises: [
        { name: "Leg Press", sets: 1, reps: 10, rir: 0 },
        { name: "Leg Extension", sets: 1, reps: 10, rir: 0 },
        { name: "Lying Leg Curl", sets: 1, reps: 10, rir: 0 },
        { name: "Standing Calf Raise", sets: 1, reps: 12, rir: 0 },
      ]},
      { day: "Shoulders / Arms", exercises: [
        { name: "Machine Shoulder Press", sets: 1, reps: 8, rir: 0 },
        { name: "Lateral Raise", sets: 1, reps: 10, rir: 0 },
        { name: "Barbell Curl", sets: 1, reps: 8, rir: 0 },
        { name: "Triceps Pressdown", sets: 1, reps: 10, rir: 0 },
      ]},
    ],
  },
  cutler: {
    label: "Jay Cutler — High Volume",
    style: "Bodypart split, high volume, moderate-heavy loads",
    durationWeeks: 8,
    weeklySchedule: [{ dayIndex: 0 }, { dayIndex: 4 }, { dayIndex: 1 }, { rest: true }, { dayIndex: 3 }, { dayIndex: 2 }, { rest: true }], // 3-on/1-off/2-on/1-off, back & legs each followed by a rest day
    philosophy: "Volume drives growth. Many sets per muscle from multiple angles create both mechanical tension and metabolic stress; short 30-60s rest keeps intensity high without needing near-max loads, which is part of why Cutler rarely trained to true failure.",
    pairingLogic: "Classic one-muscle-per-day bodypart split so each gets a complete, high-volume session. Back and legs — the hardest to recover from — are each followed by a rest day.",
    structureNotes: "Traditionally cycled in ~8-week blocks: volume builds up gradually across the block, then the block restarts with adjusted exercise selection or split to keep providing new stimulus.",
    days: [
      { day: "Chest", exercises: [
        { name: "Flat Barbell Press", sets: 4, reps: 10, rir: 2 },
        { name: "Incline DB Press", sets: 4, reps: 10, rir: 2 },
        { name: "Machine Flye", sets: 3, reps: 12, rir: 1 },
        { name: "Dips", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Back", exercises: [
        { name: "Deadlift", sets: 3, reps: 6, rir: 2 },
        { name: "Wide Pulldown", sets: 4, reps: 10, rir: 2 },
        { name: "Barbell Row", sets: 4, reps: 10, rir: 2 },
        { name: "Seated Cable Row", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Legs", exercises: [
        { name: "Back Squat", sets: 4, reps: 8, rir: 2 },
        { name: "Leg Press", sets: 4, reps: 12, rir: 1 },
        { name: "Leg Extension", sets: 3, reps: 15, rir: 1 },
        { name: "Lying Leg Curl", sets: 4, reps: 12, rir: 1 },
        { name: "Calf Raise", sets: 4, reps: 15, rir: 1 },
      ]},
      { day: "Shoulders", exercises: [
        { name: "Seated DB Press", sets: 4, reps: 10, rir: 2 },
        { name: "Lateral Raise", sets: 4, reps: 12, rir: 1 },
        { name: "Rear Delt Flye", sets: 3, reps: 15, rir: 1 },
        { name: "Barbell Shrug", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Arms", exercises: [
        { name: "Barbell Curl", sets: 4, reps: 10, rir: 1 },
        { name: "Incline DB Curl", sets: 3, reps: 12, rir: 1 },
        { name: "Close Grip Bench", sets: 4, reps: 10, rir: 1 },
        { name: "Overhead Rope Extension", sets: 3, reps: 12, rir: 1 },
      ]},
    ],
  },
  arnold: {
    label: "Arnold — Golden Era",
    style: "Antagonist pairing, high frequency, high volume",
    durationWeeks: null,
    weeklySchedule: [{ dayIndex: 0 }, { dayIndex: 1 }, { dayIndex: 2 }, { dayIndex: 0 }, { dayIndex: 1 }, { dayIndex: 2 }, { rest: true }], // Mon-Sat through the 3-day rotation twice, Sunday off
    philosophy: "Chases the pump and total training density. Pairing antagonist muscle groups (chest/back, biceps/triceps) lets one side actively rest while the other works, packing far more total volume into a session than straight sets would allow.",
    pairingLogic: "Push/pull antagonist supersets — bench press into rows, curls into close-grip presses. Since the two muscles oppose each other, one recovers while the other is under load, keeping rest periods short and density high.",
    structureNotes: "Classic 6-day split — Chest&Back / Shoulders&Arms / Legs, each trained twice a week, Sunday off — run continuously as a lifestyle split rather than a numbered block. Built for someone with excellent recovery capacity; scale volume down if it isn't you.",
    days: [
      { day: "Chest / Back", exercises: [
        { name: "Flat Bench Press", sets: 5, reps: 8, rir: 2 },
        { name: "Wide Pull-up", sets: 5, reps: 8, rir: 2 },
        { name: "Incline DB Press", sets: 4, reps: 10, rir: 1 },
        { name: "T-Bar Row", sets: 4, reps: 10, rir: 1 },
        { name: "DB Pullover", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Shoulders / Arms", exercises: [
        { name: "Standing Barbell Press", sets: 5, reps: 8, rir: 2 },
        { name: "Lateral Raise", sets: 4, reps: 10, rir: 1 },
        { name: "Barbell Curl", sets: 5, reps: 8, rir: 1 },
        { name: "Close Grip Bench", sets: 5, reps: 8, rir: 1 },
      ]},
      { day: "Legs", exercises: [
        { name: "Back Squat", sets: 5, reps: 8, rir: 2 },
        { name: "Leg Press", sets: 4, reps: 12, rir: 1 },
        { name: "Walking Lunge", sets: 3, reps: 12, rir: 1 },
        { name: "Leg Curl", sets: 4, reps: 12, rir: 1 },
        { name: "Calf Raise", sets: 5, reps: 15, rir: 1 },
      ]},
    ],
  },
  smolov: {
    label: "Smolov (Full 13-Week)",
    style: "Squat-specialization peaking cycle — see phase notes",
    durationWeeks: 13,
    weeklySchedule: [{ dayIndex: 0 }, { rest: true }, { dayIndex: 1 }, { rest: true }, { dayIndex: 2 }, { dayIndex: 3 }, { rest: true }], // Mon/Wed/Fri/Sat, matching the classic base-mesocycle schedule. Other phases (switching, intense) run at a different frequency — see structureNotes.
    philosophy: "A squat-specialization peaking cycle: extreme, escalating squat frequency and tonnage force a rapid strength adaptation by deliberately overreaching, then taper into a new max. Built for a lifter who has plateaued and needs a shock to the system, not for continuous year-round use.",
    pairingLogic: "Squat only, up to 4x/week during the base mesocycle — no other lifts share the recovery budget, because spreading volume elsewhere would blunt the adaptation this much squat frequency is designed to force.",
    structureNotes: "5 fixed phases over 13 weeks: 2-week intro, 4-week base mesocycle (4x/week, tonnage climbs weekly), 2-week active-recovery switching phase, 4-week intense mesocycle (heavy singles/triples up to ~95%+), 1-week taper before retesting your max.",
    days: [
      { day: "Base Meso — Mon", exercises: [{ name: "Back Squat", sets: 4, reps: 9, rir: 2, note: "70%" }] },
      { day: "Base Meso — Wed", exercises: [{ name: "Back Squat", sets: 5, reps: 7, rir: 1, note: "75%" }] },
      { day: "Base Meso — Fri", exercises: [{ name: "Back Squat", sets: 7, reps: 5, rir: 1, note: "80%" }] },
      { day: "Base Meso — Sat", exercises: [{ name: "Back Squat", sets: 10, reps: 3, rir: 0, note: "85%" }] },
      { day: "Switching — Speed", exercises: [{ name: "Back Squat (speed)", sets: 4, reps: 3, rir: 3, note: "50-60%" }] },
      { day: "Intense Meso", exercises: [{ name: "Back Squat", sets: 4, reps: 4, rir: 1, note: "80-95%, see week chart" }] },
    ],
  },
  smolov_jr: {
    label: "Smolov Jr (3-Week)",
    style: "Squat or bench, 4 days/week, repeatable with a rest week between runs",
    durationWeeks: 3,
    weeklySchedule: [{ dayIndex: 0 }, { dayIndex: 1 }, { rest: true }, { dayIndex: 2 }, { dayIndex: 3 }, { rest: true }, { rest: true }], // Mon/Tue/Thu/Fri, rest Wed/Sat/Sun
    philosophy: "A compressed, repeatable version of Smolov's base-mesocycle logic: the same escalating-tonnage approach aimed at a fast strength spike on one lift, without the 13-week commitment.",
    pairingLogic: "Single lift, 4x/week — same reasoning as full Smolov's base block, just shorter and usually applied to squat or bench.",
    structureNotes: "3-week block, repeatable with a rest week in between; typically produces a smaller but much faster strength gain than the full 13-week program.",
    days: [
      { day: "Day 1", exercises: [{ name: "Squat or Bench", sets: 6, reps: 6, rir: 1, note: "70%" }] },
      { day: "Day 2", exercises: [{ name: "Squat or Bench", sets: 7, reps: 5, rir: 1, note: "75%" }] },
      { day: "Day 3", exercises: [{ name: "Squat or Bench", sets: 8, reps: 4, rir: 1, note: "80%" }] },
      { day: "Day 4", exercises: [{ name: "Squat or Bench", sets: 10, reps: 3, rir: 0, note: "85%" }] },
    ],
  },
  bulldog: {
    label: "Alexander Bromley — Bullmastiff",
    style: "4-day powerbuilding block, base phase then peak phase, 3-week waves, AMRAP auto-regulation",
    durationWeeks: 18,
    weeklySchedule: [{ dayIndex: 0 }, { dayIndex: 1 }, { rest: true }, { dayIndex: 2 }, { dayIndex: 3 }, { rest: true }, { rest: true }], // Mon/Tue/Thu/Fri, rest Wed/Sat/Sun
    philosophy: "Build a wide base of strength and muscle first, then sharpen it into a peak. The base phase uses higher volume and sub-max loads to build work capacity and size; the peak phase drops volume and pushes intensity toward a new 1RM. AMRAP sets auto-regulate the weekly weight jump instead of guessing.",
    pairingLogic: "Each day's main lift is paired with a developmental variation of its 'opposite' movement pattern — squat day also does a deadlift-pattern variation, deadlift day does a squat-pattern variation, bench and overhead press mirror each other the same way — so every movement pattern still gets trained twice a week without needing a 5th day.",
    structureNotes: "Two 9-week phases (base, then peak), each built from three 3-week waves. Within a wave, the AMRAP-driven load climbs for 3 sessions then resets. Across the peak phase's three waves, main-lift intensity climbs roughly 80% → 90%+ of your 1RM.",
    days: [
      { day: "Day 1 — Squat", exercises: [
        { name: "Back Squat", sets: 4, reps: 6, rir: 2, amrap: true, mainLift: "Back Squat" },
        { name: "Deadlift Variation (Deficit/RDL)", sets: 3, reps: 8, rir: 2 },
        { name: "Leg Curl", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Day 2 — Bench", exercises: [
        { name: "Bench Press", sets: 4, reps: 6, rir: 2, amrap: true, mainLift: "Bench Press" },
        { name: "Overhead Press Variation", sets: 3, reps: 8, rir: 2 },
        { name: "Triceps Pressdown", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Day 3 — Deadlift", exercises: [
        { name: "Deadlift", sets: 4, reps: 6, rir: 2, amrap: true, mainLift: "Deadlift" },
        { name: "Squat Variation (Front Squat)", sets: 3, reps: 8, rir: 2 },
        { name: "Back Extension", sets: 3, reps: 12, rir: 1 },
      ]},
      { day: "Day 4 — Overhead Press", exercises: [
        { name: "Overhead Press", sets: 4, reps: 6, rir: 2, amrap: true, mainLift: "Overhead Press" },
        { name: "Bench Variation (Close Grip)", sets: 3, reps: 8, rir: 2 },
        { name: "Barbell Curl", sets: 3, reps: 12, rir: 1 },
      ]},
    ],
  },
};

// ---------------------------------------------------------------------------
// Program week/phase tracking — computes "Week N of program" and, where the
// source material defines one, which phase/wave you're in, from a stored
// per-program start date. Ongoing methodologies (Mentzer/Cutler/Arnold) don't
// have a fixed total, so they report elapsed weeks instead of a countdown.
// ---------------------------------------------------------------------------
function weeksSince(startDate) {
  if (!startDate) return null;
  const start = new Date(startDate + "T00:00:00");
  const now = new Date();
  const diffDays = Math.floor((now - start) / 86400000);
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}

function getProgramWeekInfo(programKey, startDate) {
  const program = PROGRAMS[programKey];
  const elapsed = weeksSince(startDate);
  if (!elapsed) return null;
  if (programKey === "smolov") {
    const w = Math.min(elapsed, 13);
    let phase;
    if (w <= 2) phase = "Introductory microcycle";
    else if (w <= 6) phase = "Base mesocycle";
    else if (w <= 8) phase = "Switching cycle";
    else if (w <= 12) phase = "Intense mesocycle";
    else phase = "Taper — retest your max";
    return { week: w, totalWeeks: 13, label: `Week ${w} of 13 — ${phase}`, done: elapsed > 13 };
  }
  if (programKey === "smolov_jr") {
    const w = ((elapsed - 1) % 3) + 1;
    const cycle = Math.floor((elapsed - 1) / 3) + 1;
    return { week: w, totalWeeks: 3, label: `Cycle ${cycle}, week ${w} of 3`, done: false };
  }
  if (programKey === "bulldog") {
    const w = Math.min(elapsed, 18);
    const phase = w <= 9 ? "base" : "peak";
    const phaseWeek = phase === "base" ? w : w - 9;
    const wave = Math.ceil(phaseWeek / 3);
    const weekInWave = ((phaseWeek - 1) % 3) + 1;
    return {
      week: w, totalWeeks: 18, phase, wave, weekInWave,
      label: `Week ${w} of 18 — ${phase === "base" ? "Base" : "Peak"} phase, wave ${wave}, week ${weekInWave} of 3`,
      done: elapsed > 18,
    };
  }
  // Ongoing methodologies — no fixed countdown
  if (programKey === "cutler") {
    const block = Math.floor((elapsed - 1) / 8) + 1;
    const weekInBlock = ((elapsed - 1) % 8) + 1;
    return { week: elapsed, totalWeeks: null, label: `Block ${block}, week ${weekInBlock} of 8 (ongoing)`, done: false };
  }
  return { week: elapsed, totalWeeks: null, label: `Week ${elapsed} (ongoing methodology)`, done: false };
}

// Bullmastiff phase-based main-lift prescription. The AMRAP auto-regulation
// (amrapNextSessionWeight) drives week-to-week jumps WITHIN a wave; this
// table only supplies the STARTING %1RM at the top of each new wave (or when
// no logged history exists yet for the current wave).
function bullmastiffPrescription(phase, wave) {
  if (phase === "base") return { pct: 0.65, reps: 6 };
  const table = { 1: { pct: 0.80, reps: 5 }, 2: { pct: 0.85, reps: 4 }, 3: { pct: 0.90, reps: 3 } };
  return table[wave] || table[1];
}

// ---------------------------------------------------------------------------
// Next-weight calculator: uses an Epley-style RIR-adjusted e1RM to project
// the weight for the next set at a target rep/RIR combo.
// e1RM = weight * (1 + (reps + RIR) / 30)
// nextWeight = e1RM / (1 + (targetReps + targetRIR) / 30), rounded to 2.5
// ---------------------------------------------------------------------------
function nextSetWeight({ weight, reps, rir, targetReps, targetRir }) {
  if (!weight || !reps) return null;
  const e1rm = weight * (1 + (reps + (rir ?? 0)) / 30);
  const raw = e1rm / (1 + (targetReps + (targetRir ?? rir ?? 0)) / 30);
  return round25(raw);
}

// ---------------------------------------------------------------------------
// PR detection — reuses the EXACT SAME e1RM formula as nextSetWeight above
// (RIR-adjusted Epley: e1RM = weight * (1 + (reps + RIR) / 30)) rather than
// a second formula that could silently disagree with it. A "PR" here means
// a new best estimated 1RM for that exercise, not necessarily a new best
// raw weight — e.g. 225x8 beats 225x5 even though the loaded weight is the
// same, because the estimated 1RM is higher.
//
// Known limitation of Epley-based e1RM (not a bug): accuracy degrades above
// ~10-12 reps and can overestimate at very high RIR. If a set is outside
// that range, this still returns a PR determination, but treat e1RM-based
// PRs on high-rep sets with more skepticism than ones from low-rep, low-RIR
// sets — the formula itself is less trustworthy there, not just this
// implementation of it.
// ---------------------------------------------------------------------------
function checkForPR(exerciseName, { weight, reps, rir }, existingRecords) {
  if (!weight || !reps) return { isNewPR: false, updatedRecords: existingRecords };
  const e1rm = Number(weight) * (1 + (Number(reps) + (Number(rir) || 0)) / 30);
  const current = existingRecords[exerciseName];
  if (!current || e1rm > current.e1rm) {
    return {
      isNewPR: true,
      record: { weight: Number(weight), reps: Number(reps), rir: Number(rir) || 0, date: todayStr(), e1rm: Math.round(e1rm * 10) / 10 },
      updatedRecords: { ...existingRecords, [exerciseName]: { weight: Number(weight), reps: Number(reps), rir: Number(rir) || 0, date: todayStr(), e1rm: Math.round(e1rm * 10) / 10 } },
    };
  }
  return { isNewPR: false, updatedRecords: existingRecords };
}

// ---------------------------------------------------------------------------
// XP engine — Phase 2, Session 1.
//
// Design principle (same one that governed Phase 0): derive, don't
// duplicate. `deriveWorkoutXpEvents` and `deriveProteinXpEvents` are pure
// functions that walk the ALREADY-VERIFIED source logs (workoutLogs,
// foodLog) and rebuild the XP ledger from scratch every time they're
// called. That means editing a past day's log automatically corrects that
// day's XP too — there's no independently-settable "totalXp" that can
// silently drift out of sync with the logs it's supposed to represent.
//
// PR events are the one exception: `personalRecords` only stores the
// CURRENT best per exercise, not a history of every time a PR was broken,
// so a past PR moment can't be reconstructed after the fact from that
// state alone. Those are appended to a small persisted ledger
// (`prXpEvents`) at the exact moment checkForPR fires in TrainTab.logSet,
// then merged with the derived events below. Streak-milestone events will
// be appended the same way once Session 2 (streaks) exists.
//
// Every event carries a stable `id` (e.g. "workout:2026-08-03") so merging
// derived + persisted events and re-deriving on every render is safe:
// re-running deriveWorkoutXpEvents for a date that already has an event
// produces the identical id/amount, so de-duping by id is idempotent.
// ---------------------------------------------------------------------------
const XP_RULES = {
  workout_completed: () => ({ amount: 50, note: "Workout logged" }),
  pr_hit: ({ exerciseName }) => ({ amount: 100, note: `New PR: ${exerciseName}` }),
  protein_goal_hit: ({ protein, target }) => ({
    amount: 30,
    note: `Protein goal hit (${Math.round(protein)}g / ${Math.round(target)}g)`,
  }),
  // Table is intentionally sparse — only real milestone lengths award XP.
  // Session 2 (streaks) decides exact milestone lengths; this table can
  // grow without changing the calling convention.
  streak_milestone: ({ streakType, length }) => {
    const table = { 7: 100, 14: 200, 30: 500, 60: 1000, 100: 2000 };
    return { amount: table[length] || 0, note: `${length}-day ${streakType} streak` };
  },
};

// Pure — given a source name and context, returns { amount, note }. Never
// touches state directly; callers decide what to do with the result (append
// to a ledger, show a toast, etc.).
function awardXp(source, context = {}) {
  const rule = XP_RULES[source];
  if (!rule) return { amount: 0, note: "" };
  return rule(context);
}

// Level curve: level = floor(sqrt(totalXp / 100)) — fast early levels,
// slows down later. Decided/locked 2026-08-03; matches the roadmap default.
function levelForXp(totalXp) {
  return Math.floor(Math.sqrt(Math.max(0, totalXp) / 100));
}
// Inverse, for UI progress bars later (Session 6): total XP required to
// REACH a given level.
function xpForLevel(level) {
  return Math.max(0, level) ** 2 * 100;
}

// One event per calendar date that has at least one logged set with both
// weight and reps — matches the real workoutLogs shape actually used in
// TrainTab (workoutLogs[`${date}|${programKey}|${dayIndex}`][exerciseName][setIndex]),
// not the stale shape described in the old useState comment. Multiple
// sessions logged on the same date (e.g. two different programs) still
// only award one workout_completed event for that date.
function deriveWorkoutXpEvents(workoutLogs) {
  const datesWithLoggedSet = new Set();
  for (const [dayKey, session] of Object.entries(workoutLogs || {})) {
    const date = dayKey.split("|")[0];
    if (datesWithLoggedSet.has(date)) continue;
    const hasLoggedSet = Object.values(session || {}).some((exSets) =>
      Object.values(exSets || {}).some((s) => s && s.weight && s.reps)
    );
    if (hasLoggedSet) datesWithLoggedSet.add(date);
  }
  return Array.from(datesWithLoggedSet).map((date) => ({
    id: `workout:${date}`,
    date,
    source: "workout_completed",
    ...awardXp("workout_completed", {}),
  }));
}

// One event per date where logged protein meets or exceeds goal — hit
// target or higher, no upper cap (decided 2026-08-03). Dates with no
// protein goal set are skipped entirely (target <= 0 can't be "hit").
function deriveProteinXpEvents(foodLog, goals) {
  const target = Number(goals?.protein) || 0;
  if (target <= 0) return [];
  const events = [];
  for (const [date, entries] of Object.entries(foodLog || {})) {
    const protein = (entries || []).reduce((s, e) => s + (Number(e.protein) || 0), 0);
    if (protein >= target) {
      events.push({
        id: `protein:${date}`,
        date,
        source: "protein_goal_hit",
        ...awardXp("protein_goal_hit", { protein, target }),
      });
    }
  }
  return events;
}

// Merges derived events (recomputed fresh every call) with the persisted
// PR-event ledger, de-dupes by id, sorts by date, and reduces to the
// current totalXp/level. This is the single source of truth for xpState —
// nothing else should compute totalXp independently.
function computeXpState({ workoutLogs, foodLog, goals, prEvents = [] }) {
  const allEvents = [...deriveWorkoutXpEvents(workoutLogs), ...deriveProteinXpEvents(foodLog, goals), ...prEvents];
  const seen = new Set();
  const xpHistory = allEvents
    .filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalXp = xpHistory.reduce((s, e) => s + (e.amount || 0), 0);
  return { totalXp, level: levelForXp(totalXp), xpHistory };
}

// ---------------------------------------------------------------------------
// Streaks — Phase 2, Session 2.
//
// Locked rules (decided 2026-08-03):
//   - Workout streak: only evaluated against the active program's SCHEDULED
//     training days (same Monday-anchored weeklySchedule lookup TrainTab
//     and WeekView already use). A scheduled rest day neither breaks nor
//     extends the streak — it's skipped entirely. Missing a scheduled
//     training day breaks it. Programs with no fixed weeklySchedule
//     (Mentzer — individualized frequency) have no defined rest days, so
//     every calendar day is treated as a training opportunity; a day with
//     no logged workout breaks the streak for those programs.
//   - Protein streak: "hit" means target or higher — no upper cap. A day
//     with nothing logged, or under target, breaks it. If no protein goal
//     is set at all, the streak concept doesn't apply (returns zeroed).
//   - Water streak: no water tracking exists yet (that's Session 5) — this
//     returns a zeroed placeholder so the {current, longest, lastDate}
//     shape is already correct and nothing has to change when water
//     tracking lands.
//   - "Today" is never treated as a break before the day is over: if today
//     hasn't been logged yet, the streak holds at whatever it was through
//     yesterday rather than resetting to 0 mid-day.
//
// Same derive-don't-duplicate principle as the XP engine: recomputed fresh
// from workoutLogs/foodLog/goals every time. Nothing here is persisted
// independently.
// ---------------------------------------------------------------------------
function isScheduledRestDay(dateStr, program) {
  if (!program?.weeklySchedule) return null; // no fixed schedule -> concept doesn't apply
  const d = new Date(dateStr + "T00:00:00");
  const mondayFirstIndex = (d.getDay() + 6) % 7;
  const slot = program.weeklySchedule[mondayFirstIndex];
  return slot?.rest === true;
}

function dateRangeInclusive(startStr, endStr) {
  const dates = [];
  let d = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function computeWorkoutStreak(workoutLogs, program, today) {
  const loggedDates = Object.keys(workoutLogs || {}).map((k) => k.split("|")[0]);
  if (!loggedDates.length) return { current: 0, longest: 0, lastDate: null };
  const datesWithWorkout = new Set(deriveWorkoutXpEvents(workoutLogs).map((e) => e.date));
  const earliest = loggedDates.sort()[0];
  const span = dateRangeInclusive(earliest < today ? earliest : today, today);

  let current = 0, longest = 0, lastDate = null;
  span.forEach((date, i) => {
    const isRest = isScheduledRestDay(date, program);
    if (isRest === true) return; // scheduled rest day — skip, doesn't touch streak
    const isToday = i === span.length - 1 && date === today;
    if (datesWithWorkout.has(date)) {
      current += 1;
      lastDate = date;
      longest = Math.max(longest, current);
    } else if (!isToday) {
      current = 0; // missed a real training day -> break (today gets a pass until it's over)
    }
  });
  return { current, longest, lastDate };
}

function computeProteinStreak(foodLog, goals, today) {
  const target = Number(goals?.protein) || 0;
  if (target <= 0) return { current: 0, longest: 0, lastDate: null };
  const loggedDates = Object.keys(foodLog || {});
  if (!loggedDates.length) return { current: 0, longest: 0, lastDate: null };
  const hitDates = new Set(deriveProteinXpEvents(foodLog, goals).map((e) => e.date));
  const earliest = loggedDates.sort()[0];
  const span = dateRangeInclusive(earliest < today ? earliest : today, today);

  let current = 0, longest = 0, lastDate = null;
  span.forEach((date, i) => {
    const isToday = i === span.length - 1 && date === today;
    if (hitDates.has(date)) {
      current += 1;
      lastDate = date;
      longest = Math.max(longest, current);
    } else if (!isToday) {
      current = 0;
    }
  });
  return { current, longest, lastDate };
}

// Water — Session 5. Same today-safe, hit-or-miss shape as the protein
// streak, just against dailyVitals (built from scratch this session; no
// water tracking existed before now) instead of foodLog.
function deriveWaterXpEvents(dailyVitals, goals) {
  const target = Number(goals?.water) || 0;
  if (target <= 0) return [];
  const events = [];
  for (const [date, vitals] of Object.entries(dailyVitals || {})) {
    const oz = Number(vitals?.waterOz) || 0;
    if (oz >= target) events.push({ date, oz });
  }
  return events;
}

function computeWaterStreak(dailyVitals, goals, today) {
  const target = Number(goals?.water) || 0;
  if (target <= 0) return { current: 0, longest: 0, lastDate: null };
  const loggedDates = Object.keys(dailyVitals || {});
  if (!loggedDates.length) return { current: 0, longest: 0, lastDate: null };
  const hitDates = new Set(deriveWaterXpEvents(dailyVitals, goals).map((e) => e.date));
  const earliest = loggedDates.sort()[0];
  const span = dateRangeInclusive(earliest < today ? earliest : today, today);

  let current = 0, longest = 0, lastDate = null;
  span.forEach((date, i) => {
    const isToday = i === span.length - 1 && date === today;
    if (hitDates.has(date)) {
      current += 1;
      lastDate = date;
      longest = Math.max(longest, current);
    } else if (!isToday) {
      current = 0;
    }
  });
  return { current, longest, lastDate };
}

function computeStreaks({ workoutLogs, foodLog, goals, dailyVitals, activeProgramKey, today }) {
  const program = PROGRAMS[activeProgramKey];
  return {
    workout: computeWorkoutStreak(workoutLogs, program, today),
    protein: computeProteinStreak(foodLog, goals, today),
    water: computeWaterStreak(dailyVitals, goals, today),
  };
}

// ---------------------------------------------------------------------------
// Attributes — Phase 2, Session 3.
//
// Five derived 0-100 scores, all recomputed fresh from the same verified
// source logs — no independent state, same principle as XP/streaks.
//
// IMPORTANT — these are first-pass weights, not final. The roadmap is
// explicit that this session is expected to get re-tuned after a week of
// real data; the exact multipliers below (e.g. "PR count * 15", "±10%
// calorie band", "streak/14") are reasonable starting points, not
// calibrated constants. Treat them as easy to find-and-adjust, not settled.
//
// Convention: an attribute returns `null`, not 0, when there isn't enough
// underlying data to say anything yet (e.g. no AMRAP sets logged for
// Endurance, no fixed weeklySchedule for Recovery/Discipline on programs
// like Mentzer). A 0 always means "real signal, currently at the floor";
// null means "no signal yet." The UI (Session 6) should render null as
// "not enough data" rather than a bar at zero.
// ---------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function daysAgoStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Shared fix for every fixed-window attribute below: a naive fixed lookback
// (e.g. "trailing 30 days") silently counts every day BEFORE the person
// started logging that particular thing as an automatic miss — someone on
// day 3 of tracking protein would get scored against 27 phantom days they
// never had a chance to hit. Clip the window start to the later of the
// fixed lookback or the earliest actually-logged date for that source, so
// only real tracked days are ever counted against the rate. (Caught by
// verify_xp.js: a 3-day-old, 2/3-hit-rate nutrition log was scoring 5/100
// instead of ~50/100 before this fix.)
function clipWindowStart(loggedDates, windowStart) {
  if (!loggedDates.length) return windowStart;
  const earliest = loggedDates.slice().sort()[0];
  return earliest > windowStart ? earliest : windowStart;
}

// Strength: PR momentum over a trailing 90-day window, using the same
// prXpEvents ledger the XP engine already maintains (it's the only place
// individual PR *moments* are recorded — personalRecords itself only
// holds the current best per exercise, not history).
function computeStrengthScore(prEvents, today, windowDays = 90) {
  if (!prEvents || !prEvents.length) return null; // no PR history logged yet at all
  const cutoff = daysAgoStr(today, windowDays);
  const recentCount = prEvents.filter((e) => e.date >= cutoff).length;
  return clamp(recentCount * 15, 0, 100);
}

// Shared helper: fraction of SCHEDULED training days in a trailing window
// that were actually logged. Returns null for programs with no fixed
// weeklySchedule (Mentzer) since "scheduled training day" isn't defined
// for those. Today is excluded until it has either been logged or is over
// — same today-safe rule as the streaks.
function computeAdherenceRate(workoutLogs, program, today, windowDays = 30) {
  if (!program?.weeklySchedule) return null;
  const loggedDates = Object.keys(workoutLogs || {}).map((k) => k.split("|")[0]);
  const start = clipWindowStart(loggedDates, daysAgoStr(today, windowDays - 1));
  const span = dateRangeInclusive(start, today);
  const datesWithWorkout = new Set(deriveWorkoutXpEvents(workoutLogs).map((e) => e.date));
  let scheduled = 0, hit = 0;
  span.forEach((date, i) => {
    const isToday = i === span.length - 1 && date === today;
    if (isScheduledRestDay(date, program)) return;
    if (isToday && !datesWithWorkout.has(date)) return; // today not over yet -> excluded, not a miss
    scheduled += 1;
    if (datesWithWorkout.has(date)) hit += 1;
  });
  return scheduled ? hit / scheduled : null;
}

// Discipline: half current workout streak (capped at a 14-day streak = 100),
// half trailing-30-day scheduled-training-day adherence rate.
function computeDisciplineScore(workoutStreak, adherenceRate) {
  if (adherenceRate == null) return null;
  const streakScore = clamp((workoutStreak.current / 14) * 100, 0, 100);
  return Math.round(streakScore * 0.5 + adherenceRate * 100 * 0.5);
}

// Nutrition: trailing-30-day hit-rate on protein (target or higher) and
// calories (within ±10% of target counts as "on target"), averaged.
// Whichever goals are actually set contributes; a day with nothing logged
// counts as a miss (same "no log = no credit" rule as the protein streak),
// except today before anything's been logged, which is excluded rather
// than scored as a miss.
function computeNutritionScore(foodLog, goals, today, windowDays = 30) {
  const proteinTarget = Number(goals?.protein) || 0;
  const calorieTarget = Number(goals?.calories) || 0;
  if (proteinTarget <= 0 && calorieTarget <= 0) return null;
  const loggedDates = Object.keys(foodLog || {});
  const start = clipWindowStart(loggedDates, daysAgoStr(today, windowDays - 1));
  const span = dateRangeInclusive(start, today);

  let proteinDays = 0, proteinHits = 0, calorieDays = 0, calorieHits = 0;
  span.forEach((date, i) => {
    const isToday = i === span.length - 1 && date === today;
    const entries = foodLog?.[date];
    if (isToday && !entries) return; // today hasn't started yet -> excluded
    const totals = (entries || []).reduce(
      (s, e) => ({ protein: s.protein + (Number(e.protein) || 0), calories: s.calories + (Number(e.calories) || 0) }),
      { protein: 0, calories: 0 }
    );
    if (proteinTarget > 0) {
      proteinDays += 1;
      if (totals.protein >= proteinTarget) proteinHits += 1;
    }
    if (calorieTarget > 0) {
      calorieDays += 1;
      if (Math.abs(totals.calories - calorieTarget) <= calorieTarget * 0.1) calorieHits += 1;
    }
  });
  const rates = [proteinDays ? proteinHits / proteinDays : null, calorieDays ? calorieHits / calorieDays : null].filter((r) => r != null);
  return rates.length ? Math.round((rates.reduce((s, r) => s + r, 0) / rates.length) * 100) : null;
}

// Recovery: of the scheduled rest days in a trailing 30-day window, what
// fraction were actually rested (no workout logged)? Training through
// rest days pulls this down. Null for programs with no fixed schedule.
function computeRecoveryScore(workoutLogs, program, today, windowDays = 30) {
  if (!program?.weeklySchedule) return null;
  const loggedDates = Object.keys(workoutLogs || {}).map((k) => k.split("|")[0]);
  const start = clipWindowStart(loggedDates, daysAgoStr(today, windowDays - 1));
  const span = dateRangeInclusive(start, today);
  const datesWithWorkout = new Set(deriveWorkoutXpEvents(workoutLogs).map((e) => e.date));
  let restDays = 0, actuallyRested = 0;
  span.forEach((date) => {
    if (!isScheduledRestDay(date, program)) return;
    restDays += 1;
    if (!datesWithWorkout.has(date)) actuallyRested += 1;
  });
  return restDays ? Math.round((actuallyRested / restDays) * 100) : null;
}

// Endurance: aggregates extraReps (actual reps - programmed target reps)
// across ALL logged AMRAP sets in a trailing 30-day window, across every
// program/exercise — same underlying signal as volumeTrendHint, just
// widened from "one exercise's history" to "everything AMRAP-tagged
// recently" for a single attribute score. avgExtra=0 -> 50 (right at
// target), each extra rep of average trend is worth +10.
function collectRecentAmrapResults(workoutLogs, today, windowDays = 30) {
  const cutoff = daysAgoStr(today, windowDays);
  const results = [];
  for (const [dayKey, session] of Object.entries(workoutLogs || {})) {
    const [date, programKey, dayIndexStr] = dayKey.split("|");
    if (date < cutoff) continue;
    const day = PROGRAMS[programKey]?.days?.[Number(dayIndexStr)];
    if (!day) continue;
    for (const ex of day.exercises) {
      if (!ex.amrap) continue;
      const sets = session[ex.name];
      if (!sets) continue;
      const indices = Object.keys(sets).map(Number).sort((a, b) => a - b);
      const last = sets[indices[indices.length - 1]];
      if (!last?.weight || !last?.reps) continue;
      results.push({ date, extraReps: Number(last.reps) - ex.reps });
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

function computeEnduranceScore(workoutLogs, today, windowDays = 30) {
  const results = collectRecentAmrapResults(workoutLogs, today, windowDays);
  if (!results.length) return null;
  const recent = results.slice(-6); // roughly the last 1-2 AMRAP sessions across exercises
  const avgExtra = recent.reduce((s, r) => s + r.extraReps, 0) / recent.length;
  return clamp(Math.round(50 + avgExtra * 10), 0, 100);
}

function computeAttributes({ workoutLogs, foodLog, goals, prXpEvents, activeProgramKey, today }) {
  const program = PROGRAMS[activeProgramKey];
  const workoutStreak = computeWorkoutStreak(workoutLogs, program, today);
  const adherenceRate = computeAdherenceRate(workoutLogs, program, today);
  return {
    strength: computeStrengthScore(prXpEvents, today),
    discipline: computeDisciplineScore(workoutStreak, adherenceRate),
    nutrition: computeNutritionScore(foodLog, goals, today),
    recovery: computeRecoveryScore(workoutLogs, program, today),
    endurance: computeEnduranceScore(workoutLogs, today),
  };
}

// ---------------------------------------------------------------------------
// Achievements — Phase 2, Session 4.
//
// Static definitions + a pure unlock-check function. Progress is fully
// re-derivable every render from xpState/streaks/prXpEvents (same
// derive-don't-duplicate principle as everything above), so it never needs
// its own storage.
//
// What CAN'T be derived after the fact is WHEN an achievement was first
// earned — same problem PR moments have (current state only says "is this
// true right now," not "the day it first became true"). So unlock dates
// live in a small persisted ledger (`achievementUnlocks: {id: dateISO}`),
// appended the moment computeAchievementProgress first reports something as
// met — same append-on-event pattern as prXpEvents, wired in App() rather
// than recomputed from scratch.
//
// All streak-based achievements use `longest`, never `current` — once
// earned, an achievement must not un-earn itself just because today's
// streak reset. Surfaced as a toast for now (Session 4 scope per roadmap);
// a full gallery view is later.
// ---------------------------------------------------------------------------
const ACHIEVEMENTS = [
  { id: "first_workout", name: "First Rep", description: "Log your first workout.", metric: (ctx) => ({ current: ctx.workoutCount, target: 1 }) },
  { id: "first_pr", name: "New Best", description: "Hit your first personal record.", metric: (ctx) => ({ current: ctx.prCount, target: 1 }) },
  { id: "workout_streak_7", name: "One Week In", description: "Reach a 7-day workout streak.", metric: (ctx) => ({ current: ctx.streaks.workout.longest, target: 7 }) },
  { id: "workout_streak_30", name: "Iron Habit", description: "Reach a 30-day workout streak.", metric: (ctx) => ({ current: ctx.streaks.workout.longest, target: 30 }) },
  { id: "protein_streak_7", name: "Dialed In", description: "Hit your protein target 7 days running.", metric: (ctx) => ({ current: ctx.streaks.protein.longest, target: 7 }) },
  { id: "protein_streak_30", name: "Locked In", description: "Hit your protein target 30 days running.", metric: (ctx) => ({ current: ctx.streaks.protein.longest, target: 30 }) },
  { id: "pr_collector_5", name: "Record Breaker", description: "Hit 5 personal records.", metric: (ctx) => ({ current: ctx.prCount, target: 5 }) },
  { id: "pr_collector_10", name: "Serial Record Breaker", description: "Hit 10 personal records.", metric: (ctx) => ({ current: ctx.prCount, target: 10 }) },
  { id: "level_5", name: "Level 5", description: "Reach level 5.", metric: (ctx) => ({ current: ctx.xpState.level, target: 5 }) },
  { id: "level_10", name: "Level 10", description: "Reach level 10.", metric: (ctx) => ({ current: ctx.xpState.level, target: 10 }) },
  { id: "fifty_workouts", name: "Half Century", description: "Log 50 total workouts.", metric: (ctx) => ({ current: ctx.workoutCount, target: 50 }) },
  { id: "century_club", name: "Century Club", description: "Log 100 total workouts.", metric: (ctx) => ({ current: ctx.workoutCount, target: 100 }) },
];

// Shared context every ACHIEVEMENTS metric reads from — computed once so
// every achievement's count stays consistent instead of each one re-deriving
// its own slightly-different count.
function buildAchievementContext({ xpState, streaks, prXpEvents }) {
  const workoutCount = xpState.xpHistory.filter((e) => e.source === "workout_completed").length;
  const prCount = (prXpEvents || []).length;
  return { xpState, streaks, workoutCount, prCount };
}

// Pure and fully derived — safe to call every render. Doesn't know or care
// about persisted unlock dates, just "is this true right now."
function computeAchievementProgress({ xpState, streaks, prXpEvents }) {
  const ctx = buildAchievementContext({ xpState, streaks, prXpEvents });
  return ACHIEVEMENTS.map((a) => {
    const { current, target } = a.metric(ctx);
    return { id: a.id, name: a.name, description: a.description, current, target, met: current >= target };
  });
}

// Given the current progress list and the persisted unlock ledger, returns
// achievements that are met now but not yet in the ledger — what needs to
// be appended + toasted.
function findNewlyUnlockedAchievements(progressList, unlockedLedger) {
  return progressList.filter((a) => a.met && !(unlockedLedger || {})[a.id]);
}

// ---------------------------------------------------------------------------
// Quests — Phase 2, Session 5.
//
// Daily quests: a fixed checklist evaluated fresh against TODAY's data only
// — no persistence needed, "done" is just "is today's condition true right
// now." A quest only appears if its underlying goal is actually set (no
// "hit your water target" quest if no water target exists) — same
// principle as computeNutritionScore skipping unset goals.
//
// Long-term quests: per the roadmap, these are "just labeled progress bars
// against verified PR/macro data — cheap once Phase 0 + Session 1 exist."
// Rather than build a second progress-tracking system, long-term quests
// ARE the not-yet-met achievements from Session 4, relabeled as an
// in-progress list — same underlying computeAchievementProgress, zero new
// state, sorted so whatever's closest to completion shows first.
// ---------------------------------------------------------------------------
const DAILY_QUEST_DEFS = [
  { id: "log_workout", label: "Log today's workout", needsGoal: () => true },
  { id: "hit_protein", label: "Hit your protein target", needsGoal: (goals) => Number(goals?.protein) > 0 },
  { id: "hit_water", label: "Hit your water target", needsGoal: (goals) => Number(goals?.water) > 0 },
  { id: "hit_steps", label: "Hit your step target", needsGoal: (goals) => Number(goals?.steps) > 0 },
];

function computeDailyQuests({ workoutLogs, foodLog, dailyVitals, goals, today }) {
  const workoutDoneToday = deriveWorkoutXpEvents(workoutLogs).some((e) => e.date === today);
  const proteinDoneToday = deriveProteinXpEvents(foodLog, goals).some((e) => e.date === today);
  const waterDoneToday = deriveWaterXpEvents(dailyVitals, goals).some((e) => e.date === today);
  const stepsTarget = Number(goals?.steps) || 0;
  const stepsToday = Number(dailyVitals?.[today]?.steps) || 0;
  const stepsDoneToday = stepsTarget > 0 && stepsToday >= stepsTarget;

  const doneMap = { log_workout: workoutDoneToday, hit_protein: proteinDoneToday, hit_water: waterDoneToday, hit_steps: stepsDoneToday };
  return DAILY_QUEST_DEFS.filter((q) => q.needsGoal(goals)).map((q) => ({ id: q.id, label: q.label, done: !!doneMap[q.id] }));
}

function computeLongTermQuests({ xpState, streaks, prXpEvents }) {
  return computeAchievementProgress({ xpState, streaks, prXpEvents })
    .filter((a) => !a.met)
    .sort((a, b) => (b.current / b.target) - (a.current / a.target)) // closest-to-done first
    .map((a) => ({ id: a.id, label: a.name, description: a.description, current: a.current, target: a.target }));
}

// Small pure helper for the Home Screen (Session 6): the persisted
// achievementUnlocks ledger only has {id: dateISO}; this joins it back
// against ACHIEVEMENTS for display and returns the most recent N, newest
// first.
function computeRecentUnlocks(achievementUnlocks, limit = 5) {
  const byId = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
  return Object.entries(achievementUnlocks || {})
    .map(([id, date]) => (byId[id] ? { id, date, name: byId[id].name, description: byId[id].description } : null))
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Progress analytics — Phase 2, Session 7.
//
// Strength graph: no new tracking needed — prXpEvents already carries a
// {weight, reps, e1rm} snapshot at the moment of each PR (extended this
// session in TrainTab.logSet), so a per-exercise strength trend is just a
// filter + sort over the existing ledger.
//
// Bodyweight/BF%: confirmed nothing tracked this before. New storage key
// (`bodyMetrics`), built from scratch this session, per the roadmap.
//
// BF% entry — Navy/USMC circumference method (Hodgdon & Beckett, official
// Navy Guide 4 formula). Manual entry is the default; "calculate from
// measurements" is the alternative for when you don't already know the
// number. Whichever mode produced an entry is what gets stored — never
// both a manual and a calculated value for the same date.
// ---------------------------------------------------------------------------

// Verified against two independently-published worked examples (not just
// re-derived from the same formula source):
//   Male,   waist=34,          neck=15.5,        height=70            -> 16.5%
//   Female, waist=29, hip=38,  neck=13,          height=65            -> 27.3%
// (both via fitties.com/blogs/fitties-journal/calculate-body-fat-us-navy-body-fat-formula)
function computeNavyBF({ sex, neck, waist, height, hip }) {
  const n = Number(neck), w = Number(waist), h = Number(height), hp = Number(hip);
  if (sex === "male") {
    if (!(n > 0 && w > 0 && h > 0) || w - n <= 0) return null;
    return 86.010 * Math.log10(w - n) - 70.041 * Math.log10(h) + 36.76;
  }
  if (sex === "female") {
    if (!(n > 0 && w > 0 && h > 0 && hp > 0) || w + hp - n <= 0) return null;
    return 163.205 * Math.log10(w + hp - n) - 97.684 * Math.log10(h) - 78.387;
  }
  return null; // unknown sex -> can't select a formula, not a guess
}

// Pure form-to-entry builder — decides what gets stored for a given date's
// bodyMetrics entry, enforcing "store whichever mode was used, never both."
function buildBodyMetricsEntry({ mode, weightLbs, manualBf, sex, neck, waist, height, hip }) {
  const entry = { weightLbs: weightLbs === "" || weightLbs == null ? null : Number(weightLbs) };
  if (mode === "calculated") {
    const bf = computeNavyBF({ sex, neck, waist, height, hip });
    entry.bfPercent = bf == null ? null : Math.round(bf * 10) / 10;
    entry.bfMethod = "calculated";
    entry.measurements = { neck: Number(neck) || null, waist: Number(waist) || null, height: Number(height) || null, hip: sex === "female" ? Number(hip) || null : null };
  } else {
    entry.bfPercent = manualBf === "" || manualBf == null ? null : Number(manualBf);
    entry.bfMethod = "manual";
  }
  return entry;
}

// Strength history for one exercise, oldest first — straight off the
// existing prXpEvents ledger, no new tracking.
function computeStrengthHistory(prXpEvents, exerciseName) {
  return (prXpEvents || [])
    .filter((e) => e.source === "pr_hit" && e.exerciseName === exerciseName && e.e1rm != null)
    .map((e) => ({ date: e.date, e1rm: e.e1rm, weight: e.weight, reps: e.reps }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Every exercise that has at least one PR event, for a picker UI.
function listExercisesWithHistory(prXpEvents) {
  return Array.from(new Set((prXpEvents || []).filter((e) => e.source === "pr_hit").map((e) => e.exerciseName))).sort();
}

// Bodyweight/BF% trend, oldest first, straight off bodyMetrics.
function computeBodyMetricsTrend(bodyMetrics) {
  return Object.entries(bodyMetrics || {})
    .map(([date, m]) => ({ date, weightLbs: m?.weightLbs ?? null, bfPercent: m?.bfPercent ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// AMRAP week-to-week progression — mirrors Bromley's actual Bullmastiff/BASE
// method: on a 4x6+ scheme, add 1% of your working weight (as a 1RM proxy)
// to NEXT SESSION's weight for every rep beyond the target you hit on the
// final AMRAP set. This is a between-session suggestion, not a within-session
// one — it only fires off the AMRAP (last) set of a marked exercise.
// ---------------------------------------------------------------------------
function amrapNextSessionWeight({ weight, reps, targetReps }) {
  if (!weight || !reps) return null;
  const extraReps = reps - targetReps;
  return round25(weight * (1 + 0.01 * extraReps));
}

// Simple volume-trend hint: looks at the last few logged AMRAP performances
// for an exercise and suggests whether to add/hold/trim a set next block —
// advisory only, doesn't auto-change the program structure.
function volumeTrendHint(history) {
  if (history.length < 2) return null;
  const recent = history.slice(-3);
  const avgExtra = recent.reduce((s, h) => s + h.extraReps, 0) / recent.length;
  if (avgExtra >= 4) return { text: "Consistently smashing the AMRAP target — consider adding a set next block.", tone: "up" };
  if (avgExtra <= -1) return { text: "Missing the AMRAP target lately — consider holding weight or trimming a set.", tone: "down" };
  return { text: "Right around target — current set count looks appropriate.", tone: "flat" };
}

// ---------------------------------------------------------------------------
// Cost of one meal = sum of its ingredient price estimates.
// ---------------------------------------------------------------------------
const mealCost = (meal, location = "") => (meal.ingredients || []).reduce((s, i) => s + (Number(i.price) || 0), 0) * regionMultiplier(location);

// ---------------------------------------------------------------------------
// TDEE — Mifflin-St Jeor
// ---------------------------------------------------------------------------
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  athlete: 1.9,
};
function calcTDEE({ sex, weightLb, heightIn, age, activity }) {
  const kg = weightLb * 0.453592;
  const cm = heightIn * 2.54;
  const bmr = sex === "male" ? 10 * kg + 6.25 * cm - 5 * age + 5 : 10 * kg + 6.25 * cm - 5 * age - 161;
  return Math.round(bmr * (ACTIVITY_MULTIPLIERS[activity] || 1.4));
}

// ---------------------------------------------------------------------------
// Meal-combo suggestion engine.
// Greedy heuristic (not a true optimizer): repeatedly picks whichever
// affordable meal, if added, best balances the *remaining* macro targets
// (lowest variance across how proportionally it consumes protein/carb/fat/
// calories relative to what's left), while respecting the remaining budget.
// Good enough for "here's a combo that's in the right ballpark" — not a
// guarantee of the mathematically optimal fit.
// ---------------------------------------------------------------------------
function suggestCombo({ meals, target, budget, maxMeals = 6, jitter = 0, location = "" }) {
  if (!meals.length) return { chosen: [], remaining: target, totalCost: 0 };
  let remaining = { calories: target.calories, protein: target.protein, carbs: target.carbs, fat: target.fat };
  let remainingBudget = budget;
  const chosen = [];
  const usedIds = new Set();

  for (let step = 0; step < maxMeals; step++) {
    if (remaining.calories <= 100) break;
    const allAffordable = meals.filter((m) => mealCost(m, location) <= remainingBudget + 0.005);
    if (!allAffordable.length) break;
    // Prefer meals not already used this round so a small library doesn't
    // just serve up the same "best fit" meal on repeat; only reuse one if
    // every affordable option has already been picked.
    const unused = allAffordable.filter((m) => !usedIds.has(m.id));
    const candidates = unused.length ? unused : allAffordable;

    let best = null;
    let bestScore = Infinity;
    for (const m of candidates) {
      const cal = m.calories || 0;
      if (cal <= 0) continue;
      if (cal > remaining.calories * 1.35 && remaining.calories > 150) continue; // don't blow past calorie target
      const ratios = ["calories", "protein", "carbs", "fat"].map((k) => {
        const r = remaining[k] > 0 ? (m[k] || 0) / remaining[k] : (m[k] || 0) > 0 ? 1 : 0;
        return r;
      });
      const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const variance = ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length;
      const score = variance + (Math.random() * jitter);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    if (!best) break;

    chosen.push(best);
    usedIds.add(best.id);
    remaining = {
      calories: remaining.calories - (best.calories || 0),
      protein: remaining.protein - (best.protein || 0),
      carbs: remaining.carbs - (best.carbs || 0),
      fat: remaining.fat - (best.fat || 0),
    };
    remainingBudget -= mealCost(best, location);
  }

  const totalCost = budget - remainingBudget;
  return { chosen, remaining, totalCost };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [tab, setTab] = useState("home");
  const [ready, setReady] = useState(false);

  const [meals, setMeals] = useState([]);
  const [log, setLog] = useState({}); // date -> { plan:[mealId], entries:{slotKey:{...}} }
  const [location, setLocation] = useState("");
  const [activeProgramKey, setActiveProgramKey] = useState("cutler");
  const [workoutLogs, setWorkoutLogs] = useState({}); // date -> { dayIndex, sets: [{exercise, weight, reps, rir, notes, suggestedNext}] }
  const [goals, setGoals] = useState({ calories: "", protein: "", carbs: "", fat: "", budget: "", water: "", steps: "" });
  const [mealTimes, setMealTimes] = useState({}); // mealId -> "HH:MM"
  const [notifiedToday, setNotifiedToday] = useState({}); // `${date}_${mealId}` -> true, in-memory only
  const [programStartDates, setProgramStartDates] = useState({}); // programKey -> "YYYY-MM-DD"
  const [trainingMaxes, setTrainingMaxes] = useState({}); // liftName -> number (used by Bullmastiff)
  const [personalRecords, setPersonalRecords] = useState({}); // exerciseName -> { weight, reps, rir, date, e1rm }
  const [foodLog, setFoodLog] = useState({}); // date -> [{id, name, serving, qty, calories, protein, carbs, fat}]
  const [prXpEvents, setPrXpEvents] = useState([]); // [{id, date, source:"pr_hit", amount, note}] — see XP engine comment above computeXpState
  const [achievementUnlocks, setAchievementUnlocks] = useState({}); // {id: dateISO} — appended the moment computeAchievementProgress first reports `met`, see Achievements comment
  const [justUnlockedAchievement, setJustUnlockedAchievement] = useState(null); // {id,name,description} | null — toast only, no persistence
  const [dailyVitals, setDailyVitals] = useState({}); // date -> { waterOz, steps } — new this session (Phase 2, Session 5); no prior tracking existed
  const [bodyMetrics, setBodyMetrics] = useState({}); // date -> { weightLbs, bfPercent, bfMethod, measurements? } — new this session (Phase 2, Session 7); no prior tracking existed
  const [groceryPlan, setGroceryPlan] = useState({}); // recipeId -> servings (batch size selected in Grocery tab)
  const [mealSlots, setMealSlots] = useState([]); // [{id, label, time, protein, carbs, fat}] — per-meal macro targets, linked to Reminders
  const [storageError, setStorageError] = useState(null);

  // All persistence writes go through this so failures (private/incognito
  // mode blocking storage, quota exceeded, etc.) surface as a visible error
  // instead of vanishing into a console.error no one sees.
  const persist = useCallback((key, value) => {
    save(key, value).then((result) => {
      if (!result.ok) setStorageError(result.reason);
      else setStorageError(null);
    });
  }, []);

  useEffect(() => {
    (async () => {
      setMeals(await load("meals", []));
      setLog(await load("dailyLog", {}));
      setLocation(await load("location", ""));
      setActiveProgramKey(await load("activeProgram", "cutler"));
      setWorkoutLogs(await load("workoutLogs", {}));
      setGoals(await load("goals", { calories: "", protein: "", carbs: "", fat: "", budget: "", water: "", steps: "" }));
      setMealTimes(await load("mealTimes", {}));
      setProgramStartDates(await load("programStartDates", {}));
      setTrainingMaxes(await load("trainingMaxes", {}));
      setPersonalRecords(await load("personalRecords", {}));
      setFoodLog(await load("foodLog", {}));
      setPrXpEvents(await load("prXpEvents", []));
      setAchievementUnlocks(await load("achievementUnlocks", {}));
      setDailyVitals(await load("dailyVitals", {}));
      setBodyMetrics(await load("bodyMetrics", {}));
      setGroceryPlan(await load("groceryPlan", {}));
      setMealSlots(await load("mealSlots", []));
      setReady(true);
    })();
  }, []);
  useEffect(() => { if (ready) persist("meals", meals); }, [meals, ready, persist]);
  useEffect(() => { if (ready) persist("dailyLog", log); }, [log, ready, persist]);
  useEffect(() => { if (ready) persist("location", location); }, [location, ready, persist]);
  useEffect(() => { if (ready) persist("activeProgram", activeProgramKey); }, [activeProgramKey, ready, persist]);
  useEffect(() => { if (ready) persist("workoutLogs", workoutLogs); }, [workoutLogs, ready, persist]);
  useEffect(() => { if (ready) persist("goals", goals); }, [goals, ready, persist]);
  useEffect(() => { if (ready) persist("mealTimes", mealTimes); }, [mealTimes, ready, persist]);
  useEffect(() => { if (ready) persist("programStartDates", programStartDates); }, [programStartDates, ready, persist]);
  useEffect(() => { if (ready) persist("trainingMaxes", trainingMaxes); }, [trainingMaxes, ready, persist]);
  useEffect(() => { if (ready) persist("personalRecords", personalRecords); }, [personalRecords, ready, persist]);
  useEffect(() => { if (ready) persist("foodLog", foodLog); }, [foodLog, ready, persist]);
  useEffect(() => { if (ready) persist("prXpEvents", prXpEvents); }, [prXpEvents, ready, persist]);
  useEffect(() => { if (ready) persist("achievementUnlocks", achievementUnlocks); }, [achievementUnlocks, ready, persist]);
  useEffect(() => { if (ready) persist("dailyVitals", dailyVitals); }, [dailyVitals, ready, persist]);
  useEffect(() => { if (ready) persist("bodyMetrics", bodyMetrics); }, [bodyMetrics, ready, persist]);

  // Single source of truth for XP — recomputed whenever any source log
  // changes. See computeXpState comment for why this is safe to fully
  // recompute rather than incrementally patch.
  const xpState = useMemo(
    () => computeXpState({ workoutLogs, foodLog, goals, prEvents: prXpEvents }),
    [workoutLogs, foodLog, goals, prXpEvents]
  );

  const streaks = useMemo(
    () => computeStreaks({ workoutLogs, foodLog, goals, dailyVitals, activeProgramKey, today: todayStr() }),
    [workoutLogs, foodLog, goals, dailyVitals, activeProgramKey]
  );

  const attributes = useMemo(
    () => computeAttributes({ workoutLogs, foodLog, goals, prXpEvents, activeProgramKey, today: todayStr() }),
    [workoutLogs, foodLog, goals, prXpEvents, activeProgramKey]
  );

  // Fully derived every render; the effect below is only responsible for
  // noticing when something NEWLY crosses into `met` and recording the date.
  const achievementProgress = useMemo(
    () => computeAchievementProgress({ xpState, streaks, prXpEvents }),
    [xpState, streaks, prXpEvents]
  );
  useEffect(() => {
    if (!ready) return;
    const newlyUnlocked = findNewlyUnlockedAchievements(achievementProgress, achievementUnlocks);
    if (!newlyUnlocked.length) return;
    const today = todayStr();
    setAchievementUnlocks((prev) => {
      const next = { ...prev };
      newlyUnlocked.forEach((a) => { next[a.id] = today; });
      return next;
    });
    setJustUnlockedAchievement(newlyUnlocked[newlyUnlocked.length - 1]);
    // Re-runs once more after achievementUnlocks updates above, but by then
    // newlyUnlocked is empty and it's a no-op — not a loop.
  }, [achievementProgress, achievementUnlocks, ready]);

  const dailyQuests = useMemo(
    () => computeDailyQuests({ workoutLogs, foodLog, dailyVitals, goals, today: todayStr() }),
    [workoutLogs, foodLog, dailyVitals, goals]
  );
  const longTermQuests = useMemo(
    () => computeLongTermQuests({ xpState, streaks, prXpEvents }),
    [xpState, streaks, prXpEvents]
  );
  const recentUnlocks = useMemo(() => computeRecentUnlocks(achievementUnlocks, 5), [achievementUnlocks]);
  const exercisesWithHistory = useMemo(() => listExercisesWithHistory(prXpEvents), [prXpEvents]);
  const bodyMetricsTrend = useMemo(() => computeBodyMetricsTrend(bodyMetrics), [bodyMetrics]);
  useEffect(() => { if (ready) persist("groceryPlan", groceryPlan); }, [groceryPlan, ready, persist]);
  useEffect(() => { if (ready) persist("mealSlots", mealSlots); }, [mealSlots, ready, persist]);

  // Poll the clock once a minute while the app is open; fire a notification
  // (or fall back to an in-app banner) for any planned, not-yet-eaten meal
  // whose scheduled time has arrived. Only works while this tab is active —
  // no service worker / push here.
  const [banner, setBanner] = useState(null);
  useEffect(() => {
    if (!ready) return;
    const check = () => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const date = todayStr();
      const dayLog = log[date] || { plan: [], entries: {} };
      dayLog.plan.forEach((mealId) => {
        const time = mealTimes[mealId];
        if (!time || time !== hhmm) return;
        const entry = dayLog.entries[mealId];
        if (entry?.status === "done" || entry?.status === "replaced") return;
        const key = `${date}_${mealId}`;
        if (notifiedToday[key]) return;
        const meal = meals.find((m) => m.id === mealId);
        const title = "FORGE — meal time";
        const body = meal ? `Time to eat: ${meal.name}` : "Time for your next planned meal";
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(title, { body });
        } else {
          setBanner(body);
          setTimeout(() => setBanner(null), 15000);
        }
        setNotifiedToday((prev) => ({ ...prev, [key]: true }));
      });
      mealSlots.forEach((slot) => {
        if (!slot.time || slot.time !== hhmm) return;
        const key = `${date}_slot_${slot.id}`;
        if (notifiedToday[key]) return;
        const title = "FORGE — meal time";
        const body = `Time to eat: ${slot.label} (target ${slot.protein || 0}P / ${slot.carbs || 0}C / ${slot.fat || 0}F)`;
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(title, { body });
        } else {
          setBanner(body);
          setTimeout(() => setBanner(null), 15000);
        }
        setNotifiedToday((prev) => ({ ...prev, [key]: true }));
      });
    };
    const id = setInterval(check, 30000);
    check();
    return () => clearInterval(id);
  }, [ready, log, mealTimes, notifiedToday, meals, mealSlots]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading FORGE…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans pb-24">
      <Header />
      {storageError && (
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="bg-red-950/60 border border-red-900 text-red-300 rounded-xl px-3.5 py-2.5 text-sm font-medium flex items-start gap-2">
            <Info size={15} className="shrink-0 mt-0.5" />
            <span className="flex-1">Not saved: {storageError}</span>
            <button onClick={() => setStorageError(null)} className="shrink-0 text-red-400 hover:text-red-200">
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      {justUnlockedAchievement && (
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="bg-amber-950/50 border border-amber-800/50 text-amber-200 rounded-xl px-3.5 py-2.5 text-sm font-medium flex items-start gap-2">
            <Trophy size={15} className="shrink-0 mt-0.5 text-amber-400" />
            <span className="flex-1">
              Achievement unlocked — {justUnlockedAchievement.name}
              <span className="block text-amber-400/80 font-normal text-xs mt-0.5">{justUnlockedAchievement.description}</span>
            </span>
            <button onClick={() => setJustUnlockedAchievement(null)} className="shrink-0 text-amber-500 hover:text-amber-300">
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      {banner && (
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="bg-orange-600 text-zinc-950 rounded-xl px-3.5 py-2.5 text-sm font-medium flex items-center gap-2">
            <Bell size={15} /> {banner}
          </div>
        </div>
      )}
      <main className="max-w-2xl mx-auto px-4 pt-4">
        {tab === "home" && (
          <HomeTab
            xpState={xpState}
            streaks={streaks}
            attributes={attributes}
            dailyQuests={dailyQuests}
            longTermQuests={longTermQuests}
            recentUnlocks={recentUnlocks}
            setTab={setTab}
          />
        )}
        {tab === "today" && (
          <TodayTab
            meals={meals}
            log={log}
            setLog={setLog}
            activeProgramKey={activeProgramKey}
            setActiveProgramKey={setActiveProgramKey}
            dailyVitals={dailyVitals}
            setDailyVitals={setDailyVitals}
            goals={goals}
            dailyQuests={dailyQuests}
            longTermQuests={longTermQuests}
          />
        )}
        {tab === "prep" && (
          <PrepTab
            meals={meals}
            setMeals={setMeals}
            location={location}
            setLocation={setLocation}
            goals={goals}
            setGoals={setGoals}
            log={log}
            setLog={setLog}
            mealSlots={mealSlots}
            setMealSlots={setMealSlots}
          />
        )}
        {tab === "cookbook" && (
          <CookbookTab goals={goals} mealSlots={mealSlots} setMeals={setMeals} setLog={setLog} meals={meals} log={log} activeProgramKey={activeProgramKey} programStartDates={programStartDates} location={location} />
        )}
        {tab === "grocery" && (
          <GroceryTab goals={goals} groceryPlan={groceryPlan} setGroceryPlan={setGroceryPlan} meals={meals} location={location} />
        )}
        {tab === "logbook" && (
          <LogbookTab goals={goals} foodLog={foodLog} setFoodLog={setFoodLog} />
        )}
        {tab === "reminders" && (
          <RemindersTab meals={meals} mealTimes={mealTimes} setMealTimes={setMealTimes} log={log} mealSlots={mealSlots} setMealSlots={setMealSlots} />
        )}
        {tab === "train" && (
          <TrainTab
            activeProgramKey={activeProgramKey}
            setActiveProgramKey={setActiveProgramKey}
            workoutLogs={workoutLogs}
            setWorkoutLogs={setWorkoutLogs}
            programStartDates={programStartDates}
            setProgramStartDates={setProgramStartDates}
            trainingMaxes={trainingMaxes}
            setTrainingMaxes={setTrainingMaxes}
            personalRecords={personalRecords}
            setPersonalRecords={setPersonalRecords}
            setPrXpEvents={setPrXpEvents}
          />
        )}
        {tab === "progress" && (
          <ProgressTab
            bodyMetrics={bodyMetrics}
            setBodyMetrics={setBodyMetrics}
            bodyMetricsTrend={bodyMetricsTrend}
            prXpEvents={prXpEvents}
            exercisesWithHistory={exercisesWithHistory}
          />
        )}
      </main>
      <NavBar tab={tab} setTab={setTab} />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/95 backdrop-blur sticky top-0 z-10">
      <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-2">
        <div className="w-8 h-8 rounded bg-orange-600 flex items-center justify-center font-black text-zinc-950 text-sm">F</div>
        <div>
          <div className="font-black tracking-tight text-lg leading-none">FORGE</div>
          <div className="text-[11px] text-zinc-500 leading-none mt-0.5">nutrition · training log</div>
        </div>
      </div>
    </header>
  );
}

function NavBar({ tab, setTab }) {
  const items = [
    { key: "home", label: "Home", icon: Flame },
    { key: "today", label: "Today", icon: ClipboardList },
    { key: "prep", label: "Prep", icon: UtensilsCrossed },
    { key: "cookbook", label: "Cookbook", icon: BookOpen },
    { key: "grocery", label: "Grocery", icon: ShoppingCart },
    { key: "logbook", label: "Log", icon: Search },
    { key: "train", label: "Train", icon: Dumbbell },
    { key: "progress", label: "Progress", icon: TrendingUp },
    { key: "reminders", label: "Remind", icon: Bell },
  ];
  return (
    <nav className="fixed bottom-0 inset-x-0 bg-zinc-900 border-t border-zinc-800 z-10">
      <div className="max-w-2xl mx-auto flex overflow-x-auto no-scrollbar">
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 min-w-[64px] shrink-0 flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
              tab === key ? "text-orange-500" : "text-zinc-500"
            }`}
          >
            <span className={`flex items-center justify-center w-9 h-7 rounded-full transition-colors ${tab === key ? "bg-orange-500/15" : ""}`}>
              <Icon size={18} />
            </span>
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// TODAY TAB — daily meal checklist with cheat-meal override
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// HOME TAB — Phase 2, Session 6. Pulls from everything built in Sessions 1-5;
// deliberately built last so it wires against real, already-verified data
// instead of getting rebuilt once real data existed. Every number here is
// a prop computed upstream in App() via useMemo — this component only
// renders, it doesn't derive anything itself.
// ---------------------------------------------------------------------------
function XpBar({ xpState }) {
  const floor = xpForLevel(xpState.level);
  const ceiling = xpForLevel(xpState.level + 1);
  const span = ceiling - floor || 1;
  const pct = clamp(((xpState.totalXp - floor) / span) * 100, 0, 100);
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-end justify-between mb-2">
        <div>
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Level</div>
          <div className="text-3xl font-bold text-orange-500">{xpState.level}</div>
        </div>
        <div className="text-right text-xs text-zinc-500">
          {xpState.totalXp} XP total<br />
          {ceiling - xpState.totalXp} to level {xpState.level + 1}
        </div>
      </div>
      <div className="w-full bg-zinc-950 rounded-full h-2 overflow-hidden">
        <div className="h-full bg-orange-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StreakBadge({ label, icon: Icon, streak, color }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex-1 text-center">
      <Icon size={16} className={`mx-auto mb-1 ${color}`} />
      <div className="text-lg font-bold text-zinc-100">{streak.current}</div>
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</div>
      {streak.longest > streak.current && <div className="text-[10px] text-zinc-600 mt-0.5">best {streak.longest}</div>}
    </div>
  );
}

function AttributeBar({ label, value }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-zinc-400">{label}</span>
        <span className="text-zinc-500">{value == null ? "—" : value}</span>
      </div>
      <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden">
        <div className="h-full bg-orange-600" style={{ width: `${value == null ? 0 : clamp(value, 0, 100)}%` }} />
      </div>
    </div>
  );
}

function HomeTab({ xpState, streaks, attributes, dailyQuests, longTermQuests, recentUnlocks, setTab }) {
  const dailyDone = dailyQuests.filter((q) => q.done).length;
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">The Forge</h2>

      <XpBar xpState={xpState} />

      <div className="flex gap-2">
        <StreakBadge label="Workout" icon={Dumbbell} streak={streaks.workout} color="text-orange-400" />
        <StreakBadge label="Protein" icon={Flame} streak={streaks.protein} color="text-emerald-400" />
        <StreakBadge label="Water" icon={Flame} streak={streaks.water} color="text-sky-400" />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Attributes</label>
        <AttributeBar label="Strength" value={attributes.strength} />
        <AttributeBar label="Discipline" value={attributes.discipline} />
        <AttributeBar label="Nutrition" value={attributes.nutrition} />
        <AttributeBar label="Recovery" value={attributes.recovery} />
        <AttributeBar label="Endurance" value={attributes.endurance} />
      </div>

      {dailyQuests.length > 0 && (
        <button onClick={() => setTab("today")} className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-left hover:border-orange-600/40">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Today's quests</label>
            <span className="text-xs text-zinc-500">{dailyDone}/{dailyQuests.length}</span>
          </div>
          <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden mt-2">
            <div className="h-full bg-emerald-600" style={{ width: `${dailyQuests.length ? (dailyDone / dailyQuests.length) * 100 : 0}%` }} />
          </div>
        </button>
      )}

      {longTermQuests.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-3">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Next up</label>
          {longTermQuests.slice(0, 3).map((q) => (
            <div key={q.id}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-300">{q.label}</span>
                <span className="text-xs text-zinc-500">{q.current} / {q.target}</span>
              </div>
              <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-orange-600" style={{ width: `${clamp((q.current / q.target) * 100, 0, 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {recentUnlocks.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-2">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-1.5">
            <Trophy size={13} className="text-amber-400" /> Recent achievements
          </label>
          {recentUnlocks.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-sm">
              <span className="text-zinc-300">{a.name}</span>
              <span className="text-xs text-zinc-600">{a.date}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function Sparkline({ points, color = "#f97316", height = 80 }) {
  const clean = (points || []).filter((p) => p.value != null);
  if (clean.length < 2) {
    return <div className="h-20 flex items-center justify-center text-xs text-zinc-600">Need at least 2 entries to chart a trend</div>;
  }
  const values = clean.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const w = 300;
  const coords = clean.map((p, i) => {
    const x = (i / (clean.length - 1)) * w;
    const y = height - ((p.value - min) / span) * (height - 8) - 4;
    return `${x},${y}`;
  });
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }}>
        <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
        <span>{clean[0].date}</span>
        <span>{clean[clean.length - 1].date}</span>
      </div>
    </div>
  );
}

function ProgressTab({ bodyMetrics, setBodyMetrics, bodyMetricsTrend, prXpEvents, exercisesWithHistory }) {
  const date = todayStr();
  const [mode, setMode] = useState("manual");
  const [sex, setSex] = useState("male");
  const [form, setForm] = useState({ weightLbs: "", manualBf: "", neck: "", waist: "", height: "", hip: "" });
  const [selectedExercise, setSelectedExercise] = useState(exercisesWithHistory[0] || "");

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const previewBf = mode === "calculated" ? computeNavyBF({ sex, neck: form.neck, waist: form.waist, height: form.height, hip: form.hip }) : null;

  const saveEntry = () => {
    const entry = buildBodyMetricsEntry({ mode, weightLbs: form.weightLbs, manualBf: form.manualBf, sex, neck: form.neck, waist: form.waist, height: form.height, hip: form.hip });
    setBodyMetrics((prev) => ({ ...prev, [date]: entry }));
  };

  const strengthHistory = useMemo(() => computeStrengthHistory(prXpEvents, selectedExercise), [prXpEvents, selectedExercise]);
  const todayEntry = bodyMetrics[date];

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Progress</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Bodyweight trend</label>
        <Sparkline points={bodyMetricsTrend.map((m) => ({ date: m.date, value: m.weightLbs }))} color="#f97316" />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Body fat % trend</label>
        <Sparkline points={bodyMetricsTrend.map((m) => ({ date: m.date, value: m.bfPercent }))} color="#38bdf8" />
      </div>

      {exercisesWithHistory.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Strength trend (e1RM)</label>
            <select value={selectedExercise} onChange={(e) => setSelectedExercise(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs">
              {exercisesWithHistory.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
            </select>
          </div>
          <Sparkline points={strengthHistory.map((h) => ({ date: h.date, value: h.e1rm }))} color="#22c55e" />
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Log today's numbers</label>
        {todayEntry && <p className="text-[11px] text-zinc-500">Already logged today via {todayEntry.bfMethod || "—"} — saving again overwrites it.</p>}
        <div>
          <label className="text-[10px] text-zinc-600">Bodyweight (lbs)</label>
          <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.weightLbs} onChange={(e) => setField("weightLbs", e.target.value)} />
        </div>

        <div className="flex gap-2 text-xs">
          <button onClick={() => setMode("manual")} className={`flex-1 rounded-lg py-1.5 border ${mode === "manual" ? "border-orange-600 text-orange-400" : "border-zinc-800 text-zinc-500"}`}>Enter BF% directly</button>
          <button onClick={() => setMode("calculated")} className={`flex-1 rounded-lg py-1.5 border ${mode === "calculated" ? "border-orange-600 text-orange-400" : "border-zinc-800 text-zinc-500"}`}>Calculate from measurements</button>
        </div>

        {mode === "manual" ? (
          <div>
            <label className="text-[10px] text-zinc-600">Body fat % (from calipers, DEXA, a coach, etc.)</label>
            <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.manualBf} onChange={(e) => setField("manualBf", e.target.value)} />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2 text-xs">
              <button onClick={() => setSex("male")} className={`flex-1 rounded-lg py-1 border ${sex === "male" ? "border-orange-600 text-orange-400" : "border-zinc-800 text-zinc-500"}`}>Male</button>
              <button onClick={() => setSex("female")} className={`flex-1 rounded-lg py-1 border ${sex === "female" ? "border-orange-600 text-orange-400" : "border-zinc-800 text-zinc-500"}`}>Female</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="text-[10px] text-zinc-600">Neck (in)</label><input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.neck} onChange={(e) => setField("neck", e.target.value)} /></div>
              <div><label className="text-[10px] text-zinc-600">Waist (in)</label><input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.waist} onChange={(e) => setField("waist", e.target.value)} /></div>
              <div><label className="text-[10px] text-zinc-600">Height (in)</label><input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.height} onChange={(e) => setField("height", e.target.value)} /></div>
              {sex === "female" && (
                <div><label className="text-[10px] text-zinc-600">Hip (in)</label><input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={form.hip} onChange={(e) => setField("hip", e.target.value)} /></div>
              )}
            </div>
            <p className="text-[11px] text-zinc-500">
              {previewBf != null ? `≈ ${previewBf.toFixed(1)}% — Navy/USMC circumference method.` : "Enter all measurements to preview."}
              {" "}Tape-measurement estimate — trend it over time rather than treating any single reading as exact; calipers or a DEXA scan will be more precise at any one point.
            </p>
          </div>
        )}

        <button onClick={saveEntry} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-lg py-2.5 text-sm">
          Save today's entry
        </button>
      </div>
    </div>
  );
}

function TodayTab({ meals, log, setLog, activeProgramKey, setActiveProgramKey, dailyVitals, setDailyVitals, goals, dailyQuests, longTermQuests }) {
  const date = todayStr();
  const dayLog = log[date] || { plan: [], entries: {} };
  const program = PROGRAMS[activeProgramKey];
  const todayVitals = dailyVitals[date] || { waterOz: 0, steps: 0 };
  const waterTarget = Number(goals?.water) || 0;
  const stepsTarget = Number(goals?.steps) || 0;

  const addWater = (oz) => {
    setDailyVitals((prev) => {
      const d = prev[date] || { waterOz: 0, steps: 0 };
      return { ...prev, [date]: { ...d, waterOz: Math.max(0, (Number(d.waterOz) || 0) + oz) } };
    });
  };
  const setSteps = (steps) => {
    setDailyVitals((prev) => {
      const d = prev[date] || { waterOz: 0, steps: 0 };
      return { ...prev, [date]: { ...d, steps: Math.max(0, Number(steps) || 0) } };
    });
  };

  const addToPlan = (mealId) => {
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      if (d.plan.includes(mealId)) return prev;
      return { ...prev, [date]: { ...d, plan: [...d.plan, mealId] } };
    });
  };
  const removeFromPlan = (mealId) => {
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      const entries = { ...d.entries };
      delete entries[mealId];
      return { ...prev, [date]: { ...d, plan: d.plan.filter((id) => id !== mealId), entries } };
    });
  };
  const markDone = (mealId) => {
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      return { ...prev, [date]: { ...d, entries: { ...d.entries, [mealId]: { status: "done" } } } };
    });
  };
  const unmark = (mealId) => {
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      const entries = { ...d.entries };
      delete entries[mealId];
      return { ...prev, [date]: { ...d, entries } };
    });
  };
  const override = (mealId, food, cals) => {
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      return {
        ...prev,
        [date]: { ...d, entries: { ...d.entries, [mealId]: { status: "replaced", food, calories: cals } } },
      };
    });
  };

  const plannedMeals = dayLog.plan.map((id) => meals.find((m) => m.id === id)).filter(Boolean);

  const totals = useMemo(() => {
    let cals = 0, planned = 0, protein = 0, carbs = 0, fat = 0, protPlanned = 0, carbPlanned = 0, fatPlanned = 0;
    plannedMeals.forEach((m) => {
      const e = dayLog.entries[m.id];
      planned += m.calories || 0;
      protPlanned += m.protein || 0;
      carbPlanned += m.carbs || 0;
      fatPlanned += m.fat || 0;
      if (e?.status === "done") {
        cals += m.calories || 0;
        protein += m.protein || 0;
        carbs += m.carbs || 0;
        fat += m.fat || 0;
      } else if (e?.status === "replaced") {
        cals += e.calories || 0;
      }
    });
    return { cals, planned, protein, carbs, fat, protPlanned, carbPlanned, fatPlanned };
  }, [plannedMeals, dayLog]);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
      </h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center gap-4">
        <CalorieRing value={totals.cals} target={totals.planned} size={112} stroke={10} />
        <div className="flex-1 min-w-0 space-y-2">
          <MacroBar label="Protein" color={MACRO_COLORS.protein} val={totals.protein} tgt={Math.round(totals.protPlanned)} />
          <MacroBar label="Carbs" color={MACRO_COLORS.carbs} val={totals.carbs} tgt={Math.round(totals.carbPlanned)} />
          <MacroBar label="Fat" color={MACRO_COLORS.fat} val={totals.fat} tgt={Math.round(totals.fatPlanned)} />
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-1.5">
          <Dumbbell size={13} /> Training program
        </label>
        <select
          value={activeProgramKey}
          onChange={(e) => setActiveProgramKey(e.target.value)}
          className="w-full mt-1.5 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm"
        >
          {Object.entries(PROGRAMS).map(([key, p]) => (
            <option key={key} value={key}>{p.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-500 mt-1.5">{program.style}</p>
        <p className="text-[11px] text-zinc-600 mt-2">Full set logging is in the Train tab — this stays in sync with whatever you pick here.</p>
      </div>

      {(waterTarget > 0 || stepsTarget > 0) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-3">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-1.5">
            <Flame size={13} /> Vitals
          </label>
          {waterTarget > 0 && (
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-300">Water</span>
                <span className={`text-xs ${todayVitals.waterOz >= waterTarget ? "text-emerald-400" : "text-zinc-500"}`}>
                  {Math.round(todayVitals.waterOz)} / {waterTarget} oz
                </span>
              </div>
              <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden mb-2">
                <div className="h-full bg-sky-500" style={{ width: `${clamp((todayVitals.waterOz / waterTarget) * 100, 0, 100)}%` }} />
              </div>
              <div className="flex gap-2">
                {[8, 16, 24].map((oz) => (
                  <button key={oz} onClick={() => addWater(oz)} className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg py-1.5 text-xs text-zinc-300 hover:border-sky-600/60">
                    +{oz}oz
                  </button>
                ))}
              </div>
            </div>
          )}
          {stepsTarget > 0 && (
            <div>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-300">Steps</span>
                <span className={`text-xs ${todayVitals.steps >= stepsTarget ? "text-emerald-400" : "text-zinc-500"}`}>
                  {todayVitals.steps} / {stepsTarget}
                </span>
              </div>
              <input
                type="number"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm"
                placeholder="Today's step count"
                value={todayVitals.steps || ""}
                onChange={(e) => setSteps(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {dailyQuests?.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-2">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Today's quests</label>
          {dailyQuests.map((q) => (
            <div key={q.id} className="flex items-center gap-2 text-sm">
              <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${q.done ? "bg-emerald-600" : "bg-zinc-800 border border-zinc-700"}`}>
                {q.done && <Check size={11} className="text-zinc-950" />}
              </div>
              <span className={q.done ? "text-zinc-500 line-through" : "text-zinc-300"}>{q.label}</span>
            </div>
          ))}
        </div>
      )}

      {longTermQuests?.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-3">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Long-term quests</label>
          {longTermQuests.slice(0, 3).map((q) => (
            <div key={q.id}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-zinc-300">{q.label}</span>
                <span className="text-xs text-zinc-500">{q.current} / {q.target}</span>
              </div>
              <div className="w-full bg-zinc-950 rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-orange-600" style={{ width: `${clamp((q.current / q.target) * 100, 0, 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {plannedMeals.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="Nothing on today's plan"
          body="Add meals from your Prep library below to build today's checklist."
        />
      )}

      <div className="space-y-2">
        {plannedMeals.map((m) => (
          <MealRow
            key={m.id}
            meal={m}
            entry={dayLog.entries[m.id]}
            onDone={() => markDone(m.id)}
            onUnmark={() => unmark(m.id)}
            onOverride={(food, cals) => override(m.id, food, cals)}
            onRemove={() => removeFromPlan(m.id)}
          />
        ))}
      </div>

      <div className="pt-2">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Add from your prep library</h3>
        {meals.length === 0 ? (
          <p className="text-sm text-zinc-500">No meals saved yet — build some in the Prep tab first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {meals
              .filter((m) => !dayLog.plan.includes(m.id))
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => addToPlan(m.id)}
                  className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-full pl-3 pr-2 py-1.5 text-sm text-zinc-300 hover:border-orange-600/60"
                >
                  {m.name} <span className="text-zinc-500 text-xs">{m.calories}kcal</span>
                  <Plus size={14} className="text-orange-500" />
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MealRow({ meal, entry, onDone, onUnmark, onOverride, onRemove }) {
  const [showOverride, setShowOverride] = useState(false);
  const [food, setFood] = useState("");
  const [cals, setCals] = useState("");

  const status = entry?.status;

  return (
    <div className={`rounded-xl border p-3 ${status === "done" ? "border-teal-700/60 bg-teal-950/20" : status === "replaced" ? "border-orange-700/60 bg-orange-950/10" : "border-zinc-800 bg-zinc-900"}`}>
      <div className="flex items-center gap-3">
        <button
          onClick={() => (status === "done" ? onUnmark() : onDone())}
          className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center border-2 transition-colors ${
            status === "done" ? "bg-teal-600 border-teal-600" : "border-zinc-600"
          }`}
        >
          {status === "done" && <Check size={16} className="text-zinc-950" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{meal.name}</div>
          {status === "replaced" ? (
            <div className="text-xs text-orange-400">Replaced: {entry.food} · {entry.calories} kcal</div>
          ) : (
            <div className="text-xs text-zinc-500 flex items-center gap-1.5">
              <span>{meal.calories} kcal</span>
              {meal.protein ? <><span className="text-zinc-700">·</span><MacroInline protein={meal.protein} carbs={meal.carbs} fat={meal.fat} /></> : null}
            </div>
          )}
        </div>
        <button onClick={() => setShowOverride((s) => !s)} className="text-xs text-zinc-500 px-2 py-1 hover:text-orange-500">
          {status === "replaced" ? "Edit" : "Swap"}
        </button>
        <button onClick={onRemove} className="text-zinc-600 hover:text-red-500">
          <Trash2 size={15} />
        </button>
      </div>
      {showOverride && (
        <div className="mt-3 pt-3 border-t border-zinc-800 flex gap-2">
          <input
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm"
            placeholder="What did you actually eat?"
            value={food}
            onChange={(e) => setFood(e.target.value)}
          />
          <input
            type="number"
            className="w-24 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm"
            placeholder="kcal"
            value={cals}
            onChange={(e) => setCals(e.target.value)}
          />
          <button
            onClick={() => {
              if (!food || !cals) return;
              onOverride(food, Number(cals));
              setShowOverride(false);
              setFood(""); setCals("");
            }}
            className="bg-orange-600 text-zinc-950 font-semibold rounded-lg px-3 text-sm"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PREP TAB — meal + ingredient library with cost estimation
// ---------------------------------------------------------------------------
function PrepTab({ meals, setMeals, location, setLocation, goals, setGoals, log, setLog, mealSlots, setMealSlots }) {
  const [showForm, setShowForm] = useState(false);

  const addMeal = (meal) => setMeals((prev) => [...prev, { ...meal, id: uid() }]);
  const deleteMeal = (id) => setMeals((prev) => prev.filter((m) => m.id !== id));

  const addMealToToday = (mealId) => {
    const date = todayStr();
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      if (d.plan.includes(mealId)) return prev;
      return { ...prev, [date]: { ...d, plan: [...d.plan, mealId] } };
    });
  };

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex items-center gap-2">
        <DollarSign size={16} className="text-zinc-500 shrink-0" />
        <input
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-600"
          placeholder="Your area (e.g. Parkersburg, WV) — for cost context"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>
      <p className="text-[11px] text-zinc-600 flex gap-1.5">
        <Info size={13} className="shrink-0 mt-0.5" />
        Grocery costs below are estimates from typical US grocery pricing, not a live lookup of your local stores — tap any price to override it with what you actually pay.
      </p>

      <GoalsPanel meals={meals} goals={goals} setGoals={setGoals} onAddToToday={addMealToToday} log={log} mealSlots={mealSlots} setMealSlots={setMealSlots} location={location} />

      <button
        onClick={() => setShowForm((s) => !s)}
        className="w-full flex items-center justify-center gap-2 bg-orange-600 text-zinc-950 font-semibold rounded-xl py-2.5 text-sm"
      >
        <Plus size={16} /> {showForm ? "Close" : "New meal prep item"}
      </button>

      {showForm && <MealForm onSave={(m) => { addMeal(m); setShowForm(false); }} />}

      <div className="space-y-3">
        {meals.length === 0 && (
          <EmptyState icon={UtensilsCrossed} title="No meals yet" body="Add your prep meals with ingredients to auto-estimate grocery cost." />
        )}
        {meals.map((m) => (
          <MealCard key={m.id} meal={m} onDelete={() => deleteMeal(m.id)} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GOALS + MEAL-COMBO SUGGESTIONS
// ---------------------------------------------------------------------------
function GoalsPanel({ meals, goals, setGoals, onAddToToday, log, mealSlots, setMealSlots, location }) {
  const [showTdee, setShowTdee] = useState(false);
  const [bio, setBio] = useState({ sex: "male", weightLb: "", heightIn: "", age: "", activity: "moderate", adjust: "0" });
  const [result, setResult] = useState(null);
  const [addedIds, setAddedIds] = useState([]);
  const [mode, setMode] = useState("daily"); // "daily" | "perMeal"

  const setGoal = (field, val) => setGoals((prev) => ({ ...prev, [field]: val }));

  const runTdee = () => {
    const { weightLb, heightIn, age, sex, activity, adjust } = bio;
    if (!weightLb || !heightIn || !age) return;
    const tdee = calcTDEE({ sex, weightLb: Number(weightLb), heightIn: Number(heightIn), age: Number(age), activity });
    const calories = tdee + Number(adjust || 0);
    setGoal("calories", String(calories));
    // simple default split if protein/carbs/fat are still blank: 1g protein/lb bodyweight, 25% cals from fat, rest carbs
    setGoals((prev) => {
      const protein = prev.protein || String(Math.round(Number(weightLb)));
      const fat = prev.fat || String(Math.round((calories * 0.25) / 9));
      const proteinCals = Number(protein) * 4;
      const fatCals = Number(fat) * 9;
      const carbs = prev.carbs || String(Math.max(0, Math.round((calories - proteinCals - fatCals) / 4)));
      return { ...prev, calories: String(calories), protein, fat, carbs };
    });
  };

  const target = {
    calories: Number(goals.calories) || 0,
    protein: Number(goals.protein) || 0,
    carbs: Number(goals.carbs) || 0,
    fat: Number(goals.fat) || 0,
  };
  const budget = Number(goals.budget) || 0;
  const hasTargets = target.calories > 0;

  const generate = (jitter = 0) => {
    const r = suggestCombo({ meals, target, budget: budget ? budget / 7 : Infinity, jitter, location });
    setResult(r);
    setAddedIds([]);
  };

  const totals = useMemo(() => {
    if (!result) return null;
    return result.chosen.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein: acc.protein + (m.protein || 0),
        carbs: acc.carbs + (m.carbs || 0),
        fat: acc.fat + (m.fat || 0),
        cost: acc.cost + mealCost(m, location),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0, cost: 0 }
    );
  }, [result, location]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Daily goals</div>
        {mode === "daily" && (
          <button onClick={() => setShowTdee((s) => !s)} className="text-xs text-orange-500 font-medium">
            {showTdee ? "Hide TDEE calculator" : "Calculate from TDEE"}
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setMode("daily")}
          className={`flex-1 rounded-lg py-1.5 text-xs font-medium border ${mode === "daily" ? "bg-orange-600 border-orange-600 text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          Daily total
        </button>
        <button
          onClick={() => setMode("perMeal")}
          className={`flex-1 rounded-lg py-1.5 text-xs font-medium border ${mode === "perMeal" ? "bg-orange-600 border-orange-600 text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          Per-meal targets
        </button>
      </div>

      {mode === "perMeal" && (
        <PerMealTargets mealSlots={mealSlots} setMealSlots={setMealSlots} dailyTarget={target} />
      )}

      {mode === "daily" && (
      <>
      {showTdee && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.sex} onChange={(e) => setBio((b) => ({ ...b, sex: e.target.value }))}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
            <select className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.activity} onChange={(e) => setBio((b) => ({ ...b, activity: e.target.value }))}>
              <option value="sedentary">Sedentary</option>
              <option value="light">Light activity</option>
              <option value="moderate">Moderate (training 3-5x/wk)</option>
              <option value="active">Very active</option>
              <option value="athlete">Athlete / physical job</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input type="number" placeholder="Weight (lb)" className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.weightLb} onChange={(e) => setBio((b) => ({ ...b, weightLb: e.target.value }))} />
            <input type="number" placeholder="Height (in)" className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.heightIn} onChange={(e) => setBio((b) => ({ ...b, heightIn: e.target.value }))} />
            <input type="number" placeholder="Age" className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.age} onChange={(e) => setBio((b) => ({ ...b, age: e.target.value }))} />
          </div>
          <div className="flex items-center gap-2">
            <input type="number" placeholder="+/- kcal (e.g. 300 for surplus)" className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={bio.adjust} onChange={(e) => setBio((b) => ({ ...b, adjust: e.target.value }))} />
            <button onClick={runTdee} className="bg-orange-600 text-zinc-950 font-semibold rounded px-3 py-1.5 text-sm">Fill goals</button>
          </div>
          <p className="text-[11px] text-zinc-600">Mifflin-St Jeor estimate. Protein/carb/fat split defaults to 1g/lb protein and 25% of calories from fat — edit the fields below to match your actual coach's numbers.</p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        <div>
          <label className="text-[10px] text-zinc-600">Calories</label>
          <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.calories} onChange={(e) => setGoal("calories", e.target.value)} />
        </div>
        <div>
          <label className={`text-[10px] font-medium ${MACRO_COLORS.protein.text}`}>Protein g</label>
          <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.protein} onChange={(e) => setGoal("protein", e.target.value)} />
        </div>
        <div>
          <label className={`text-[10px] font-medium ${MACRO_COLORS.carbs.text}`}>Carb g</label>
          <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.carbs} onChange={(e) => setGoal("carbs", e.target.value)} />
        </div>
        <div>
          <label className={`text-[10px] font-medium ${MACRO_COLORS.fat.text}`}>Fat g</label>
          <input type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.fat} onChange={(e) => setGoal("fat", e.target.value)} />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-zinc-600">Weekly grocery budget (optional — leave blank for no cap)</label>
        <input type="number" placeholder="e.g. 150" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.budget} onChange={(e) => setGoal("budget", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-zinc-600">Water target (oz/day, optional)</label>
          <input type="number" placeholder="e.g. 128" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.water || ""} onChange={(e) => setGoal("water", e.target.value)} />
        </div>
        <div>
          <label className="text-[10px] text-zinc-600">Step target (per day, optional)</label>
          <input type="number" placeholder="e.g. 8000" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={goals.steps || ""} onChange={(e) => setGoal("steps", e.target.value)} />
        </div>
      </div>

      <button
        onClick={() => generate(0)}
        disabled={!hasTargets || meals.length === 0}
        className="w-full bg-orange-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-950 font-semibold rounded-lg py-2 text-sm"
      >
        Suggest a meal combo
      </button>
      {meals.length === 0 && <p className="text-[11px] text-zinc-600 text-center">Add at least one meal below first.</p>}

      {result && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
          {result.chosen.length === 0 ? (
            <p className="text-sm text-zinc-500">No combo fits within that budget/target with your current meals — try adding cheaper or lower-calorie meals, or raising the budget.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                {result.chosen.map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-200">{m.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">{m.calories}kcal · ${mealCost(m, location).toFixed(2)}</span>
                      <button
                        onClick={() => { onAddToToday(m.id); setAddedIds((prev) => [...prev, `${i}`]); }}
                        className={`text-xs rounded-full px-2 py-1 font-medium ${addedIds.includes(`${i}`) ? "bg-teal-700 text-zinc-100" : "bg-zinc-800 text-orange-500"}`}
                      >
                        {addedIds.includes(`${i}`) ? <Check size={12} /> : "Add"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-zinc-800 pt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <span className="text-zinc-500">Calories</span><span className="text-right">{totals.calories} / {target.calories}</span>
                <span className="text-zinc-500">Protein</span><span className="text-right">{totals.protein}g / {target.protein}g</span>
                <span className="text-zinc-500">Carbs</span><span className="text-right">{totals.carbs}g / {target.carbs}g</span>
                <span className="text-zinc-500">Fat</span><span className="text-right">{totals.fat}g / {target.fat}g</span>
                <span className="text-zinc-500">Cost (this combo)</span>
                <span className={`text-right font-semibold ${budget && totals.cost > budget / 7 ? "text-red-500" : "text-teal-500"}`}>
                  ${totals.cost.toFixed(2)}{budget ? ` / $${(budget / 7).toFixed(2)} daily share` : ""}
                </span>
              </div>
              <button onClick={() => generate(0.4)} className="w-full flex items-center justify-center gap-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg py-1.5">
                <RotateCcw size={12} /> Try a different combo
              </button>
              <p className="text-[10px] text-zinc-600 flex gap-1"><Info size={11} className="shrink-0 mt-0.5" /> Heuristic best-fit from your saved meals, not a guaranteed exact match — nudge quantities or add more meal variety for a tighter fit.</p>
            </>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PER-MEAL TARGETS — an alternative to one daily macro total: break the day
// into named meals (Meal 1, Meal 2, ...), each with its own protein/carb/fat
// target and a time. The time field is the same data the Reminders tab
// reads/writes (mealSlots), so setting it here or there stays in sync and
// FORGE will notify at that time either way.
// ---------------------------------------------------------------------------
function PerMealTargets({ mealSlots, setMealSlots, dailyTarget }) {
  const addSlot = () => {
    setMealSlots((prev) => [
      ...prev,
      { id: uid(), label: `Meal ${prev.length + 1}`, time: "", protein: "", carbs: "", fat: "" },
    ]);
  };
  const removeSlot = (id) => setMealSlots((prev) => prev.filter((s) => s.id !== id));
  const updateSlot = (id, field, val) => setMealSlots((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: val } : s)));

  const slotCalories = (s) => Math.round((Number(s.protein) || 0) * 4 + (Number(s.carbs) || 0) * 4 + (Number(s.fat) || 0) * 9);

  const sums = mealSlots.reduce(
    (acc, s) => ({
      protein: acc.protein + (Number(s.protein) || 0),
      carbs: acc.carbs + (Number(s.carbs) || 0),
      fat: acc.fat + (Number(s.fat) || 0),
      calories: acc.calories + slotCalories(s),
    }),
    { protein: 0, carbs: 0, fat: 0, calories: 0 }
  );

  return (
    <div className="space-y-2.5">
      {mealSlots.length === 0 && (
        <EmptyState icon={ClipboardList} title="No meals set up yet" body='Add meals below (e.g. "Meal 1: 50g protein / 80g carb / 20g fat") and set a time for each.' />
      )}

      {mealSlots.map((s) => (
        <div key={s.id} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm font-medium"
              value={s.label}
              onChange={(e) => updateSlot(s.id, "label", e.target.value)}
            />
            <input
              type="time"
              value={s.time || ""}
              onChange={(e) => updateSlot(s.id, "time", e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm shrink-0"
            />
            <button onClick={() => removeSlot(s.id)} className="text-zinc-600 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className={`text-[10px] font-medium ${MACRO_COLORS.protein.text}`}>Protein g</label>
              <input type="number" className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={s.protein} onChange={(e) => updateSlot(s.id, "protein", e.target.value)} />
            </div>
            <div>
              <label className={`text-[10px] font-medium ${MACRO_COLORS.carbs.text}`}>Carb g</label>
              <input type="number" className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={s.carbs} onChange={(e) => updateSlot(s.id, "carbs", e.target.value)} />
            </div>
            <div>
              <label className={`text-[10px] font-medium ${MACRO_COLORS.fat.text}`}>Fat g</label>
              <input type="number" className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm" value={s.fat} onChange={(e) => updateSlot(s.id, "fat", e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] text-zinc-600">Kcal</label>
              <div className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-400">{slotCalories(s)}</div>
            </div>
          </div>
        </div>
      ))}

      <button onClick={addSlot} className="w-full flex items-center justify-center gap-1.5 bg-zinc-800 text-orange-500 font-medium rounded-lg py-2 text-sm">
        <Plus size={15} /> Add meal
      </button>

      {mealSlots.length > 0 && (
        <div className="border-t border-zinc-800 pt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span className="text-zinc-500">Total across meals</span><span className="text-right">{sums.calories} kcal</span>
          <span className="text-zinc-500">Protein / Carb / Fat</span>
          <span className="text-right">{sums.protein}g / {sums.carbs}g / {sums.fat}g</span>
          {dailyTarget.calories > 0 && (
            <>
              <span className="text-zinc-500">vs. Daily total goal</span>
              <span className={`text-right font-semibold ${Math.abs(sums.calories - dailyTarget.calories) > 100 ? "text-red-500" : "text-teal-500"}`}>
                {sums.calories} / {dailyTarget.calories} kcal
              </span>
            </>
          )}
        </div>
      )}
      <p className="text-[10px] text-zinc-600 flex gap-1"><Info size={11} className="shrink-0 mt-0.5" /> Set a time on any meal above and it'll show up in the Reminders tab too — same data, either place works.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI TAB — generates a fresh meal plan from macros/budget via the Claude API,
// no saved meal library required. Ingredient costs are still run through the
// local price table (not the model's own guess) so estimates stay consistent
// with the rest of the app.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// COOKBOOK — a recipe set covering breakfast/lunch/dinner/snack, built
// entirely from ingredients recognized by the local price table above.
// Macros are standard approximations for these common bodybuilding-style
// meals, not lab-tested values. `ingredients` quantities are PER SERVING,
// denominated in whatever unit estimatePrice() returns for that ingredient
// name (lb, dozen, 32oz tub, etc.) so cost math lines up directly with the
// rest of the app and scales correctly regardless of how many days a given
// recipe is used across the week.
// ---------------------------------------------------------------------------
const COOKBOOK = {
  breakfast: [
    { id: "b1", name: "Egg & Oat Bowl", perServing: { calories: 610, protein: 29, carbs: 83, fat: 20 },
      ingredients: [{ name: "eggs", qty: 0.25 }, { name: "oats", qty: 0.2 }, { name: "banana", qty: 0.357 }],
      instructions: [
        "Scramble eggs (3 per serving) in a nonstick pan over medium heat, ~4 min.",
        "Cook oats per package instructions (stovetop or microwave) — about 1 cup dry per serving.",
        "Slice banana over the oats once plated.",
        "For batch prep: scramble all eggs for the week at once, cool, and portion into containers with a base of dry oats to cook fresh each morning (oats reheat poorly, so prep dry oats + pre-cooked eggs separately).",
      ] },
    { id: "b2", name: "Greek Yogurt Protein Bowl", perServing: { calories: 450, protein: 35, carbs: 55, fat: 8 },
      ingredients: [{ name: "greek yogurt", qty: 0.357 }, { name: "oats", qty: 0.0714 }, { name: "berries", qty: 0.25 }],
      instructions: [
        "No cooking needed — this is a no-prep bowl.",
        "Portion 1.5 cups Greek yogurt into a container per serving.",
        "Top with a small handful of dry oats (or granola) and a handful of berries just before eating.",
        "For batch prep: portion yogurt into containers for the week and store berries/oats separately so they don't go soggy — combine fresh each morning.",
      ] },
    { id: "b3", name: "Protein Oat Pancakes", perServing: { calories: 520, protein: 40, carbs: 55, fat: 12 },
      ingredients: [{ name: "oats", qty: 0.2 }, { name: "eggs", qty: 0.167 }, { name: "whey protein powder", qty: 0.0171 }],
      instructions: [
        "Blend 1 cup oats, 2 eggs, and 1 scoop whey per serving into a smooth batter.",
        "Cook like regular pancakes on a lightly oiled nonstick pan, 2-3 min per side.",
        "For batch prep: multiply the batter by the number of servings needed, cook all pancakes at once, cool completely, then stack with parchment paper between and refrigerate or freeze. Reheat in a toaster or pan.",
      ] },
    { id: "b4", name: "Cottage Cheese Toast", perServing: { calories: 430, protein: 32, carbs: 35, fat: 16 },
      ingredients: [{ name: "cottage cheese", qty: 0.5 }, { name: "bread", qty: 0.1 }, { name: "peanut butter", qty: 0.0314 }],
      instructions: [
        "Toast 2 slices of bread per serving.",
        "Spread 1 tbsp peanut butter on the toast.",
        "Top with 1 cup cottage cheese on the side or spooned on top.",
        "No real batch-cooking needed — just portion cottage cheese into containers and toast bread fresh each morning.",
      ] },
    { id: "b5", name: "Honey Oat Protein Bowl", perServing: { calories: 580, protein: 34, carbs: 95, fat: 6 },
      ingredients: [{ name: "oats", qty: 0.2 }, { name: "whey protein powder", qty: 0.0171 }, { name: "honey", qty: 0.05 }, { name: "banana", qty: 0.357 }],
      instructions: [
        "Cook 1 cup dry oats per serving per package instructions.",
        "Stir in 1 scoop whey once oats have cooled slightly (adding it hot can clump the protein).",
        "Drizzle with 1 tbsp honey and top with sliced banana.",
        "For batch prep: cook a large batch of plain oats, portion into containers, and stir in whey/honey/banana fresh each morning.",
      ] },
    { id: "b6", name: "Egg White Veggie Scramble", perServing: { calories: 320, protein: 34, carbs: 18, fat: 10 },
      ingredients: [{ name: "egg whites", qty: 0.3 }, { name: "spinach", qty: 0.15 }, { name: "cheddar cheese", qty: 0.1 }, { name: "bread", qty: 0.1 }],
      instructions: [
        "Sauté a handful of spinach in a nonstick pan for 1 min until wilted.",
        "Pour in liquid egg whites (about 1 cup per serving) and scramble until just set.",
        "Sprinkle shredded cheddar on top and fold in.",
        "Serve with 2 slices of toast. For batch prep, this reheats fine — cook all servings' worth at once and portion into containers.",
      ] },
    { id: "b7", name: "Levrone Egg White Oat Bowl", inspiredBy: "Kevin Levrone's actual Meal 1 (10 egg whites, 2 whole eggs, oatmeal)", perServing: { calories: 460, protein: 53, carbs: 27, fat: 13 },
      ingredients: [{ name: "egg whites", qty: 0.625 }, { name: "eggs", qty: 0.167 }, { name: "oats", qty: 0.1 }],
      instructions: [
        "Scramble 10oz liquid egg whites with 2 whole eggs in a nonstick pan over medium heat until just set.",
        "Cook 1/2 cup dry oats per package instructions on the side.",
        "This is close to Levrone's actual documented breakfast during his competitive years — very high protein, moderate carb, low fat.",
        "For batch prep: scramble all the eggs for the week at once and portion, but cook oats fresh each morning since they reheat poorly.",
      ] },
    { id: "b8", name: "Shakshuka-Style Eggs", inspiredBy: "North African/Middle Eastern shakshuka", perServing: { calories: 380, protein: 24, carbs: 18, fat: 24 },
      ingredients: [{ name: "eggs", qty: 0.25 }, { name: "tomato", qty: 0.2 }, { name: "bell pepper", qty: 0.5 }, { name: "feta", qty: 0.1875 }],
      instructions: [
        "Sauté diced bell pepper in olive oil over medium heat for 4-5 min until softened.",
        "Add crushed tomatoes, simmer 8-10 min until slightly thickened; season with cumin, paprika, salt.",
        "Crack 3 eggs per serving directly into the sauce, cover, and cook 6-8 min until whites set but yolks stay soft.",
        "Crumble feta over the top just before serving.",
        "For batch prep: make the tomato-pepper sauce ahead in a large batch and refrigerate — poach fresh eggs into it each morning since eggs don't reheat well.",
      ] },
    { id: "b9", name: "Breakfast Burrito Bowl", inspiredBy: "Tex-Mex breakfast burrito, deconstructed", perServing: { calories: 520, protein: 34, carbs: 45, fat: 22 },
      ingredients: [{ name: "eggs", qty: 0.25 }, { name: "black beans", qty: 0.333 }, { name: "salsa", qty: 0.125 }, { name: "cheddar cheese", qty: 0.125 }],
      instructions: [
        "Scramble 3 eggs per serving in a nonstick pan over medium heat.",
        "Warm black beans in a small pot or microwave.",
        "Layer eggs and beans in a bowl, top with salsa and shredded cheddar.",
        "For batch prep: scramble all the eggs at once, warm a big batch of beans, portion into containers with cheese/salsa added fresh so it doesn't get soggy.",
      ] },
    { id: "b10", name: "Mediterranean Egg & Feta Wrap", inspiredBy: "Greek-style breakfast wrap", perServing: { calories: 440, protein: 28, carbs: 32, fat: 22 },
      ingredients: [{ name: "eggs", qty: 0.25 }, { name: "feta", qty: 0.125 }, { name: "spinach", qty: 0.15 }, { name: "pita", qty: 0.5 }],
      instructions: [
        "Scramble 3 eggs per serving with a handful of spinach until just wilted.",
        "Crumble feta into the eggs off heat so it stays creamy.",
        "Warm a pita and fold the egg mixture inside.",
        "For batch prep: scramble all the eggs/spinach together, store separately from the pita, and assemble fresh each morning.",
      ] },
  ],
  lunch: [
    { id: "l1", name: "Chicken Rice Bowl", inspiredBy: "Ronnie Coleman & Kai Greene's chicken-and-rice staple", perServing: { calories: 520, protein: 45, carbs: 50, fat: 12 },
      ingredients: [{ name: "chicken breast", qty: 0.375 }, { name: "rice", qty: 0.143 }, { name: "broccoli", qty: 0.357 }, { name: "olive oil", qty: 0.0214 }],
      instructions: [
        "Season chicken breast (6oz per serving) with salt, pepper, and paprika; bake at 400°F for 20-25 min or pan-sear ~6 min per side until cooked through.",
        "Cook rice per package instructions (rice cooker is easiest for batch amounts).",
        "Steam or roast broccoli (7-10 min) tossed in a little olive oil.",
        "For batch prep: cook all chicken breasts at once on a sheet pan, cook one large pot of rice, roast all broccoli on a second sheet pan, then portion evenly into containers.",
      ] },
    { id: "l2", name: "Ground Beef & Potato", perServing: { calories: 560, protein: 40, carbs: 45, fat: 20 },
      ingredients: [{ name: "ground beef", qty: 0.375 }, { name: "potato", qty: 0.5 }, { name: "spinach", qty: 0.286 }],
      instructions: [
        "Brown ground beef (6oz per serving) in a skillet over medium-high heat, breaking it up as it cooks, ~8 min. Season with salt, pepper, garlic powder.",
        "Dice and roast or boil potatoes (8oz per serving) until fork-tender, ~20-25 min roasted at 425°F.",
        "Wilt spinach in the same pan as the beef in the last minute of cooking.",
        "For batch prep: brown all the beef in one large batch, roast all potatoes on sheet pans, then portion into containers with spinach on top.",
      ] },
    { id: "l3", name: "Tilapia & Sweet Potato", perServing: { calories: 430, protein: 42, carbs: 35, fat: 10 },
      ingredients: [{ name: "tilapia", qty: 0.375 }, { name: "sweet potato", qty: 0.375 }, { name: "avocado", qty: 0.25 }],
      instructions: [
        "Season tilapia (6oz per serving) with lemon, salt, and pepper; bake at 400°F for 12-15 min until it flakes easily.",
        "Cube and roast sweet potato (6oz per serving) at 425°F for 20-25 min.",
        "Add a quarter avocado, sliced, right before eating (avocado doesn't hold up to batch prep — slice fresh).",
        "For batch prep: bake all tilapia and all sweet potato on sheet pans at the same time, portion into containers, and add fresh avocado each day.",
      ] },
    { id: "l4", name: "Salmon Power Bowl", inspiredBy: "Kevin Levrone's fish-and-rice repeat meals", perServing: { calories: 540, protein: 38, carbs: 45, fat: 20 },
      ingredients: [{ name: "salmon", qty: 0.313 }, { name: "rice", qty: 0.143 }, { name: "mixed vegetables", qty: 0.571 }],
      instructions: [
        "Season salmon (5oz per serving) with salt, pepper, and a squeeze of lemon; bake at 400°F for 12-15 min.",
        "Cook rice per package instructions.",
        "Steam mixed vegetables 5-7 min or roast alongside the salmon.",
        "For batch prep: bake all the salmon on one sheet pan, cook a large batch of rice, steam all the vegetables, then portion into containers.",
      ] },
    { id: "l5", name: "Steak Fajita Bowl", perServing: { calories: 560, protein: 40, carbs: 45, fat: 20 },
      ingredients: [{ name: "sirloin steak", qty: 0.375 }, { name: "rice", qty: 0.143 }, { name: "mixed vegetables", qty: 0.571 }, { name: "avocado", qty: 0.25 }],
      instructions: [
        "Slice sirloin steak (6oz per serving) thin and sear in a hot pan 2-3 min per side for medium; season with cumin, chili powder, salt.",
        "Sauté mixed vegetables (bell pepper/onion style mix works well) in the same pan after removing the steak.",
        "Cook rice per package instructions.",
        "For batch prep: sear all the steak in batches so the pan stays hot, sauté all vegetables together, cook one large pot of rice, portion into containers, and slice avocado fresh each day.",
      ] },
    { id: "l6", name: "Chicken Thigh Sweet Potato Bowl", perServing: { calories: 520, protein: 38, carbs: 40, fat: 18 },
      ingredients: [{ name: "chicken thigh", qty: 0.375 }, { name: "sweet potato", qty: 0.375 }, { name: "spinach", qty: 0.15 }],
      instructions: [
        "Season boneless chicken thighs (6oz per serving) with salt, pepper, garlic; bake at 400°F for 25-30 min or pan-sear until internal temp hits 165°F.",
        "Cube and roast sweet potato at 425°F for 20-25 min.",
        "Wilt spinach in a hot pan for 1 min, or add raw to the container to wilt when reheated.",
        "For batch prep: bake all chicken thighs and all sweet potato together on sheet pans, then portion into containers with spinach.",
      ] },
    { id: "l7", name: "Wheeler Chicken & Salad", inspiredBy: "Flex Wheeler's contest-prep chicken-and-green-salad meals", perServing: { calories: 430, protein: 55, carbs: 8, fat: 18 },
      ingredients: [{ name: "chicken breast", qty: 0.5 }, { name: "spinach", qty: 0.2 }, { name: "olive oil", qty: 0.03 }],
      instructions: [
        "Season and grill or pan-sear chicken breast (8oz per serving) until cooked through, ~7-8 min per side.",
        "Serve over a bed of spinach or mixed greens, dressed lightly with olive oil, salt, pepper, and a squeeze of lemon.",
        "This mirrors Wheeler's low-carb, high-protein contest-prep meals almost exactly — good option when carbs need to come down for a cut.",
        "For batch prep: grill all the chicken at once and slice, keep the greens separate and add fresh each day so they don't wilt.",
      ] },
    { id: "l8", name: "Mediterranean Chicken Bowl", inspiredBy: "Greek grain bowl", perServing: { calories: 520, protein: 42, carbs: 42, fat: 18 },
      ingredients: [{ name: "chicken breast", qty: 0.375 }, { name: "quinoa", qty: 0.143 }, { name: "cucumber", qty: 0.5 }, { name: "feta", qty: 0.125 }, { name: "olive oil", qty: 0.0214 }],
      instructions: [
        "Season chicken breast (6oz per serving) with oregano, lemon, salt, pepper; grill or pan-sear ~7 min per side.",
        "Cook quinoa per package instructions.",
        "Dice cucumber and toss with the quinoa, a drizzle of olive oil, and crumbled feta.",
        "Slice the chicken over the top.",
        "For batch prep: cook all the chicken and quinoa in large batches, portion into containers, and add fresh cucumber each day.",
      ] },
    { id: "l9", name: "Chicken Tikka Bowl", inspiredBy: "Indian chicken tikka masala, bowl-style", perServing: { calories: 560, protein: 44, carbs: 48, fat: 20 },
      ingredients: [{ name: "chicken breast", qty: 0.375 }, { name: "rice", qty: 0.143 }, { name: "coconut milk", qty: 0.286 }, { name: "curry paste", qty: 0.125 }, { name: "spinach", qty: 0.15 }],
      instructions: [
        "Sear diced chicken breast (6oz per serving) in a hot pan 5-6 min until browned.",
        "Add curry paste, cook 1 min until fragrant, stir in coconut milk, simmer 8-10 min until sauce thickens.",
        "Stir in spinach in the last minute to wilt. Serve over rice.",
        "For batch prep: cook the whole sauce and chicken in one large pot, cook rice separately in bulk, then portion.",
      ] },
    { id: "l10", name: "Turkey Taco Bowl", inspiredBy: "Tex-Mex taco bowl", perServing: { calories: 540, protein: 38, carbs: 48, fat: 18 },
      ingredients: [{ name: "ground turkey", qty: 0.375 }, { name: "black beans", qty: 0.333 }, { name: "rice", qty: 0.107 }, { name: "salsa", qty: 0.125 }, { name: "avocado", qty: 0.25 }],
      instructions: [
        "Brown ground turkey (6oz per serving) in a skillet with taco seasoning, ~7-8 min.",
        "Warm black beans and cook rice per package instructions.",
        "Layer rice, beans, turkey, and salsa in a bowl. Add fresh avocado just before eating.",
        "For batch prep: brown all the turkey at once, cook rice in bulk, warm all the beans, portion into containers, slice avocado fresh each day.",
      ] },
    { id: "l11", name: "Tofu Stir Fry Bowl", inspiredBy: "Asian-style vegetarian stir fry", perServing: { calories: 460, protein: 26, carbs: 50, fat: 16 },
      ingredients: [{ name: "tofu", qty: 0.5 }, { name: "mixed vegetables", qty: 0.571 }, { name: "rice", qty: 0.143 }, { name: "soy sauce", qty: 0.0625 }, { name: "sesame oil", qty: 0.0125 }],
      instructions: [
        "Press and cube firm tofu (half a block per serving); pan-fry until golden on most sides, ~8 min.",
        "Add mixed vegetables to the same pan, stir-fry 4-5 min until tender-crisp.",
        "Toss with soy sauce and a drizzle of sesame oil off heat. Serve over rice.",
        "For batch prep: fry all the tofu and vegetables together in large batches, cook rice in bulk, then portion.",
      ] },
    { id: "l12", name: "Greek Chicken Pita", inspiredBy: "Greek souvlaki wrap", perServing: { calories: 500, protein: 40, carbs: 40, fat: 18 },
      ingredients: [{ name: "chicken breast", qty: 0.375 }, { name: "pita", qty: 0.5 }, { name: "tzatziki", qty: 0.25 }, { name: "cucumber", qty: 0.5 }, { name: "feta", qty: 0.0625 }],
      instructions: [
        "Season and grill chicken breast (6oz per serving) with oregano and lemon, ~7 min per side; slice.",
        "Warm the pita, spread tzatziki inside, add sliced chicken, cucumber, and a little crumbled feta.",
        "For batch prep: grill all the chicken and slice ahead, keep pita/tzatziki/cucumber separate and assemble fresh each day.",
      ] },
    { id: "l13", name: "Shrimp Fried Rice", inspiredBy: "Asian-style fried rice", perServing: { calories: 460, protein: 32, carbs: 50, fat: 12 },
      ingredients: [{ name: "shrimp", qty: 0.375 }, { name: "rice", qty: 0.143 }, { name: "mixed vegetables", qty: 0.429 }, { name: "eggs", qty: 0.083 }, { name: "soy sauce", qty: 0.0625 }],
      instructions: [
        "Cook rice ahead of time and let it cool — 1 cup dry per serving (day-old rice fries better).",
        "Scramble a little egg in a hot wok/pan, push to the side; add shrimp (6oz per serving), cook 2-3 min per side, then add mixed vegetables 3-4 min.",
        "Add the rice and soy sauce, tossing over high heat 3-4 min.",
        "For batch prep: cook rice a day ahead, then fry everything together in big batches, portioning into containers.",
      ] },
  ],
  dinner: [
    { id: "d1", name: "Steak & Potato", inspiredBy: "Ronnie Coleman & Kevin Levrone's steak meals", perServing: { calories: 600, protein: 42, carbs: 50, fat: 22 },
      ingredients: [{ name: "sirloin steak", qty: 0.375 }, { name: "potato", qty: 0.5 }, { name: "broccoli", qty: 0.357 }],
      instructions: [
        "Season sirloin steak (6oz per serving) generously with salt and pepper; sear in a hot cast-iron pan 3-4 min per side for medium.",
        "Roast diced potatoes at 425°F for 20-25 min, tossed in a little oil and salt.",
        "Steam or roast broccoli 7-10 min.",
        "For batch prep: sear all steaks (working in batches so the pan stays hot), roast all potatoes and broccoli on sheet pans, then portion into containers.",
      ] },
    { id: "d2", name: "Chicken Pasta", perServing: { calories: 560, protein: 45, carbs: 55, fat: 14 },
      ingredients: [{ name: "chicken breast", qty: 0.375 }, { name: "pasta", qty: 0.125 }, { name: "spinach", qty: 0.286 }, { name: "olive oil", qty: 0.0214 }],
      instructions: [
        "Boil pasta (2oz dry per serving) per package instructions.",
        "Season and pan-sear diced chicken breast (6oz per serving) until cooked through, ~8 min.",
        "Toss pasta with a little olive oil, the cooked chicken, and wilted spinach.",
        "For batch prep: boil all the pasta at once, cook all the chicken in one large batch, wilt all the spinach in the pasta water residual heat, then toss everything together and portion into containers.",
      ] },
    { id: "d3", name: "Ground Beef Stir Fry", perServing: { calories: 580, protein: 40, carbs: 50, fat: 22 },
      ingredients: [{ name: "ground beef", qty: 0.375 }, { name: "mixed vegetables", qty: 0.571 }, { name: "rice", qty: 0.143 }],
      instructions: [
        "Brown ground beef (6oz per serving) in a wok or large skillet over high heat, ~7-8 min. Season with soy sauce, garlic, ginger to taste.",
        "Add mixed vegetables to the same pan and stir-fry 4-5 min until tender-crisp.",
        "Cook rice per package instructions.",
        "For batch prep: brown all the beef in batches, stir-fry all the vegetables together, cook one large pot of rice, then portion into containers.",
      ] },
    { id: "d4", name: "Baked Tilapia & Rice", perServing: { calories: 430, protein: 42, carbs: 45, fat: 6 },
      ingredients: [{ name: "tilapia", qty: 0.375 }, { name: "rice", qty: 0.143 }, { name: "broccoli", qty: 0.357 }],
      instructions: [
        "Season tilapia (6oz per serving) with lemon, salt, pepper; bake at 400°F for 12-15 min.",
        "Cook rice per package instructions.",
        "Steam or roast broccoli 7-10 min.",
        "For batch prep: bake all the tilapia on one sheet pan, cook a large pot of rice, steam all the broccoli, then portion into containers.",
      ] },
    { id: "d5", name: "Beef & Sweet Potato Skillet", perServing: { calories: 570, protein: 38, carbs: 42, fat: 22 },
      ingredients: [{ name: "ground beef", qty: 0.375 }, { name: "sweet potato", qty: 0.375 }, { name: "spinach", qty: 0.15 }],
      instructions: [
        "Dice and pre-cook sweet potato (microwave 5 min or par-boil) so it finishes fast in the skillet.",
        "Brown ground beef (6oz per serving) in a large skillet, ~7 min.",
        "Add the sweet potato to the skillet and cook another 5 min until slightly crisp on the edges; stir in spinach to wilt at the end.",
        "For batch prep: cook everything in one large batch in a big skillet or on sheet pans, then portion into containers.",
      ] },
    { id: "d6", name: "Salmon & Sweet Potato", inspiredBy: "Kai Greene's fish-and-sweet-potato meals", perServing: { calories: 520, protein: 36, carbs: 38, fat: 18 },
      ingredients: [{ name: "salmon", qty: 0.313 }, { name: "sweet potato", qty: 0.375 }, { name: "broccoli", qty: 0.357 }],
      instructions: [
        "Season salmon (5oz per serving) with salt, pepper, lemon; bake at 400°F for 12-15 min.",
        "Cube and roast sweet potato at 425°F for 20-25 min.",
        "Steam or roast broccoli 7-10 min.",
        "For batch prep: roast the salmon, sweet potato, and broccoli together on sheet pans (salmon needs less time — add it partway through), then portion into containers.",
      ] },
    { id: "d7", name: "Sirloin & Sweet Potato", inspiredBy: "Kai Greene's steak-and-carb meals", perServing: { calories: 580, protein: 42, carbs: 45, fat: 20 },
      ingredients: [{ name: "sirloin steak", qty: 0.375 }, { name: "sweet potato", qty: 0.375 }, { name: "broccoli", qty: 0.357 }],
      instructions: [
        "Season sirloin steak (6oz per serving) with salt and pepper; sear in a hot pan 3-4 min per side for medium.",
        "Cube and roast sweet potato at 425°F for 20-25 min.",
        "Steam or roast broccoli 7-10 min.",
        "For batch prep: sear all the steaks in batches so the pan stays hot, roast the sweet potato and broccoli together on sheet pans, then portion into containers.",
      ] },
  ],
  snack: [
    { id: "s1", name: "Protein Shake", perServing: { calories: 250, protein: 30, carbs: 15, fat: 6 },
      ingredients: [{ name: "whey protein powder", qty: 0.0171 }, { name: "fairlife milk", qty: 0.143 }],
      instructions: ["Blend or shake 1 scoop whey with 8-12oz Fairlife milk. No prep needed — mix fresh each time."] },
    { id: "s2", name: "Apple & Peanut Butter", perServing: { calories: 270, protein: 7, carbs: 30, fat: 16 },
      ingredients: [{ name: "apple", qty: 0.329 }, { name: "peanut butter", qty: 0.0629 }],
      instructions: ["Slice one apple and serve with 2 tbsp peanut butter. No prep — assemble fresh."] },
    { id: "s3", name: "Almonds & Cheese", perServing: { calories: 260, protein: 12, carbs: 8, fat: 20 },
      ingredients: [{ name: "almonds", qty: 0.0629 }, { name: "cheddar cheese", qty: 0.125 }],
      instructions: ["Portion 1oz almonds and 1oz cheddar cheese into small containers or bags for the week — this one just needs pre-portioning, no cooking."] },
    { id: "s4", name: "Cottage Cheese & Berries", perServing: { calories: 260, protein: 22, carbs: 28, fat: 4 },
      ingredients: [{ name: "cottage cheese", qty: 0.5 }, { name: "berries", qty: 0.25 }, { name: "honey", qty: 0.04 }],
      instructions: ["Portion cottage cheese into containers, top with berries and a drizzle of honey fresh each time (berries go soft if pre-mixed)."] },
  ],
};

// Recompute every recipe's perServing macros from its own ingredient list at
// load time, instead of trusting the hand-typed literals above. Mirrors the
// "derive, don't duplicate" pattern already used for pricing (mealCost/
// estimatePrice compute at read time rather than storing a static number
// that can drift). An audit found 32/34 recipes' stated perServing values
// disagreed with mealMacros(ingredients) by more than 12% — some by 2x or
// more — meaning the numbers you've been tracking against for these recipes
// were frequently wrong. This line is the actual fix: perServing is now
// always in sync with the ingredient list, so editing a recipe's ingredients
// later can never leave a stale macro number behind.
for (const category of Object.keys(COOKBOOK)) {
  COOKBOOK[category] = COOKBOOK[category].map((r) => ({ ...r, perServing: mealMacros(r.ingredients) }));
}

function combosOfSnacks(snacks) {
  // returns every subset of size 0, 1, or 2 — realistic snack counts for a day
  const out = [[]];
  for (let i = 0; i < snacks.length; i++) out.push([snacks[i]]);
  for (let i = 0; i < snacks.length; i++)
    for (let j = i + 1; j < snacks.length; j++) out.push([snacks[i], snacks[j]]);
  return out;
}

// Returns a scaled copy of a recipe — macros and ingredient quantities all
// multiplied by `factor` (e.g. 1.5x a serving of Chicken Rice Bowl). Without
// this, matching is stuck picking whichever of the ~25 fixed-serving recipes
// happens to be closest, which can be a bad fit and looks like it's ignoring
// your macros entirely. Scaling lets a recipe portion itself up or down to
// actually hit a target. `baseId` is preserved so "pick a genuinely
// different recipe for variety" logic isn't fooled by two different
// portion sizes of the same dish.
function scaleRecipe(base, factor) {
  if (factor === 1) return { ...base, baseId: base.id, scaleFactor: 1 };
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    ...base,
    id: `${base.id}@${factor}`,
    baseId: base.id,
    scaleFactor: factor,
    name: `${base.name} (${round1(factor)}× serving)`,
    perServing: {
      calories: Math.round(base.perServing.calories * factor),
      protein: Math.round(base.perServing.protein * factor),
      carbs: Math.round(base.perServing.carbs * factor),
      fat: Math.round(base.perServing.fat * factor),
    },
    ingredients: base.ingredients.map((i) => ({ ...i, qty: i.qty * factor })),
  };
}

// Builds a consolidated grocery list from a set of (recipe, servingsNeeded)
// pairs — servingsNeeded being how many days that recipe is used across the
// week. Ingredient quantities are per-serving, so this scales correctly
// whether a recipe is used 7 days or just 2-3.
function weeklyGroceryList(recipeCounts, location = "") {
  const map = new Map();
  for (const { recipe, count } of recipeCounts) {
    for (const ing of recipe.ingredients) {
      const key = ing.name.toLowerCase();
      map.set(key, (map.get(key) || 0) + ing.qty * count);
    }
  }
  return Array.from(map.entries()).map(([name, qtyNeeded]) => {
    const purchase = estimatePurchase(name, qtyNeeded, location);
    return {
      name,
      qty: qtyNeeded,
      unit: purchase.unit,
      unitPrice: purchase.price,
      cost: purchase.cost,
      guessed: !!purchase.guessed,
      packagesToBuy: purchase.packagesToBuy,
      packageLabel: purchase.packageLabel,
      totalQtyBought: purchase.totalQtyBought,
    };
  });
}

// Selection-time cost estimate used inside scoreCombo/scoreRecipeForSlot —
// deliberately NOT package-rounded (stays a smooth qty × unit-price value)
// since it's comparing thousands of candidate recipes against each other
// during generation, not representing an actual shopping trip. The real,
// rounded-to-what-you'd-buy total shows up in weeklyGroceryList() once a
// week's recipes are locked in.
function recipeCost(recipe, location = "") {
  return (recipe.ingredients || []).reduce((s, i) => s + i.qty * estimatePrice(i.name, location).price, 0);
}

function scoreCombo(recipes, target, dailyBudget = null, location = "") {
  const totals = recipes.reduce(
    (acc, r) => ({
      calories: acc.calories + r.perServing.calories,
      protein: acc.protein + r.perServing.protein,
      carbs: acc.carbs + r.perServing.carbs,
      fat: acc.fat + r.perServing.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const cost = recipes.reduce((s, r) => s + recipeCost(r, location), 0);
  const err = (a, b) => (b > 0 ? Math.abs(a - b) / b : 0);
  let score =
    err(totals.calories, target.calories) * 2 +
    err(totals.protein, target.protein) +
    err(totals.carbs, target.carbs) +
    err(totals.fat, target.fat);
  // Budget is a real selection criterion, not just an after-the-fact report:
  // combos that blow past the daily budget share get penalized heavily so
  // affordable-but-slightly-worse-macro-fit combos rank above them.
  if (dailyBudget != null && dailyBudget > 0 && cost > dailyBudget) {
    score += ((cost - dailyBudget) / dailyBudget) * 3;
  }
  return { totals, score, cost };
}

// Brute-forces every breakfast x lunch x dinner x snack-subset combination
// for ONE day (≈1000+ combos with 6 recipes per slot — trivial client-side),
// scores each against the daily macro target AND (if a budget was set) the
// daily budget share. Used as the building block for the two-variant weekly
// layout below.
const DAILY_SCALE_OPTIONS = [0.75, 1, 1.25];

function rankDailyCombos({ target, weeklyBudget, location = "" }) {
  const dailyBudget = weeklyBudget > 0 ? weeklyBudget / 7 : null;
  const results = [];
  const breakfasts = COOKBOOK.breakfast.flatMap((r) => DAILY_SCALE_OPTIONS.map((f) => scaleRecipe(r, f)));
  const lunches = COOKBOOK.lunch.flatMap((r) => DAILY_SCALE_OPTIONS.map((f) => scaleRecipe(r, f)));
  const dinners = COOKBOOK.dinner.flatMap((r) => DAILY_SCALE_OPTIONS.map((f) => scaleRecipe(r, f)));
  for (const b of breakfasts) {
    for (const l of lunches) {
      for (const d of dinners) {
        for (const snackSet of combosOfSnacks(COOKBOOK.snack)) {
          const recipes = [b, l, d, ...snackSet];
          const { totals, score, cost } = scoreCombo(recipes, target, dailyBudget, location);
          results.push({ recipes, totals, score, cost });
        }
      }
    }
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

// ---------------------------------------------------------------------------
// Real weekly meal-prep layout: rather than pretending you'll cook 7 unique
// days of meals (unrealistic for batch prep), this picks TWO daily combos —
// "Combo A" (best overall fit) and "Combo B" (next-best combo that's
// actually different, for variety) — and assigns A to 4 days, B to 3 days.
// That's a realistic batch-cooking pattern: two rounds of prep per week per
// meal slot, some day-to-day variety, and a grocery list scaled to exactly
// how many of each you're actually making.
// ---------------------------------------------------------------------------
const WEEK_DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const COMBO_A_DAYS = [0, 2, 4, 6]; // Mon, Wed, Fri, Sun — 4 days
const COMBO_B_DAYS = [1, 3, 5]; // Tue, Thu, Sat — 3 days

function generateCookbookWeek({ target, weeklyBudget, location = "" }) {
  const ranked = rankDailyCombos({ target, weeklyBudget, location });
  if (!ranked.length) return null;
  const comboA = ranked[0];
  const comboBraw = ranked.find((r) => {
    const idsA = new Set(comboA.recipes.map((x) => x.baseId || x.id));
    return (
      r.recipes.some((x) => !idsA.has(x.baseId || x.id)) &&
      (r.recipes[0].baseId || r.recipes[0].id) !== (comboA.recipes[0].baseId || comboA.recipes[0].id)
    );
  }) || ranked[Math.min(1, ranked.length - 1)];
  const comboB = comboBraw;

  const recipeCounts = [
    ...comboA.recipes.map((r) => ({ recipe: r, count: COMBO_A_DAYS.length })),
    ...comboB.recipes.map((r) => ({ recipe: r, count: COMBO_B_DAYS.length })),
  ];
  const groceries = weeklyGroceryList(recipeCounts, location);
  const weeklyCost = groceries.reduce((s, g) => s + g.cost, 0);
  const avgDaily = {
    calories: (comboA.totals.calories * COMBO_A_DAYS.length + comboB.totals.calories * COMBO_B_DAYS.length) / 7,
    protein: (comboA.totals.protein * COMBO_A_DAYS.length + comboB.totals.protein * COMBO_B_DAYS.length) / 7,
    carbs: (comboA.totals.carbs * COMBO_A_DAYS.length + comboB.totals.carbs * COMBO_B_DAYS.length) / 7,
    fat: (comboA.totals.fat * COMBO_A_DAYS.length + comboB.totals.fat * COMBO_B_DAYS.length) / 7,
  };
  // Dedupe recipes that appear in both combos so instructions aren't repeated
  const allRecipesMap = new Map();
  [...comboA.recipes, ...comboB.recipes].forEach((r) => allRecipesMap.set(r.id, r));

  return { comboA, comboB, groceries, weeklyCost, avgDaily, allRecipes: Array.from(allRecipesMap.values()) };
}

// ---------------------------------------------------------------------------
// Per-meal-slot weekly layout: used instead of generateCookbookWeek() when
// the user has set up Per-meal targets in Prep → Daily goals (mealSlots).
// Rather than brute-forcing a whole day's combo against a single daily
// total (which can hit the total while individual meals are way off target),
// this matches EACH meal slot's own protein/carb/fat target to the single
// best-fitting recipe in the whole library (any category), independently.
// That's what actually keeps Prep's per-meal macros and the Cookbook in
// sync: the number of meals generated matches the number of slots you set
// up, and each one is picked for that slot's specific macros.
// ---------------------------------------------------------------------------
function scoreRecipeForSlot(recipe, slot, mealBudget = null, location = "") {
  const p = recipe.perServing;
  const err = (a, b) => (b > 0 ? Math.abs(a - b) / b : 0);
  // Protein weighted heaviest — it's usually the tightest constraint for a
  // bodybuilder's per-meal target — with calories as a lighter tiebreaker.
  let score =
    err(p.protein, slot.protein) * 2 +
    err(p.carbs, slot.carbs) +
    err(p.fat, slot.fat) +
    err(p.calories, slot.calories) * 0.25;
  if (mealBudget != null && mealBudget > 0) {
    const cost = recipeCost(recipe, location);
    if (cost > mealBudget) score += ((cost - mealBudget) / mealBudget) * 2;
  }
  return score;
}

const SLOT_SCALE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function generateCookbookWeekFromMealSlots({ mealSlots, weeklyBudget, location = "" }) {
  const baseRecipes = [
    ...COOKBOOK.breakfast,
    ...COOKBOOK.lunch,
    ...COOKBOOK.dinner,
    ...COOKBOOK.snack,
  ];
  // Every recipe at every portion size — this is what lets a slot match a
  // recipe scaled to fit (e.g. 1.5x Chicken Rice Bowl), rather than only
  // choosing from the 25 fixed single-serving amounts.
  const allVariants = baseRecipes.flatMap((r) => SLOT_SCALE_OPTIONS.map((f) => scaleRecipe(r, f)));

  const slots = mealSlots
    .map((s) => {
      const protein = Number(s.protein) || 0;
      const carbs = Number(s.carbs) || 0;
      const fat = Number(s.fat) || 0;
      return {
        id: s.id,
        label: s.label || "Meal",
        protein,
        carbs,
        fat,
        calories: protein * 4 + carbs * 4 + fat * 9,
      };
    })
    .filter((s) => s.protein > 0 || s.carbs > 0 || s.fat > 0);

  if (!slots.length) return null;

  // Rough per-meal budget share: split the weekly budget across 7 days,
  // then across however many meal slots are set up. Heuristic, not exact —
  // matches the same best-effort spirit as the rest of the cost estimation.
  const mealBudget = weeklyBudget > 0 ? weeklyBudget / 7 / slots.length : null;

  const comboARecipes = [];
  const comboBRecipes = [];
  const slotLabels = [];
  // Track which base recipes have already been assigned to a slot in each
  // combo — without this, two different meal slots (e.g. "Meal 1" and
  // "Meal 4") can independently pick the same closest-fitting recipe if
  // their macro targets are similar, which is exactly the "same meal twice"
  // bug. Only fall back to reusing a recipe once every option is exhausted
  // (unavoidable with a small library and many slots).
  const usedInA = new Set();
  const usedInB = new Set();
  const pickUnused = (ranked, used) => ranked.find((r) => !used.has(r.baseId || r.id)) || ranked[0];

  slots.forEach((slot) => {
    const ranked = [...allVariants].sort(
      (a, b) => scoreRecipeForSlot(a, slot, mealBudget, location) - scoreRecipeForSlot(b, slot, mealBudget, location)
    );

    const bestA = pickUnused(ranked, usedInA);
    usedInA.add(bestA.baseId || bestA.id);
    comboARecipes.push(bestA);

    // Combo B should be a genuinely different dish from what THIS slot got
    // in Combo A, and from anything already used elsewhere in Combo B —
    // compare baseId, not the scaled id, so different portion sizes of the
    // same dish still count as the same recipe for dedup purposes.
    const rankedForB = ranked.filter((r) => (r.baseId || r.id) !== (bestA.baseId || bestA.id));
    const bestB = pickUnused(rankedForB.length ? rankedForB : ranked, usedInB);
    usedInB.add(bestB.baseId || bestB.id);
    comboBRecipes.push(bestB);

    slotLabels.push(slot.label);
  });

  const sumTotals = (recipes) =>
    recipes.reduce(
      (acc, r) => ({
        calories: acc.calories + r.perServing.calories,
        protein: acc.protein + r.perServing.protein,
        carbs: acc.carbs + r.perServing.carbs,
        fat: acc.fat + r.perServing.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

  const comboA = { recipes: comboARecipes, totals: sumTotals(comboARecipes), score: 0 };
  const comboB = { recipes: comboBRecipes, totals: sumTotals(comboBRecipes), score: 0 };

  const recipeCounts = [
    ...comboA.recipes.map((r) => ({ recipe: r, count: COMBO_A_DAYS.length })),
    ...comboB.recipes.map((r) => ({ recipe: r, count: COMBO_B_DAYS.length })),
  ];
  const groceries = weeklyGroceryList(recipeCounts, location);
  const weeklyCost = groceries.reduce((s, g) => s + g.cost, 0);
  const avgDaily = {
    calories: (comboA.totals.calories * COMBO_A_DAYS.length + comboB.totals.calories * COMBO_B_DAYS.length) / 7,
    protein: (comboA.totals.protein * COMBO_A_DAYS.length + comboB.totals.protein * COMBO_B_DAYS.length) / 7,
    carbs: (comboA.totals.carbs * COMBO_A_DAYS.length + comboB.totals.carbs * COMBO_B_DAYS.length) / 7,
    fat: (comboA.totals.fat * COMBO_A_DAYS.length + comboB.totals.fat * COMBO_B_DAYS.length) / 7,
  };
  const allRecipesMap = new Map();
  [...comboA.recipes, ...comboB.recipes].forEach((r) => allRecipesMap.set(r.id, r));

  return {
    comboA,
    comboB,
    groceries,
    weeklyCost,
    avgDaily,
    allRecipes: Array.from(allRecipesMap.values()),
    slotLabels,
    slotTargets: slots,
    perMealMode: true,
  };
}

// ---------------------------------------------------------------------------
// BATCH PREP PLANNER — "chicken and rice for 3 days" workflow: pick a
// Cookbook recipe, say how many days you want it to last, and get the
// recipe scaled ×days, a grocery list for that batch, and a food-safety
// verdict comparing the day count against how long that dish actually stays
// good (cook once → freeze the overflow if you've asked for more days than
// it can safely hold in the fridge).
// ---------------------------------------------------------------------------
function BatchPrepPlanner({ location }) {
  const allRecipes = useMemo(
    () => [
      ...COOKBOOK.breakfast.map((r) => ({ ...r, slot: "Breakfast" })),
      ...COOKBOOK.lunch.map((r) => ({ ...r, slot: "Lunch" })),
      ...COOKBOOK.dinner.map((r) => ({ ...r, slot: "Dinner" })),
      ...COOKBOOK.snack.map((r) => ({ ...r, slot: "Snack" })),
    ],
    []
  );
  const [recipeId, setRecipeId] = useState(allRecipes[0]?.id || "");
  const [days, setDays] = useState(3);
  const [open, setOpen] = useState(true);

  const recipe = allRecipes.find((r) => r.id === recipeId) || allRecipes[0];
  if (!recipe) return null;

  const shelf = cookedShelfLife(recipe.ingredients.map((i) => i.name));
  const fitsFridge = days <= shelf.fridgeDays;
  const scaled = recipe.ingredients.map((i) => {
    const qty = i.qty * days;
    const purchase = estimatePurchase(i.name, qty, location);
    return { name: i.name, qty, unit: purchase.unit, cost: purchase.cost, packagesToBuy: purchase.packagesToBuy, packageLabel: purchase.packageLabel };
  });
  const totalCost = scaled.reduce((s, i) => s + i.cost, 0);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UtensilsCrossed size={16} className="text-orange-500" /> Batch prep planner
      </div>
      <p className="text-xs text-zinc-500">Pick a recipe and how many days you want it to last — e.g. "chicken and rice for 3 days" scales the recipe ×3 and tells you whether that's still fridge-safe or you should freeze part of it.</p>

      <select
        value={recipe.id}
        onChange={(e) => { setRecipeId(e.target.value); setOpen(true); }}
        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm"
      >
        {["Breakfast", "Lunch", "Dinner", "Snack"].map((slot) => (
          <optgroup key={slot} label={slot}>
            {allRecipes.filter((r) => r.slot === slot).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
        ))}
      </select>

      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-500 shrink-0">Prep for</span>
        <input
          type="range" min="1" max="7" step="1"
          value={days}
          onChange={(e) => { setDays(Number(e.target.value)); setOpen(true); }}
          className="flex-1 accent-orange-600"
        />
        <span className="text-sm font-semibold text-orange-500 w-16 text-right shrink-0">{days} day{days === 1 ? "" : "s"}</span>
      </div>

      <div className={`rounded-lg p-2.5 flex items-start gap-2 text-xs ${fitsFridge ? "bg-teal-950/40 border border-teal-900/50" : "bg-red-950/40 border border-red-900/50"}`}>
        <Clock size={14} className={`shrink-0 mt-0.5 ${fitsFridge ? "text-teal-500" : "text-red-500"}`} />
        <div>
          {fitsFridge ? (
            <span className="text-teal-400">Cook it once — this dish holds {shelf.fridgeDays} days in the fridge, so {days} day{days === 1 ? "" : "s"} worth is fine straight in the fridge.</span>
          ) : (
            <span className="text-red-400">This dish only holds ~{shelf.fridgeDays} days in the fridge, but you asked for {days}. Refrigerate the first {shelf.fridgeDays} day{shelf.fridgeDays === 1 ? "" : "s"}' worth and freeze the rest (freezer: {shelf.freezer}) — thaw as you go.</span>
          )}
          <div className="text-zinc-500 mt-1">{shelf.note}</div>
        </div>
      </div>

      {open && (
        <div className="space-y-2 pt-1 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Recipe ×{days} — exact amounts</div>
          <div className="space-y-1">
            {scaled.map((ing, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-zinc-300 capitalize">{ing.name}</span>
                <div className="text-right">
                  <div className="text-zinc-500">${ing.cost.toFixed(2)}</div>
                  <div className="text-zinc-600 text-[10px]">
                    need {ing.qty.toFixed(2)} {ing.unit} · buy {ing.packagesToBuy} {ing.packageLabel}{ing.packagesToBuy === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-sm font-semibold pt-1.5 border-t border-zinc-800">
            <span>Batch cost</span><span className="text-teal-500">${totalCost.toFixed(2)}</span>
          </div>
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide pt-1">Cook it</div>
          <div className="space-y-1">
            {recipe.instructions.map((step, i) => (
              <div key={i} className="text-xs text-zinc-400 flex gap-2">
                <span className="text-orange-500 font-semibold shrink-0">{i + 1}.</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 flex gap-1 pt-1"><Info size={11} className="shrink-0 mt-0.5" /> Cook time per step stays about the same regardless of batch size — use a bigger pan/pot for the scaled quantity, and add ~5-10 min if things are more densely packed than a single serving. Cool cooked food within 2 hours before refrigerating.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WEEK VIEW — the 7-day breakdown pairing the active Train program's day
// split with whatever meals are actually planned/logged for each date.
// Unlike the Generate view (a two-variant hypothetical layout), this reflects
// REAL planned data per day and updates automatically as each day passes
// (today's date shifts forward on its own) and as you log workouts/meals.
//
// Training-day assumption: uses each program's real weekly schedule
// (including rest days) anchored to its start date from the Train tab.
// ---------------------------------------------------------------------------
function dateAtOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function WeekView({ meals, log, setLog, activeProgramKey, target, mealSlots = [], weeklyBudget, setMeals, programStartDate, location }) {
  const program = PROGRAMS[activeProgramKey];
  const [filling, setFilling] = useState(null); // date currently being filled
  const hasPerMealTargets = mealSlots.length > 0;
  const hasDailyTarget = target.calories > 0;
  const hasAnyTarget = hasPerMealTargets || hasDailyTarget;

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = dateAtOffset(i);
      const d = new Date(date + "T00:00:00");
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "long" });
      const dateLabel = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      // Each program's weeklySchedule is a fixed Mon-Sun pattern (including
      // rest days) anchored to real weekdays — Monday is always the same
      // slot every week, so the cycle never drifts or "runs out." Programs
      // without a fixed weekly pattern (Mentzer — individualized frequency)
      // fall back to a simple training-day cycle from today.
      const mondayFirstIndex = (d.getDay() + 6) % 7; // JS getDay(): 0=Sun -> convert to 0=Mon
      let trainingDay;
      if (program.weeklySchedule) {
        const slot = program.weeklySchedule[mondayFirstIndex];
        trainingDay = slot.rest ? { day: "Rest day", exercises: [], isRest: true } : program.days[slot.dayIndex];
      } else {
        trainingDay = program.days[i % program.days.length];
      }
      const dayLog = log[date] || { plan: [], entries: {} };
      const plannedMeals = dayLog.plan.map((id) => meals.find((m) => m.id === id)).filter(Boolean);
      const cost = plannedMeals.reduce((s, m) => s + mealCost(m, location), 0);
      const macros = plannedMeals.reduce(
        (acc, m) => ({
          calories: acc.calories + (m.calories || 0),
          protein: acc.protein + (m.protein || 0),
          carbs: acc.carbs + (m.carbs || 0),
          fat: acc.fat + (m.fat || 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 }
      );
      return { date, label, dateLabel, trainingDay, plannedMeals, cost, macros };
    });
  }, [log, meals, program, programStartDate, location]);

  const weekCost = days.reduce((s, d) => s + d.cost, 0);
  const overBudget = weeklyBudget > 0 && weekCost > weeklyBudget;

  const fillDay = (date) => {
    if (!hasAnyTarget) return;
    setFilling(date);
    let recipes = [];
    if (hasPerMealTargets) {
      // Same matching as the Generate tab's Combo A — one best-fit recipe
      // per meal slot you set up in Prep, not just a whole-day guess.
      const result = generateCookbookWeekFromMealSlots({ mealSlots, weeklyBudget, location });
      recipes = result ? result.comboA.recipes : [];
    } else {
      const ranked = rankDailyCombos({ target, weeklyBudget, location });
      recipes = ranked[0] ? ranked[0].recipes : [];
    }
    if (!recipes.length) { setFilling(null); return; }
    const withIds = recipes.map((r) => ({
      id: `cb_${r.id}_${uid()}`,
      name: r.name,
      calories: r.perServing.calories,
      protein: r.perServing.protein,
      carbs: r.perServing.carbs,
      fat: r.perServing.fat,
      ingredients: r.ingredients.map((i) => {
        const est = estimatePrice(i.name);
        return { name: i.name, qty: "1 serving", unit: est.unit, price: i.qty * est.price, guessed: !!est.guessed };
      }),
    }));
    setMeals((prev) => [...prev, ...withIds]);
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      const ids = withIds.map((m) => m.id);
      return { ...prev, [date]: { ...d, plan: [...d.plan, ...ids] } };
    });
    setFilling(null);
  };

  return (
    <div className="space-y-3">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 flex items-center justify-between text-sm">
        <span className="text-zinc-500">Week grocery cost (planned so far)</span>
        <span className={`font-semibold ${overBudget ? "text-red-500" : "text-teal-500"}`}>
          ${weekCost.toFixed(2)}{weeklyBudget ? ` / $${weeklyBudget.toFixed(2)}` : ""}
        </span>
      </div>
      <p className="text-[11px] text-zinc-600 flex gap-1.5">
        <Info size={12} className="shrink-0 mt-0.5" />
        Cost only counts days you've actually planned meals for; use "Fill with Cookbook" on empty days to fill them in. Training day info moved to the Today and Train tabs — this view is meals only.
      </p>

      <BatchPrepPlanner location={location} />

      {days.map((d) => {
        const dayShelf = d.plannedMeals.length
          ? cookedShelfLife(d.plannedMeals.flatMap((m) => (m.ingredients || []).map((i) => i.name)))
          : null;
        return (
        <div key={d.date} className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
          <div className="flex items-baseline justify-between mb-2">
            <div>
              <span className="font-semibold text-sm">{d.label}</span>
              <span className="text-xs text-zinc-500 ml-1.5">{d.dateLabel}</span>
            </div>
            <span className={`text-xs font-semibold ${d.cost > 0 ? "text-teal-500" : "text-zinc-600"}`}>${d.cost.toFixed(2)}</span>
          </div>

          {d.plannedMeals.length === 0 ? (
            hasAnyTarget ? (
              <button
                onClick={() => fillDay(d.date)}
                disabled={filling === d.date}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-zinc-400 border border-dashed border-zinc-800 rounded-lg py-2"
              >
                {filling === d.date ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
                {filling === d.date ? "Filling…" : "Fill with Cookbook"}
              </button>
            ) : (
              <div className="text-[11px] text-zinc-600 text-center py-2 border border-dashed border-zinc-800 rounded-lg">
                Set daily or per-meal targets in Prep → Daily goals to fill this day
              </div>
            )
          ) : (
            <div className="space-y-1">
              {d.plannedMeals.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-xs text-zinc-400">
                  <span className="truncate">{m.name}</span>
                  <span className="shrink-0 ml-2">{m.calories}kcal</span>
                </div>
              ))}
              <div className="text-[10px] text-zinc-600 pt-1 border-t border-zinc-800 mt-1.5 flex items-center gap-1.5">
                <span>{d.macros.calories} kcal ·</span>
                <MacroInline protein={d.macros.protein} carbs={d.macros.carbs} fat={d.macros.fat} size="text-[10px]" />
                {target.calories > 0 ? <span>(target {target.calories} kcal)</span> : null}
              </div>
              {dayShelf && (
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 pt-0.5">
                  <Clock size={10} className="shrink-0" />
                  <span>Good in fridge ~{dayShelf.fridgeDays} days if cooked fresh today</span>
                </div>
              )}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

function CookbookTab({ goals, mealSlots = [], setMeals, setLog, meals, log, activeProgramKey, programStartDates, location }) {
  const [view, setView] = useState("generate"); // "generate" | "week"
  const target = {
    calories: Number(goals.calories) || 0,
    protein: Number(goals.protein) || 0,
    carbs: Number(goals.carbs) || 0,
    fat: Number(goals.fat) || 0,
  };
  const weeklyBudget = Number(goals.budget) || 0;
  const usableMealSlots = mealSlots.filter(
    (s) => (Number(s.protein) || 0) > 0 || (Number(s.carbs) || 0) > 0 || (Number(s.fat) || 0) > 0
  );
  const hasPerMealTargets = usableMealSlots.length > 0;
  const hasTargets = target.calories > 0 || hasPerMealTargets;

  const [week, setWeek] = useState(null);
  const [addedDays, setAddedDays] = useState({}); // dayIndex -> true
  const [openRecipe, setOpenRecipe] = useState(null); // recipe key currently showing instructions

  const generate = () => {
    // Prefer Prep's per-meal macro targets when they're set up — this is
    // what keeps the number of meals and each meal's macros in sync with
    // what was configured in Prep, rather than only matching the daily total.
    const result = hasPerMealTargets
      ? generateCookbookWeekFromMealSlots({ mealSlots: usableMealSlots, weeklyBudget, location })
      : generateCookbookWeek({ target, weeklyBudget, location });
    setWeek(result);
    setAddedDays({});
    setOpenRecipe(null);
  };

  const overBudget = weeklyBudget > 0 && week && week.weeklyCost > weeklyBudget;

  const addRecipesToDate = (recipes, date) => {
    const withIds = recipes.map((r) => ({
      id: `cb_${r.id}_${uid()}`,
      name: r.name,
      calories: r.perServing.calories,
      protein: r.perServing.protein,
      carbs: r.perServing.carbs,
      fat: r.perServing.fat,
      ingredients: r.ingredients.map((i) => {
        const est = estimatePrice(i.name);
        return { name: i.name, qty: "1 serving", unit: est.unit, price: i.qty * est.price, guessed: !!est.guessed };
      }),
    }));
    setMeals((prev) => [...prev, ...withIds]);
    setLog((prev) => {
      const d = prev[date] || { plan: [], entries: {} };
      const ids = withIds.map((m) => m.id);
      return { ...prev, [date]: { ...d, plan: [...d.plan, ...ids] } };
    });
  };

  const addDayToToday = (dayIdx) => {
    if (!week) return;
    const recipes = COMBO_A_DAYS.includes(dayIdx) ? week.comboA.recipes : week.comboB.recipes;
    addRecipesToDate(recipes, todayStr());
    setAddedDays((prev) => ({ ...prev, [dayIdx]: true }));
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setView("generate")}
          className={`flex-1 rounded-lg py-2 text-sm font-medium border ${view === "generate" ? "bg-orange-600 border-orange-600 text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          Generate
        </button>
        <button
          onClick={() => setView("week")}
          className={`flex-1 rounded-lg py-2 text-sm font-medium border ${view === "week" ? "bg-orange-600 border-orange-600 text-zinc-950" : "border-zinc-800 text-zinc-400"}`}
        >
          This week
        </button>
      </div>

      {view === "week" && (
        <WeekView meals={meals} log={log} setLog={setLog} activeProgramKey={activeProgramKey} target={target} mealSlots={usableMealSlots} weeklyBudget={weeklyBudget} setMeals={setMeals} programStartDate={programStartDates?.[activeProgramKey]} location={location} />
      )}

      {view === "generate" && (
      <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BookOpen size={16} className="text-orange-500" /> Weekly cookbook & grocery list
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          Builds entirely offline — no live AI call. {hasPerMealTargets
            ? `Matches each of your ${usableMealSlots.length} Per-meal targets (from Prep → Daily goals) to the single best-fitting recipe for that meal's own protein/carb/fat — not just the daily total — then picks two daily combos`
            : "Picks two daily meal combos that best fit your daily macro target (from Prep → Daily goals)"}, assigns one to 4 days and one to 3 days for realistic batch cooking, and gives you a grocery list and cooking instructions for the whole week. Several recipes are modeled on real pro bodybuilder diets — Ronnie Coleman, Kevin Levrone, Flex Wheeler, and Kai Greene all repeated a handful of staple meals rather than eating something different every day, which is exactly the batch-prep approach this builds.
        </p>
        {!hasPerMealTargets && (
          <p className="text-[11px] text-orange-500/80 mt-2 flex gap-1.5">
            <Info size={12} className="shrink-0 mt-0.5" />
            Set up Per-meal targets in Prep → Daily goals for meal-by-meal macro accuracy instead of just an overall daily fit.
          </p>
        )}
      </div>

      {!hasTargets && (
        <EmptyState icon={BookOpen} title="Set your goals first" body="Head to Prep → Daily goals and fill in calories/macros (or set up Per-meal targets), then come back here." />
      )}

      {hasTargets && (
        <>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-2">
            {hasPerMealTargets ? (
              <div className="space-y-1">
                {usableMealSlots.map((s) => (
                  <div key={s.id} className="grid grid-cols-2 gap-x-3 text-xs text-zinc-400">
                    <span className="truncate">{s.label}</span>
                    <span className="text-right">{s.protein || 0}g / {s.carbs || 0}g / {s.fat || 0}g</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-400">
                <span>Daily target</span><span className="text-right">{target.calories} kcal</span>
                <span>Protein / Carb / Fat</span><span className="text-right">{target.protein}g / {target.carbs}g / {target.fat}g</span>
              </div>
            )}
            {weeklyBudget > 0 && (
              <div className="grid grid-cols-2 gap-x-3 text-xs text-zinc-400 pt-1 border-t border-zinc-800">
                <span>Weekly budget</span><span className="text-right">${weeklyBudget.toFixed(2)}</span>
              </div>
            )}
            <button onClick={generate} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-lg py-2.5 text-sm">
              {week ? "Regenerate" : "Build my week"}
            </button>
          </div>

          {week && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <span className="text-zinc-500">Avg daily total</span><span className="text-right">{Math.round(week.avgDaily.calories)} kcal</span>
                <span className="text-zinc-500">Protein / Carb / Fat</span><span className="text-right">{Math.round(week.avgDaily.protein)}g / {Math.round(week.avgDaily.carbs)}g / {Math.round(week.avgDaily.fat)}g</span>
                <span className="text-zinc-500">Weekly grocery cost</span>
                <span className={`text-right font-semibold ${overBudget ? "text-red-500" : "text-teal-500"}`}>
                  ${week.weeklyCost.toFixed(2)}{weeklyBudget ? ` / $${weeklyBudget.toFixed(2)}` : ""}
                </span>
              </div>
              {overBudget && (
                <p className="text-[11px] text-red-500 flex gap-1.5"><Info size={12} className="shrink-0 mt-0.5" /> This is the closest fit found — raise the budget or regenerate for a different combo.</p>
              )}

              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">7-day layout</div>
              <div className="grid grid-cols-1 gap-1.5">
                {WEEK_DAY_LABELS.map((label, i) => {
                  const isA = COMBO_A_DAYS.includes(i);
                  const combo = isA ? week.comboA : week.comboB;
                  return (
                    <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium">{label}</span>
                        <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full ${isA ? "bg-orange-900/40 text-orange-400" : "bg-teal-900/40 text-teal-400"}`}>Combo {isA ? "A" : "B"}</span>
                      </div>
                      <button
                        onClick={() => addDayToToday(i)}
                        disabled={addedDays[i]}
                        className={`text-[11px] rounded-full px-2 py-1 font-medium ${addedDays[i] ? "bg-teal-700 text-zinc-100" : "bg-zinc-800 text-orange-500"}`}
                      >
                        {addedDays[i] ? <Check size={11} /> : "Add to today"}
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-zinc-600">
                {week.perMealMode
                  ? `Combo A (Mon/Wed/Fri/Sun) and Combo B (Tue/Thu/Sat) each have one recipe per meal you set up in Prep (${week.slotLabels.length} meals) — cook each combo twice a week, not seven different days.`
                  : "Combo A (Mon/Wed/Fri/Sun) and Combo B (Tue/Thu/Sat) are each a fixed breakfast+lunch+dinner+snack — cook each one twice a week, not seven different meals."}
              </p>

              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide pt-1">Combo A meals</div>
              <div className="space-y-2">
                {week.comboA.recipes.map((r, i) => {
                  const key = `${r.id}-A-${i}`;
                  return (
                    <RecipeCard
                      key={key}
                      recipe={r}
                      slotLabel={week.slotLabels?.[i]}
                      open={openRecipe === key}
                      onToggle={() => setOpenRecipe(openRecipe === key ? null : key)}
                    />
                  );
                })}
              </div>
              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide pt-1">Combo B meals</div>
              <div className="space-y-2">
                {week.comboB.recipes.map((r, i) => {
                  const key = `${r.id}-B-${i}`;
                  return (
                    <RecipeCard
                      key={key}
                      recipe={r}
                      slotLabel={week.slotLabels?.[i]}
                      open={openRecipe === key}
                      onToggle={() => setOpenRecipe(openRecipe === key ? null : key)}
                    />
                  );
                })}
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
                <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Full week grocery list</div>
                <div className="space-y-1.5">
                  {week.groceries.map((g, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-zinc-300 capitalize">{g.name}</span>
                      <div className="text-right">
                        <div className="text-zinc-500 text-xs">${g.cost.toFixed(2)}{g.guessed ? " *" : ""}</div>
                        <div className="text-zinc-600 text-[10px]">
                          need {g.qty.toFixed(2)} {g.unit} · buy {g.packagesToBuy} {g.packageLabel}{g.packagesToBuy === 1 ? "" : "s"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between pt-2 mt-2 border-t border-zinc-800 text-sm font-semibold">
                  <span>Total</span>
                  <span className={overBudget ? "text-red-500" : "text-teal-500"}>${week.weeklyCost.toFixed(2)}</span>
                </div>
              </div>

              <button onClick={generate} className="w-full flex items-center justify-center gap-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg py-1.5">
                <RotateCcw size={12} /> Try a different week
              </button>
              <p className="text-[10px] text-zinc-600 flex gap-1"><Info size={11} className="shrink-0 mt-0.5" /> Macros are standard approximations, and items marked * had no close match in the price table (rough placeholder). Tap any meal above to see batch-cooking instructions.</p>
            </div>
          )}
        </>
      )}
      </div>
      )}
    </div>
  );
}

function RecipeCard({ recipe, slotLabel, open, onToggle }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between p-3">
        <div className="text-left">
          {slotLabel && (
            <div className="text-[10px] font-semibold text-teal-500 uppercase tracking-wide mb-0.5">{slotLabel}</div>
          )}
          <div className="font-medium text-sm">{recipe.name}</div>
          <div className="text-xs text-zinc-500 flex items-center gap-1.5 flex-wrap">
            <span>{recipe.perServing.calories} kcal ·</span>
            <MacroInline protein={recipe.perServing.protein} carbs={recipe.perServing.carbs} fat={recipe.perServing.fat} />
            <span>per serving</span>
          </div>
          {recipe.inspiredBy && <div className="text-[10px] text-orange-500 mt-0.5">Inspired by: {recipe.inspiredBy}</div>}
        </div>
        {open ? <ChevronDown size={16} className="text-zinc-500 shrink-0" /> : <ChevronRight size={16} className="text-zinc-500 shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-zinc-800 pt-2.5 space-y-1.5">
          {recipe.instructions.map((step, i) => (
            <div key={i} className="text-xs text-zinc-400 flex gap-2">
              <span className="text-orange-500 font-semibold shrink-0">{i + 1}.</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOGBOOK TAB — free-form daily food log, MyFitnessPal-style. Separate from
// the meal-plan checklist in Today: this is for logging whatever you
// actually ate, searched from FOOD_DATABASE or entered as a custom item,
// with a serving-count multiplier and running totals against Daily goals
// (set in Prep). Stored per-date under the "foodLog" key.
// ---------------------------------------------------------------------------
function LogbookTab({ goals, foodLog, setFoodLog }) {
  const [date, setDate] = useState(todayStr());
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);

  const target = {
    calories: Number(goals.calories) || 0,
    protein: Number(goals.protein) || 0,
    carbs: Number(goals.carbs) || 0,
    fat: Number(goals.fat) || 0,
  };

  const entries = foodLog[date] || [];
  const totals = useMemo(
    () =>
      entries.reduce(
        (acc, e) => ({
          calories: acc.calories + (Number(e.calories) || 0),
          protein: acc.protein + (Number(e.protein) || 0),
          carbs: acc.carbs + (Number(e.carbs) || 0),
          fat: acc.fat + (Number(e.fat) || 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 }
      ),
    [entries]
  );

  const addEntry = (entry) => {
    setFoodLog((prev) => {
      const list = prev[date] || [];
      return { ...prev, [date]: [...list, { ...entry, id: uid() }] };
    });
  };
  const removeEntry = (id) => {
    setFoodLog((prev) => ({ ...prev, [date]: (prev[date] || []).filter((e) => e.id !== id) }));
  };

  const filtered = query.trim()
    ? FOOD_DATABASE.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase()))
    : FOOD_DATABASE;
  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach((f) => {
      if (!map.has(f.category)) map.set(f.category, []);
      map.get(f.category).push(f);
    });
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <div className="space-y-4">
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-300"
      />

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center gap-4">
        <CalorieRing value={totals.calories} target={target.calories} size={112} stroke={10} />
        <div className="flex-1 min-w-0 space-y-2">
          {target.calories > 0 ? (
            <>
              <MacroBar label="Protein" color={MACRO_COLORS.protein} val={totals.protein} tgt={target.protein} />
              <MacroBar label="Carbs" color={MACRO_COLORS.carbs} val={totals.carbs} tgt={target.carbs} />
              <MacroBar label="Fat" color={MACRO_COLORS.fat} val={totals.fat} tgt={target.fat} />
            </>
          ) : (
            <p className="text-xs text-zinc-500">Set daily goals in Prep to see progress bars here.</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Today's entries</div>
        {entries.length === 0 && (
          <EmptyState icon={Search} title="Nothing logged yet" body="Search the food database below or add a custom item." />
        )}
        {entries.map((e) => (
          <div key={e.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{e.name}</div>
              <div className="text-xs text-zinc-500 flex items-center gap-1.5 flex-wrap">
                <span>{e.qty}× {e.serving} · {Math.round(e.calories)} kcal ·</span>
                <MacroInline protein={e.protein} carbs={e.carbs} fat={e.fat} />
              </div>
            </div>
            <button onClick={() => removeEntry(e.id)} className="text-zinc-600 hover:text-red-500 shrink-0 ml-2"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex items-center gap-2">
        <Search size={16} className="text-zinc-500 shrink-0" />
        <input
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-600"
          placeholder="Search food database…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="space-y-3">
        {grouped.map(([category, foods]) => (
          <div key={category}>
            <div className="text-[11px] font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">{category}</div>
            <div className="space-y-1.5">
              {foods.map((f) => (
                <FoodDbRow key={f.name} food={f} onAdd={(qty) => addEntry({
                  name: f.name,
                  serving: f.serving,
                  qty,
                  calories: f.calories * qty,
                  protein: f.protein * qty,
                  carbs: f.carbs * qty,
                  fat: f.fat * qty,
                })} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setCustomOpen((s) => !s)}
        className="w-full flex items-center justify-center gap-2 bg-zinc-900 border border-zinc-800 text-zinc-300 font-medium rounded-xl py-2.5 text-sm"
      >
        <Plus size={15} /> {customOpen ? "Close" : "Log a custom food"}
      </button>
      {customOpen && (
        <CustomFoodForm onSave={(entry) => { addEntry(entry); setCustomOpen(false); }} />
      )}
      <p className="text-[10px] text-zinc-600 flex gap-1"><Info size={11} className="shrink-0 mt-0.5" /> Macros are standard approximations per listed serving, not lab-verified — use the custom entry for anything that doesn't match, or adjust the serving count to match what you actually ate.</p>
    </div>
  );
}

function FoodDbRow({ food, onAdd }) {
  const [qty, setQty] = useState(1);
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-200 truncate">{food.name}</div>
        <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
          <span>{food.serving} · {food.calories} kcal ·</span>
          <MacroInline protein={food.protein} carbs={food.carbs} fat={food.fat} size="text-[11px]" />
        </div>
      </div>
      <input
        type="number"
        step="0.5"
        min="0.5"
        value={qty}
        onChange={(e) => setQty(Number(e.target.value) || 1)}
        className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm text-center"
      />
      <button onClick={() => onAdd(qty)} className="shrink-0 bg-orange-600 text-zinc-950 rounded-full p-1.5"><Plus size={14} /></button>
    </div>
  );
}

function CustomFoodForm({ onSave }) {
  const [name, setName] = useState("");
  const [serving, setServing] = useState("1 serving");
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");

  const submit = () => {
    if (!name.trim() || !calories) return;
    onSave({
      name: name.trim(),
      serving: serving.trim() || "1 serving",
      qty: 1,
      calories: Number(calories) || 0,
      protein: Number(protein) || 0,
      carbs: Number(carbs) || 0,
      fat: Number(fat) || 0,
    });
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-2.5">
      <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" placeholder="Food name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" placeholder="Serving (e.g. 1 cup, 6oz)" value={serving} onChange={(e) => setServing(e.target.value)} />
      <div className="grid grid-cols-4 gap-2">
        <input type="number" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-sm" placeholder="kcal" value={calories} onChange={(e) => setCalories(e.target.value)} />
        <input type="number" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-sm" placeholder="protein g" value={protein} onChange={(e) => setProtein(e.target.value)} />
        <input type="number" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-sm" placeholder="carbs g" value={carbs} onChange={(e) => setCarbs(e.target.value)} />
        <input type="number" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-sm" placeholder="fat g" value={fat} onChange={(e) => setFat(e.target.value)} />
      </div>
      <button onClick={submit} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-lg py-2 text-sm">Log it</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GROCERY TAB — pick recipes from the Cookbook library, set a batch-size
// slider per recipe (how many servings you want to cook at once), and get
// exact scaled ingredient quantities, the recipe steps, and shelf-life
// guidance for each ingredient. Selections persist under "groceryPlan"
// (recipeId -> servings) so the plan survives a refresh.
// ---------------------------------------------------------------------------
function GroceryTab({ groceryPlan, setGroceryPlan, meals, location }) {
  const [openRecipe, setOpenRecipe] = useState(null);
  const allRecipes = useMemo(
    () => [
      ...COOKBOOK.breakfast.map((r) => ({ ...r, slot: "Breakfast" })),
      ...COOKBOOK.lunch.map((r) => ({ ...r, slot: "Lunch" })),
      ...COOKBOOK.dinner.map((r) => ({ ...r, slot: "Dinner" })),
      ...COOKBOOK.snack.map((r) => ({ ...r, slot: "Snack" })),
    ],
    []
  );

  const selected = allRecipes.filter((r) => groceryPlan[r.id] > 0);

  const setServings = (id, servings) => {
    setGroceryPlan((prev) => ({ ...prev, [id]: Math.max(0, servings) }));
  };
  const toggle = (id) => {
    setGroceryPlan((prev) => (prev[id] > 0 ? { ...prev, [id]: 0 } : { ...prev, [id]: 5 }));
  };

  const combinedGroceries = useMemo(() => {
    if (!selected.length) return [];
    return weeklyGroceryList(selected.map((r) => ({ recipe: r, count: groceryPlan[r.id] })), location);
  }, [selected, groceryPlan, location]);
  const combinedCost = combinedGroceries.reduce((s, g) => s + g.cost, 0);

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShoppingCart size={16} className="text-orange-500" /> Grocery & batch prep
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          Pick recipes from the Cookbook library below, set how many servings you want to batch cook with each slider, and get exact scaled ingredient amounts, the recipe, and shelf-life guidance — plus one combined grocery list across everything you've selected.
        </p>
      </div>

      {selected.length > 0 && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3.5">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Combined grocery list</div>
          <div className="space-y-1.5">
            {combinedGroceries.map((g, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-zinc-300 capitalize">{g.name}</span>
                <div className="text-right">
                  <div className="text-zinc-500 text-xs">${g.cost.toFixed(2)}{g.guessed ? " *" : ""}</div>
                  <div className="text-zinc-600 text-[10px]">
                    need {g.qty.toFixed(2)} {g.unit} · buy {g.packagesToBuy} {g.packageLabel}{g.packagesToBuy === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between pt-2 mt-2 border-t border-zinc-800 text-sm font-semibold">
            <span>Total</span>
            <span className="text-teal-500">${combinedCost.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {["Breakfast", "Lunch", "Dinner", "Snack"].map((slot) => (
          <div key={slot}>
            <div className="text-[11px] font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">{slot}</div>
            <div className="space-y-2">
              {allRecipes.filter((r) => r.slot === slot).map((r) => (
                <GroceryRecipeCard
                  key={r.id}
                  recipe={r}
                  servings={groceryPlan[r.id] || 0}
                  active={groceryPlan[r.id] > 0}
                  open={openRecipe === r.id}
                  onToggleActive={() => toggle(r.id)}
                  onServings={(n) => setServings(r.id, n)}
                  onToggleOpen={() => setOpenRecipe(openRecipe === r.id ? null : r.id)}
                  location={location}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {meals.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Your Prep meals</div>
          <p className="text-[11px] text-zinc-600 mb-2">These are custom, so quantities aren't auto-scaled — batch-cook by multiplying the ingredient list yourself.</p>
          <div className="space-y-1.5">
            {meals.map((m) => (
              <div key={m.id} className="text-sm text-zinc-300">{m.name} <span className="text-zinc-600 text-xs">· {(m.ingredients || []).length} ingredients</span></div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-zinc-600 flex gap-1"><Info size={11} className="shrink-0 mt-0.5" /> Shelf-life windows are general food-safety guidance, not exact — when in doubt, trust your nose, and freeze anything you won't use within the fridge window.</p>
    </div>
  );
}

function GroceryRecipeCard({ recipe, servings, active, open, onToggleActive, onServings, onToggleOpen, location }) {
  const scaled = recipe.ingredients.map((i) => {
    const qty = i.qty * (servings || 1);
    const purchase = estimatePurchase(i.name, qty, location);
    return { name: i.name, qty, unit: purchase.unit, cost: purchase.cost, packagesToBuy: purchase.packagesToBuy, packageLabel: purchase.packageLabel, shelf: estimateShelfLife(i.name) };
  });
  const shelf = cookedShelfLife(recipe.ingredients.map((i) => i.name));
  // Servings here doubles as "days you'll be eating this" (same ~1
  // serving/day assumption BatchPrepPlanner uses) — if that's more days
  // than the cooked dish actually holds in the fridge, warn before the
  // person buys ingredients for a batch that'll spoil before it's eaten.
  const willSpoil = active && (servings || 1) > shelf.fridgeDays;

  return (
    <div className={`bg-zinc-900 border rounded-xl overflow-hidden ${active ? "border-orange-700/60" : "border-zinc-800"}`}>
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={onToggleActive}
          className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center border-2 transition-colors ${
            active ? "bg-orange-600 border-orange-600" : "border-zinc-600"
          }`}
        >
          {active && <Check size={14} className="text-zinc-950" />}
        </button>
        <button onClick={onToggleOpen} className="flex-1 min-w-0 text-left">
          <div className="font-medium text-sm truncate">{recipe.name}</div>
          <div className="text-xs text-zinc-500 flex items-center gap-1.5">
            <span>{recipe.perServing.calories} kcal/serving ·</span>
            <MacroInline protein={recipe.perServing.protein} carbs={recipe.perServing.carbs} fat={recipe.perServing.fat} />
          </div>
        </button>
        {open ? <ChevronDown size={16} className="text-zinc-500 shrink-0" /> : <ChevronRight size={16} className="text-zinc-500 shrink-0" />}
      </div>

      {active && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={13} className="text-zinc-500 shrink-0" />
            <input
              type="range"
              min="1"
              max="14"
              step="1"
              value={servings || 1}
              onChange={(e) => onServings(Number(e.target.value))}
              className="flex-1 accent-orange-600"
            />
            <span className="text-sm font-semibold text-orange-500 w-24 text-right shrink-0">{servings} serving{servings === 1 ? "" : "s"}</span>
          </div>
          {willSpoil && (
            <div className="rounded-lg p-2.5 flex items-start gap-2 text-xs bg-red-950/40 border border-red-900/50">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-500" />
              <span className="text-red-400">
                This dish only holds ~{shelf.fridgeDays} day{shelf.fridgeDays === 1 ? "" : "s"} in the fridge, but {servings} servings is more than that (assuming ~1 serving/day). Freeze what you won't eat within {shelf.fridgeDays} day{shelf.fridgeDays === 1 ? "" : "s"} (freezer: {shelf.freezer}) or drop the serving count.
              </span>
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="px-3 pb-3.5 border-t border-zinc-800 pt-3 space-y-3">
          <div>
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">
              Ingredients {active ? `(scaled to ${servings})` : "(per serving — select above to scale)"}
            </div>
            <div className="space-y-1.5">
              {(active ? scaled : recipe.ingredients.map((i) => {
                const purchase = estimatePurchase(i.name, i.qty, location);
                return { name: i.name, qty: i.qty, unit: purchase.unit, cost: purchase.cost, packagesToBuy: purchase.packagesToBuy, packageLabel: purchase.packageLabel, shelf: estimateShelfLife(i.name) };
              })).map((ing, i) => (
                <div key={i} className="text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-300 capitalize">{ing.name}</span>
                    <span className="text-zinc-500">${ing.cost.toFixed(2)}</span>
                  </div>
                  <div className="text-zinc-600 text-[10px] mt-0.5">
                    need {ing.qty.toFixed(2)} {ing.unit} · buy {ing.packagesToBuy} {ing.packageLabel}{ing.packagesToBuy === 1 ? "" : "s"}
                  </div>
                  <div className="text-zinc-600 flex items-center gap-1 mt-0.5">
                    <Clock size={10} className="shrink-0" />
                    <span>Fridge: {ing.shelf.fridge} · Freezer: {ing.shelf.freezer}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">Recipe</div>
            <div className="space-y-1.5">
              {recipe.instructions.map((step, i) => (
                <div key={i} className="text-xs text-zinc-400 flex gap-2">
                  <span className="text-orange-500 font-semibold shrink-0">{i + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// REMINDERS TAB — set a target time per meal; the app checks the clock while
// it's open and fires a browser notification (or in-app banner as fallback)
// when a planned, not-yet-eaten meal's time arrives.
//
// Honest limitation: this only works while this artifact is open and active
// in your browser/app — there's no service worker or push infrastructure
// here, so it can't wake up a closed tab or send a true OS push notification.
// Keep FORGE open (or in another tab) around mealtimes for it to fire.
// ---------------------------------------------------------------------------
function RemindersTab({ meals, mealTimes, setMealTimes, log, mealSlots, setMealSlots }) {
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const date = todayStr();
  const dayLog = log[date] || { plan: [], entries: {} };
  const plannedMeals = dayLog.plan.map((id) => meals.find((m) => m.id === id)).filter(Boolean);

  const requestPermission = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result);
  };

  const setTime = (mealId, time) => {
    setMealTimes((prev) => ({ ...prev, [mealId]: time }));
  };
  const setSlotTime = (id, time) => {
    setMealSlots((prev) => prev.map((s) => (s.id === id ? { ...s, time } : s)));
  };

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bell size={16} className="text-orange-500" /> Meal reminders
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          Set a target time for each of today's planned meals and FORGE will notify you when it's time to eat, as long as it's still marked open on Today.
        </p>
        <p className="text-[11px] text-zinc-600 mt-2 flex gap-1.5">
          <Info size={12} className="shrink-0 mt-0.5" />
          Works only while this app is open in your browser — there's no background push here, so leave it open (even in another tab) around mealtimes.
        </p>
      </div>

      {permission !== "granted" && permission !== "unsupported" && (
        <button onClick={requestPermission} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-xl py-2.5 text-sm">
          Enable notifications
        </button>
      )}
      {permission === "unsupported" && (
        <p className="text-xs text-zinc-500 text-center">Notifications aren't supported in this browser context — reminders will still show as an in-app banner while FORGE is open.</p>
      )}
      {permission === "denied" && (
        <p className="text-xs text-red-500 text-center">Notifications are blocked for this page — enable them in your browser's site settings to get alerts, or rely on the in-app banner.</p>
      )}

      {plannedMeals.length === 0 ? (
        <EmptyState icon={Bell} title="Nothing planned for today yet" body="Add meals to Today's plan first, then set reminder times for them here." />
      ) : (
        <div className="space-y-2">
          {plannedMeals.map((m) => {
            const eaten = dayLog.entries[m.id]?.status === "done" || dayLog.entries[m.id]?.status === "replaced";
            return (
              <div key={m.id} className={`bg-zinc-900 border rounded-xl p-3 flex items-center justify-between gap-3 ${eaten ? "border-zinc-800 opacity-50" : "border-zinc-800"}`}>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{m.name}</div>
                  <div className="text-xs text-zinc-500">{eaten ? "already logged today" : "not yet eaten"}</div>
                </div>
                <input
                  type="time"
                  value={mealTimes[m.id] || ""}
                  onChange={(e) => setTime(m.id, e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm shrink-0"
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="pt-2">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Per-meal targets (from Prep → Daily goals)</h3>
        {mealSlots.length === 0 ? (
          <p className="text-sm text-zinc-500">No per-meal targets set up yet — build them in Prep → Daily goals → Per-meal targets.</p>
        ) : (
          <div className="space-y-2">
            {mealSlots.map((s) => (
              <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{s.label}</div>
                  <MacroInline protein={s.protein} carbs={s.carbs} fat={s.fat} />
                </div>
                <input
                  type="time"
                  value={s.time || ""}
                  onChange={(e) => setSlotTime(s.id, e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm shrink-0"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MealForm({ onSave }) {
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState([{ name: "", qty: "" }]);

  const updateIng = (i, field, val) => {
    setIngredients((prev) => prev.map((ing, idx) => (idx === i ? { ...ing, [field]: val } : ing)));
  };
  const addRow = () => setIngredients((prev) => [...prev, { name: "", qty: "" }]);
  const removeRow = (i) => setIngredients((prev) => prev.filter((_, idx) => idx !== i));

  // Live-computed macros from the ingredient list — mirrors how price is
  // already estimated live via estimatePrice() as ingredients are typed.
  // Manual calorie/protein/carb/fat entry has been removed entirely: there
  // is no longer a number here that can drift from what's actually in the
  // ingredient list (the exact failure mode this replaced — see MACRO_TABLE
  // comment above for the audit that found it).
  const liveMacros = useMemo(() => {
    const clean = ingredients
      .filter((i) => i.name.trim())
      .map((i) => ({ name: i.name.trim(), qty: Number(i.qty) || 0 }));
    return mealMacros(clean);
  }, [ingredients]);

  const submit = () => {
    if (!name.trim()) return;
    const clean = ingredients.filter((i) => i.name.trim());
    onSave({
      name: name.trim(),
      calories: liveMacros.calories,
      protein: liveMacros.protein,
      carbs: liveMacros.carbs,
      fat: liveMacros.fat,
      ingredients: clean.map((i) => {
        const est = estimatePrice(i.name);
        return { name: i.name.trim(), qty: i.qty.trim() || "1", unit: est.unit, price: est.price, guessed: !!est.guessed };
      }),
    });
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" placeholder="Meal name (e.g. Chicken Rice Bowl)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5">
        <div className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wide mb-1">Computed from ingredients below</div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-semibold text-zinc-200">{liveMacros.calories} kcal</span>
          <MacroInline protein={liveMacros.protein} carbs={liveMacros.carbs} fat={liveMacros.fat} />
        </div>
        {liveMacros.unmatched.length > 0 && (
          <div className="text-[11px] text-amber-500 mt-1.5">
            No macro data for: {liveMacros.unmatched.join(", ")} — those ingredients aren't counted above. Check spelling or use a more common name.
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Ingredients</div>
        {ingredients.map((ing, i) => (
          <div key={i} className="flex gap-2">
            <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" placeholder="Ingredient (e.g. chicken breast)" value={ing.name} onChange={(e) => updateIng(i, "name", e.target.value)} />
            <input className="w-20 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm" placeholder="qty" value={ing.qty} onChange={(e) => updateIng(i, "qty", e.target.value)} />
            <button onClick={() => removeRow(i)} className="text-zinc-600 hover:text-red-500 px-1"><X size={16} /></button>
          </div>
        ))}
        <button onClick={addRow} className="text-xs text-orange-500 font-medium flex items-center gap-1"><Plus size={13} /> Add ingredient</button>
      </div>
      <button onClick={submit} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-lg py-2 text-sm">Save meal</button>
    </div>
  );
}

function MealCard({ meal, onDelete }) {
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState({});

  const total = useMemo(() => {
    return (meal.ingredients || []).reduce((sum, ing, i) => {
      const price = overrides[i] !== undefined ? Number(overrides[i]) : ing.price;
      return sum + (isNaN(price) ? 0 : price);
    }, 0);
  }, [meal.ingredients, overrides]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button onClick={() => setOpen((s) => !s)} className="w-full flex items-center justify-between p-3.5">
        <div className="text-left">
          <div className="font-medium text-sm">{meal.name}</div>
          <div className="text-xs text-zinc-500 flex items-center gap-1.5">
            <span>{meal.calories} kcal</span>
            {(meal.protein || meal.carbs || meal.fat) ? <><span className="text-zinc-700">·</span><MacroInline protein={meal.protein} carbs={meal.carbs} fat={meal.fat} /></> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-orange-500">~${total.toFixed(2)}</span>
          {open ? <ChevronDown size={16} className="text-zinc-500" /> : <ChevronRight size={16} className="text-zinc-500" />}
        </div>
      </button>
      {open && (
        <div className="px-3.5 pb-3.5 space-y-2 border-t border-zinc-800 pt-3">
          {(meal.ingredients || []).map((ing, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-zinc-300">{ing.name} <span className="text-zinc-600">· {ing.qty}</span></span>
              <span className="flex items-center gap-1 text-zinc-400">
                <span className="text-xs text-zinc-600">/{ing.unit}</span>
                $
                <input
                  type="number"
                  step="0.01"
                  defaultValue={ing.price}
                  onChange={(e) => setOverrides((prev) => ({ ...prev, [i]: e.target.value }))}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5 text-right"
                />
                {ing.guessed && <span title="No close match found — rough placeholder estimate" className="text-zinc-600">*</span>}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 border-t border-zinc-800 text-sm font-semibold">
            <span>Est. total</span>
            <span className="text-orange-500">${total.toFixed(2)}</span>
          </div>
          <button onClick={onDelete} className="text-xs text-red-500 flex items-center gap-1 pt-1"><Trash2 size={12} /> Delete meal</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TRAIN TAB — program presets + set logging with RIR-based next-weight calc
// ---------------------------------------------------------------------------
// Extract cross-session history for one exercise within one program+day slot.
// Used to drive AMRAP week-to-week progression and the volume trend hint.
function getExerciseHistory(workoutLogs, programKey, dayIndex, exerciseName, targetReps) {
  const suffix = `|${programKey}|${dayIndex}`;
  const rows = Object.entries(workoutLogs)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, session]) => {
      const date = key.split("|")[0];
      const sets = session[exerciseName];
      if (!sets) return null;
      const indices = Object.keys(sets).map(Number).sort((a, b) => a - b);
      if (!indices.length) return null;
      const last = sets[indices[indices.length - 1]];
      if (!last?.weight || !last?.reps) return null;
      return { date, weight: Number(last.weight), reps: Number(last.reps), extraReps: Number(last.reps) - targetReps };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function TrainTab({ activeProgramKey, setActiveProgramKey, workoutLogs, setWorkoutLogs, programStartDates, setProgramStartDates, trainingMaxes, setTrainingMaxes, personalRecords, setPersonalRecords, setPrXpEvents }) {
  const [dayIndex, setDayIndex] = useState(0);
  const [showGuide, setShowGuide] = useState(false);
  const program = PROGRAMS[activeProgramKey];
  const date = todayStr();
  const dayKey = `${date}|${activeProgramKey}|${dayIndex}`;
  const sessionSets = workoutLogs[dayKey] || {};
  const startDate = programStartDates[activeProgramKey];
  const weekInfo = getProgramWeekInfo(activeProgramKey, startDate);
  const isBulldog = activeProgramKey === "bulldog";

  const todayD = new Date();
  const mondayFirstIndex = (todayD.getDay() + 6) % 7;
  const todaySlot = program.weeklySchedule ? program.weeklySchedule[mondayFirstIndex] : null;
  const todayIsRest = todaySlot?.rest === true;

  const [justHitPR, setJustHitPR] = useState(null); // { exerciseName, record } | null — cleared when a new set is logged

  const logSet = (exerciseName, setIndex, data) => {
    setWorkoutLogs((prev) => {
      const session = { ...(prev[dayKey] || {}) };
      const ex = { ...(session[exerciseName] || {}) };
      ex[setIndex] = data;
      session[exerciseName] = ex;
      return { ...prev, [dayKey]: session };
    });

    // PR check runs on every logged set, not just AMRAP sets — a PR can
    // happen on any set, and gating this to AMRAP-only would silently miss
    // real PRs on straight-weight days.
    const prResult = checkForPR(exerciseName, data, personalRecords);
    if (prResult.isNewPR) {
      setPersonalRecords(prResult.updatedRecords);
      setJustHitPR({ exerciseName, record: prResult.record });
      // id includes date+exercise, so a second PR on the same exercise
      // later the same day won't award XP twice — the record itself still
      // updates to the new best, only the XP event is capped at one/day.
      const xpEvent = {
        id: `pr:${date}:${exerciseName}`, date, source: "pr_hit",
        exerciseName, e1rm: prResult.record.e1rm, weight: prResult.record.weight, reps: prResult.record.reps, // snapshot for the Session 7 strength graph — same "record the moment, since only-current is stored elsewhere" reasoning as the rest of this ledger
        ...awardXp("pr_hit", { exerciseName }),
      };
      setPrXpEvents((prev) => (prev.some((e) => e.id === xpEvent.id) ? prev : [...prev, xpEvent]));
    }
  };

  const startProgram = () => {
    setProgramStartDates((prev) => ({ ...prev, [activeProgramKey]: date }));
  };

  const setMax = (lift, value) => {
    setTrainingMaxes((prev) => ({ ...prev, [lift]: value }));
  };

  return (
    <div className="space-y-4">
      {justHitPR && (
        <div className="bg-orange-950/40 border border-orange-800/50 rounded-xl p-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Trophy size={16} className="text-orange-400" />
            <span className="text-orange-200 font-medium">New PR — {justHitPR.exerciseName}</span>
            <span className="text-zinc-400">{justHitPR.record.weight}×{justHitPR.record.reps} (e1RM {justHitPR.record.e1rm})</span>
          </div>
          <button onClick={() => setJustHitPR(null)} className="text-zinc-500 hover:text-zinc-300"><X size={14} /></button>
        </div>
      )}
      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Program</label>
        <select
          value={activeProgramKey}
          onChange={(e) => { setActiveProgramKey(e.target.value); setDayIndex(0); }}
          className="w-full mt-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm"
        >
          {Object.entries(PROGRAMS).map(([key, p]) => (
            <option key={key} value={key}>{p.label}</option>
          ))}
        </select>
        <p className="text-xs text-zinc-500 mt-1.5">{program.style}</p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
        {program.weeklySchedule && (
          <div className={`text-xs font-medium mb-2 flex items-center gap-1.5 ${todayIsRest ? "text-zinc-500" : "text-teal-500"}`}>
            <Bell size={12} />
            {todayIsRest ? "Today is a scheduled rest day on this program." : `Today's scheduled session: ${program.days[todaySlot.dayIndex].day}`}
          </div>
        )}
        {weekInfo ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-orange-500">{weekInfo.label}</div>
              {weekInfo.done && <div className="text-xs text-red-500 mt-0.5">Program length reached — restart, or run another block.</div>}
            </div>
            <button onClick={startProgram} className="text-xs text-zinc-500 border border-zinc-800 rounded-full px-2.5 py-1">Restart</button>
          </div>
        ) : (
          <button onClick={startProgram} className="w-full bg-orange-600 text-zinc-950 font-semibold rounded-lg py-2 text-sm">
            Start this program today
          </button>
        )}
        <button onClick={() => setShowGuide((s) => !s)} className="text-xs text-orange-500 font-medium mt-2">
          {showGuide ? "Hide program guide" : "Why this program works this way"}
        </button>
        {showGuide && (
          <div className="mt-2.5 pt-2.5 border-t border-zinc-800 space-y-2 text-xs text-zinc-400">
            <div><span className="text-zinc-300 font-medium">Philosophy: </span>{program.philosophy}</div>
            <div><span className="text-zinc-300 font-medium">Why these movements are paired: </span>{program.pairingLogic}</div>
            <div><span className="text-zinc-300 font-medium">Structure: </span>{program.structureNotes}</div>
          </div>
        )}
      </div>

      {isBulldog && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Training maxes (1RM)</div>
          <div className="grid grid-cols-2 gap-2">
            {["Back Squat", "Bench Press", "Deadlift", "Overhead Press"].map((lift) => (
              <div key={lift}>
                <label className="text-[10px] text-zinc-600">{lift}</label>
                <input
                  type="number"
                  value={trainingMaxes[lift] || ""}
                  onChange={(e) => setMax(lift, e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm"
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">Used to prescribe each wave's starting weight — week-to-week jumps within a wave are still driven by your logged AMRAP performance, not this number directly.</p>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {program.days.map((d, i) => (
          <button
            key={i}
            onClick={() => setDayIndex(i)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border ${
              dayIndex === i ? "bg-orange-600 border-orange-600 text-zinc-950" : "border-zinc-800 text-zinc-400"
            }`}
          >
            {d.day}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {program.days[dayIndex].exercises.map((ex) => {
          const history = ex.amrap
            ? getExerciseHistory(workoutLogs, activeProgramKey, dayIndex, ex.name, ex.reps).filter((h) => h.date !== date)
            : [];
          const phasePrescription = isBulldog && ex.amrap && weekInfo
            ? bullmastiffPrescription(weekInfo.phase, weekInfo.wave)
            : null;
          const trainingMax = ex.mainLift ? Number(trainingMaxes[ex.mainLift]) || null : null;
          return (
            <ExerciseLogger
              key={ex.name}
              exercise={ex}
              loggedSets={sessionSets[ex.name] || {}}
              onLogSet={(setIndex, data) => logSet(ex.name, setIndex, data)}
              history={history}
              phasePrescription={phasePrescription}
              trainingMax={trainingMax}
              weekInWave={weekInfo?.weekInWave}
            />
          );
        })}
      </div>
    </div>
  );
}

function ExerciseLogger({ exercise, loggedSets, onLogSet, history, phasePrescription, trainingMax, weekInWave }) {
  const [open, setOpen] = useState(true);
  const setIndices = Array.from({ length: exercise.sets }, (_, i) => i);
  const lastSetIndex = exercise.sets - 1;
  const lastSession = history.length ? history[history.length - 1] : null;
  const trend = exercise.amrap ? volumeTrendHint(history) : null;

  // Within a wave (week 2-3), the AMRAP auto-regulation formula drives the
  // jump. At the top of a new wave (week 1) or with no history yet, fall
  // back to the phase's prescribed starting %1RM.
  const useAutoReg = lastSession && weekInWave && weekInWave !== 1;
  const amrapSuggestion = exercise.amrap && useAutoReg
    ? amrapNextSessionWeight({ weight: lastSession.weight, reps: lastSession.reps, targetReps: exercise.reps })
    : null;
  const phaseWeight = phasePrescription && trainingMax ? round25(trainingMax * phasePrescription.pct) : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button onClick={() => setOpen((s) => !s)} className="w-full flex items-center justify-between p-3.5">
        <div className="text-left">
          <div className="font-medium text-sm">{exercise.name}{exercise.amrap ? " +" : ""}</div>
          <div className="text-xs text-zinc-500">
            target {exercise.sets}×{exercise.reps}{exercise.amrap ? " (last set AMRAP)" : ""} · RIR {exercise.rir}{exercise.note ? ` · ${exercise.note}` : ""}
          </div>
        </div>
        {open ? <ChevronDown size={16} className="text-zinc-500" /> : <ChevronRight size={16} className="text-zinc-500" />}
      </button>
      {open && (
        <div className="px-3.5 pb-3.5 border-t border-zinc-800 pt-3 space-y-2.5">
          {exercise.amrap && (amrapSuggestion || phaseWeight) && (
            <div className="bg-zinc-950 border border-orange-900/40 rounded-lg p-2.5 text-xs">
              {amrapSuggestion ? (
                <>
                  <div className="flex items-center gap-1.5 text-orange-500 font-medium">
                    <Flame size={12} /> Last AMRAP: {lastSession.weight} lb × {lastSession.reps} (target {exercise.reps})
                  </div>
                  <div className="text-zinc-400 mt-1">Suggested today: <span className="text-zinc-100 font-semibold">{amrapSuggestion} lb</span> — auto-regulated, +1% per rep over target.</div>
                </>
              ) : (
                <div className="text-zinc-400">
                  Wave start — prescribed: <span className="text-zinc-100 font-semibold">{phaseWeight ? `${phaseWeight} lb` : `${Math.round(phasePrescription.pct * 100)}% of 1RM`}</span> for {phasePrescription.reps}+ reps.
                  {!trainingMax && " Enter a training max above to see a weight."}
                </div>
              )}
              {trend && <div className={`mt-1 ${trend.tone === "up" ? "text-teal-500" : trend.tone === "down" ? "text-red-500" : "text-zinc-500"}`}>{trend.text}</div>}
            </div>
          )}
          {setIndices.map((i) => (
            <SetRow
              key={i}
              setNumber={i + 1}
              targetReps={exercise.reps}
              targetRir={exercise.rir}
              data={loggedSets[i]}
              prevData={loggedSets[i - 1]}
              onSave={(d) => onLogSet(i, d)}
              isAmrapSet={exercise.amrap && i === lastSetIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SetRow({ setNumber, targetReps, targetRir, data, prevData, onSave, isAmrapSet }) {
  const [weight, setWeight] = useState(data?.weight ?? "");
  const [reps, setReps] = useState(data?.reps ?? "");
  const [rir, setRir] = useState(data?.rir ?? "");
  const [notes, setNotes] = useState(data?.notes ?? "");
  const [saved, setSaved] = useState(!!data);

  const suggestion = !isAmrapSet && prevData?.weight && prevData?.reps
    ? nextSetWeight({ weight: Number(prevData.weight), reps: Number(prevData.reps), rir: Number(prevData.rir), targetReps, targetRir })
    : null;

  const commit = () => {
    if (!weight || !reps) return;
    onSave({ weight, reps, rir, notes });
    setSaved(true);
  };

  return (
    <div className={`bg-zinc-950 border rounded-lg p-2.5 ${isAmrapSet ? "border-orange-900/50" : "border-zinc-800"}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-xs font-semibold text-zinc-500 w-16">Set {setNumber}{isAmrapSet ? " (AMRAP)" : ""}</span>
        {suggestion && !saved && (
          <span className="text-[11px] text-teal-500 flex items-center gap-1">
            <Flame size={11} /> suggested: {suggestion} lb
          </span>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <input type="number" placeholder="lb" value={weight} onChange={(e) => { setWeight(e.target.value); setSaved(false); }} className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-center" />
        <input type="number" placeholder={isAmrapSet ? "reps (max)" : "reps"} value={reps} onChange={(e) => { setReps(e.target.value); setSaved(false); }} className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-center" />
        <input type="number" placeholder="RIR" value={rir} onChange={(e) => { setRir(e.target.value); setSaved(false); }} className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-center" />
        <button onClick={commit} className={`rounded px-2 py-1.5 text-sm font-semibold ${saved ? "bg-teal-700 text-zinc-100" : "bg-orange-600 text-zinc-950"}`}>
          {saved ? <Check size={15} className="mx-auto" /> : "Log"}
        </button>
      </div>
      <input
        placeholder="notes — how it felt, form cues, etc."
        value={notes}
        onChange={(e) => { setNotes(e.target.value); setSaved(false); }}
        onBlur={commit}
        className="w-full mt-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-400"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="border border-dashed border-zinc-800 rounded-xl p-6 text-center">
      <Icon size={22} className="mx-auto text-zinc-700 mb-2" />
      <div className="text-sm font-medium text-zinc-400">{title}</div>
      <div className="text-xs text-zinc-600 mt-1">{body}</div>
    </div>
  );
}
