# Security

## Reporting a vulnerability

Please do not describe a security problem in a public issue. Open an issue titled "Security contact" without any details instead, and the maintainer will reply with a private way to send the report.

Useful details for the report: the version or commit, what you ran, what happened and what you expected. A local test page that reproduces the problem is ideal.

## Scan results of real websites

Do not post scan results, screenshots or URLs of websites you do not own, neither in issues nor in pull requests or discussions. A finding is a technical measurement, and published results about a named company can be misread as an accusation. To show a problem, build a small local test page that reproduces it; `src/fixtures.ts` has many examples.

## Scope

consentprobe runs a real browser against the URL you give it and executes that site's scripts in an isolated browser context. Scan only sites you own or are authorized to test, and run it in an environment where visiting that site is acceptable.
