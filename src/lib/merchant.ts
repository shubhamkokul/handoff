// The merchant's callback implementations, i.e. what a real integration would
// write against the SDK. In production these would hit the merchant's backend.

import type { PaySheetOptions, ShippingUpdate } from "./mock-paysheet-sdk";
import { sumItems } from "./mock-paysheet-sdk";
import type { CallbackName, LineItem } from "./protocol";

const TAX_RATES: Record<string, number> = { CA: 0.0725, NY: 0.04, TX: 0.0625, WA: 0.065 };
const REMOTE_STATES = new Set(["AK", "HI"]);

// Each new session picks one, so concurrent transactions are easy to tell apart.
export const SCENARIOS: { merchant: string; items: LineItem[] }[] = [
  {
    merchant: "Keebs & Co.",
    items: [
      { name: "Mechanical keyboard", unitAmount: 129, quantity: 1 },
      { name: "Keycap set", unitAmount: 39.5, quantity: 2 },
    ],
  },
  { merchant: "Bean There Coffee", items: [{ name: "Single-origin beans 1kg", unitAmount: 32, quantity: 2 }] },
  {
    merchant: "Trailhead Outfitters",
    items: [
      { name: "Trail runners", unitAmount: 145, quantity: 1 },
      { name: "Wool socks", unitAmount: 18, quantity: 3 },
    ],
  },
  { merchant: "Paper & Ink", items: [{ name: "Dot-grid notebook", unitAmount: 24, quantity: 1 }] },
  {
    merchant: "Volt Electronics",
    items: [
      { name: "USB-C dock", unitAmount: 219, quantity: 1 },
      { name: "Braided cable", unitAmount: 15, quantity: 2 },
    ],
  },
];

// beforeRespond lets the caller hold a response (see ResponseGate); without
// it the merchant answers immediately.
export function merchantCallbacks(
  items: LineItem[],
  beforeRespond: (callback: CallbackName) => Promise<void> = () => Promise.resolve(),
): Pick<PaySheetOptions, "onShippingAddressChange" | "onShippingOptionsChange" | "onApprove"> {
  const subtotal = sumItems(items);

  return {
    async onShippingAddressChange({ shippingAddress }, actions) {
      await beforeRespond("onShippingAddressChange");
      if (shippingAddress.countryCode !== "US") return actions.reject("COUNTRY_ERROR");
      if (!/^\d{5}$/.test(shippingAddress.postalCode) || shippingAddress.postalCode === "00000")
        return actions.reject("ZIP_ERROR");

      const state = shippingAddress.state.toUpperCase();
      const options: ShippingUpdate["shippingOptions"] = REMOTE_STATES.has(state)
        ? [{ id: "express", label: "Express (3–5 days, AK/HI)", amount: 24.99 }]
        : [
            { id: "standard", label: "Standard (5–7 days)", amount: subtotal >= 100 ? 0 : 6.99 },
            { id: "express", label: "Express (2 days)", amount: 14.99 },
            { id: "overnight", label: "Overnight", amount: 34.99 },
          ];
      return { shippingOptions: options, tax: round2(subtotal * (TAX_RATES[state] ?? 0)) };
    },

    async onShippingOptionsChange({ selectedShippingOption }, actions) {
      await beforeRespond("onShippingOptionsChange");
      // e.g. merchant ran out of overnight capacity today
      if (selectedShippingOption.id === "overnight" && new Date().getHours() >= 20)
        return actions.reject("METHOD_UNAVAILABLE");
    },

    async onApprove() {
      await beforeRespond("onApprove");
    },
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
