# Security

## Reporting a vulnerability

Please do not describe a security problem in a public issue. Open an issue titled "Security contact" without any details instead, and the maintainer will reply with a private way to send the report.

Useful details for the report: the version or commit, what you ran, what happened and what you expected. A local test page that reproduces the problem is ideal.

## Scan results of real websites

Do not post scan results, screenshots or URLs of websites you do not own, neither in issues nor in pull requests or discussions. A finding is a technical measurement, and published results about a named company can be misread as an accusation. To show a problem, build a small local test page that reproduces it; `src/fixtures.ts` has many examples.

## Scope

consentprobe runs a real browser against the URL you give it and executes that site's scripts. Each visit gets a fresh browser context (no shared cookies or storage), but that is not a security boundary: Playwright starts Chromium without its OS sandbox (`--no-sandbox`, its default so it works in containers and CI). Treat a scan like opening the site in a browser you do not otherwise use, and scan untrusted sites in a disposable environment such as a container or a CI runner.

consentprobe never requests hosts on the machine or the local network (localhost, private and link-local addresses, `.local` and `.internal` names) on behalf of a page through its legal-link check, also not after a redirect. The only exception is the local host you typed yourself (a dev server): its own legal pages are checked, every other local address stays blocked. It does not resolve DNS names first, so a public name that points to a private address is not caught. The browser visit itself loads what the page loads, like any browser. Credentials in the URL are sent only to the origin you typed.

Scan only sites you own or are authorized to test.
