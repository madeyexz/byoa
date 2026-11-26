// The MCP SDK's client side of MCP authorization (OAuth 2.1 with PKCE), kept in a plain JSON object that byoa stores
// encrypted. The SDK uses a Client ID Metadata Document (the app's `clientMetadataUrl`) when the authorization server
// says it supports them, and Dynamic Client Registration only when it does not (R2.1).
// Adapted from Bookish src/core/oauth.ts.
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomToken } from '../crypto.ts'

export interface OAuthConfig {
  /** Where the MCP server's sign-in page sends the browser back; the app's route calls `finishMcp` there. */
  redirectUrl: string
  /** The HTTPS URL where the app serves `clientMetadataDocument(...)`. Without it, byoa uses only Dynamic Client
   *  Registration. */
  clientMetadataUrl?: string
  /** The name the MCP server shows on its consent page. */
  clientName: string
}

/** A sign-in's state as the SDK keeps it. `at`: when `tokens` were saved (expires_in counts from then). */
export interface OAuthState {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  at?: number
  verifier?: string
  discovery?: OAuthDiscoveryState
}

/** The Client ID Metadata Document the app serves at `clientMetadataUrl`. */
export function clientMetadataDocument(c: OAuthConfig): OAuthClientMetadata & { client_id: string } {
  if (!c.clientMetadataUrl) throw new Error('byoa: clientMetadataDocument needs oauth.clientMetadataUrl')
  return { client_id: c.clientMetadataUrl, ...metadata(c) }
}

const metadata = (c: OAuthConfig): OAuthClientMetadata => ({
  client_name: c.clientName,
  redirect_uris: [c.redirectUrl],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
})

export class Provider implements OAuthClientProvider {
  /** Where `redirectToAuthorization` sent the user. A refresh that needs a new sign-in ends here too. */
  url?: URL
  readonly id = randomToken(18)
  readonly config: OAuthConfig
  s: OAuthState
  constructor(config: OAuthConfig, s: OAuthState = {}) { this.config = config; this.s = s }
  get redirectUrl() { return this.config.redirectUrl }
  get clientMetadataUrl() { return this.config.clientMetadataUrl }
  get clientMetadata() { return metadata(this.config) }
  state() { return this.id }
  clientInformation() { return this.s.client }
  saveClientInformation(c: OAuthClientInformationMixed) { this.s.client = c }
  tokens() { return this.s.tokens }
  saveTokens(t: OAuthTokens) { this.s.tokens = t; this.s.at = Date.now() }
  redirectToAuthorization(u: URL) { this.url = u }
  saveCodeVerifier(v: string) { this.s.verifier = v }
  codeVerifier() { if (!this.s.verifier) throw new Error('byoa: no code verifier'); return this.s.verifier }
  saveDiscoveryState(d: OAuthDiscoveryState) { this.s.discovery = d }
  discoveryState() { return this.s.discovery }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.s.client = undefined
    if (scope === 'all' || scope === 'tokens') { this.s.tokens = undefined; this.s.at = undefined }
    if (scope === 'all' || scope === 'verifier') this.s.verifier = undefined
    if (scope === 'all' || scope === 'discovery') this.s.discovery = undefined
  }
}
