# Contributing

Thanks for taking the time. Mail-MCP is deliberately small, so the most useful contributions are bug reports, fixes, and focused tools that make cleaning up a personal inbox safer or faster.

## Setup

Node.js 22 or newer.

```bash
git clone https://github.com/Rixtayz/Mail-MCP.git
cd Mail-MCP
npm install
npm test
npm run typecheck
npm run build
npm run inspect    # MCP Inspector against dist/index.js
```

The tests mock Microsoft Graph and need no account. To try the server against your own mailbox, follow the README to register an Entra app, then `MAIL_MCP_CLIENT_ID=<id> npm run login`.

## Ground rules

1. **No real mail data, ever.** Not in fixtures, not in issues, not in pull requests. Build test messages and headers by hand, with placeholder senders such as `news@example.com`.
2. **Safe by default.** Deletion moves to Deleted Items unless `permanent: true` is passed. Bulk actions support `dryRun`. Every tool declares accurate MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so hosts can auto-approve read-only calls and confirm the rest.
3. **No generic send tool.** `Mail.Send` exists only for `mailto:` unsubscribe requests. A feature that needs more is a discussion for an issue first.
4. **Least privilege.** A new Graph permission needs a reason in the pull request, and the README's permission list and `SCOPES` in [`src/constants.ts`](src/constants.ts) change together.
5. **Tests first.** Every behavior change comes with a test that fails without it. CI runs on Linux, macOS and Windows with Node 22 and 24.

## Layout

Business logic lives in [`src/mail.ts`](src/mail.ts) and talks to Graph only through [`GraphClient`](src/graph.ts), which tests replace with a mocked `fetch`. Tool definitions in [`src/tools/`](src/tools) stay thin: a zod input schema, an output schema, annotations, and a call into `MailService`.

## Pull requests

- Keep them focused: one change per pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

Security problems go through [SECURITY.md](SECURITY.md) rather than a public issue.

## Releasing (maintainer)

1. Bump the version in `package.json` and in both `version` fields of `server.json`, then run `npm install --package-lock-only`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version.
3. Commit, then `npm publish` (typecheck, tests and build run first).
4. Tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main vX.Y.Z`.
5. Run **Publish to MCP Registry** from the Actions tab. It checks that `server.json` matches the version now on npm, then publishes through GitHub OIDC.
6. Create the GitHub release from the tag, with the changelog entry as notes.
