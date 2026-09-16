# Security policy

## Supported versions

| version | supported |
|---|---|
| 0.1.x | yes |
| 0.0.9 and earlier | no: upgrade. 0.0.9 shipped bound to every interface with no sign-in, and later audits fixed issues it still has |

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. On GitHub, open the repository's **Security** tab and choose **Report a vulnerability**
   (private vulnerability reporting), or
2. contact the maintainer through their GitHub profile and ask for a private channel.

Include what you found, the version or commit, how to reproduce it, and the impact you
expect. If you have a fix in mind, describe it — but please do not open a public pull request
for an unpatched vulnerability.

What to expect:

- an acknowledgement within a few days;
- an assessment and, if confirmed, a fix and a release with credit to you (unless you prefer
  otherwise);
- coordinated disclosure once a fixed release is available.

## Scope

In scope: the monitor's server and browser code in this repository — authentication and
sessions, the RPC allowlist and node-write gates, the HTTP API, the CSP and other headers, and
anything that could leak node data or credentials.

Out of scope: vulnerabilities in the Bitcoin node itself (report those to the node's project),
in Node.js, or in the exchanges whose public APIs the Markets tab reads; and deployments that
deliberately expose an open (no-accounts) monitor to untrusted networks — that is a
configuration choice described in [docs/SECURITY.md](docs/SECURITY.md).
