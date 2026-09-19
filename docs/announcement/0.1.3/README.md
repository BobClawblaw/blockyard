# The 0.1.3 announcement

For the bitcointalk thread (https://bitcointalk.org/index.php?topic=5594141): a release post for
0.1.3, two days after 0.1.2.

`blockyard-0.1.3-announcement.txt` is the post in Markdown; `blockyard-0.1.3-announcement.bbcode`
is the same post in BBCode for the forum, generated from it so the two cannot drift. Its three
pictures are marked `IMAGE-URL-FOR:<file>` until they are uploaded to talkimg.com and the links put
in: `overview.jpg` at the top, `about.jpg` (the Bitcoin Machine Code card) beside that section, and
`chain.jpg` (Chain & Sync) beside the charts. The other screenshots are here too, for the thread.

Every picture was shot at 0.1.3 on 2026-09-19 against the local Core node with
`scripts/shots.mjs`, and is a copy of `docs/images/`. No Bitcoin Machine Code node was configured
when they were taken -- run 27 was benchmarking its initial sync, and BlockYard's polling would have
disturbed the timing -- so the Chain & Sync shot is of a synced Core node.

The post leads with Bitcoin Machine Code as BlockYard's companion node (and its experimental
warning), then the four-wide RPC lane, the chart fixes found by watching a node in initial sync, the
Diversions, and what to know when upgrading from 0.1.2. The full list is `CHANGELOG.md` under 0.1.3.
