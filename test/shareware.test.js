// THE SHAREWARE IS SHIPPED WHOLE AND UNMODIFIED (operator, 2026-09-18: "this software will alway be
// free. Can you reconcile the stuff needed so we are in 100% compliance with the id shareware?").
//
// Each game's licence makes redistribution conditional on the package being complete and unchanged:
// Quake's SLICNSE.TXT allows passing on "the Software as a whole", Apogee's VENDOR.DOC for
// Wolfenstein 3D requires "all of the Program's files, including this one, as released by us ...
// without modification" and names them. So every file is pinned here to the hash of the official
// release it came from, and a missing, altered or substituted file fails the suite:
//   wolf3d_dos  Apogee / 3D Realms' 1wolf14.zip (ftp.3drealms.com/share/, via the Wayback Machine),
//               unpacked by running its own INSTALL.EXE on the emulated PC. An earlier mirror copy
//               of the same zip carried a different WOLF3D.EXE; the one here is 3D Realms'.
//   doom_dos    id's doom19s.zip (idstuff/doom/)
//   quake_dos   id's quake106.zip (idstuff/quake/)
// The game-written settings (CONFIG.WL1, DEFAULT.CFG, ID1/CONFIG.CFG) are not part of any release and
// are not pinned. NOTICE names each game's terms; the test below holds it to that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES = {
  wolf3d_dos: {
    'AUDIOHED.WL1': '39351624ae6f8eef4b873e060c1a6f3e5ee7e81c4939c485275a89b145336338',
    'AUDIOT.WL1': '1e2c9ae30398a14c61a4ddd39aabaa0dbcc984cc4924a3e51df75574c259cfb9',
    'FILE_ID.DIZ': '840242ab486718872c865f4feed86b7bd874bf0d7e339977956e347dac97dfca',
    'GAMEMAPS.WL1': 'a6a6654b342f2c027bcb22bfce0a41f9fc0063b775e9e4da0c771970e53e11aa',
    'MAPHEAD.WL1': '3458f661c9b875bca99ea22a7267771fad8f2a33c699ea732cf7c3322909bf8c',
    'ORDER.FRM': 'e0596c5390896a27001f6cf263bc7a6b5f087a7499c5df18f1530de6c959bcd4',
    'VENDOR.DOC': 'fc1f4c23122702198eaa0df09a12af135801bdc835317638f2b895e948a33710',
    'VGADICT.WL1': '59878fec65f033b00dbb1240317d1793f5858213dc8013b4d68f9ac8b45b0c80',
    'VGAGRAPH.WL1': 'd5176f843c53415132db199c19f38591eaf3cedd35a4f7eb2698c1865d83030d',
    'VGAHEAD.WL1': 'f4cc800dc8444373092d4eaa5d6ab59d63d23a510a9d38b73ca9b3dbb700d18b',
    'VSWAP.WL1': '698f217257e2cbb951a4d110ba09140291f38d0121b3784d1d6be59c03a6b47b',
    'W3DHELP.EXE': 'ea226934cbfa1d11060992c2201aabe6c5e2310a117225dd0388a068d5b23684',
    'WOLF3D.EXE': '75bd63f1db75be77a9dfd317144fec2a86d2a409dd3b6847a251a2565b646280',
  },
  doom_dos: {
    'DM.DOC': 'aade82ddad8b05b9e57121b80158893d2b3f2f8a2eed9147e720947dd9821b4e',
    'DM.EXE': '2725df25c7536aa98a4e6282e61e17186777f54074e6fa56d9a38825dd1c7e09',
    'DMFAQ66A.TXT': '794a4c94f78b724dcffa6a4ee44337e0e2bb41be612967d2cae5a9380f67638b',
    'DMFAQ66B.TXT': 'ba677bc04a55e5c829befb3cc3ba950c5056247269f7620327714dde93023900',
    'DMFAQ66C.TXT': '43163af971e20064e3431fdde14977c66928b064e8fab1e48c343d44ac26be19',
    'DMFAQ66D.TXT': '9776b1976fb00c14cbe3c89d882c52bea0e3fe6a4522a4305763d58b31068471',
    'DOOM1.WAD': '1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771',
    'DOOM.EXE': 'b8020523561a5ad9706e009a52d61c578f37faafd85ac471962308406292ce27',
    'DWANGO.DOC': '2300bcb497b18389de4fa8ed7c2822710967b4a26d6d162bccae9cd8cebd0cee',
    'DWANGO.EXE': '724486508cb23da93986c34336299972fbfaa2509a9ed18b0ec2832e07d600ca',
    'DWANGO.STR': 'b4f93bc9d74e22f3b489e574b71189a931f963e76f4ea8da4d34e22c8be0971c',
    'HELPME.TXT': 'b8ee1678923e1130700ec6a73cf50ed320091c9f79a933124e8c99e347aae5f5',
    'IPXSETUP.EXE': '1e5eeb2e3b6f526d603f19ed08c00668e04bd2b7e6439c109b84b1c61d283d51',
    'MODEM.CFG': '0eb17ba5df3f319a02325401c9fbe212a3aa9065d63d4b7bd49d75bd2bb0268b',
    'MODEM.NUM': '604a8033fa26c634a758006e318573206d123419fefc9df8cf76f2b1e67ba105',
    'MODEM.STR': '84a5af6596ce180bdb03a0bee414421538c27df5b0722041213cec953099d1d2',
    'ORDER.FRM': 'a7fa68a0021b3d04abd781e74175511a1a96d923c544fce19805ea5a9696df86',
    'README.TXT': '17878ebe5ca179de7ec2cc90bbabbc922ab69924118be168a25f8d317f65a2ff',
    'SERSETUP.EXE': '94cf23eac5fc43da942f9529e9ff4dd6dc5aab82fe348bd72eb7de971d9170f5',
    'SETUP.EXE': 'c9d328bff268854414feae5459870aac6f779e55a9cbf4568a83fef9b7be6e15',
  },
  quake_dos: {
    'CWSDPMI.EXE': '0a890815df6cbdc052915a856c16944cedec825267e7b6e453c351a0cdc695f2',
    'GENVXD.DLL': 'ef446c02db3adc5687288739b484ad933d9e1ce8c196f8951b969b1bc3c7d776',
    'HELP.TXT': 'fb762348875647992b53732d50e41cf966cfecaca7c6ea2f7f682742d84a9f54',
    'ID1/PAK0.PAK': '35a9c55e5e5a284a159ad2a62e0e8def23d829561fe2f54eb402dbc0a9a946af',
    'LICINFO.TXT': '8d654834d085c088d603fb6879a874799e8b4cc6ae9317bbf826afd83bc72e31',
    'MGENVXD.VXD': '4568f96cb70a2abf47f156f1fb1b432019155b6b4e5e3bf5fd773e1ecf5ee3e0',
    'ORDER.TXT': '1e04e5899b36c3e47dac6c771cb1fdaee0e1528db0d720b8db06e83ea5c631da',
    'PDIPX.COM': '868c16e2a561ebc955ab873013a8b2a5e6d2cdd95d185915da51a9294dea15e9',
    'Q95.BAT': 'cac38ce5180160a624353c9bc0baede63613e5aa3bca07653145bc9943323deb',
    'QLAUNCH.EXE': '83ce5209f15623fd0a00726e1e6cfee900829971e3294270b8efbca28ea1aac3',
    'QUAKE.EXE': '7cdb244122cc607cc6f162524bfcac60f6d11d8ca2ff07473d6cd962311161fb',
    'QUAKEUDP.DLL': 'de88488c178319d5e4aaf3a9d664406f6df8e8cc049d87dfdc048a254598137a',
    'README.TXT': '9ade267c7e22a1c4c4aa8fa3dd58ad3354c173ae2cfc39344093cea534316d61',
    'READV106.TXT': '0a496875fce806ebc175bc6bebedc9d739381dceacc5636cf83ef60cf056ab0d',
    'SLICNSE.TXT': '070cdf6a6410adef8fb5f83a4e5ccdb9e2301d2e48d460bb3a67a0f5ba9d70a8',
    'TECHINFO.TXT': 'b7c080df7487e69b0c3f9c6b3a8eff5ce29741f5c596d3d6a08534649691d314',
  },
};
const GENERATED = /^(CONFIG\.WL1|DEFAULT\.CFG|ID1\/CONFIG\.CFG)$/;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function listed(dir, pre = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, pre))) {
    if (e.startsWith('.')) continue;                     // macOS ._ forks, never shipped (.gitignore)
    const rel = pre ? `${pre}/${e}` : e;
    if (fs.statSync(path.join(dir, rel)).isDirectory()) out.push(...listed(dir, rel)); else out.push(rel);
  }
  return out;
}

