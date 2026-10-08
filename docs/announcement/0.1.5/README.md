# The 0.1.5 announcement

For the bitcointalk thread (https://bitcointalk.org/index.php?topic=5594141): the release post for
0.1.5 (2026-10-08). It covers 0.1.4 too, which never had a post of its own.

`blockyard-0.1.5-announcement.txt` is the post in Markdown; `blockyard-0.1.5-announcement.bbcode` is
the same post in BBCode for the forum, generated from it. Three pictures are marked
`IMAGE-URL-FOR:<file>` until they are uploaded to talkimg.com: `overview.jpg` at the top,
`block-space-mode1.jpg` in the Simple section, `block-space-mode2.jpg` (the Detailed board) beside
the section on Core's block. Those three are copied into `talkimg/` to drag on in one go. The four
pictures of the full renderers reuse 0.1.3's talkimg links (the Sun, the Formation, chrome, ball
lightning), so they need no upload. `kiosk.jpg` is here for the thread.

Every new picture was shot at 0.1.5 on 2026-10-08 against the local Core node with
`scripts/shots.mjs`, in a fresh browser profile set to "This browser" settings with nothing saved, so
they show the SHIPPED defaults (Simple, still sky) and the operator's shared settings were never
written. `docs/images/` was left as it was: the README's pictures show the full renderers.

The post leads with Simple as the default and an invitation to explore WebGL and Software, then the
pushed mempool, the Detailed board as Core's block, 0.1.4's security audit, smaller fixes, and npm's
retirement with the migration for an npm install. The full list is `CHANGELOG.md` under 0.1.5.
