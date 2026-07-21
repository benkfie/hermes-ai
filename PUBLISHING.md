# Publishing hermes-ai to GitHub

This branch (`publish/github`) is a **clean, publish-ready** fork of
`joaompfp/hermes-vscode` (v3.0.0). All personal data has been removed from the
entire commit history:

- Commit author/committer for local work is `benkfie <benkfie>` (no personal email).
- Upstream commits by `joaompfp` retain their original public attribution.
- Forgejo server URLs / internal IPs (`100.96.127.43`, `100.103.119.5`) rewritten to
  `https://github.com/benkfie/hermes-ai`.
- Personal paths (`C:\Users\Ben`, `/c/Users/Ben`) and `benkentfiebig` handle removed.
- No API keys, tokens, or SSH private keys are present anywhere in history.

## Steps to publish

1. Create the GitHub repo (owner `benkfie`, name `hermes-ai`):
   https://github.com/new

2. Add the GitHub remote and push this branch:
   ```bash
   git remote add github https://github.com/benkfie/hermes-ai.git
   git push -u github publish/github
   # then, to publish as the default branch:
   git push github publish/github:main
   ```

3. On GitHub, open a PR against the upstream if you want it merged:
   base: `joaompfp/hermes-vscode:main`, head: `benkfie/hermes-ai:main`.

4. (Optional) Create a release / publish the VSIX:
   ```bash
   npm install
   npm run package            # produces hermes-ai-<version>.vsix
   gh release create v1.0.2 hermes-ai-1.0.2.vsix
   ```

## Notes
- `dev-install.bat` is a local dev convenience (builds + installs into Antigravity
  IDE). It derives the VSIX filename from `package.json` automatically.
- The `Antigravity IDE` references describe the editor this extension also targets;
  it is a product name, not personal data.
