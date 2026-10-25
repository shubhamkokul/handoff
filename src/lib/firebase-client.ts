"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  inMemoryPersistence,
  connectAuthEmulator,
  signInWithCustomToken,
} from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, type Database } from "firebase/database";
import type { Role } from "./protocol";

const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
};

// One named Firebase app per role, with in-memory auth. Without this, a VM tab
// and a device tab in the same browser would share (and clobber) one auth session.
export async function connectAs(role: Role | "operator", customToken: string): Promise<Database> {
  const name = `handoff-${role}`;
  let app: FirebaseApp | undefined = getApps().find((a) => a.name === name);
  const fresh = !app;
  app ??= initializeApp(config, name);

  const auth = initializeAuthOnce(app);
  const db = getDatabase(app);

  if (fresh && useEmulators) {
    // Same hostname as the page, so a phone on the LAN reaches the emulators too.
    const host = window.location.hostname;
    connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(db, host, 9000);
  }

  await signInWithCustomToken(auth, customToken);
  return db;
}

const authByApp = new WeakMap<FirebaseApp, ReturnType<typeof initializeAuth>>();
function initializeAuthOnce(app: FirebaseApp) {
  let auth = authByApp.get(app);
  if (!auth) {
    auth = initializeAuth(app, { persistence: inMemoryPersistence });
    authByApp.set(app, auth);
  }
  return auth;
}
