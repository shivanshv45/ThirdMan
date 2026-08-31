import { eq, and } from "drizzle-orm";
import { env, getAppUrl } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";

/**
 * Hand-rolled OAuth2 authorization-code flow for Google and GitHub —
 * no new dependency (CLAUDE.md: no new dependency without a clear
 * reason it can't be done with what's installed). Both providers are
 * a plain, standard exchange: redirect to an authorize URL, receive a
 * code, exchange it server-side for a token, fetch the provider's own
 * profile endpoint. Nothing here needs a library.
 */

export type OAuthProvider = "google" | "github";

interface ProviderConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
};

export function isProviderConfigured(provider: OAuthProvider): boolean {
  const config = PROVIDERS[provider];
  return !!config.clientId && !!config.clientSecret;
}

function redirectUri(provider: OAuthProvider): string {
  return `${getAppUrl()}/api/auth/${provider}/callback`;
}

export function buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
  const config = PROVIDERS[provider];
  if (!config.clientId) {
    throw new Error(`oauth: ${provider} is not configured (missing client id)`);
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(provider),
    scope: config.scope,
    state,
  });

  if (provider === "google") {
    params.set("response_type", "code");
    params.set("access_type", "online");
    params.set("prompt", "select_account");
  }

  return `${config.authorizeUrl}?${params.toString()}`;
}

export interface OAuthProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

async function exchangeCodeForToken(provider: OAuthProvider, code: string): Promise<string> {
  const config = PROVIDERS[provider];
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`oauth: ${provider} is not configured (missing client secret)`);
  }

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri(provider),
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new Error(`oauth: ${provider} token exchange failed with status ${res.status}`);
  }

  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`oauth: ${provider} token exchange returned no access_token (${body.error ?? "unknown error"})`);
  }
  return body.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`oauth: google userinfo fetch failed with status ${res.status}`);

  const profile = (await res.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (!profile.email) throw new Error("oauth: google profile has no email");

  return {
    providerAccountId: profile.sub,
    email: profile.email.toLowerCase(),
    emailVerified: !!profile.email_verified,
    name: profile.name ?? profile.email,
  };
}

async function fetchGithubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "thirdman",
  };

  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error(`oauth: github user fetch failed with status ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string; name: string | null };

  // GitHub's primary email can be private and absent from /user — the
  // verified primary address only shows up via the dedicated emails
  // endpoint, so that's the one source of truth used here.
  const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
  if (!emailsRes.ok) throw new Error(`oauth: github emails fetch failed with status ${emailsRes.status}`);
  const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;

  const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
  if (!primary) throw new Error("oauth: github account has no verified email");

  return {
    providerAccountId: String(user.id),
    email: primary.email.toLowerCase(),
    emailVerified: primary.verified,
    name: user.name ?? user.login,
  };
}

export async function exchangeCodeForProfile(provider: OAuthProvider, code: string): Promise<OAuthProfile> {
  const accessToken = await exchangeCodeForToken(provider, code);
  return provider === "google" ? fetchGoogleProfile(accessToken) : fetchGithubProfile(accessToken);
}

export type ResolveOAuthMerchantResult =
  | { outcome: "signed_in" | "linked" | "created"; merchantId: string }
  | { outcome: "email_taken" };

/**
 * The DB-only half of the OAuth callback — everything after the token
 * exchange, kept separate from the route handler so it's unit-testable
 * without a real provider round-trip (the exchange itself isn't
 * mockable honestly; this is). Three real outcomes plus a fail-closed
 * refusal:
 *
 *   1. This provider identity is already linked -> reuse that merchant.
 *   2. No linked identity, but a merchant already exists with this
 *      provider-VERIFIED email -> link this identity to that merchant
 *      (auto-link — decided with the user, see plans/layer-12).
 *   3. Neither, and the email is free -> create a new merchant with no
 *      password, link the identity.
 *   4. The email is already taken by another account (unverified email,
 *      or a race) -> refuse rather than silently attaching to the wrong
 *      merchant or violating merchants.email's unique constraint.
 */
export async function resolveOrCreateMerchantForOAuth(provider: OAuthProvider, profile: OAuthProfile): Promise<ResolveOAuthMerchantResult> {
  const [existingIdentity] = await db
    .select({ merchantId: schema.oauthIdentities.merchantId })
    .from(schema.oauthIdentities)
    .where(and(eq(schema.oauthIdentities.provider, provider), eq(schema.oauthIdentities.providerAccountId, profile.providerAccountId)));

  if (existingIdentity) {
    return { outcome: "signed_in", merchantId: existingIdentity.merchantId };
  }

  if (profile.emailVerified) {
    const [existingMerchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.email, profile.email));

    if (existingMerchant) {
      await db
        .insert(schema.oauthIdentities)
        .values({
          merchantId: existingMerchant.id,
          provider,
          providerAccountId: profile.providerAccountId,
          email: profile.email,
        })
        .onConflictDoUpdate({
          target: [schema.oauthIdentities.provider, schema.oauthIdentities.providerAccountId],
          set: { merchantId: existingMerchant.id, email: profile.email },
        });

      await logAuditEntry({
        merchantId: existingMerchant.id,
        actor: "merchant",
        event: "oauth_identity_linked",
        decision: "n/a",
        reason: `Linked ${provider} account to existing merchant via verified email match.`,
      });

      return { outcome: "linked", merchantId: existingMerchant.id };
    }
  }

  const [emailTaken] = await db.select({ id: schema.merchants.id }).from(schema.merchants).where(eq(schema.merchants.email, profile.email));
  if (emailTaken) {
    return { outcome: "email_taken" };
  }

  const [merchant] = await db
    .insert(schema.merchants)
    .values({ name: profile.name, email: profile.email, passwordHash: null })
    .returning();

  await db.insert(schema.oauthIdentities).values({
    merchantId: merchant.id,
    provider,
    providerAccountId: profile.providerAccountId,
    email: profile.email,
  });

  await logAuditEntry({
    merchantId: merchant.id,
    actor: "merchant",
    event: "merchant_signed_up",
    decision: "n/a",
    reason: `New merchant account created via ${provider} sign-in for "${profile.name}".`,
  });

  return { outcome: "created", merchantId: merchant.id };
}
