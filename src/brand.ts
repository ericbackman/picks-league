// Per-bot branding. Deliberately NOT in discord.ts: that file is a brick
// (shared with sibling bots) and must stay
// byte-identical across consumers, so anything bot-specific lives here instead.
//
// These hexes predate the house design system and are left as-is on purpose — restyling a
// live bot's embeds is a visible change, not a refactor. If they are ever brought
// onto the house palette, this file is the one place to do it.

export const EMBED_COLOR = 0x21c065; // green
