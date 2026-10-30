export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  ASSETS: Fetcher;
  /** Cloudflare Access team domain, e.g. "jeff" for jeff.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN: string;
  /** Audience tag of the Access application protecting this Worker. */
  ACCESS_AUD: string;
  /** Comma-separated emails allowed in, on top of the Access policy. Empty = any Access user. */
  ALLOWED_EMAILS: string;
  /** Days after an address is created in the app during which its first sender is auto-approved. */
  AUTO_ALLOW_DAYS: string;
  /** The domain newsletters are sent to, e.g. "example.com". Shown in the app when creating addresses. */
  MAIL_DOMAIN: string;
  /** Client ID of the Cloudflare Access service token the PC helper signs in with. */
  HELPER_CLIENT_ID: string;
  /** Local development only (.dev.vars). */
  DEV_BYPASS_AUTH?: string;
  DEV_EMAIL?: string;
}

export type AppVariables = {
  /** Set for people; empty for the helper. */
  userEmail: string;
};
