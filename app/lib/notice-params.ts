export const POST_NOTICE_PARAMS = ["posted", "edited", "followed"] as const;
export const REAUTH_RETURN_PARAM = "reverified";
export const NOTICE_PARAMS = [...POST_NOTICE_PARAMS, REAUTH_RETURN_PARAM] as const;
