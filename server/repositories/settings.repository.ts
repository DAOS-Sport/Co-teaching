/**
 * User + system settings repository.
 *
 * Owns the small leaf tables (`users` for Replit Auth and the simple
 * key/value `system_settings` table). The IStorage façade in
 * `server/storage.ts` delegates here.
 */
import { eq } from "drizzle-orm";
// #3: follows the caller's transaction (see shared/dbContext).
import { txDb as db } from "../shared/dbContext";
import {
  users,
  systemSettings,
  type User,
  type UpsertUser,
} from "@shared/schema";

export class SettingsRepository {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: { ...userData, updatedAt: new Date() },
      })
      .returning();
    return user;
  }

  async getSetting(key: string): Promise<string | null> {
    const [result] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key));
    return result?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await db
      .insert(systemSettings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}
