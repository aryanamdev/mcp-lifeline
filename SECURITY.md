# Security

mcp-lifeline runs inside MCP servers and can kill processes, so bugs that could make it **kill processes it shouldn't** (anything outside the server's own process tree, or another user's processes via `reap`) are treated as security issues.

Please report these privately through GitHub's **"Report a vulnerability"** button on the repository's Security tab instead of opening a public issue. You'll get a response within a few days.

Releases are published from GitHub Actions with npm provenance; you can verify a release with `npm audit signatures`.
