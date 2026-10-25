import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

// Read-only token for the operator console so it can subscribe to sessions
// live. Demo only: in production this sits behind your own staff auth.
export async function POST() {
  const token = await adminAuth().createCustomToken("operator", { role: "operator" });
  return NextResponse.json({ token });
}
