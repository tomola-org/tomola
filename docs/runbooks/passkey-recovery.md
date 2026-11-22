# Manual passkey recovery

Use this procedure when a member who requires passkey-only login or signs posts has lost all usable passkeys. Other members can sign in through an available method and register a replacement in settings.

1. Verify the member through a separate contact channel known before the request, or document the basis on which you personally know the member. A reply from the member’s email address alone is insufficient. Record the method, time, and operator who verified the identity. Omit sensitive evidence such as identity document numbers or answers to secret questions.
2. Confirm the database, `BETTER_AUTH_URL` and `OPERATOR_EMAILS` for the intended environment. Run the command as a registered operator using an account other than the member’s. Both the reason and the verification method are required and kept in the recovery audit record.

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/recover-passkeys.ts operator@example.org member@example.org \
  'Member reported losing access to all passkeys' 'Verified in a call to the previously recorded number. Operator and time recorded.'
```

For Docker Compose, run the command in the app container:

```sh
docker compose exec app pnpm exec tsx scripts/recover-passkeys.ts operator@example.org member@example.org \
  'Member reported losing access to all passkeys' 'Verified in a call to the previously recorded number. Operator and time recorded.'
```

3. The command revokes the member’s old passkeys, challenges, previous recovery permit, sessions, API tokens, MCP connections, and Open in AI links. The worker sends a dedicated registration link to the account’s email address. The link permits one registration with user verification within 30 minutes of issuance. A successful registration consumes the permit, records the completion time in the recovery log, and opens a passkey session while preserving the login preference.
4. Ask the member to try logging in with the new key. Members who sign posts should also confirm they can sign. If the permit expires, check the identity evidence before issuing a new one. Verify delivery through the job status if the member does not receive the link.

Published signatures and their public keys remain available as evidence. Use the device or credential provider’s backup options to establish a second working way to use a passkey.
