// Writes the FICTIONAL sample files used by the README guide and the screenshots:
//   samples/ig_whitelist_sample.xlsx           the workbook you upload
//   samples/export/following.html              }
//   samples/export/followers_1.html            } same layout as Instagram's "Download your information"
//   samples/export/recently_unfollowed_profiles.html
// Every account is made up (*_demo); nothing here comes from a real profile.
// Run with: npm run samples
const fs = require('fs');
const path = require('path');
const model = require('../test-dist/src/offline/model.js');
const { sheetsFromData } = require('../test-dist/src/offline/workbook.js');
const { writeXlsx } = require('../test-dist/src/offline/xlsx.js');

const firsts = ['ana', 'ben', 'cara', 'dan', 'eli', 'fay', 'gus', 'hana', 'ivo', 'jade', 'kai', 'lena', 'milo', 'nora', 'omar', 'pia', 'quin', 'rae', 'sol', 'tess',
  'uma', 'vic', 'wren', 'xena', 'yara', 'zed', 'abel', 'bea', 'cyrus', 'dara', 'emil', 'fern', 'gil', 'hope', 'ian', 'june', 'knox', 'lia', 'mara', 'nico'];
const n = i => `${firsts[i]}_demo`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => n(a + i));

// Who follows whom
const mutual = range(0, 19); // follow you back
const nonFollowers = range(20, 35); // you follow them, they do not follow you
const deleted = ['__deleted__demoaaa111', '__deleted__demobbb222', '__deleted__democcc333'];
const following = [...mutual, ...nonFollowers, ...deleted];
const followers = [...mutual, ...range(36, 39), 'emil_new']; // emil_demo renamed to emil_new

// What the workbook says about them
let data = model.emptyData();
const flag = (fn, ...names) => { for (const name of names) data = fn(data, name, true); };
flag(model.setWhitelisted, ...range(20, 25)); //   6 whitelisted
flag(model.setDeactivated, n(22)); //               wren: whitelisted AND deactivated
flag(model.setDeactivated, ...range(26, 29)); //    4 deactivated
flag(model.setDeactivated, n(8)); //                ivo follows you now: "Active again"
data = model.setNewUsername(data, n(30), 'emil_new'); // renamed
flag(model.setUnfollowedYou, n(31)); //             fern unfollowed you (tracking)
flag(model.setDeactivated, 'ghost_demo'); //        in neither list: "Missing"
flag(model.setWhitelisted, 'gone_demo'); //         you unfollowed it recently: not "Missing"
data = model.markUnfollowed(data, 'gone_demo', '2026-11-12');
// A column of your own ("notes") sits between the standard ones: the checker keeps it, and keeps this column order.
const notes = { [n(20)]: 'coworker', [n(23)]: 'met at the gym', [n(31)]: 'cousin' };
data = {
  ...data,
  accounts: data.accounts.map(account => (notes[account.username] ? { ...account, extra: { notes: notes[account.username] } } : account)),
  whiteListHeader: ['username', 'profile_link', 'notes', 'is_whitelisted', 'is_deactivated', 'new_username', 'unfollowed', 'is_deleted'],
};
const EXPORT_DAY = '2026-11-20'; //   the date of the sample export (it is written into the HTML, like Instagram does)
const PREVIOUS_DAY = '2026-10-20'; //  the snapshot already stored in the sample workbook
data = { ...data, following: { name: 'following.html', usernames: following }, followerFiles: [{ name: 'followers_1.html', usernames: followers, generatedOn: EXPORT_DAY }] };

