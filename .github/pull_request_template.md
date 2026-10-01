## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm test` and `npm run typecheck` pass
- [ ] New behavior has a test that fails without the change (Graph is mocked, no real mailbox)
- [ ] Test data is synthetic: no real email content, addresses or tokens
- [ ] Destructive tools keep their safe defaults (`dryRun`, move to Deleted Items) and MCP annotations are accurate
- [ ] No new Graph permission, or the README and `SCOPES` are updated and the reason is explained above
- [ ] `CHANGELOG.md` has a line under `Unreleased` if users will notice the change
