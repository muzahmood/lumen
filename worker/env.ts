export interface Env {
  DB: D1Database;
  /** Default file storage (free, no card needed). */
  FILES_KV?: KVNamespace;
  /** Optional: R2 bucket. When bound, new uploads go here instead of KV. */
  FILES_BUCKET?: R2Bucket;
  /** Optional: R2 bucket for automatic weekly backups (made and sealed by the app; see /api/backups). */
  BACKUP_BUCKET?: R2Bucket;
  ASSETS?: Fetcher;
  /** Required in production, e.g. https://yourteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Required in production: the Access application's Audience (AUD) tag. Several may be listed, separated by commas. */
  ACCESS_AUD?: string;
  /** Optional: only these emails may open the notes, even if the Access policy is broader. Comma-separated. */
  ACCESS_ALLOWED_EMAILS?: string;
  /** Set only by `wrangler dev --var LOCAL_DEV:true` (never deployed). Lets http://localhost run without Access. */
  LOCAL_DEV?: string;
}

export interface User {
  email: string | null;
  verified: boolean;
  /** How the request was authenticated. */
  via: 'access' | 'local';
}

export type AppEnv = { Bindings: Env; Variables: { user: User } };
