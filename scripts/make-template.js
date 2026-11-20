// Writes templates/ig_whitelist_template.xlsx: the blank base workbook
// (white_list / new_followingxfollowers / unfollowed tabs, headers only).
// Run with: npm run template
const fs = require('fs');
const path = require('path');
const { writeWorkbook } = require('../test-dist/src/offline/workbook.js');
const { emptyData } = require('../test-dist/src/offline/model.js');

const out = path.resolve(__dirname, '..', 'templates', 'ig_whitelist_template.xlsx');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(writeWorkbook(emptyData())));
console.log('wrote', path.relative(process.cwd(), out));
