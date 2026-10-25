import "server-only";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";

const app =
  getApps()[0] ??
  initializeApp({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    // Emulators accept unsigned tokens. A real project signs custom tokens
    // locally with the service-account key; cert() (unlike applicationDefault())
    // avoids a round trip to the IAM signBlob API, which isn't enabled.
    ...(useEmulators ? {} : { credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS!) }),
  });

export const adminAuth = getAuth(app);
export const adminDb = getDatabase(app);