test('each game is its official shareware release: every file present and byte for byte', () => {
  let seen = 0;
  for (const [game, files] of Object.entries(RELEASES)) {
    const dir = path.join(ROOT, 'games', game);
    if (!fs.existsSync(dir)) continue;                   // a checkout without the game files
    seen++;
    for (const [rel, want] of Object.entries(files)) {
      const p = path.join(dir, rel);
      assert.ok(fs.existsSync(p), `${game}/${rel} is missing: the licence requires the package whole`);
      assert.equal(sha(p), want, `${game}/${rel} differs from the official release`);
    }
    const extra = listed(dir).filter((rel) => !(rel in files) && !GENERATED.test(rel));
    assert.deepEqual(extra, [], `${game} carries files that are not in its release`);
  }
  assert.ok(seen > 0 || !fs.existsSync(path.join(ROOT, 'games')), 'the games that are here were checked');
});

test('each game ships its own terms, and NOTICE names them', () => {
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  for (const [game, terms] of [['wolf3d_dos', 'VENDOR.DOC'], ['doom_dos', 'README.TXT'], ['quake_dos', 'SLICNSE.TXT']]) {
    assert.ok(terms in RELEASES[game], `${game}'s ${terms} is pinned above`);
    assert.match(notice, new RegExp(`games/${game}/[\\s\\S]*?${terms.replace('.', '\\.')}`), `NOTICE points to ${game}'s ${terms}`);
  }
  assert.match(notice, /NOT COVERED BY THE APACHE LICENSE/, 'and says the Apache licence does not reach them');
  // VENDOR.DOC [3][A][1]: the files it names "must always be included" -- read from the document itself
  const vendor = fs.readFileSync(path.join(ROOT, 'games', 'wolf3d_dos', 'VENDOR.DOC'), 'latin1');
  const named = [...vendor.matchAll(/^\s*\S\s+([a-z0-9]+)\s+(exe|wl1|frm)\b/gim)].map((m) => `${m[1]}.${m[2]}`.toUpperCase());
  assert.ok(named.length >= 10, `VENDOR.DOC's list was read (${named.join(' ')})`);
  for (const f of named) assert.ok(f in RELEASES.wolf3d_dos, `VENDOR.DOC requires ${f}`);
});

test('Apogee is named wherever Wolfenstein 3D is described', () => {
  // VENDOR.DOC: "All advertising of the Program must include \"Apogee\" in the description."
  for (const f of ['README.md', 'docs/USER-GUIDE.md', 'public/js/wolf3d.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /Apogee/, `${f} names Apogee`);
  }
});
