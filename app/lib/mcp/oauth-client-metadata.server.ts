const logoutFields = [
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "post_logout_redirect_uris",
  "enable_end_session",
] as const;

export function omitClientLogoutMetadata(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const field of logoutFields) Reflect.deleteProperty(value, field);
  }
}

export const disabledClientLogout = {
  backchannelLogoutUri: null,
  backchannelLogoutSessionRequired: null,
  postLogoutRedirectUris: null,
  enableEndSession: null,
};
