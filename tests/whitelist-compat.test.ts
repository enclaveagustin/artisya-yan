import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUserList } from "../src/utils/validation";

// Shapes the previous app versions wrote into localStorage ("iu_whitelisted-results").
const oldScanEntry = {
  id: "5551234567", username: "some.user_1", full_name: "Some User",
  profile_pic_url: "https://scontent.cdninstagram.com/v/t51/abc.jpg?stp=dst-jpg&_nc_ht=x",
  is_private: true, is_verified: false, followed_by_viewer: true, follows_viewer: false, requested_by_viewer: false,
};
const oldPastedEntry = {
  id: "pasted_my_friend.x_1760000000000_k3j9a", username: "my_friend.x", full_name: "my_friend.x",
  profile_pic_url: "https://api.dicebear.com/9.x/initials/svg?seed=my_friend.x&backgroundColor=0f172a",
  is_private: false, is_verified: false, followed_by_viewer: true, follows_viewer: false, requested_by_viewer: false,
  reel: { id: "pasted_x", expiring_at: 0, has_pride_media: false, latest_reel_media: 0, seen: null, owner: { id: "pasted_x" } },
};

test("existing whitelist entries (real and pasted) survive the new validation", () => {
  const list = sanitizeUserList([oldScanEntry, oldPastedEntry], true);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, oldScanEntry.id);
  assert.equal(list[1].username, "my_friend.x");
});

test("old pasted entries no longer point at the third-party avatar service", () => {
  const [, pasted] = sanitizeUserList([oldScanEntry, oldPastedEntry], true);
  assert.equal(pasted.profile_pic_url, "");
});
