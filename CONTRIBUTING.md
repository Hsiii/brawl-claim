# Contributing

Issues and focused pull requests are welcome.

1. Describe the problem or proposed behavior before a large change.
2. Create a branch from `main`.
3. Install and validate the project:

   ```bash
   bun install --frozen-lockfile
   bun run build
   bun audit
   ```

4. Keep credentials, `.env*`, `.data/`, browser profiles, screenshots, and
   production details out of commits and issue attachments.
5. Use a conventional commit message and explain user-visible behavior in the
   pull request.

Changes that weaken authentication, signature verification, user isolation, or
claim-result verification need explicit justification and testing notes.
