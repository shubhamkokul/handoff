// Wire protocol between the VM paysheet and the device mirror.
// Transport-agnostic: nothing here knows about Firebase.

export type Role = "vm" | "device";

export interface Address {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
}

export interface ShippingOption {
  id: string;
  label: string;
  amount: number;
  selected: boolean;
}

export interface LineItem {
  name: string;
  unitAmount: number;
  quantity: number;
}

export type CallbackName =
  | "onShippingAddressChange"
  | "onShippingOptionsChange"
  | "onApprove";

export interface PaySheetState {
  status: "open" | "approved" | "cancelled";
  merchant: string;
  currency: string;
  items: LineItem[];
  shippingAddress: Address | null;
  shippingOptions: ShippingOption[];
  tax: number;
  total: number;
  // Set while a merchant callback is in flight; the device shows a spinner.
  busy: { callback: CallbackName; requestId: string } | null;
  error: string | null;
  orderId: string | null;
}

export interface StateSnapshot {
  seq: number;
  paysheet: PaySheetState;
}

// device -> VM
export type DeviceAction =
  | { action: "set_shipping_address"; payload: Address }
  | { action: "select_shipping_option"; payload: { optionId: string } }
  | { action: "approve"; payload: null }
  | { action: "cancel"; payload: null };

export type ToVmMessage = { type: "action"; id: string; ts: number } & DeviceAction;

// VM -> device
export type ToDeviceMessage =
  | { type: "callback_pending"; ref: string; callback: CallbackName; ts: number }
  | {
      type: "callback_result";
      ref: string;
      callback: CallbackName | null;
      status: "resolved" | "rejected";
      reason: string | null;
      ts: number;
    };

export interface SessionMeta {
  status: "waiting" | "active" | "complete" | "cancelled";
  label: string;
  createdAt: number;
  expiresAt: number;
}

// Operator console row (served by GET /api/sessions).
export interface SessionSummary {
  sid: string;
  label: string;
  status: SessionMeta["status"] | "expired";
  createdAt: number;
  expiresAt: number;
  shareUrl: string;
  vmOnline: boolean;
  deviceOnline: boolean;
  total: number | null;
  currency: string;
  busy: CallbackName | null;
}

// RTDB drops nulls and empty arrays on write, so fill them back in on read.
export function normalizePaySheet(p: Partial<PaySheetState>): PaySheetState {
  return {
    status: p.status ?? "open",
    merchant: p.merchant ?? "",
    currency: p.currency ?? "USD",
    items: p.items ?? [],
    shippingAddress: p.shippingAddress ?? null,
    shippingOptions: p.shippingOptions ?? [],
    tax: p.tax ?? 0,
    total: p.total ?? 0,
    busy: p.busy ?? null,
    error: p.error ?? null,
    orderId: p.orderId ?? null,
  };
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