// The workbook stores the PREVIOUS snapshot. Compared with the sample export it shows 3 new followers and 4 lost ones:
// lost1/2/3_demo unfollowed (or something else, only a look at the profile tells) and ghost_demo (marked deactivated).
const previousSnapshot = [
  ...mutual.map(name => ({ username: name, firstSeen: '2026-09-01', lastSeen: PREVIOUS_DAY })),
  { username: n(36), firstSeen: '2026-10-02', lastSeen: PREVIOUS_DAY },
  { username: n(37), firstSeen: '2026-10-10', lastSeen: PREVIOUS_DAY },
  { username: 'lost1_demo', firstSeen: '2026-09-01', lastSeen: PREVIOUS_DAY },
  { username: 'lost2_demo', firstSeen: '2026-09-01', lastSeen: PREVIOUS_DAY },
  { username: 'lost3_demo', firstSeen: '2026-09-15', lastSeen: PREVIOUS_DAY },
  { username: 'ghost_demo', firstSeen: '2026-09-01', lastSeen: PREVIOUS_DAY },
];

// ---- workbook ----
const out = path.resolve(__dirname, '..', 'samples');
fs.mkdirSync(path.join(out, 'export'), { recursive: true });
const sheets = sheetsFromData(data, EXPORT_DAY).map(sheet =>
  sheet.name === 'followers_snapshot'
    ? { ...sheet, rows: [sheet.rows[0], ...previousSnapshot.map(r => [r.username, `https://www.instagram.com/${r.username}`, r.firstSeen, r.lastSeen])] }
    : sheet);
fs.writeFileSync(path.join(out, 'ig_whitelist_sample.xlsx'), Buffer.from(writeXlsx(sheets)));

// ---- Instagram-style HTML (same markup the real export uses for these pages) ----
const MONTHS = ['Nov', 'Oct', 'Sep', 'Aug', 'Jul', 'Jun'];
const date = i => `${MONTHS[Math.floor(i / 9) % MONTHS.length]} ${String(28 - (i % 9) * 3).padStart(2, '0')}, 2026 ${(i % 11) + 1}:${String((i * 7) % 60).padStart(2, '0')} ${i % 2 ? 'pm' : 'am'}`;
const page = (title, subtitle, body) => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><title>${title}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;font-size:13px;background:#e9ebee;max-width:760px;margin:0 auto;padding:12px}
.pam{background:#fff;margin:6px 0;padding:10px;border-radius:8px}h1{font-size:16px}.note{background:#fff3cd;padding:8px;border-radius:6px}</style></head>
<body><div><div><header><h1>${title}</h1>${subtitle}
<aside role="contentinfo">Generated for the sample on <time datetime="${EXPORT_DAY}T08:34Z">Friday, November 20, 2026 at 8:34 AM UTC</time></aside>
<p class="note">SAMPLE DATA: made-up accounts for the README guide. Not a real Instagram export.</p></header>
<main>${body}</main></div></div></body></html>
`;
const followersBody = followers.map((name, i) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/${name}">${name}</a></div><div>${date(i)}</div></div></div></div>`).join('');
const followingBody = following.map((name, i) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${name}</h2><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/${name}">https://www.instagram.com/_u/${name}</a></div><div>${date(i)}</div></div></div></div>`).join('');
const unfollowedNames = ['gone_demo', 'old_pal_demo', 'quiet_demo'];
const unfollowedBody = unfollowedNames.map((name, i) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><table style="table-layout: fixed;"><tr><td class="_a6_q">Name</td><td class="_2piu _a6_r">${name.split('_')[0]}</td></tr><tr><td class="_a6_q">Username</td><td class="_2piu _a6_r">${name}</td></tr></table></div><div class="_3-94 _a6-o">${date(i)}</div></div>`).join('');

fs.writeFileSync(path.join(out, 'export', 'followers_1.html'), page('Followers', '', followersBody));
fs.writeFileSync(path.join(out, 'export', 'following.html'), page('Following', '<p>Profiles you choose to see content from</p>', followingBody));
fs.writeFileSync(path.join(out, 'export', 'recently_unfollowed_profiles.html'), page('Recently unfollowed profiles', '<p>Profiles that you have recently stopped following</p>', unfollowedBody));

console.log(`samples written to ${path.relative(process.cwd(), out)}: ${following.length} following, ${followers.length} followers, ${data.accounts.length} workbook accounts`);
