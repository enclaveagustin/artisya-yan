import { UserNode } from "../model/user";

/**
 * A locally generated initials avatar (inline SVG data URI). It is used instead
 * of a third-party avatar service, so no usernames are ever sent to a server
 * other than Instagram's own.
 */
export function localAvatar(username: string): string {
  const letter = (username.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="#1f2937"/>` +
    `<text x="48" y="48" dy=".35em" text-anchor="middle" font-family="Verdana,sans-serif" font-size="44" fill="#e5e7eb">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The avatar to render: Instagram's https picture when there is one, a local placeholder otherwise. */
export function avatarSrc(user: Pick<UserNode, "username" | "profile_pic_url">): string {
  return user.profile_pic_url || localAvatar(user.username);
}
