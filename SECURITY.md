# Security policy

## Report a problem

Report a vulnerability in private. Use GitHub private vulnerability reporting
on this repository: Security tab, then "Report a vulnerability".

Do not open a public issue for a vulnerability. Do not include real personal
data in a report.

## What to expect

- We confirm receipt within 5 working days.
- We tell you our plan within 30 days.
- We credit you in the release notes if you want that.

## Supported versions

The package is in development. Only the latest commit on `main` gets fixes.

## Secure defaults

- The package ships no default credentials.
- A board refuses remote image URLs and SVG images, so a board never makes an
  outbound call and never carries script.
- Colours are limited to hex and plain names, so they are safe in SVG output.
- A board treats every synced Yjs update as untrusted. Each read checks every element against
  the same rules as the write methods: types, finite numbers, size caps, colours, and image
  sources. An element that fails the checks is hidden. `repair()` and `Board.decode` delete it.
  This holds when a peer writes to `doc` directly.
